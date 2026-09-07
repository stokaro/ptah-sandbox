//go:build js

package browsersqlite

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
)

// stmt is one prepared statement, or one script.
//
// A single statement is compiled once and reused, which is what a prepared
// statement is for. A script -- more than one statement in the string -- is
// held as text and re-walked on each execution, because only the first of its
// statements can be compiled ahead of time. modernc splits the same two ways.
type stmt struct {
	c   *conn
	sql string
	// handle is the compiled statement for the single-statement case, and
	// zero for a script or for a string that compiled to nothing.
	handle int
	closed bool
}

var (
	_ driver.Stmt             = (*stmt)(nil)
	_ driver.StmtExecContext  = (*stmt)(nil)
	_ driver.StmtQueryContext = (*stmt)(nil)
)

func newStmt(ctx context.Context, c *conn, query string) (*stmt, error) {
	s := &stmt{c: c, sql: query}
	handle, tail, err := c.bridge.prepare(c.handle, query)
	if err != nil {
		return nil, contextError(ctx, err)
	}
	if handle == 0 {
		// A comment or whitespace. Nothing to run and nothing to keep.
		return s, nil
	}
	if strings.TrimSpace(tail) == "" {
		s.handle = handle
		return s, nil
	}
	// A script. Give the compiled first statement back; the execution paths
	// re-prepare each statement in turn so every one of them gets bound.
	if err := c.bridge.finalize(handle); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *stmt) Close() error {
	if s.closed {
		return nil
	}
	s.closed = true
	if s.handle == 0 {
		return nil
	}
	handle := s.handle
	s.handle = 0
	return s.c.bridge.finalize(handle)
}

// NumInput reports that the driver does not know the placeholder count.
//
// It is not knowable ahead of the arguments: Ptah builds IN-lists whose
// placeholder count comes from the data (internal/dbschema/sqlite/reader.go
// excludeTablesFilter), so any number this returned would be wrong for some
// call and database/sql would reject a correct query before it ran.
func (s *stmt) NumInput() int { return -1 }

func (s *stmt) Exec(args []driver.Value) (driver.Result, error) {
	return s.ExecContext(context.Background(), ordinalValues(args))
}

func (s *stmt) Query(args []driver.Value) (driver.Rows, error) {
	return s.QueryContext(context.Background(), ordinalValues(args))
}

func ordinalValues(args []driver.Value) []driver.NamedValue {
	named := make([]driver.NamedValue, len(args))
	for i, arg := range args {
		named[i] = driver.NamedValue{Ordinal: i + 1, Value: arg}
	}
	return named
}

func (s *stmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	if s.closed {
		return nil, errors.New("browsersqlite: statement is closed")
	}
	if err := s.c.enterOperation(ctx); err != nil {
		return nil, err
	}
	if s.handle != 0 {
		if err := s.execOne(ctx, s.handle, args, false); err != nil {
			return nil, err
		}
		return s.c.result()
	}
	return s.execScript(ctx, args)
}

// execOne binds, runs a compiled statement to completion and leaves it ready
// for the next execution.
//
// Running to completion matters even for a statement that returns rows:
// sqlite3_exec has the same semantics, DML with RETURNING only takes effect
// once every row has been stepped over, and a SELECT handed to Exec has to be
// drained rather than left half-run on a reusable handle.
func (s *stmt) execOne(ctx context.Context, handle int, args []driver.NamedValue, stopAtExtra bool) (err error) {
	defer func() {
		// Reset whatever happened. A statement left mid-execution cannot be
		// re-prepared or re-bound, and on the reusable handle that would
		// break every later use of it.
		if resetErr := s.c.bridge.reset(handle); err == nil && resetErr != nil {
			err = resetErr
		}
	}()
	if err := bindArgs(s.c.bridge, s.c.cfg, handle, args, stopAtExtra); err != nil {
		return err
	}
	for {
		hasRow, err := s.c.bridge.step(handle)
		if err != nil {
			return contextError(ctx, err)
		}
		if !hasRow {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}
}

// execScript walks a multi-statement string, binding the same arguments to
// each statement that takes any. modernc binds a script's arguments the same
// way.
func (s *stmt) execScript(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	remaining := s.sql
	ran := false
	for strings.TrimSpace(remaining) != "" {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		handle, tail, err := s.c.bridge.prepare(s.c.handle, remaining)
		if err != nil {
			return nil, contextError(ctx, err)
		}
		remaining = tail
		if handle == 0 {
			continue
		}
		execErr := s.execOne(ctx, handle, args, true)
		finalizeErr := s.c.bridge.finalize(handle)
		if execErr != nil {
			return nil, execErr
		}
		if finalizeErr != nil {
			return nil, finalizeErr
		}
		ran = true
	}
	if !ran {
		// Nothing but comments. There is no statement to have changed rows,
		// and reading the handle's counters would report the previous
		// statement's.
		return result{}, nil
	}
	return s.c.result()
}

func (s *stmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	return s.queryContext(ctx, args, false)
}

// queryContext runs the statement for its rows.
//
// ownStmt says the returned Rows owns the statement handle and must finalize
// it on Close. That is the Conn.QueryContext path, where the statement exists
// only for this query; the prepared-statement path resets the handle instead,
// so the statement can be run again.
func (s *stmt) queryContext(ctx context.Context, args []driver.NamedValue, ownStmt bool) (driver.Rows, error) {
	if s.closed {
		return nil, errors.New("browsersqlite: statement is closed")
	}
	if err := s.c.enterOperation(ctx); err != nil {
		return nil, err
	}
	if s.handle != 0 {
		opened, err := newRows(ctx, s.c, s.handle, args, false, ownStmt)
		if err != nil {
			return nil, err
		}
		if ownStmt {
			// The Rows own the handle now. Forget it here so a later
			// stmt.Close cannot finalize it a second time.
			s.handle, s.closed = 0, true
		}
		return opened, nil
	}
	return s.queryScript(ctx, args)
}

// queryScript runs every statement of a script and returns the rows of the
// last one.
//
// The statements before it are run to completion, which is what makes their
// effects land. modernc instead returns the last statement that produced any
// rows and leaves it half-stepped; the difference only shows for a script
// whose last statement returns nothing after an earlier one did, and nothing
// in Ptah sends a script to Query at all -- core/sqlutil splits scripts
// before they reach the driver.
func (s *stmt) queryScript(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	remaining := s.sql
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		handle, tail, err := s.c.bridge.prepare(s.c.handle, remaining)
		if err != nil {
			return nil, contextError(ctx, err)
		}
		remaining = tail
		if handle == 0 {
			if strings.TrimSpace(remaining) == "" {
				// Only comments. An empty result, not a nil Rows.
				return &rows{c: s.c, exhausted: true}, nil
			}
			continue
		}
		if strings.TrimSpace(remaining) == "" {
			opened, err := newRows(ctx, s.c, handle, args, true, true)
			if err != nil {
				_ = s.c.bridge.finalize(handle)
				return nil, err
			}
			return opened, nil
		}
		execErr := s.execOne(ctx, handle, args, true)
		finalizeErr := s.c.bridge.finalize(handle)
		if execErr != nil {
			return nil, execErr
		}
		if finalizeErr != nil {
			return nil, finalizeErr
		}
	}
}
