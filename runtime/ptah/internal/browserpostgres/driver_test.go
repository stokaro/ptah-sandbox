//go:build js

package browserpostgres_test

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	_ "ptah.run/internal/browserpostgres"
)

func open(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("browser-postgres", "postgres://pglite/app")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	return db
}

func TestRealPostgresValuesAndParameters(t *testing.T) {
	db := open(t)
	var integer int64
	var flag bool
	var data []byte
	var jsonText, arr, precise string
	var timestamp time.Time
	var nullable *string
	err := db.QueryRow(`SELECT $1::bigint,$2::boolean,$3::bytea,$4::jsonb,$5::text[],12345678901234567890.123456789::numeric,'2026-01-02 03:04:05+00'::timestamptz,NULL::text`, int64(9223372036854775807), true, []byte{0, 127, 255}, `{"n":9223372036854775807}`, `{"a,b","c"}`).Scan(&integer, &flag, &data, &jsonText, &arr, &precise, &timestamp, &nullable)
	if err != nil {
		t.Fatal(err)
	}
	if integer != 9223372036854775807 || !flag || string(data) != string([]byte{0, 127, 255}) || !strings.Contains(jsonText, "9223372036854775807") || arr != `{"a,b",c}` || precise != "12345678901234567890.123456789" || timestamp.UTC().Format(time.RFC3339) != "2026-01-02T03:04:05Z" || nullable != nil {
		t.Fatalf("values changed: %d %v %x %s %s %s %v %v", integer, flag, data, jsonText, arr, precise, timestamp, nullable)
	}
}
func TestTransactionsAndPreparedStatements(t *testing.T) {
	db := open(t)
	if _, err := db.Exec("CREATE TABLE driver_test (id int PRIMARY KEY, value text)"); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec("INSERT INTO driver_test VALUES ($1,$2)", 1, "rollback"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = db.QueryRow("SELECT count(*) FROM driver_test").Scan(&count); err != nil || count != 0 {
		t.Fatalf("rollback: %d %v", count, err)
	}
	st, err := db.Prepare("INSERT INTO driver_test VALUES ($1,$2)")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	result, err := st.Exec(2, "kept")
	if err != nil {
		t.Fatal(err)
	}
	n, err := result.RowsAffected()
	if err != nil || n != 1 {
		t.Fatalf("affected: %d %v", n, err)
	}
	if _, err = result.LastInsertId(); err == nil {
		t.Fatal("invented LastInsertId")
	}
	tx, err = db.BeginTx(context.Background(), &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec("UPDATE driver_test SET value='committed'"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
}
func TestSQLStateAndRecovery(t *testing.T) {
	db := open(t)
	_, err := db.Exec("SELECT * FROM no_such_table")
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "42P01" {
		t.Fatalf("SQLSTATE lost: %v", err)
	}
	var v int
	if err = db.QueryRow("SELECT 42").Scan(&v); err != nil || v != 42 {
		t.Fatalf("query after rejection: %d %v", v, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = db.ExecContext(ctx, "CREATE TABLE should_not_exist (id int)"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
func TestRefuseExternalURLs(t *testing.T) {
	for _, dsn := range []string{"postgres://example.com/app", "postgres://pglite/other", "postgres://user@pglite/app", "postgres://pglite/app?search_path=other"} {
		db, err := sql.Open("browser-postgres", dsn)
		if err != nil {
			continue
		}
		err = db.Ping()
		db.Close()
		if err == nil {
			t.Errorf("accepted %s", dsn)
		}
	}
}

func TestDate(t *testing.T) {
	db := open(t)
	var date time.Time
	if err := db.QueryRow("SELECT '2026-01-02'::date").Scan(&date); err != nil {
		t.Fatal(err)
	}
	if date.Format("2006-01-02") != "2026-01-02" {
		t.Fatal(date)
	}
}
