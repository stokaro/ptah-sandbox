//go:build js

package browsersqlite

import (
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// config is one parsed DSN: which database to open, and what to run on the
// connection before handing it to the caller.
type config struct {
	// path names the logical database for the bridge. See the package doc for
	// how a DSN becomes one.
	path string
	// setup is the pragma statements to execute at open, already in the order
	// they must run.
	setup []string
	// writeTimeFormat is the layout a bound time.Time is written in.
	writeTimeFormat string
	// beginMode is the _txlock word appended to BEGIN, empty for a plain one.
	beginMode string
}

// parseDSN reads the string convertSQLiteURL produced.
//
// The shapes Ptah can hand this driver are fixed by dbschema's own tests
// (TestConvertSQLiteURL): a bare path, an absolute path, ":memory:", a
// "file:" URI for a named memory database, and any of those carrying repeated
// _pragma parameters. sqlitemodule.Registered additionally opens a bare
// ":memory:" with no query at all.
func parseDSN(dsn string) (config, error) {
	name, rawQuery, isURI := splitDSN(dsn)

	query, err := url.ParseQuery(rawQuery)
	if err != nil {
		return config{}, fmt.Errorf("browsersqlite: parse DSN parameters: %w", err)
	}

	cfg := config{path: databasePath(name, isURI)}
	if err := applyQueryParams(&cfg, query); err != nil {
		return config{}, err
	}
	return cfg, nil
}

// splitDSN separates the filename from the query the way modernc does: the
// query is everything after the first "?", and it is cut from the name only
// when the name is not a "file:" URI, because SQLite parses a URI's query
// itself.
//
// The leading-position check is modernc's too. A DSN that starts with "?" is
// a filename, not a query.
func splitDSN(dsn string) (name, rawQuery string, isURI bool) {
	isURI = strings.HasPrefix(dsn, "file:")
	position := strings.IndexRune(dsn, '?')
	if position < 1 {
		return dsn, "", isURI
	}
	return dsn[:position], dsn[position+1:], isURI
}

// databasePath turns the filename into the name the bridge addresses the
// database by.
//
// The "file:" scheme and its percent-encoding are unwrapped, because the
// bridge takes a name and not a URI, and because two spellings of one
// database must not become two databases. A plain path is left exactly as it
// is: percent-decoding it would rewrite a filename that legitimately contains
// a "%", and SQLite does not decode one either.
func databasePath(name string, isURI bool) string {
	if !isURI {
		if name == "" {
			return memoryPath
		}
		return name
	}
	path := strings.TrimPrefix(name, "file:")
	// An empty authority is the only one SQLite accepts, so "file://name" and
	// "file:name" name the same database.
	path = strings.TrimPrefix(path, "//")
	if decoded, err := url.PathUnescape(path); err == nil {
		path = decoded
	}
	if path == "" {
		// A URI with no filename is SQLite's private temporary database. The
		// bridge has no such thing, so it becomes the shared memory database,
		// which is the closest name it does have.
		return memoryPath
	}
	return path
}

const memoryPath = ":memory:"

// applyQueryParams validates the DSN parameters and records the pragmas the
// connection must run.
//
// Validation happens before anything is queued, matching modernc: a typo in a
// later parameter must not leave the database half-configured by an earlier
// one. The apply order below is modernc's documented order, not the order the
// keys appear in the DSN.
func applyQueryParams(cfg *config, query url.Values) error {
	busyKey, busyTimeout := pick(query, "_busy_timeout", "_timeout")
	if busyTimeout != "" {
		if _, err := strconv.ParseInt(busyTimeout, 10, 64); err != nil {
			return fmt.Errorf("browsersqlite: invalid %s %q: %w", busyKey, busyTimeout, err)
		}
	}

	autoVacuumKey, autoVacuum := pick(query, "_auto_vacuum", "_vacuum")
	if err := enum(autoVacuumKey, autoVacuum, "0", "NONE", "1", "FULL", "2", "INCREMENTAL"); err != nil {
		return err
	}

	foreignKeysKey, foreignKeys := pick(query, "_foreign_keys", "_fk")
	if foreignKeys != "" {
		if _, err := strconv.ParseBool(foreignKeys); err != nil {
			return fmt.Errorf("browsersqlite: invalid %s %q", foreignKeysKey, foreignKeys)
		}
	}

	journalKey, journalMode := pick(query, "_journal_mode", "_journal")
	if err := enum(journalKey, journalMode, "DELETE", "TRUNCATE", "PERSIST", "MEMORY", "WAL", "OFF"); err != nil {
		return err
	}

	syncKey, synchronous := pick(query, "_synchronous", "_sync")
	if err := enum(syncKey, synchronous, "0", "OFF", "1", "NORMAL", "2", "FULL", "3", "EXTRA"); err != nil {
		return err
	}

	queryOnly := query.Get("_query_only")
	if queryOnly != "" {
		if _, err := strconv.ParseBool(queryOnly); err != nil {
			return fmt.Errorf("browsersqlite: invalid _query_only %q", queryOnly)
		}
	}
	// mode=ro asks SQLite to open the file read-only. The bridge opens a
	// database by name and has no such flag, so the nearest honest thing is
	// to refuse writes on the connection. Refusing them is the point of the
	// parameter, and silently dropping it would open a writable database
	// where the caller asked for a read-only one.
	if strings.EqualFold(query.Get("mode"), "ro") && queryOnly == "" {
		queryOnly = "1"
	}

	if format := query.Get("_time_format"); format != "" {
		layout, known := writeTimeFormats[format]
		if !known {
			return fmt.Errorf("browsersqlite: unknown _time_format %q", format)
		}
		cfg.writeTimeFormat = layout
	}

	if zone := query.Get("_timezone"); zone != "" {
		// time.LoadLocation needs the zoneinfo database, which a js/wasm
		// binary does not carry unless it imports time/tzdata. Refusing is
		// better than silently reading every timestamp in UTC.
		return fmt.Errorf("browsersqlite: _timezone is not supported in the browser build (got %q)", zone)
	}

	if lock := query.Get("_txlock"); lock != "" {
		switch strings.ToLower(lock) {
		case "deferred", "immediate", "exclusive":
			cfg.beginMode = lock
		default:
			return fmt.Errorf("browsersqlite: unknown _txlock %q", lock)
		}
	}

	// Busy timeout first: a pragma that writes to the database can otherwise
	// fail with SQLITE_BUSY before the timeout that would have covered it is
	// in force.
	if busyTimeout != "" {
		cfg.setup = append(cfg.setup, "pragma busy_timeout = "+busyTimeout)
	}
	// auto_vacuum has to run while the database is still empty: the first
	// table locks the setting in.
	if autoVacuum != "" {
		cfg.setup = append(cfg.setup, "pragma auto_vacuum = "+autoVacuum)
	}
	cfg.setup = append(cfg.setup, pragmaStatements(query["_pragma"])...)
	if foreignKeys != "" {
		cfg.setup = append(cfg.setup, "pragma foreign_keys = "+foreignKeys)
	}
	if journalMode != "" {
		cfg.setup = append(cfg.setup, "pragma journal_mode = "+journalMode)
	}
	if synchronous != "" {
		cfg.setup = append(cfg.setup, "pragma synchronous = "+synchronous)
	}
	// query_only last: it makes the connection read-only, so it must not
	// precede the pragmas that write.
	if queryOnly != "" {
		cfg.setup = append(cfg.setup, "pragma query_only = "+queryOnly)
	}
	return nil
}

// pragmaStatements renders the _pragma list in the order modernc runs it:
// busy_timeout first, then case-insensitively sorted. The order is not the
// DSN's, and it is not arbitrary either -- a busy_timeout that runs after a
// pragma that needs it would not have covered it.
func pragmaStatements(pragmas []string) []string {
	if len(pragmas) == 0 {
		return nil
	}
	ordered := make([]string, len(pragmas))
	copy(ordered, pragmas)
	sort.SliceStable(ordered, func(i, j int) bool {
		left := strings.TrimSpace(strings.ToLower(ordered[i]))
		right := strings.TrimSpace(strings.ToLower(ordered[j]))
		if strings.HasPrefix(left, "busy_timeout") {
			return true
		}
		if strings.HasPrefix(right, "busy_timeout") {
			return false
		}
		return left < right
	})
	statements := make([]string, 0, len(ordered))
	for _, pragma := range ordered {
		statements = append(statements, "pragma "+pragma)
	}
	return statements
}

// pick returns the value of key or its alias, with the alias winning when
// both are present. modernc resolves the pair the same way.
func pick(query url.Values, key, alias string) (string, string) {
	if value := query.Get(alias); value != "" {
		return alias, value
	}
	return key, query.Get(key)
}

func enum(key, value string, allowed ...string) error {
	if value == "" {
		return nil
	}
	for _, candidate := range allowed {
		if strings.EqualFold(value, candidate) {
			return nil
		}
	}
	return fmt.Errorf("browsersqlite: invalid %s %q, expected one of %s", key, value, strings.Join(allowed, ", "))
}

// writeTimeFormats are the _time_format names modernc accepts. The default,
// when the parameter is absent, is RFC 3339 with nanoseconds rather than
// modernc's time.Time.String -- see the package doc for why.
var writeTimeFormats = map[string]string{
	"sqlite":   "2006-01-02 15:04:05.999999999-07:00",
	"datetime": "2006-01-02 15:04:05",
}

// defaultWriteTimeFormat is the layout a bound time.Time is written in when
// the DSN says nothing.
const defaultWriteTimeFormat = time.RFC3339Nano
