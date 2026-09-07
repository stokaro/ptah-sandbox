//go:build js

package browsersqlite

import "database/sql/driver"

// tx is one transaction on one connection.
type tx struct {
	c    *conn
	done bool
}

var _ driver.Tx = (*tx)(nil)

func (t *tx) Commit() error {
	if t.done {
		return driver.ErrBadConn
	}
	t.done = true
	t.c.inTx = false
	err := t.c.bridge.commit(t.c.handle)
	if err != nil {
		// A COMMIT that failed may leave the transaction open, and
		// database/sql will hand this connection to somebody else believing
		// it is clean. Contract A exposes no autocommit flag to check, so
		// roll back unconditionally and ignore the "no transaction is
		// active" this produces when the commit had in fact ended it. The
		// commit's error is the one the caller needs.
		_ = t.c.bridge.rollback(t.c.handle)
	}
	return err
}

func (t *tx) Rollback() error {
	if t.done {
		return driver.ErrBadConn
	}
	t.done = true
	t.c.inTx = false
	return t.c.bridge.rollback(t.c.handle)
}
