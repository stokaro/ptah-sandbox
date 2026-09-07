//go:build js

package browsersqlite

import (
	"errors"
	"fmt"
)

// SQLite primary result codes this package names.
const (
	sqliteOK        = 0
	sqliteError     = 1
	sqliteBusy      = 5
	sqliteInterrupt = 9
	sqliteRow       = 100
	sqliteDone      = 101
)

// ErrInterrupted matches an operation SQLite stopped before it finished --
// the host's interrupt, or the wall-clock deadline its progress handler
// enforces. Callers that need to tell "the query was stopped" from "the query
// was wrong" test for it with errors.Is.
var ErrInterrupted = errors.New("sqlite: interrupted")

// Error is a SQLite failure that crossed the bridge.
//
// Error is formatted exactly the way modernc.org/sqlite formats one, because
// Ptah reads these strings: internal/dbschema/sqlite/restrict.go requires the
// engine's own "too many attached databases" text to appear in the error of a
// refused ATTACH, and every SQLite failure a Ptah command prints is this
// string. Keeping the shape means a browser run and a native run report the
// same fault in the same words.
type Error struct {
	msg      string
	code     int
	extended int
}

// Code returns the primary SQLite result code.
func (e *Error) Code() int { return e.code }

// ExtendedCode returns the extended SQLite result code.
func (e *Error) ExtendedCode() int { return e.extended }

func (e *Error) Error() string { return e.msg }

// Unwrap reports an interrupted statement as ErrInterrupted so a caller can
// tell a cancelled query from a broken one without matching on text.
func (e *Error) Unwrap() error {
	if e.code == sqliteInterrupt {
		return ErrInterrupted
	}
	return nil
}

// newSQLiteError builds the error text modernc's errstrForDB builds: the
// canonical string for the result code, then the engine's message when it
// says something the canonical string does not, then the code. The code
// carried in the text is the extended one, because Ptah's native driver
// enables extended result codes on every connection.
func newSQLiteError(code, extended int, message string) *Error {
	if extended == 0 {
		extended = code
	}
	if code == 0 {
		code = extended & 0xff
	}
	canonical := errstr(extended)
	busy := ""
	if extended == sqliteBusy {
		busy = " (SQLITE_BUSY)"
	}
	msg := fmt.Sprintf("%s: %s (%v)%s", canonical, message, extended, busy)
	if message == "" || message == canonical {
		msg = fmt.Sprintf("%s (%v)%s", canonical, extended, busy)
	}
	return &Error{msg: msg, code: code, extended: extended}
}

// errstrTable is sqlite3_errstr's own table, indexed by primary result code.
//
// Transcribed from the engine Ptah links natively -- modernc.org/sqlite
// v1.58.0, SQLite 3.53.x -- by calling sqlite3_errstr for every code, so a
// browser run words a failure the way a native run does. The empty entries are
// the codes SQLite has no message for; they report "unknown error", which is
// what the C function returns for them.
var errstrTable = [...]string{
	0:  "not an error",
	1:  "SQL logic error",
	2:  "",
	3:  "access permission denied",
	4:  "query aborted",
	5:  "database is locked",
	6:  "database table is locked",
	7:  "out of memory",
	8:  "attempt to write a readonly database",
	9:  "interrupted",
	10: "disk I/O error",
	11: "database disk image is malformed",
	12: "unknown operation",
	13: "database or disk is full",
	14: "unable to open database file",
	15: "locking protocol",
	16: "",
	17: "database schema has changed",
	18: "string or blob too big",
	19: "constraint failed",
	20: "datatype mismatch",
	21: "bad parameter or other API misuse",
	22: "",
	23: "authorization denied",
	24: "",
	25: "column index out of range",
	26: "file is not a database",
	27: "notification message",
	28: "warning message",
}

// errstr reproduces sqlite3_errstr, including its three special cases for
// extended codes.
func errstr(rc int) string {
	switch rc {
	case 4 | (2 << 8): // SQLITE_ABORT_ROLLBACK
		return "abort due to ROLLBACK"
	case sqliteRow:
		return "another row available"
	case sqliteDone:
		return "no more rows available"
	}
	primary := rc & 0xff
	if rc >= 0 && primary < len(errstrTable) && errstrTable[primary] != "" {
		return errstrTable[primary]
	}
	return "unknown error"
}
