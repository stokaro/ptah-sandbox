//go:build js

package browsersqlite

import (
	"database/sql/driver"
	"fmt"
	"strconv"
	"sync"
	"syscall/js"
)

// bridgeGlobal is the name Contract A gives the JS object this package talks
// to. The host installs it before the Go program starts.
const bridgeGlobal = "__sqlite"

// Column type tags returned by __sqlite.fetch.
const (
	tagInt   = 1
	tagFloat = 2
	tagText  = 3
	tagBlob  = 4
	tagNull  = 5
)

// bridge is globalThis.__sqlite. Every method is synchronous, and every
// method reports failure as a Go error: syscall/js signals both a thrown JS
// exception and a value it cannot represent by panicking, and neither may
// escape into a Ptah command.
type bridge struct{ value js.Value }

var (
	bridgeOnce  sync.Once
	bridgeValue bridge
	bridgeErr   error
)

// host returns the installed bridge.
//
// The lookup is cached because the host installs the object once, before Go
// starts; re-reading it per call would let a page swap engines out from under
// live handles.
func host() (bridge, error) {
	bridgeOnce.Do(func() {
		v := js.Global().Get(bridgeGlobal)
		if v.Type() != js.TypeObject {
			bridgeErr = fmt.Errorf(
				"browsersqlite: globalThis.%s is not installed: the host must install the SQLite bridge before starting Go",
				bridgeGlobal)
			return
		}
		bridgeValue = bridge{value: v}
	})
	return bridgeValue, bridgeErr
}

// guard runs fn and turns any panic into an error.
//
// syscall/js panics where a Go API would return an error: a JS exception
// thrown out of Call, a property read on undefined, a value whose type it
// cannot represent. A JS BigInt is that last case -- Contract A forbids one
// for exactly this reason -- and a bridge that returned one anyway would
// otherwise take the whole wasm module down mid-command.
func guard(what string, fn func()) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = recoveredError(what, recovered)
		}
	}()
	fn()
	return nil
}

// recoveredError converts a recovered panic into the error the caller sees.
// A JS Error carrying Contract A's sqliteCode becomes an *Error, so the
// engine's own message and result code survive the crossing.
func recoveredError(what string, recovered any) error {
	jsErr, ok := recovered.(js.Error)
	if !ok {
		return fmt.Errorf("browsersqlite: %s: %v", what, recovered)
	}
	if sqliteErr := sqliteErrorFrom(jsErr.Value); sqliteErr != nil {
		return sqliteErr
	}
	return fmt.Errorf("browsersqlite: %s: %s", what, jsError(jsErr.Value))
}

// sqliteErrorFrom reads Contract A's error fields. It returns nil for a JS
// error that carries none of them, which is a bug in the bridge rather than a
// SQLite failure and should not be dressed up as one.
func sqliteErrorFrom(value js.Value) (result *Error) {
	defer func() {
		if recover() != nil {
			result = nil
		}
	}()
	codeField := value.Get("sqliteCode")
	if codeField.Type() != js.TypeNumber {
		return nil
	}
	extended := codeField.Int()
	if extendedField := value.Get("sqliteExtended"); extendedField.Type() == js.TypeNumber {
		extended = extendedField.Int()
	}
	message := ""
	if messageField := value.Get("message"); messageField.Type() == js.TypeString {
		message = messageField.String()
	}
	return newSQLiteError(codeField.Int(), extended, message)
}

// jsError renders a JS error for a message, without trusting any field to be
// the type it should be.
func jsError(value js.Value) (text string) {
	defer func() {
		if recover() != nil {
			text = "unknown JavaScript error"
		}
	}()
	if message := value.Get("message"); message.Type() == js.TypeString {
		return message.String()
	}
	return value.String()
}

// Contract A, one Go method per JS method. The wrapping is uniform on
// purpose: every crossing is a place a panic could start.

func (b bridge) open(path string) (int, error) {
	var handle int
	err := guard("open "+path, func() { handle = b.value.Call("open", path).Int() })
	return handle, err
}

func (b bridge) close(handle int) error {
	return guard("close", func() { b.value.Call("close", handle) })
}

func (b bridge) exec(handle int, sql string) error {
	return guard("exec", func() { b.value.Call("exec", handle, sql) })
}

// prepare compiles the first statement in sql and reports what is left after
// it, so a script can be walked without a second parser on this side.
func (b bridge) prepare(handle int, sql string) (stmt int, tail string, err error) {
	err = guard("prepare", func() {
		result := b.value.Call("prepare", handle, sql)
		stmt = result.Get("stmt").Int()
		if tailValue := result.Get("tail"); tailValue.Type() == js.TypeString {
			tail = tailValue.String()
		}
	})
	return stmt, tail, err
}

func (b bridge) bindNull(stmt, index int) error {
	return guard("bindNull", func() { b.value.Call("bindNull", stmt, index) })
}

func (b bridge) bindInt(stmt, index int, value int64) error {
	// A decimal string, not a number: syscall/js cannot carry an int64 that a
	// float64 cannot hold exactly, and it panics on the BigInt that would.
	text := strconv.FormatInt(value, 10)
	return guard("bindInt", func() { b.value.Call("bindInt", stmt, index, text) })
}

func (b bridge) bindFloat(stmt, index int, value float64) error {
	return guard("bindFloat", func() { b.value.Call("bindFloat", stmt, index, value) })
}

func (b bridge) bindText(stmt, index int, value string) error {
	return guard("bindText", func() { b.value.Call("bindText", stmt, index, value) })
}

func (b bridge) bindBlob(stmt, index int, value []byte) error {
	return guard("bindBlob", func() {
		buffer := uint8Array.New(len(value))
		if len(value) > 0 {
			js.CopyBytesToJS(buffer, value)
		}
		b.value.Call("bindBlob", stmt, index, buffer)
	})
}

func (b bridge) columns(stmt int) ([]string, error) {
	var names []string
	err := guard("columns", func() {
		list := b.value.Call("columns", stmt)
		count := list.Length()
		names = make([]string, count)
		for i := range names {
			names[i] = list.Index(i).String()
		}
	})
	return names, err
}

func (b bridge) step(stmt int) (bool, error) {
	var hasRow bool
	err := guard("step", func() { hasRow = b.value.Call("step", stmt).Bool() })
	return hasRow, err
}

// fetch pulls up to maxRows rows in one crossing and decodes them into Go
// immediately, so no js.Value outlives the call. values is row-major and
// columns wide; it is reused between calls.
func (b bridge) fetch(stmt, maxRows, columns int, values []driver.Value) (rows int, done bool, out []driver.Value, err error) {
	out = values
	err = guard("fetch", func() {
		result := b.value.Call("fetch", stmt, maxRows)
		rows = result.Get("n").Int()
		done = result.Get("done").Bool()
		if rows == 0 {
			return
		}
		count := rows * columns
		if cap(out) < count {
			out = make([]driver.Value, count)
		}
		out = out[:count]
		types := result.Get("types")
		cells := result.Get("values")
		for i := 0; i < count; i++ {
			out[i] = decodeCell(types.Index(i).Int(), cells.Index(i))
		}
	})
	return rows, done, out, err
}

// decodeCell turns one Contract A cell into the driver.Value database/sql
// expects. It runs inside fetch's guard: a tag that does not match its value
// panics here and is reported as a bridge failure.
func decodeCell(tag int, value js.Value) driver.Value {
	switch tag {
	case tagNull:
		return nil
	case tagInt:
		// A JS number when Number.isSafeInteger held, a decimal string when
		// it did not. Both must land on the same int64.
		if value.Type() == js.TypeString {
			parsed, err := strconv.ParseInt(value.String(), 10, 64)
			if err != nil {
				panic(fmt.Sprintf("integer column value %q is not an int64", value.String()))
			}
			return parsed
		}
		return int64(value.Float())
	case tagFloat:
		return value.Float()
	case tagText:
		return textValue(value.String())
	case tagBlob:
		size := value.Get("length").Int()
		blob := make([]byte, size)
		if size > 0 {
			js.CopyBytesToGo(blob, value)
		}
		return blob
	default:
		panic(fmt.Sprintf("unknown column type tag %d", tag))
	}
}

func (b bridge) reset(stmt int) error {
	return guard("reset", func() { b.value.Call("reset", stmt) })
}

func (b bridge) finalize(stmt int) error {
	return guard("finalize", func() { b.value.Call("finalize", stmt) })
}

func (b bridge) changes(handle int) (int64, error) {
	var changed int64
	err := guard("changes", func() { changed = int64(b.value.Call("changes", handle).Float()) })
	return changed, err
}

func (b bridge) lastInsertRowid(handle int) (int64, error) {
	var rowid int64
	err := guard("lastInsertRowid", func() {
		text := b.value.Call("lastInsertRowid", handle).String()
		parsed, parseErr := strconv.ParseInt(text, 10, 64)
		if parseErr != nil {
			panic(fmt.Sprintf("lastInsertRowid %q is not an int64", text))
		}
		rowid = parsed
	})
	return rowid, err
}

func (b bridge) begin(handle int) error {
	return guard("begin", func() { b.value.Call("begin", handle) })
}

func (b bridge) commit(handle int) error {
	return guard("commit", func() { b.value.Call("commit", handle) })
}

func (b bridge) rollback(handle int) error {
	return guard("rollback", func() { b.value.Call("rollback", handle) })
}

func (b bridge) limitAttachedZero(handle int) error {
	return guard("limitAttachedZero", func() { b.value.Call("limitAttachedZero", handle) })
}

func (b bridge) setDeadline(handle int, epochMillis float64) error {
	return guard("setDeadline", func() { b.value.Call("setDeadline", handle, epochMillis) })
}

var uint8Array = js.Global().Get("Uint8Array")
