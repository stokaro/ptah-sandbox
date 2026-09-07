//go:build js

package browsersqlite

import (
	"database/sql"
	"database/sql/driver"
	"sync"
)

// DriverName is the database/sql name Ptah opens SQLite under. See
// dbschema.databaseDriverConfig.
const DriverName = "sqlite"

var registerOnce sync.Once

// RegisterDriver registers the browser SQLite driver under DriverName.
//
// It is idempotent, and the package init calls it, so a blank import is
// enough. It stays exported for a host that wants the registration to be a
// statement it can read rather than an import side effect.
func RegisterDriver() {
	registerOnce.Do(func() { sql.Register(DriverName, Driver{}) })
}

func init() { RegisterDriver() }

// Driver is the database/sql driver over globalThis.__sqlite.
//
// It deliberately does not implement driver.DriverContext: Ptah only ever
// calls sql.Open, and a Connector would add a second path to keep correct for
// no caller.
type Driver struct{}

var _ driver.Driver = Driver{}

// Open opens one connection. name is the DSN convertSQLiteURL produced, not
// the sqlite:// URL the operator typed.
func (Driver) Open(name string) (driver.Conn, error) {
	return openConn(name)
}
