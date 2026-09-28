//go:build js

// Package browserpostgres connects database/sql to real PostgreSQL in PGlite.
// Commands run in goroutines, so waiting on a Promise yields to JavaScript.
// Never call this driver directly inside a syscall/js callback: that callback
// must return before the event loop can settle the Promise.
package browserpostgres

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"syscall/js"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func init() { sql.Register("browser-postgres", Driver{}) }

type Driver struct{}
type conn struct {
	handle int
	closed bool
}
type stmt struct {
	c     *conn
	query string
}
type tx struct{ c *conn }
type rows struct {
	fields []field
	data   [][]*string
	at     int
}
type field struct {
	Name       string
	DataTypeID int
}
type response struct {
	Fields       []field
	Rows         [][]*string
	AffectedRows int64
}
type result int64

func (Driver) Open(dsn string) (driver.Conn, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, err
	}
	// A browser URL is a local address, never an alias for an external server.
	if u.Scheme != "postgres" || u.Host != "pglite" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "/app" {
		return nil, fmt.Errorf("browser PostgreSQL only accepts postgres://pglite/app")
	}
	v, err := call("open")
	if err != nil {
		return nil, err
	}
	return &conn{handle: v.Int()}, nil
}

// call owns its callbacks until settlement, including after cancellation.
// PGlite cannot interrupt synchronous wasm SQL; wait for settlement before
// returning a canceled context so a transaction cannot be reused mid-query.
func call(method string, args ...any) (value js.Value, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("browserpostgres %s: %v", method, p)
		}
	}()
	host := js.Global().Get("__postgres")
	if host.Type() != js.TypeObject {
		return js.Undefined(), errors.New("PostgreSQL is not loaded; select PostgreSQL in the database picker")
	}
	type answer struct {
		value js.Value
		err   error
	}
	done := make(chan answer, 1)
	ok := js.FuncOf(func(_ js.Value, a []js.Value) any {
		value := js.Undefined()
		if len(a) != 0 {
			value = a[0]
		}
		done <- answer{value: value}
		return nil
	})
	bad := js.FuncOf(func(_ js.Value, a []js.Value) any {
		err := errors.New("PostgreSQL Promise rejected without a reason")
		if len(a) != 0 {
			err = promiseError(a[0])
		}
		done <- answer{err: err}
		return nil
	})
	defer ok.Release()
	defer bad.Release()
	host.Call(method, args...).Call("then", ok, bad)
	a := <-done
	return a.value, a.err
}

// The host may reject with an Error, a string, or even null. None may panic
// inside a syscall/js callback, which would terminate the whole runtime.
func promiseError(value js.Value) (err error) {
	err = errors.New("PostgreSQL Promise rejected")
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("PostgreSQL Promise rejected: %v", p)
		}
	}()
	if value.Type() != js.TypeObject {
		return fmt.Errorf("PostgreSQL Promise rejected: %s", value.String())
	}
	message := value.Get("message").String()
	if code := value.Get("code"); code.Type() == js.TypeString {
		return &pgconn.PgError{Code: code.String(), Message: message}
	}
	return errors.New(message)
}

func (c *conn) Close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	_, err := call("close", c.handle)
	return err
}
func (c *conn) Prepare(q string) (driver.Stmt, error) { return &stmt{c: c, query: q}, nil }
func (c *conn) Begin() (driver.Tx, error)             { return c.BeginTx(context.Background(), driver.TxOptions{}) }
func (c *conn) BeginTx(ctx context.Context, o driver.TxOptions) (driver.Tx, error) {
	q := "BEGIN"
	switch sql.IsolationLevel(o.Isolation) {
	case sql.LevelDefault:
	case sql.LevelReadUncommitted:
		q += " ISOLATION LEVEL READ UNCOMMITTED"
	case sql.LevelReadCommitted:
		q += " ISOLATION LEVEL READ COMMITTED"
	case sql.LevelRepeatableRead:
		q += " ISOLATION LEVEL REPEATABLE READ"
	case sql.LevelSerializable:
		q += " ISOLATION LEVEL SERIALIZABLE"
	default:
		return nil, errors.New("unsupported PostgreSQL isolation level")
	}
	if o.ReadOnly {
		q += " READ ONLY"
	}
	_, err := c.ExecContext(ctx, q, nil)
	if err != nil {
		return nil, err
	}
	return &tx{c: c}, nil
}
func (c *conn) Ping(ctx context.Context) error {
	_, err := c.ExecContext(ctx, "SELECT 1", nil)
	return err
}
func (c *conn) query(ctx context.Context, q string, args []driver.NamedValue) (response, error) {
	var out response
	if err := ctx.Err(); err != nil {
		return out, err
	}
	params := make([]any, len(args))
	for i, a := range args {
		switch v := a.Value.(type) {
		case int64:
			params[i] = strconv.FormatInt(v, 10)
		case []byte:
			params[i] = "\\x" + hex.EncodeToString(v)
		case time.Time:
			params[i] = v.Format(time.RFC3339Nano)
		default:
			params[i] = v
		}
	}
	encoded, err := json.Marshal(params)
	if err != nil {
		return out, err
	}
	value, err := call("query", c.handle, q, string(encoded))
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal([]byte(value.String()), &out); err != nil {
		return out, err
	}
	return out, ctx.Err()
}
func (c *conn) ExecContext(ctx context.Context, q string, args []driver.NamedValue) (driver.Result, error) {
	r, e := c.query(ctx, q, args)
	return result(r.AffectedRows), e
}
func (c *conn) QueryContext(ctx context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	r, e := c.query(ctx, q, args)
	if e != nil {
		return nil, e
	}
	return &rows{fields: r.Fields, data: r.Rows}, nil
}
func (t *tx) Commit() error { _, e := t.c.ExecContext(context.Background(), "COMMIT", nil); return e }
func (t *tx) Rollback() error {
	_, e := t.c.ExecContext(context.Background(), "ROLLBACK", nil)
	return e
}
func (s *stmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	return s.c.ExecContext(ctx, s.query, args)
}
func (s *stmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	return s.c.QueryContext(ctx, s.query, args)
}
func (s *stmt) Close() error  { return nil }
func (s *stmt) NumInput() int { return -1 }
func named(v []driver.Value) []driver.NamedValue {
	a := make([]driver.NamedValue, len(v))
	for i, x := range v {
		a[i] = driver.NamedValue{Ordinal: i + 1, Value: x}
	}
	return a
}
func (s *stmt) Exec(v []driver.Value) (driver.Result, error) {
	return s.c.ExecContext(context.Background(), s.query, named(v))
}
func (s *stmt) Query(v []driver.Value) (driver.Rows, error) {
	return s.c.QueryContext(context.Background(), s.query, named(v))
}
func (r result) RowsAffected() (int64, error) { return int64(r), nil }
func (r result) LastInsertId() (int64, error) {
	return 0, errors.New("PostgreSQL requires INSERT ... RETURNING")
}
func (r *rows) Columns() []string {
	names := make([]string, len(r.fields))
	for i, f := range r.fields {
		names[i] = f.Name
	}
	return names
}
func (r *rows) Close() error { r.data = nil; return nil }
func (r *rows) Next(dest []driver.Value) error {
	if r.at >= len(r.data) {
		return io.EOF
	}
	for i, p := range r.data[r.at] {
		if p == nil {
			dest[i] = nil
			continue
		}
		var err error
		switch r.fields[i].DataTypeID {
		case 16:
			dest[i], err = strconv.ParseBool(*p)
		case 20, 21, 23, 26:
			dest[i], err = strconv.ParseInt(*p, 10, 64)
		case 700, 701:
			dest[i], err = strconv.ParseFloat(*p, 64)
		case 17:
			dest[i], err = hex.DecodeString((*p)[2:])
		case 1082, 1114, 1184:
			for _, layout := range []string{"2006-01-02", "2006-01-02 15:04:05.999999999Z07:00", "2006-01-02 15:04:05.999999999Z07", "2006-01-02 15:04:05.999999999"} {
				dest[i], err = time.Parse(layout, *p)
				if err == nil {
					break
				}
			}
		default:
			dest[i] = *p
		}
		if err != nil {
			return err
		}
	}
	r.at++
	return nil
}
