//go:build js

package browsersqlite

import (
	"context"
	"database/sql/driver"
	"errors"
	"io"
)

// fetchBatchRows is how many rows one crossing into JS brings back.
//
// A fetch costs about five crossings of fixed overhead -- the call, three
// property reads, and the array lookups that follow -- plus two per cell. At
// 256 rows the fixed part is under two percent of the crossing cost, so
// raising it further buys almost nothing, while lowering it toward one row
// per call is the mistake this batching exists to avoid.
//
// The ceiling matters as much as the floor. The bridge materializes a
// JavaScript array of n*columns values before Go sees any of them, so the
// batch is also the memory a runaway "select * from big_table" can commit
// before the first row is read, and it is how often a cancelled context gets
// looked at. 256 rows of a wide schema row is tens of kilobytes.
//
// Ptah's own SQLite reads are far smaller than this: a sqlite_schema scan and
// the per-table PRAGMA batches are hundreds of rows of a handful of columns,
// so almost every query Ptah runs finishes in one or two fetches.
const fetchBatchRows = 256

// rows is one result set, pulled in batches.
type rows struct {
	c      *conn
	ctx    context.Context
	handle int
	// ownStmt says Close must finalize the statement. It is false for a
	// prepared statement, which is reset instead so it can run again.
	ownStmt bool

	columns []string
	// buffer holds the current batch row-major, columns wide. It is reused
	// across fetches.
	buffer []driver.Value
	rows   int
	next   int
	// exhausted records that the engine has reported the statement done, so
	// no further fetch is needed or allowed.
	exhausted bool
	closed    bool
}

var _ driver.Rows = (*rows)(nil)

// newRows binds the arguments, reads the column names and pulls the first
// batch.
//
// The first batch is read here rather than on the first Next because that is
// where the statement actually runs: a query that fails does so at
// QueryContext, which is where the caller is looking, and it is what modernc
// does too -- its query path steps once before returning.
func newRows(ctx context.Context, c *conn, handle int, args []driver.NamedValue, stopAtExtra, ownStmt bool) (*rows, error) {
	if err := bindArgs(c.bridge, c.cfg, handle, args, stopAtExtra); err != nil {
		if !ownStmt {
			err = errors.Join(err, c.bridge.reset(handle))
		}
		return nil, err
	}
	columns, err := c.bridge.columns(handle)
	if err != nil {
		return nil, err
	}
	r := &rows{c: c, ctx: ctx, handle: handle, ownStmt: ownStmt, columns: columns}
	if err := r.fetch(); err != nil {
		// The statement is left mid-execution; reset it so the handle is
		// usable, then report the failure the caller cares about.
		_ = c.bridge.reset(handle)
		return nil, err
	}
	return r, nil
}

func (r *rows) Columns() []string { return r.columns }

func (r *rows) Close() error {
	if r.closed {
		return nil
	}
	r.closed = true
	if r.handle == 0 {
		return nil
	}
	handle := r.handle
	r.handle = 0
	if r.ownStmt {
		return r.c.bridge.finalize(handle)
	}
	// A prepared statement goes back to its caller runnable. Contract A has
	// no sqlite3_clear_bindings, which costs nothing here: the SQL is fixed,
	// so the next execution rebinds every parameter it has.
	return r.c.bridge.reset(handle)
}

func (r *rows) Next(dest []driver.Value) error {
	if r.closed {
		return errors.New("browsersqlite: rows are closed")
	}
	if r.next >= r.rows {
		if r.exhausted {
			return io.EOF
		}
		// Between batches is where a cancelled context becomes visible. It
		// cannot be seen inside one: the fetch is a synchronous call into JS,
		// and Go's js/wasm runtime runs no goroutine while it is in there.
		if err := r.ctx.Err(); err != nil {
			return err
		}
		if err := r.fetch(); err != nil {
			return err
		}
		if r.rows == 0 {
			return io.EOF
		}
	}
	offset := r.next * len(r.columns)
	copy(dest, r.buffer[offset:offset+len(r.columns)])
	r.next++
	return nil
}

func (r *rows) fetch() error {
	count, done, buffer, err := r.c.bridge.fetch(r.handle, fetchBatchRows, len(r.columns), r.buffer)
	if err != nil {
		return contextError(r.ctx, err)
	}
	r.buffer, r.rows, r.next, r.exhausted = buffer, count, 0, done
	return nil
}
