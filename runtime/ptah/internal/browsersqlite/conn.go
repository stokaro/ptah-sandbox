//go:build js

package browsersqlite

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"time"
)

// conn is one connection: one bridge handle on one logical database, plus the
// per-connection state Ptah depends on being per-connection.
//
// A handle is never shared between conns. PRAGMA foreign_keys and
// SQLITE_LIMIT_ATTACHED are properties of a database handle, and Ptah relies
// on both being scoped to the session it pinned -- see
// internal/dbschema/sqlite/foreignkeysession.go and restrict.go. Multiplexing
// one handle would make a restricted session protect nothing while reporting
// success.
type conn struct {
	bridge bridge
	cfg    config
	handle int
	closed bool
	// deadline is the epoch-milliseconds value currently armed on the handle.
	// It is tracked so a context without one costs no crossing after the
	// first, and so an expired deadline can never survive into the next
	// statement.
	deadline float64
	// inTx marks an open transaction, so BeginTx can refuse a second one
	// rather than letting SQLite report a nested BEGIN.
	inTx bool
}

var (
	_ driver.Conn               = (*conn)(nil)
	_ driver.ConnPrepareContext = (*conn)(nil)
	_ driver.ExecerContext      = (*conn)(nil)
	_ driver.QueryerContext     = (*conn)(nil)
	_ driver.Pinger             = (*conn)(nil)
	_ driver.ConnBeginTx        = (*conn)(nil)
	_ driver.SessionResetter    = (*conn)(nil)
	_ driver.Validator          = (*conn)(nil)
)

func openConn(dsn string) (*conn, error) {
	cfg, err := parseDSN(dsn)
	if err != nil {
		return nil, err
	}
	b, err := host()
	if err != nil {
		return nil, err
	}
	handle, err := b.open(cfg.path)
	if err != nil {
		return nil, fmt.Errorf("browsersqlite: open %q: %w", cfg.path, err)
	}
	c := &conn{bridge: b, cfg: cfg, handle: handle}
	for _, statement := range cfg.setup {
		if err := b.exec(handle, statement); err != nil {
			closeErr := c.Close()
			return nil, errors.Join(fmt.Errorf("browsersqlite: %s: %w", statement, err), closeErr)
		}
	}
	return c, nil
}

func (c *conn) Close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	// Only this handle. The database outlives it: the host owns that
	// lifetime, and database/sql closes connections whenever it feels like
	// it, including through the driver.ErrBadConn discard Ptah uses to retire
	// a session it no longer trusts.
	return c.bridge.close(c.handle)
}

// ResetSession is called before a pooled connection is reused.
func (c *conn) ResetSession(context.Context) error {
	if !c.IsValid() {
		return driver.ErrBadConn
	}
	return nil
}

// IsValid is called before a connection goes back into the pool.
//
// An interrupted statement does not invalidate the connection. It cannot: the
// interrupt flag does not carry into a statement started after it, and the
// deadline that may have caused it is re-asserted per operation.
func (c *conn) IsValid() bool { return !c.closed && c.handle != 0 }

func (c *conn) Ping(ctx context.Context) error {
	if err := c.enterOperation(ctx); err != nil {
		return err
	}
	// A statement the engine has to compile and run, so a handle that is open
	// but unusable is reported here rather than at the first real query.
	return contextError(ctx, c.bridge.exec(c.handle, "select 1"))
}

// enterOperation is the preamble every context method shares: refuse work on
// a closed connection, observe a context that is already done, and arm the
// deadline the host's progress handler enforces.
//
// Every context method calls it first; nothing here touches the engine until
// it has.
func (c *conn) enterOperation(ctx context.Context) error {
	if !c.IsValid() {
		return driver.ErrBadConn
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return c.applyDeadline(ctx)
}

// applyDeadline pushes the context deadline down to the engine.
//
// This is the only cancellation that can stop a statement already running:
// Go's js/wasm runtime is single-threaded, so while SQLite is inside a step no
// goroutine of ours can run to interrupt it. The host enforces the deadline
// from a progress handler, inside the engine.
//
// Asserting it per operation, including asserting that there is none, is what
// keeps an expired deadline from killing every statement after the one it was
// meant for.
func (c *conn) applyDeadline(ctx context.Context) error {
	wanted := float64(0)
	if deadline, ok := ctx.Deadline(); ok {
		// Epoch milliseconds as a plain number. Nanoseconds would not survive
		// the crossing: a float64 cannot hold them exactly, and the BigInt
		// that could is the one thing Contract A forbids.
		wanted = float64(deadline.UnixMilli())
	}
	if wanted == c.deadline {
		return nil
	}
	if err := c.bridge.setDeadline(c.handle, wanted); err != nil {
		return err
	}
	c.deadline = wanted
	return nil
}

// contextError turns a failure into the context's error when the context is
// what ended the operation, which is what modernc reports for the same case.
//
// The clock is consulted as well as ctx.Err, and it has to be: a deadline
// context sets its error from a timer goroutine, and no goroutine of ours can
// have run while the engine was inside the synchronous JS call that just
// returned. Without this, a statement the host's progress handler stopped on
// the deadline would report "interrupted" instead of the deadline that caused
// it. Only an interrupt is reinterpreted -- a syntax error that happened to
// arrive late is still a syntax error.
func contextError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	if errors.Is(err, ErrInterrupted) {
		if deadline, ok := ctx.Deadline(); ok && !time.Now().Add(deadlineClockSkew).Before(deadline) {
			return context.DeadlineExceeded
		}
	}
	return err
}

// deadlineClockSkew is how far short of its deadline a statement the host
// stopped can look from here.
//
// The deadline crosses as epoch milliseconds and the host compares it against
// Date.now, which counts whole milliseconds. Go measures the elapsed time
// with performance.now, which does not, and its wall clock is Date.now: the
// instant Go read as the start of the timeout was somewhere inside that
// millisecond, so the engine can stop a statement up to one millisecond
// before Go's own clock says the deadline arrived.
const deadlineClockSkew = time.Millisecond

func (c *conn) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}

func (c *conn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	if err := c.enterOperation(ctx); err != nil {
		return nil, err
	}
	return newStmt(ctx, c, query)
}

// ExecContext runs a statement, or a script, that returns no rows.
//
// With no arguments the whole string goes across in one call to the bridge's
// multi-statement exec, which is what makes a DDL batch or a PRAGMA cost one
// crossing instead of four per statement. With arguments the script has to be
// walked here, because each statement has to be bound separately.
func (c *conn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if err := c.enterOperation(ctx); err != nil {
		return nil, err
	}
	if len(args) == 0 {
		if err := c.bridge.exec(c.handle, query); err != nil {
			return nil, contextError(ctx, err)
		}
		return c.result()
	}
	statement, err := newStmt(ctx, c, query)
	if err != nil {
		return nil, contextError(ctx, err)
	}
	defer statement.Close()
	return statement.ExecContext(ctx, args)
}

func (c *conn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if err := c.enterOperation(ctx); err != nil {
		return nil, err
	}
	statement, err := newStmt(ctx, c, query)
	if err != nil {
		return nil, contextError(ctx, err)
	}
	rows, err := statement.queryContext(ctx, args, true)
	if err != nil {
		return nil, errors.Join(err, statement.Close())
	}
	return rows, nil
}

// result reads the counters the last statement left on the handle. Both are
// read eagerly, the way modernc's newResult does, because the next statement
// overwrites them.
func (c *conn) result() (driver.Result, error) {
	affected, err := c.bridge.changes(c.handle)
	if err != nil {
		return nil, err
	}
	rowid, err := c.bridge.lastInsertRowid(c.handle)
	if err != nil {
		return nil, err
	}
	return result{rowsAffected: affected, lastInsertID: rowid}, nil
}

func (c *conn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *conn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	if err := c.enterOperation(ctx); err != nil {
		return nil, err
	}
	// SQLite gives one isolation level, and it is serializable. Refusing the
	// others is better than modernc's silent acceptance: a caller that asked
	// for read-committed would otherwise be told it got it.
	switch opts.Isolation {
	case driver.IsolationLevel(sql.LevelDefault), driver.IsolationLevel(sql.LevelSerializable):
	default:
		return nil, fmt.Errorf("browsersqlite: isolation level %d is not supported by SQLite", opts.Isolation)
	}
	if c.inTx {
		return nil, errors.New("browsersqlite: a transaction is already open on this connection")
	}

	var err error
	switch {
	case opts.ReadOnly || c.cfg.beginMode == "":
		err = c.bridge.begin(c.handle)
	default:
		err = c.bridge.exec(c.handle, "begin "+c.cfg.beginMode)
	}
	if err != nil {
		return nil, contextError(ctx, err)
	}
	c.inTx = true
	return &tx{c: c}, nil
}
