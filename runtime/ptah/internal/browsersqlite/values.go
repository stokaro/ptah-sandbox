//go:build js

package browsersqlite

import (
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"
	"time"
)

// sqliteRange is SQLITE_RANGE: a bind index the statement does not have.
const sqliteRange = 25

// bindArgs binds one argument list to a prepared statement.
//
// Only ordinal placeholders are bound. Contract A has no
// sqlite3_bind_parameter_name, so a named placeholder cannot be matched to a
// sql.Named argument; Ptah never uses one on SQLite -- its only sql.Named
// call site is SQL Server -- and a named argument is refused with an error
// rather than bound to the wrong slot.
//
// A statement with more placeholders than there are arguments leaves the
// extra ones NULL, where modernc reports "missing argument with index N".
// Telling the two apart needs sqlite3_bind_parameter_count, which Contract A
// does not expose, and the only way to ask the engine costs a crossing on
// every execution. Ptah builds its SQL and its arguments together, so the
// mismatch is a bug that its native tests already fail on.
//
// stopAtExtra is for the statements of a script, which are handed the whole
// argument list and take the prefix of it they have room for -- modernc does
// the same by asking sqlite3_bind_parameter_count first. Contract A has no
// such call, so the engine's SQLITE_RANGE is the only count available, and
// treating it as an error would make a script with arguments impossible
// rather than merely awkward.
func bindArgs(b bridge, cfg config, stmt int, args []driver.NamedValue, stopAtExtra bool) error {
	for _, arg := range args {
		if arg.Name != "" {
			return fmt.Errorf("browsersqlite: named parameter %q is not supported", arg.Name)
		}
		err := bindValue(b, cfg, stmt, arg.Ordinal, arg.Value)
		if err == nil {
			continue
		}
		var sqliteErr *Error
		if stopAtExtra && errors.As(err, &sqliteErr) && sqliteErr.Code() == sqliteRange {
			return nil
		}
		return err
	}
	return nil
}

// bindValue binds one value.
//
// The types are the ones driver.DefaultParameterConverter produces. There is
// no NamedValueChecker on this driver, so nothing else can arrive.
func bindValue(b bridge, cfg config, stmt, index int, value driver.Value) error {
	switch typed := value.(type) {
	case nil:
		return b.bindNull(stmt, index)
	case int64:
		return b.bindInt(stmt, index, typed)
	case bool:
		// SQLite has no boolean; it stores 0 and 1, and so does modernc.
		if typed {
			return b.bindInt(stmt, index, 1)
		}
		return b.bindInt(stmt, index, 0)
	case float64:
		return b.bindFloat(stmt, index, typed)
	case string:
		return b.bindText(stmt, index, typed)
	case []byte:
		// A nil []byte is SQL NULL and an empty one is a zero-length blob.
		// modernc draws the line in the same place, and Ptah's Atlas
		// partial_hashes column depends on telling them apart.
		if typed == nil {
			return b.bindNull(stmt, index)
		}
		return b.bindBlob(stmt, index, typed)
	case time.Time:
		return b.bindText(stmt, index, formatTime(cfg, typed))
	default:
		return fmt.Errorf("browsersqlite: cannot bind %T", value)
	}
}

// formatTime renders a bound time.Time.
func formatTime(cfg config, value time.Time) string {
	if cfg.writeTimeFormat != "" {
		return value.Format(cfg.writeTimeFormat)
	}
	return value.Format(defaultWriteTimeFormat)
}

// goStringTimeLayout is the layout time.Time.String produces, which is what
// modernc writes by default and therefore what a natively written SQLite
// database holds in a TIMESTAMP column.
const goStringTimeLayout = "2006-01-02 15:04:05.999999999 -0700 MST"

// textValue decides what a TEXT column becomes on the Go side.
//
// Almost always a string: without sqlite3_column_decltype this driver cannot
// know that a column is a timestamp, and guessing from the value would turn
// a column default like "2020-01-01" into a time.Time.
//
// The exception is the layout time.Time.String produces. That is the layout
// a database written by native Ptah holds, it is the one layout Ptah's own
// fallback parser cannot read (migration/migrator/revisions.go), and nothing
// else looks like it: a date, a space, a time, an offset, a zone abbreviation
// and optionally Go's monotonic-clock suffix. Recognizing it is what makes an
// imported database readable; recognizing anything more would start rewriting
// data that is only text.
func textValue(text string) driver.Value {
	if !looksLikeGoTimeString(text) {
		return text
	}
	trimmed := text
	if monotonic := strings.Index(trimmed, " m="); monotonic > 0 {
		trimmed = trimmed[:monotonic]
	}
	parsed, err := time.Parse(goStringTimeLayout, strings.TrimSpace(trimmed))
	if err != nil {
		return text
	}
	return parsed
}

// looksLikeGoTimeString is the cheap check that keeps textValue from running
// a time.Parse over every string the database returns.
func looksLikeGoTimeString(text string) bool {
	// "2006-01-02 15:04:05 -0700 MST" is the shortest form the layout can
	// produce, and the monotonic suffix is the longest thing that can follow.
	if len(text) < 29 || len(text) > 80 {
		return false
	}
	return text[4] == '-' && text[7] == '-' && text[10] == ' ' &&
		text[13] == ':' && text[16] == ':' &&
		(strings.Contains(text, " +") || strings.Contains(text, " -"))
}
