// Package browsersqlite implements database/sql/driver on top of the
// SQLite engine a browser host exposes as globalThis.__sqlite.
//
// It exists because modernc.org/sqlite, the driver Ptah links everywhere
// else, cannot be built for js/wasm: its transpiled C runtime needs POSIX
// subpackages of modernc.org/libc that have no js/wasm implementation. The
// engine in the browser is therefore the canonical sqlite.org WASM build,
// reached through a synchronous JS shim, and this package is the piece that
// makes it look like the driver Ptah already speaks to.
//
// The driver registers itself as "sqlite", the name
// dbschema.databaseDriverConfig hands sql.Open for the SQLite dialect.
//
// # The bridge
//
// Every call crosses into JS through globalThis.__sqlite. That object must be
// installed before the Go program starts. No value that crosses may be a JS
// BigInt: syscall/js cannot represent one and js.Value.Type panics on it, so
// int64 travels as a decimal string in both directions. Every JS call this
// package makes is wrapped so a thrown exception, or a value syscall/js
// refuses, becomes a Go error rather than a panic in Ptah's command path.
//
// # Database identity
//
// The bridge addresses databases by path, and a database outlives the handles
// opened on it. This package derives that path the way modernc derives the
// string it passes sqlite3_open_v2 -- everything before the first "?" unless
// the DSN starts with "file:" -- and then strips the "file:" scheme and the
// URI query, so one logical database has one name:
//
//	sqlite://app.db          -> "app.db"
//	sqlite:///tmp/app.db     -> "/tmp/app.db"
//	sqlite:///:memory:       -> ":memory:"
//	sqlite://dev?mode=memory -> "dev"
//
// Two consequences differ from a native run and are not bugs to fix here:
// ":memory:" names one shared database rather than a private one per
// connection, and a database is not destroyed when the last connection to it
// closes. Both follow from the bridge contract, where the host owns database
// lifetime and can drop or snapshot a database by name.
//
// # Timestamps
//
// Ptah binds a raw time.Time for the revision table's applied_at column and
// reads it back into an any (migration/migrator/revisions.go). modernc writes
// such a value with time.Time.String and recognizes it on the way back only
// because it inspects sqlite3_column_decltype. The bridge contract exposes no
// declared-type accessor, so this driver cannot reproduce that rule, and it
// must not: Ptah's own fallback string parser accepts none of the layouts
// time.Time.String can produce, so returning that text as a string would make
// every "ptah migrations status" fail after a successful apply.
//
// The rule here is therefore:
//
//   - A bound time.Time is written as TEXT in RFC 3339 with nanoseconds.
//     Ptah's fallback parser accepts that layout, and so does modernc's
//     reader, so a database written in the browser stays readable natively.
//   - A TEXT value comes back as a Go string, unchanged -- except one in the
//     exact layout time.Time.String produces, which becomes a time.Time.
//     That is the layout a natively written database contains and the only
//     one Ptah cannot parse itself, so recognizing it makes an imported
//     database readable. No other layout is guessed at, because a value like
//     "2020-01-01" is far more often a column default than a timestamp.
//
// _time_format=sqlite and _time_format=datetime select modernc's two other
// write layouts.
//
// # Cancellation
//
// Go's js/wasm runtime is single-threaded and every bridge call is
// synchronous, so while SQLite is running no goroutine can run: a context
// cancelled during a step cannot be observed until that step returns. The
// only thing that can stop a statement in flight is the wall-clock deadline
// the host enforces with sqlite3_progress_handler, so every context method
// pushes its ctx deadline through setDeadline before it starts.
//
// Cancellation with no deadline is honored between operations instead: every
// context method checks ctx.Err before it does anything, and Rows checks it
// before each fetch. A statement stopped by the deadline or by the host's
// interrupt reports SQLITE_INTERRUPT, which this package surfaces as an error
// matching ErrInterrupted.
//
// A deadline is a property of the database handle, so leaving one armed would
// kill every later statement on that connection. Each operation asserts the
// deadline it wants, including "none", which is what keeps an expired
// deadline from poisoning the statement after it.
//
// # Where it differs from modernc.org/sqlite
//
// Everything above, plus four smaller things, all of them forced by what the
// bridge contract exposes:
//
//   - A named parameter is refused rather than bound. Matching one needs
//     sqlite3_bind_parameter_name, which the contract has not got. Ptah's
//     only sql.Named call site is SQL Server.
//   - A statement with more placeholders than arguments leaves the extra ones
//     NULL, where modernc reports a missing argument. Telling the two apart
//     needs sqlite3_bind_parameter_count on every execution.
//   - mode=ro becomes PRAGMA query_only, because the bridge opens a database
//     by name and has no read-only flag. Refusing writes is what the
//     parameter asks for; dropping it would open a writable database instead.
//   - vfs=, cache= and the other SQLite URI parameters are read past. The
//     bridge chooses the storage, and there is one cache per database
//     whatever the URI says.
//
// _timezone is refused outright: resolving one needs the zoneinfo database,
// which a js/wasm binary does not carry, and reading every timestamp in UTC
// while claiming otherwise is worse than saying no.
//
// Every file in this package is constrained to js. On any other platform the
// package builds to nothing, so "go build ./..." and the linters still see a
// package here rather than one whose files are all excluded.
package browsersqlite
