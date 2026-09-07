//go:build js

package main

import "ptah.run/internal/browsersqlite"

// installSQLite puts the browser SQLite driver in the database/sql registry
// under the name every SQLite path in Ptah resolves.
//
// On every other platform modernc.org/sqlite registers itself from an init
// function that internal/dbschema/sqlite and internal/sqlitemodule import for
// exactly that side effect. It does not build for js/wasm -- it is a
// transpiled C library full of syscalls this platform does not have -- so on a
// js build those packages import the browser driver instead and this call is
// what makes it available.
//
// RestrictSession, the js equivalent of the
// sqlitedriver.Limit(conn, SQLITE_LIMIT_ATTACHED, 0) that
// internal/dbschema/sqlite/restrict.go applies to every pinned session, lives
// in the same package and is reached from there directly on js builds. If the
// upstream patch instead keeps a seam package with a setter, the installation
// belongs on the next line and nowhere else:
//
//	browserdb.SetSessionRestrictor(browsersqlite.RestrictSession)
func installSQLite() {
	browsersqlite.RegisterDriver()
}
