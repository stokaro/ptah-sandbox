//go:build js

package browsersqlite

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
)

// RestrictSession sets SQLITE_LIMIT_ATTACHED to zero on one pinned session,
// which is what makes the engine itself refuse ATTACH, DETACH and VACUUM INTO.
//
// It is the js half of what modernc.org/sqlite's Limit does for every other
// platform. That function cannot serve here: it type-switches on modernc's
// own unexported connection type and refuses anything else.
//
// The limit belongs to one database handle, so the caller has to pass a
// session it pinned for the whole unit of work; this function has no way to
// tell a pinned session from a pooled one. It also does not verify that the
// restriction took: internal/dbschema/sqlite/restrict.go runs that ATTACH
// self-check itself, on both platforms, so the two builds cannot drift on the
// half that decides whether the restriction is trusted.
func RestrictSession(ctx context.Context, session *sql.Conn) error {
	if session == nil {
		return errors.New("browsersqlite: session restriction requires a pinned session")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return session.Raw(func(driverConn any) error {
		c, ok := driverConn.(*conn)
		if !ok {
			return fmt.Errorf("unexpected driverConn type: %T", driverConn)
		}
		if !c.IsValid() {
			return driver.ErrBadConn
		}
		return c.bridge.limitAttachedZero(c.handle)
	})
}
