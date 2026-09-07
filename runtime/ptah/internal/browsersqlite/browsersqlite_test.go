//go:build js

package browsersqlite

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"syscall/js"
	"testing"
	"time"
)

// The bridge these tests run against is testdata/bridge_stub.mjs: a Contract A
// implementation over the same sqlite.org WASM build the playground vendors,
// installed before the Go program starts by
// testdata/go_js_wasm_exec_sqlite. It is not the bridge the playground
// ships -- that one is a separate component -- so what is proven here is the
// driver against a real engine, not the shipping bridge.
//
//	GOOS=js GOARCH=wasm go test -exec=./testdata/go_js_wasm_exec_sqlite ./...

func requireBridge(t *testing.T) {
	t.Helper()
	if js.Global().Get(bridgeGlobal).Type() != js.TypeObject {
		t.Skip("globalThis.__sqlite is not installed; run with -exec=./testdata/go_js_wasm_exec_sqlite")
	}
}

var databaseSerial int

// newDB opens a database nothing else in this file touches. Databases outlive
// the connections opened on them, so a shared name would leak state between
// tests.
func newDB(t *testing.T, params string) *sql.DB {
	t.Helper()
	requireBridge(t)
	databaseSerial++
	dsn := fmt.Sprintf("test-%s-%d.db", t.Name(), databaseSerial)
	dsn = strings.ReplaceAll(dsn, "/", "-")
	if params != "" {
		dsn += "?" + params
	}
	db, err := sql.Open(DriverName, dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})
	return db
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) sql.Result {
	t.Helper()
	result, err := db.ExecContext(context.Background(), query, args...)
	if err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
	return result
}

// --- DSN ---------------------------------------------------------------

// TestParseDSN covers every string dbschema.convertSQLiteURL can produce.
// The inputs are the expectations of Ptah's own TestConvertSQLiteURL, plus
// the bare ":memory:" sqlitemodule.Registered opens with no query at all.
func TestParseDSN(t *testing.T) {
	tests := []struct {
		name  string
		dsn   string
		path  string
		setup []string
	}{
		{
			name:  "relative file",
			dsn:   "test.db?_pragma=foreign_keys%281%29",
			path:  "test.db",
			setup: []string{"pragma foreign_keys(1)"},
		},
		{
			name:  "nested relative file",
			dsn:   "data/app.db?_pragma=foreign_keys%281%29",
			path:  "data/app.db",
			setup: []string{"pragma foreign_keys(1)"},
		},
		{
			name:  "absolute path",
			dsn:   "/tmp/app.db?_pragma=foreign_keys%281%29",
			path:  "/tmp/app.db",
			setup: []string{"pragma foreign_keys(1)"},
		},
		{
			name:  "memory",
			dsn:   ":memory:?_pragma=foreign_keys%281%29",
			path:  ":memory:",
			setup: []string{"pragma foreign_keys(1)"},
		},
		{
			name:  "named memory uri",
			dsn:   "file:dev?_pragma=foreign_keys%281%29&mode=memory",
			path:  "dev",
			setup: []string{"pragma foreign_keys(1)"},
		},
		{
			name:  "named memory uri with shared cache",
			dsn:   "file:dev?_pragma=foreign_keys%281%29&cache=shared&mode=memory",
			path:  "dev",
			setup: []string{"pragma foreign_keys(1)"},
		},
		{
			name:  "uri memory database",
			dsn:   "file:memdb1?_pragma=foreign_keys%281%29&cache=shared&mode=memory",
			path:  "memdb1",
			setup: []string{"pragma foreign_keys(1)"},
		},
		{
			name:  "explicit foreign keys off",
			dsn:   ":memory:?_pragma=foreign_keys%280%29",
			path:  ":memory:",
			setup: []string{"pragma foreign_keys(0)"},
		},
		{
			// sqlitemodule.Registered opens this to ask the build which
			// virtual-table modules it has.
			name: "bare memory with no query",
			dsn:  ":memory:",
			path: ":memory:",
		},
		{
			name: "windows path keeps its query",
			dsn:  `C:\tmp\app.db?mode=ro&_pragma=foreign_keys%281%29`,
			path: `C:\tmp\app.db`,
			// mode=ro has no bridge equivalent, so it becomes the refusal it
			// was asking for.
			setup: []string{"pragma foreign_keys(1)", "pragma query_only = 1"},
		},
		{
			name: "percent-encoded uri name",
			dsn:  "file:my%20db?mode=memory",
			path: "my db",
		},
		{
			name: "file scheme with empty authority",
			dsn:  "file://dev?mode=memory",
			path: "dev",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg, err := parseDSN(test.dsn)
			if err != nil {
				t.Fatalf("parseDSN(%q): %v", test.dsn, err)
			}
			if cfg.path != test.path {
				t.Errorf("path = %q, want %q", cfg.path, test.path)
			}
			if !reflect.DeepEqual(cfg.setup, test.setup) && !(len(cfg.setup) == 0 && len(test.setup) == 0) {
				t.Errorf("setup = %q, want %q", cfg.setup, test.setup)
			}
		})
	}
}

// TestParseDSNPragmaOrder pins the order modernc applies the _pragma list in:
// busy_timeout first, the rest folded-case lexicographic, neither of them the
// order they appear in the DSN.
func TestParseDSNPragmaOrder(t *testing.T) {
	cfg, err := parseDSN("app.db?_pragma=journal_mode%28WAL%29&_pragma=Foreign_Keys%281%29&_pragma=busy_timeout%285000%29")
	if err != nil {
		t.Fatalf("parseDSN: %v", err)
	}
	want := []string{
		"pragma busy_timeout(5000)",
		"pragma Foreign_Keys(1)",
		"pragma journal_mode(WAL)",
	}
	if !reflect.DeepEqual(cfg.setup, want) {
		t.Errorf("setup = %q, want %q", cfg.setup, want)
	}
}

func TestParseDSNShorthandOrder(t *testing.T) {
	cfg, err := parseDSN("app.db?_query_only=1&_synchronous=OFF&_fk=1&_busy_timeout=100&_auto_vacuum=FULL&_pragma=cache_size%28-2000%29")
	if err != nil {
		t.Fatalf("parseDSN: %v", err)
	}
	want := []string{
		"pragma busy_timeout = 100",
		"pragma auto_vacuum = FULL",
		"pragma cache_size(-2000)",
		"pragma foreign_keys = 1",
		"pragma synchronous = OFF",
		"pragma query_only = 1",
	}
	if !reflect.DeepEqual(cfg.setup, want) {
		t.Errorf("setup = %q, want %q", cfg.setup, want)
	}
}

func TestParseDSNRejections(t *testing.T) {
	tests := []struct {
		dsn     string
		wantSub string
	}{
		{"app.db?_time_format=iso", "unknown _time_format"},
		{"app.db?_txlock=shared", "unknown _txlock"},
		{"app.db?_timezone=Europe/Prague", "_timezone is not supported"},
		{"app.db?_journal_mode=SOMETIMES", "invalid _journal_mode"},
		{"app.db?_busy_timeout=soon", "invalid _busy_timeout"},
		{"app.db?_fk=perhaps", "invalid _fk"},
	}
	for _, test := range tests {
		_, err := parseDSN(test.dsn)
		if err == nil || !strings.Contains(err.Error(), test.wantSub) {
			t.Errorf("parseDSN(%q) = %v, want an error containing %q", test.dsn, err, test.wantSub)
		}
	}
}

// --- driver surface ----------------------------------------------------

func TestDriverIsRegistered(t *testing.T) {
	found := false
	for _, name := range sql.Drivers() {
		if name == DriverName {
			found = true
		}
	}
	if !found {
		t.Fatalf("sql.Drivers() = %q, want it to contain %q", sql.Drivers(), DriverName)
	}
	RegisterDriver() // idempotent: a second call must not panic on re-register
}

// TestDriverInterfaces asserts the set Ptah actually reaches for, on the live
// connection rather than at compile time, because a nil-typed assertion in
// the source would still pass if the method set moved to another type.
func TestDriverInterfaces(t *testing.T) {
	db := newDB(t, "")
	session, err := db.Conn(context.Background())
	if err != nil {
		t.Fatalf("conn: %v", err)
	}
	defer session.Close()

	err = session.Raw(func(driverConn any) error {
		for name, ok := range map[string]bool{
			"ConnPrepareContext": func() bool { _, ok := driverConn.(driver.ConnPrepareContext); return ok }(),
			"ExecerContext":      func() bool { _, ok := driverConn.(driver.ExecerContext); return ok }(),
			"QueryerContext":     func() bool { _, ok := driverConn.(driver.QueryerContext); return ok }(),
			"Pinger":             func() bool { _, ok := driverConn.(driver.Pinger); return ok }(),
			"ConnBeginTx":        func() bool { _, ok := driverConn.(driver.ConnBeginTx); return ok }(),
			"SessionResetter":    func() bool { _, ok := driverConn.(driver.SessionResetter); return ok }(),
			"Validator":          func() bool { _, ok := driverConn.(driver.Validator); return ok }(),
		} {
			if !ok {
				t.Errorf("driver connection does not implement %s", name)
			}
		}
		if _, unwanted := driverConn.(driver.NamedValueChecker); unwanted {
			t.Error("driver connection implements NamedValueChecker; driver.DefaultParameterConverter is what this driver expects")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("raw: %v", err)
	}
}

func TestStmtNumInputIsUnknown(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE t(a INTEGER)")
	mustExec(t, db, "INSERT INTO t VALUES(1),(2),(3)")

	// The placeholder count comes from the data, the way
	// internal/dbschema/sqlite/reader.go builds its exclusion list. A driver
	// reporting a fixed NumInput would have database/sql refuse this.
	for _, count := range []int{1, 2, 3} {
		placeholders := strings.TrimSuffix(strings.Repeat("?, ", count), ", ")
		args := make([]any, count)
		for i := range args {
			args[i] = i + 1
		}
		var got int
		query := "SELECT count(*) FROM t WHERE a IN (" + placeholders + ")"
		if err := db.QueryRow(query, args...).Scan(&got); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
		if got != count {
			t.Errorf("%s = %d, want %d", query, got, count)
		}
	}
}

func TestPing(t *testing.T) {
	db := newDB(t, "")
	if err := db.PingContext(context.Background()); err != nil {
		t.Fatalf("ping: %v", err)
	}
}

// --- values ------------------------------------------------------------

func TestInt64Extremes(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)")

	values := []int64{
		math.MinInt64, math.MinInt64 + 1, -(1 << 53) - 1, -(1 << 53), -1, 0, 1,
		1 << 53, (1 << 53) + 1, math.MaxInt64 - 1, math.MaxInt64,
	}
	for i, value := range values {
		mustExec(t, db, "INSERT INTO t VALUES(?, ?)", i, value)
	}
	rows, err := db.Query("SELECT id, v FROM t ORDER BY id")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var id int
		var got int64
		if err := rows.Scan(&id, &got); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if got != values[id] {
			t.Errorf("row %d = %d, want %d", id, got, values[id])
		}
		seen++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	if seen != len(values) {
		t.Fatalf("read %d rows, want %d", seen, len(values))
	}
}

func TestNullVersusEmpty(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE t(id INTEGER PRIMARY KEY, text TEXT, blob BLOB)")
	mustExec(t, db, "INSERT INTO t VALUES(1, ?, ?)", nil, nil)
	mustExec(t, db, "INSERT INTO t VALUES(2, ?, ?)", "", []byte{})
	// A nil []byte is NULL, not a zero-length blob. modernc's bindBlob draws
	// the line in the same place, and Ptah's Atlas partial_hashes column
	// depends on it.
	mustExec(t, db, "INSERT INTO t VALUES(3, ?, ?)", "x", []byte(nil))

	rows, err := db.Query("SELECT id, typeof(text), typeof(blob), text, blob FROM t ORDER BY id")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()

	type record struct {
		textType, blobType string
		text               any
		blob               []byte
	}
	got := map[int]record{}
	for rows.Next() {
		var id int
		var r record
		var text any
		if err := rows.Scan(&id, &r.textType, &r.blobType, &text, &r.blob); err != nil {
			t.Fatalf("scan: %v", err)
		}
		r.text = text
		got[id] = r
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}

	if got[1].textType != "null" || got[1].blobType != "null" {
		t.Errorf("row 1 types = %q/%q, want null/null", got[1].textType, got[1].blobType)
	}
	if got[2].textType != "text" || got[2].blobType != "blob" {
		t.Errorf("row 2 types = %q/%q, want text/blob", got[2].textType, got[2].blobType)
	}
	if got[2].text != "" {
		t.Errorf("row 2 text = %#v, want an empty string", got[2].text)
	}
	if got[2].blob == nil || len(got[2].blob) != 0 {
		t.Errorf("row 2 blob = %#v, want a non-nil empty slice", got[2].blob)
	}
	if got[3].blobType != "null" {
		t.Errorf("row 3 blob type = %q, want null: a nil []byte binds as NULL", got[3].blobType)
	}
}

func TestBlobRoundTrip(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE t(v BLOB)")

	blob := make([]byte, 512)
	for i := range blob {
		blob[i] = byte(i)
	}
	mustExec(t, db, "INSERT INTO t VALUES(?)", blob)

	var got []byte
	if err := db.QueryRow("SELECT v FROM t").Scan(&got); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !reflect.DeepEqual(got, blob) {
		t.Fatalf("blob round trip lost bytes: got %d bytes, want %d", len(got), len(blob))
	}
}

func TestScalarTypes(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE t(f REAL, b INTEGER, s TEXT)")
	mustExec(t, db, "INSERT INTO t VALUES(?, ?, ?)", 1.5, true, "ünïcødé — ok")
	mustExec(t, db, "INSERT INTO t VALUES(?, ?, ?)", math.Inf(-1), false, "")

	rows, err := db.Query("SELECT f, b, s FROM t")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()

	var floats []float64
	var bools []bool
	var strings1 []string
	for rows.Next() {
		var f float64
		var b bool
		var s string
		if err := rows.Scan(&f, &b, &s); err != nil {
			t.Fatalf("scan: %v", err)
		}
		floats = append(floats, f)
		bools = append(bools, b)
		strings1 = append(strings1, s)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	if floats[0] != 1.5 || !math.IsInf(floats[1], -1) {
		t.Errorf("floats = %v, want [1.5 -Inf]", floats)
	}
	if bools[0] != true || bools[1] != false {
		t.Errorf("bools = %v, want [true false]", bools)
	}
	if strings1[0] != "ünïcødé — ok" || strings1[1] != "" {
		t.Errorf("strings = %q", strings1)
	}
}

// --- results, transactions, statements ---------------------------------

// TestRowsAffected is the count migration/migrator/tags.go turns into
// ErrMigrationTagNotFound, so a driver that guessed here would report a tag
// as missing right after deleting it.
func TestRowsAffected(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE tags(tag TEXT PRIMARY KEY)")
	mustExec(t, db, "INSERT INTO tags VALUES('v1'),('v2')")

	result := mustExec(t, db, "DELETE FROM tags WHERE tag = ?", "nope")
	affected, err := result.RowsAffected()
	if err != nil {
		t.Fatalf("rows affected: %v", err)
	}
	if affected != 0 {
		t.Errorf("deleting a missing tag affected %d rows, want 0", affected)
	}

	result = mustExec(t, db, "DELETE FROM tags WHERE tag = ?", "v1")
	if affected, err = result.RowsAffected(); err != nil || affected != 1 {
		t.Errorf("deleting a tag affected %d rows (err %v), want 1", affected, err)
	}
}

func TestLastInsertID(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
	mustExec(t, db, "INSERT INTO t VALUES(4611686018427387904, 'far')")
	result := mustExec(t, db, "INSERT INTO t(v) VALUES('next')")
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}
	if id != 4611686018427387905 {
		t.Errorf("last insert id = %d, want 4611686018427387905", id)
	}
}

func TestTransactionCommitAndRollback(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE t(v INTEGER)")

	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec("INSERT INTO t VALUES(1)"); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}

	tx, err = db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec("INSERT INTO t VALUES(2)"); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("rollback: %v", err)
	}

	var sum int
	if err := db.QueryRow("SELECT coalesce(sum(v), 0) FROM t").Scan(&sum); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if sum != 1 {
		t.Errorf("sum = %d, want 1: the rolled back insert must not be there", sum)
	}
}

func TestTransactionRejectsUnsupportedIsolation(t *testing.T) {
	db := newDB(t, "")
	_, err := db.BeginTx(context.Background(), &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err == nil {
		t.Fatal("BeginTx accepted read-committed; SQLite has one isolation level and it is not that")
	}
	if !strings.Contains(err.Error(), "isolation level") {
		t.Errorf("error = %v, want it to name the isolation level", err)
	}
	// checks.go hands SQLite a zero-value TxOptions, which must still work.
	tx, err := db.BeginTx(context.Background(), new(sql.TxOptions))
	if err != nil {
		t.Fatalf("BeginTx with the default level: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("rollback: %v", err)
	}
}

func TestPreparedStatementReuse(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE t(k TEXT, v INTEGER)")

	insert, err := db.Prepare("INSERT INTO t VALUES(?, ?)")
	if err != nil {
		t.Fatalf("prepare insert: %v", err)
	}
	defer insert.Close()
	for i := 0; i < 5; i++ {
		if _, err := insert.Exec(fmt.Sprintf("k%d", i), i); err != nil {
			t.Fatalf("exec %d: %v", i, err)
		}
	}

	query, err := db.Prepare("SELECT v FROM t WHERE k = ?")
	if err != nil {
		t.Fatalf("prepare select: %v", err)
	}
	defer query.Close()
	for i := 0; i < 5; i++ {
		var got int
		if err := query.QueryRow(fmt.Sprintf("k%d", i)).Scan(&got); err != nil {
			t.Fatalf("query %d: %v", i, err)
		}
		if got != i {
			t.Errorf("k%d = %d, want %d", i, got, i)
		}
	}
	// The same statement handle, run again after its rows were read to the
	// end and after they were abandoned half-read.
	rows, err := query.Query("k0")
	if err != nil {
		t.Fatalf("query for early close: %v", err)
	}
	if err := rows.Close(); err != nil {
		t.Fatalf("close rows early: %v", err)
	}
	var got int
	if err := query.QueryRow("k4").Scan(&got); err != nil {
		t.Fatalf("query after an early close: %v", err)
	}
	if got != 4 {
		t.Errorf("k4 = %d, want 4", got)
	}
}

func TestMultiStatementExec(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, `
		CREATE TABLE a(v INTEGER);
		CREATE TABLE b(v INTEGER);
		INSERT INTO a VALUES(1), (2);
		-- a trailing comment, which compiles to nothing
	`)
	var count int
	if err := db.QueryRow("SELECT count(*) FROM a").Scan(&count); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if count != 2 {
		t.Errorf("count = %d, want 2", count)
	}
	if _, err := db.Exec("SELECT 1 FROM b"); err != nil {
		t.Fatalf("second table missing: %v", err)
	}
}

// TestScriptWithArguments takes the path that cannot use the bridge's
// multi-statement exec, because every statement has to be bound separately.
func TestScriptWithArguments(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE a(v INTEGER); CREATE TABLE b(v INTEGER)")
	result := mustExec(t, db, "INSERT INTO a VALUES(?); INSERT INTO b VALUES(?);", 7, 7)
	affected, err := result.RowsAffected()
	if err != nil || affected != 1 {
		t.Errorf("rows affected = %d (err %v), want the last statement's 1", affected, err)
	}
	var a, b int
	if err := db.QueryRow("SELECT (SELECT v FROM a), (SELECT v FROM b)").Scan(&a, &b); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if a != 7 || b != 7 {
		t.Errorf("a, b = %d, %d, want 7, 7: a script binds the same arguments to every statement", a, b)
	}
}

// TestFetchBatching walks past the batch boundary in both directions, which
// is where an off-by-one in the fetch loop would show.
func TestFetchBatching(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE t(v INTEGER)")

	const total = fetchBatchRows*3 + 7
	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	insert, err := tx.Prepare("INSERT INTO t VALUES(?)")
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	for i := 0; i < total; i++ {
		if _, err := insert.Exec(i); err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
	}
	insert.Close()
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}

	for _, limit := range []int{0, 1, fetchBatchRows - 1, fetchBatchRows, fetchBatchRows + 1, total} {
		rows, err := db.Query("SELECT v FROM t ORDER BY v LIMIT ?", limit)
		if err != nil {
			t.Fatalf("query: %v", err)
		}
		seen := 0
		for rows.Next() {
			var v int
			if err := rows.Scan(&v); err != nil {
				t.Fatalf("scan: %v", err)
			}
			if v != seen {
				t.Fatalf("row %d = %d, want %d: the batches are out of order", seen, v, seen)
			}
			seen++
		}
		if err := rows.Err(); err != nil {
			t.Fatalf("rows: %v", err)
		}
		rows.Close()
		if seen != limit {
			t.Errorf("limit %d produced %d rows", limit, seen)
		}
	}
}

// --- pragmas and sessions ----------------------------------------------

// TestForeignKeysPragmaFromDSN is the whole point of parsing _pragma: without
// it foreign keys stay off and the browser build enforces less than a native
// run does.
func TestForeignKeysPragmaFromDSN(t *testing.T) {
	schema := `
		CREATE TABLE parent(id INTEGER PRIMARY KEY);
		CREATE TABLE child(parent INTEGER REFERENCES parent(id));
	`
	on := newDB(t, "_pragma=foreign_keys%281%29")
	mustExec(t, on, schema)
	if _, err := on.Exec("INSERT INTO child VALUES(404)"); err == nil {
		t.Error("foreign_keys(1) did not take effect: an unreferenced row was accepted")
	} else if !strings.Contains(err.Error(), "FOREIGN KEY constraint failed") {
		t.Errorf("error = %v, want the engine's FOREIGN KEY constraint message", err)
	}

	off := newDB(t, "_pragma=foreign_keys%280%29")
	mustExec(t, off, schema)
	if _, err := off.Exec("INSERT INTO child VALUES(404)"); err != nil {
		t.Errorf("foreign_keys(0) still enforced the reference: %v", err)
	}
}

// TestRestrictSession runs the whole of what
// internal/dbschema/sqlite/restrict.go does, including its self-check, so the
// error text coupling is proven rather than assumed.
func TestRestrictSession(t *testing.T) {
	const (
		probeSchemaName     = "ptah_restriction_probe"
		attachRefusalMarker = "too many attached databases"
	)

	db := newDB(t, "")
	ctx := context.Background()
	session, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("conn: %v", err)
	}
	defer session.Close()

	// An ATTACH is allowed before the restriction, so the check below is
	// measuring the restriction and not some unrelated refusal.
	if _, err := session.ExecContext(ctx, "ATTACH DATABASE ':memory:' AS before_restriction"); err != nil {
		t.Fatalf("ATTACH before the restriction: %v", err)
	}
	if _, err := session.ExecContext(ctx, "DETACH DATABASE before_restriction"); err != nil {
		t.Fatalf("DETACH: %v", err)
	}

	if err := RestrictSession(ctx, session); err != nil {
		t.Fatalf("RestrictSession: %v", err)
	}

	_, err = session.ExecContext(ctx, "ATTACH DATABASE ':memory:' AS "+probeSchemaName)
	if err == nil {
		t.Fatal("ATTACH still succeeds on the restricted session")
	}
	if !strings.Contains(err.Error(), attachRefusalMarker) {
		t.Fatalf("error = %q, want it to contain %q: verifyAttachRefused matches on that text",
			err.Error(), attachRefusalMarker)
	}
	// The whole message, so a change to the format is visible here rather
	// than in a Ptah command's output.
	if want := "SQL logic error: too many attached databases - max 0 (1)"; err.Error() != want {
		t.Errorf("error = %q, want %q", err.Error(), want)
	}

	if err := RestrictSession(ctx, nil); err == nil {
		t.Error("RestrictSession(nil) must refuse rather than pretend to restrict")
	}
}

// --- errors ------------------------------------------------------------

func TestErrorMapping(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE t(v INTEGER PRIMARY KEY)")
	mustExec(t, db, "INSERT INTO t VALUES(1)")

	tests := []struct {
		name         string
		query        string
		wantMessage  string
		wantCode     int
		wantExtended int
	}{
		{
			name:         "syntax",
			query:        "SELECT FROM",
			wantMessage:  `SQL logic error: near "FROM": syntax error (1)`,
			wantCode:     1,
			wantExtended: 1,
		},
		{
			name:         "missing table",
			query:        "SELECT * FROM nope",
			wantMessage:  "SQL logic error: no such table: nope (1)",
			wantCode:     1,
			wantExtended: 1,
		},
		{
			// SQLITE_CONSTRAINT_PRIMARYKEY: the column is the primary key,
			// and the extended code says so even though the engine's message
			// calls it a UNIQUE constraint.
			name:         "constraint failure carries its extended code",
			query:        "INSERT INTO t VALUES(1)",
			wantMessage:  "constraint failed: UNIQUE constraint failed: t.v (1555)",
			wantCode:     19,
			wantExtended: 1555,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := db.Exec(test.query)
			if err == nil {
				t.Fatalf("%q succeeded", test.query)
			}
			if err.Error() != test.wantMessage {
				t.Errorf("message = %q, want %q", err.Error(), test.wantMessage)
			}
			var sqliteErr *Error
			if !errors.As(err, &sqliteErr) {
				t.Fatalf("error is %T, want an *Error", err)
			}
			if sqliteErr.Code() != test.wantCode {
				t.Errorf("code = %d, want %d", sqliteErr.Code(), test.wantCode)
			}
			if sqliteErr.ExtendedCode() != test.wantExtended {
				t.Errorf("extended code = %d, want %d", sqliteErr.ExtendedCode(), test.wantExtended)
			}
		})
	}
}

func TestErrstrMatchesTheEngine(t *testing.T) {
	// Read out of the engine Ptah links natively, modernc.org/sqlite v1.58.0,
	// by calling sqlite3_errstr for each code.
	for code, want := range map[int]string{
		0:            "not an error",
		1:            "SQL logic error",
		2:            "unknown error",
		5:            "database is locked",
		9:            "interrupted",
		19:           "constraint failed",
		2067:         "constraint failed",
		4 | (2 << 8): "abort due to ROLLBACK",
		100:          "another row available",
		101:          "no more rows available",
	} {
		if got := errstr(code); got != want {
			t.Errorf("errstr(%d) = %q, want %q", code, got, want)
		}
	}
}

// --- cancellation ------------------------------------------------------

func TestContextCancelledBeforeTheOperation(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE t(v INTEGER)")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := db.ExecContext(ctx, "INSERT INTO t VALUES(1)"); !errors.Is(err, context.Canceled) {
		t.Errorf("exec on a cancelled context = %v, want context.Canceled", err)
	}

	var count int
	if err := db.QueryRow("SELECT count(*) FROM t").Scan(&count); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if count != 0 {
		t.Errorf("the cancelled insert still ran: count = %d", count)
	}
}

// TestDeadlineStopsARunningStatement is the only cancellation that can reach
// a statement already inside the engine, and the one the host enforces from a
// progress handler.
func TestDeadlineStopsARunningStatement(t *testing.T) {
	db := newDB(t, "")
	ctx := context.Background()
	session, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("conn: %v", err)
	}
	defer session.Close()

	const runaway = `
		WITH RECURSIVE counter(x) AS (
			SELECT 1 UNION ALL SELECT x + 1 FROM counter WHERE x < 100000000
		)
		SELECT count(*) FROM counter`

	deadlineCtx, cancel := context.WithTimeout(ctx, 150*time.Millisecond)
	defer cancel()
	started := time.Now()
	var ignored int
	err = session.QueryRowContext(deadlineCtx, runaway).Scan(&ignored)
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("the runaway query finished; the deadline was not enforced")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("error = %v, want context.DeadlineExceeded", err)
	}
	if elapsed > 5*time.Second {
		t.Errorf("the deadline took %v to stop the query", elapsed)
	}

	// The expired deadline must not survive onto the next statement on the
	// same physical connection. It is a property of the database handle, so
	// leaving it armed would kill everything after it.
	var one int
	if err := session.QueryRowContext(ctx, "SELECT 1").Scan(&one); err != nil {
		t.Fatalf("the statement after an expired deadline failed: %v", err)
	}
	if one != 1 {
		t.Errorf("SELECT 1 = %d", one)
	}
}

// TestInterruptedIsRecognisable proves the SQLITE_INTERRUPT the deadline
// produces is reachable as ErrInterrupted when there is no context error to
// report instead.
func TestInterruptedIsRecognisable(t *testing.T) {
	interrupted := newSQLiteError(sqliteInterrupt, sqliteInterrupt, "interrupted")
	if !errors.Is(interrupted, ErrInterrupted) {
		t.Error("a SQLITE_INTERRUPT error does not match ErrInterrupted")
	}
	if got, want := interrupted.Error(), "interrupted (9)"; got != want {
		t.Errorf("message = %q, want %q", got, want)
	}
	constraint := newSQLiteError(19, 2067, "UNIQUE constraint failed: t.v")
	if errors.Is(constraint, ErrInterrupted) {
		t.Error("a constraint failure matched ErrInterrupted")
	}
}

// --- timestamps --------------------------------------------------------

// parseRevisionAppliedAt is migration/migrator/revisions.go's own reader,
// copied so this test measures what Ptah will do with what the driver
// returns rather than what this package hopes it will do.
func parseRevisionAppliedAt(value any) (time.Time, error) {
	switch v := value.(type) {
	case time.Time:
		return v, nil
	case []byte:
		return parseRevisionAppliedAtString(string(v))
	case string:
		return parseRevisionAppliedAtString(v)
	case nil:
		return time.Time{}, nil
	default:
		return time.Time{}, fmt.Errorf("unsupported applied_at value %T", value)
	}
}

func parseRevisionAppliedAtString(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, nil
	}
	for _, layout := range []string{
		"2006-01-02 15:04:05.999999",
		"2006-01-02 15:04:05",
		time.RFC3339Nano,
	} {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("failed to parse applied_at %q", value)
}

// TestRevisionTimestampRoundTrip runs the shape of ptah's own migration
// metadata path: the revision table's DDL, a bound time.Time for applied_at,
// and a read back into an any that goes through Ptah's parser.
//
// Getting this wrong is silent: every migration applies, and the next
// "ptah migrations status" fails with "failed to parse applied_at".
func TestRevisionTimestampRoundTrip(t *testing.T) {
	db := newDB(t, "")
	// ptahRevisionsTableDDL, for a non-SQL-Server dialect.
	mustExec(t, db, `CREATE TABLE IF NOT EXISTS schema_migrations (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TIMESTAMP NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'applied',
    applied INTEGER NOT NULL DEFAULT 1,
    total INTEGER NOT NULL DEFAULT 1,
    error TEXT NULL,
    error_stmt TEXT NULL,
    execution_time_ms BIGINT NOT NULL DEFAULT 0,
    checksum VARCHAR(64) NOT NULL DEFAULT ''
)`)

	// time.Now carries a monotonic reading, exactly as revisions.go's does.
	appliedAt := time.Now()
	mustExec(t, db,
		`INSERT INTO schema_migrations (version, description, applied_at, state, applied, total, error, error_stmt, execution_time_ms, checksum)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		int64(20240101120000), "create widgets", appliedAt, "applied", 1, 1, nil, nil, int64(12), "abc")

	var readBack any
	if err := db.QueryRow(`SELECT applied_at FROM schema_migrations WHERE version = ?`, int64(20240101120000)).
		Scan(&readBack); err != nil {
		t.Fatalf("scan applied_at: %v", err)
	}
	parsed, err := parseRevisionAppliedAt(readBack)
	if err != nil {
		t.Fatalf("Ptah cannot read back what the driver stored (%#v): %v", readBack, err)
	}
	if !parsed.Equal(appliedAt) {
		t.Errorf("applied_at = %v, want %v", parsed, appliedAt)
	}
	if parsed.Truncate(time.Nanosecond) != parsed {
		t.Error("the value read back is not a clean time")
	}
}

// TestNativeTimestampTextIsRecognised covers a database written by native
// Ptah and imported into the playground: modernc writes time.Time.String,
// which is the one layout Ptah's own fallback parser cannot read.
func TestNativeTimestampTextIsRecognised(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE schema_migrations(applied_at TIMESTAMP)")

	// Exactly what modernc's formatTime produces by default, monotonic
	// suffix included.
	const native = "2024-03-01 09:15:30.123456789 +0100 CET m=+0.004512345"
	mustExec(t, db, "INSERT INTO schema_migrations VALUES(?)", native)

	var readBack any
	if err := db.QueryRow("SELECT applied_at FROM schema_migrations").Scan(&readBack); err != nil {
		t.Fatalf("scan: %v", err)
	}
	parsed, err := parseRevisionAppliedAt(readBack)
	if err != nil {
		t.Fatalf("a natively written applied_at is unreadable: %v", err)
	}
	want := time.Date(2024, 3, 1, 9, 15, 30, 123456789, time.FixedZone("CET", 3600))
	if !parsed.Equal(want) {
		t.Errorf("applied_at = %v, want %v", parsed, want)
	}
}

// TestTextThatOnlyLooksLikeATimeStaysText is the other half of the rule: a
// column default or any other ordinary string must not be rewritten into a
// timestamp.
func TestTextThatOnlyLooksLikeATimeStaysText(t *testing.T) {
	for _, text := range []string{
		"2020-01-01",
		"2020-01-01 10:00:00",
		"2020-01-01T10:00:00Z",
		"CURRENT_TIMESTAMP",
		"'2020-01-01 10:00:00'",
		"2020-01-01 10:00:00.000 - a note about -1",
	} {
		if got := textValue(text); got != any(text) {
			t.Errorf("textValue(%q) = %#v, want the string unchanged", text, got)
		}
	}
	if _, ok := textValue("2024-03-01 09:15:30.123456789 +0100 CET").(time.Time); !ok {
		t.Error("the time.Time.String layout was not recognised")
	}
}

func TestTimeFormatParameter(t *testing.T) {
	moment := time.Date(2024, 3, 1, 9, 15, 30, 123456789, time.UTC)
	for params, want := range map[string]string{
		"":                      "2024-03-01T09:15:30.123456789Z",
		"_time_format=sqlite":   "2024-03-01 09:15:30.123456789+00:00",
		"_time_format=datetime": "2024-03-01 09:15:30",
	} {
		cfg, err := parseDSN("app.db?" + params)
		if err != nil {
			t.Fatalf("parseDSN(%q): %v", params, err)
		}
		if got := formatTime(cfg, moment); got != want {
			t.Errorf("%q wrote %q, want %q", params, got, want)
		}
	}
}

// --- connection lifetime -----------------------------------------------

// TestDatabaseOutlivesItsConnections is the contract difference from a native
// run that Ptah can observe: dbschema discards a session by returning
// driver.ErrBadConn from Raw, and on an in-memory native database that
// destroys the data. Here the host owns the database, so it does not.
func TestDatabaseOutlivesItsConnections(t *testing.T) {
	db := newDB(t, "")
	mustExec(t, db, "CREATE TABLE t(v INTEGER)")
	mustExec(t, db, "INSERT INTO t VALUES(1)")

	ctx := context.Background()
	session, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("conn: %v", err)
	}
	// dbschema.discardSQLConnection, verbatim.
	discardErr := session.Raw(func(any) error { return driver.ErrBadConn })
	if discardErr != nil && !errors.Is(discardErr, driver.ErrBadConn) {
		t.Fatalf("discard: %v", discardErr)
	}
	if err := session.Close(); err != nil && !errors.Is(err, sql.ErrConnDone) {
		t.Fatalf("close session: %v", err)
	}

	var count int
	if err := db.QueryRow("SELECT count(*) FROM t").Scan(&count); err != nil {
		t.Fatalf("after discarding the session: %v", err)
	}
	if count != 1 {
		t.Errorf("count = %d, want 1", count)
	}
}

func TestSessionResetterAndValidator(t *testing.T) {
	requireBridge(t)
	c, err := openConn("test-resetter.db")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if !c.IsValid() {
		t.Error("a fresh connection reports itself invalid")
	}
	if err := c.ResetSession(context.Background()); err != nil {
		t.Errorf("ResetSession on a live connection: %v", err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if c.IsValid() {
		t.Error("a closed connection reports itself valid")
	}
	if err := c.ResetSession(context.Background()); !errors.Is(err, driver.ErrBadConn) {
		t.Errorf("ResetSession on a closed connection = %v, want driver.ErrBadConn", err)
	}
	if err := c.Close(); err != nil {
		t.Errorf("a second Close: %v", err)
	}
}

// TestMissingBridgeIsAnError is the one path that must not panic: a host that
// forgot to install globalThis.__sqlite.
func TestBridgeErrorsDoNotPanic(t *testing.T) {
	requireBridge(t)
	// A JS error with none of Contract A's fields is a bridge bug, not a
	// SQLite failure, and must not be dressed up as one.
	err := guard("probe", func() { panic(js.Error{Value: js.Global().Get("Object").New()}) })
	if err == nil {
		t.Fatal("guard swallowed a JS error")
	}
	var sqliteErr *Error
	if errors.As(err, &sqliteErr) {
		t.Errorf("a JS error without sqliteCode became %#v", sqliteErr)
	}
	// A plain Go panic crossing the same path.
	err = guard("probe", func() { panic("boom") })
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Errorf("guard(panic) = %v", err)
	}
}

// --- the shapes Ptah actually sends ------------------------------------

// TestPragmaQueriesReturnRows covers the reads the SQLite dialect is built
// on: internal/sqlitemodule asks PRAGMA module_list, the writer asks
// PRAGMA database_list, and foreignkeysession.go asks
// PRAGMA foreign_key_check inside a transaction.
func TestPragmaQueriesReturnRows(t *testing.T) {
	db := newDB(t, "_pragma=foreign_keys%281%29")
	mustExec(t, db, `
		CREATE TABLE parent(id INTEGER PRIMARY KEY);
		CREATE TABLE child(parent INTEGER REFERENCES parent(id));
	`)

	modules := 0
	rows, err := db.Query("PRAGMA module_list")
	if err != nil {
		t.Fatalf("module_list: %v", err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan module: %v", err)
		}
		modules++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("module_list rows: %v", err)
	}
	rows.Close()
	if modules == 0 {
		t.Error("PRAGMA module_list returned nothing; sqlitemodule.Registered would classify every shadow table as a user table")
	}

	var seq int
	var name, file string
	if err := db.QueryRow("PRAGMA database_list").Scan(&seq, &name, &file); err != nil {
		t.Fatalf("database_list: %v", err)
	}
	if name != "main" {
		t.Errorf("database_list first row = %q, want main", name)
	}

	// foreign_key_check inside a transaction, over a violation created with
	// enforcement off, which is the rebuild sequence writer.go runs.
	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec("PRAGMA defer_foreign_keys = 1"); err != nil {
		t.Fatalf("defer: %v", err)
	}
	if _, err := tx.Exec("INSERT INTO child VALUES(404)"); err != nil {
		t.Fatalf("insert: %v", err)
	}
	violations := 0
	checkRows, err := tx.Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatalf("foreign_key_check: %v", err)
	}
	for checkRows.Next() {
		var child, parent sql.NullString
		var rowID, keyIndex sql.NullInt64
		if err := checkRows.Scan(&child, &rowID, &parent, &keyIndex); err != nil {
			t.Fatalf("scan violation: %v", err)
		}
		violations++
	}
	if err := checkRows.Err(); err != nil {
		t.Fatalf("foreign_key_check rows: %v", err)
	}
	checkRows.Close()
	if violations != 1 {
		t.Errorf("foreign_key_check reported %d violations, want 1", violations)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("rollback: %v", err)
	}
}

// TestBareMemoryDSN is sqlitemodule.Registered's own call, which asks the
// build a question with no DSN parameters at all.
func TestBareMemoryDSN(t *testing.T) {
	requireBridge(t)
	db, err := sql.Open(DriverName, ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	rows, err := db.Query("PRAGMA module_list")
	if err != nil {
		t.Fatalf("module_list: %v", err)
	}
	defer rows.Close()
	if !rows.Next() {
		t.Fatal("PRAGMA module_list returned no rows")
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
}

// TestPinnedSessionUnderASingleConnection is the shape dbschema puts an
// in-memory SQLite database in: SetMaxOpenConns(1) plus a session pinned for
// the unit of work.
func TestPinnedSessionUnderASingleConnection(t *testing.T) {
	db := newDB(t, "_pragma=foreign_keys%281%29")
	db.SetMaxOpenConns(1)

	ctx := context.Background()
	session, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("conn: %v", err)
	}
	defer session.Close()

	if _, err := session.ExecContext(ctx, "CREATE TABLE t(v INTEGER)"); err != nil {
		t.Fatalf("create: %v", err)
	}
	// The pragma and the transaction have to meet on the same physical
	// connection, which is the whole reason foreignkeysession.go pins one.
	if _, err := session.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		t.Fatalf("pragma off: %v", err)
	}
	var enabled int
	if err := session.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&enabled); err != nil {
		t.Fatalf("read pragma: %v", err)
	}
	if enabled != 0 {
		t.Errorf("foreign_keys = %d after turning it off", enabled)
	}
	tx, err := session.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO t VALUES(1)"); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if _, err := session.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("pragma on: %v", err)
	}
}

func TestScriptStopsAtTheFailingStatement(t *testing.T) {
	db := newDB(t, "")
	_, err := db.Exec("CREATE TABLE ok(v INTEGER); CREATE TABLE ok(v INTEGER); CREATE TABLE never(v INTEGER);")
	if err == nil {
		t.Fatal("the duplicate CREATE TABLE was accepted")
	}
	if !strings.Contains(err.Error(), "table ok already exists") {
		t.Errorf("error = %v, want the engine's duplicate-table message", err)
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM sqlite_schema WHERE name = 'never'").Scan(&count); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if count != 0 {
		t.Error("the statement after the failing one still ran")
	}
}

// TestSqliteSchemaTextSurvives reads DDL back out of sqlite_schema, which is
// where the SQLite reader gets nearly everything and where a lossy text
// crossing would show up as a wrong schema rather than as an error.
func TestSqliteSchemaTextSurvives(t *testing.T) {
	db := newDB(t, "")
	const ddl = "CREATE TABLE \"quoted \"\"name\"\"\" (\n  \"col — ünïcode\" TEXT DEFAULT 'a''b',\n  CHECK (\"col — ünïcode\" <> '')\n)"
	mustExec(t, db, ddl)

	var got string
	if err := db.QueryRow("SELECT sql FROM sqlite_schema WHERE type = 'table'").Scan(&got); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if got != ddl {
		t.Errorf("sqlite_schema.sql =\n%q\nwant\n%q", got, ddl)
	}
}
