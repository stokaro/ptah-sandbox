//go:build js

package main

import (
	"ptah.run/internal/browsersqlite"
	"ptah.run/internal/dbschema/sqlite"
)

// installSQLite gives this build the two things a js/wasm Ptah has no engine
// for until a host supplies one.
//
// Everywhere else modernc.org/sqlite answers both. It registers itself under
// the name every SQLite path resolves, from an init function that
// internal/dbschema/sqlite and internal/sqlitemodule import for exactly that
// side effect; and it exposes the limit that
// internal/dbschema/sqlite/restrict.go sets on every pinned session. It does
// not build for js/wasm, so a js build links no driver at all and
// RestrictSession refuses until a limiter is installed -- deliberately, because
// that restriction is what stops SQL on an untrusted session from reaching
// another database file, and a build that cannot establish it must say so
// rather than run unrestricted.
//
// Both halves are supplied here rather than by a blank import, because which
// engine is present is a property of this host and not of the platform. Call
// it before anything opens a connection.
func installSQLite() {
	browsersqlite.RegisterDriver()
	sqlite.SetAttachedDatabaseLimiter(browsersqlite.RestrictSession)
}
