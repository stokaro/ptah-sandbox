//go:build js

package browsersqlite

import "database/sql/driver"

// result carries the counters read straight after a statement ran.
//
// Both are read eagerly, because the next statement on the same connection
// overwrites them. RowsAffected is load-bearing: migration/migrator/tags.go
// turns a zero count into ErrMigrationTagNotFound, so a driver that guessed
// here would report a tag as missing after deleting it.
type result struct {
	rowsAffected int64
	lastInsertID int64
}

var _ driver.Result = result{}

func (r result) RowsAffected() (int64, error) { return r.rowsAffected, nil }

func (r result) LastInsertId() (int64, error) { return r.lastInsertID, nil }
