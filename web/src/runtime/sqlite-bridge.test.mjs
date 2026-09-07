/**
 * Runs the real bridge against the real vendored sqlite3.wasm under Node.
 *
 *   node --test web/src/runtime/sqlite-bridge.test.mjs
 *
 * Node's built-in type stripping loads sqlite-bridge.ts directly, so there is
 * no build step between the source that ships and the source under test.
 *
 * The only Node-specific piece is instantiateWasm: the canonical sqlite.org
 * glue fetches sqlite3.wasm with fetch(), and Node's fetch refuses file: URLs.
 * The browser never takes that path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteBridge, SqliteError } from "./sqlite-bridge.ts";

const WASM_URL = new URL("../../vendor/sqlite/sqlite3.wasm", import.meta.url);
const MJS_URL = new URL("../../vendor/sqlite/sqlite3.mjs", import.meta.url);

const initModule = (await import(MJS_URL.href)).default;
const initArgs = {
  instantiateWasm(imports, onSuccess) {
    return WebAssembly.instantiate(readFileSync(WASM_URL), imports)
      .then((r) => onSuccess(r.instance, r.module));
  },
  printErr: () => {},
};

// Under Node the glue tries to install the OPFS VFSes and logs two failures
// (there is no `location`). They are expected here and never happen in the
// browser, so they are kept out of the test output.
const warn = console.warn;
console.warn = (...a) => { if (!/Ignoring inability to install/.test(String(a[0]))) warn(...a); };
const db = await createSqliteBridge({ initModule, initArgs, progressOps: 500 });
console.warn = warn;

/** assert.throws() does not hand back the error, and these tests inspect it. */
function capture(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw, got none");
}

/** Convenience: run a query and return rows as arrays of values. */
function query(h, sql) {
  const { stmt } = db.prepare(h, sql);
  if (stmt === 0) return { columns: [], rows: [], types: [] };
  const columns = db.columns(stmt);
  const rows = [];
  const types = [];
  for (;;) {
    const batch = db.fetch(stmt, 100);
    for (let r = 0; r < batch.n; r++) {
      rows.push(batch.values.slice(r * columns.length, (r + 1) * columns.length));
      types.push(batch.types.slice(r * columns.length, (r + 1) * columns.length));
    }
    if (batch.done) break;
  }
  db.finalize(stmt);
  return { columns, rows, types };
}

test("info() reports the pinned build", () => {
  const info = db.info();
  assert.equal(info.version, "3.53.4");
  assert.match(info.sourceId, /^2026-07-24 /);
  assert.ok(info.compileOptions.includes("ENABLE_FTS5"), "FTS5 must be compiled in");
  assert.ok(info.compileOptions.includes("ENABLE_COLUMN_METADATA"));
  assert.ok(info.compileOptions.includes("ENABLE_MATH_FUNCTIONS"));
  assert.ok(!info.compileOptions.some((o) => o === "OMIT_JSON"), "JSON must not be omitted");
  assert.ok(info.vfs.includes("memdb"), "memdb VFS must be registered");
  assert.ok(info.compileOptions.includes("DQS=0"), "double-quoted string literals must be errors");
  console.log("  info: %s (%s), %d compile options, vfs %j",
    info.version, info.sourceId.slice(0, 10), info.compileOptions.length, info.vfs);
});

test("a logical database survives close() and is shared by concurrent handles", () => {
  assert.equal(db.exists("app.db"), false);
  const a = db.open("app.db");
  assert.equal(db.exists("app.db"), true);
  db.exec(a, "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  db.exec(a, "INSERT INTO t(v) VALUES('first')");

  // second live handle, same path: Ptah does this for db-vs-dev comparisons
  const b = db.open("app.db");
  assert.deepEqual(query(b, "SELECT v FROM t").rows, [["first"]]);
  db.exec(b, "INSERT INTO t(v) VALUES('second')");
  assert.equal(query(a, "SELECT count(*) FROM t").rows[0][0], 2);

  // closing every user handle must not take the database with it
  db.close(a);
  db.close(b);
  const c = db.open("app.db");
  assert.equal(query(c, "SELECT count(*) FROM t").rows[0][0], 2);
  db.close(c);

  // a different path is a different database
  const other = db.open("other.db");
  assert.throws(() => query(other, "SELECT count(*) FROM t"), /no such table: t/);
  db.close(other);
  db.drop("other.db");
});

test("all five value types round-trip, including the full int64 range", () => {
  const h = db.open("types.db");
  db.exec(h, "CREATE TABLE v(k TEXT, i INTEGER, f REAL, s TEXT, b BLOB)");
  const { stmt } = db.prepare(h, "INSERT INTO v(k,i,f,s,b) VALUES(?,?,?,?,?)");

  const blob = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff]);
  const cases = [
    ["max", "9223372036854775807", 1.5, "text", blob],
    ["min", "-9223372036854775808", -0.0, "", new Uint8Array(0)],
    ["safe", "42", Number.MAX_SAFE_INTEGER, "unicode: é中", new Uint8Array([1])],
  ];
  for (const [k, i, f, s, b] of cases) {
    db.bindText(stmt, 1, k);
    db.bindInt(stmt, 2, i);
    db.bindFloat(stmt, 3, f);
    db.bindText(stmt, 4, s);
    db.bindBlob(stmt, 5, b);
    assert.equal(db.step(stmt), false, "INSERT yields no rows");
    db.reset(stmt); // prepared-statement reuse
  }
  db.finalize(stmt);
  assert.equal(db.changes(h), 1);
  assert.equal(db.lastInsertRowid(h), "3");

  const got = query(h, "SELECT k,i,f,s,b FROM v ORDER BY rowid");
  assert.deepEqual(got.columns, ["k", "i", "f", "s", "b"]);
  // int64 beyond 2^53 crosses as a decimal string; inside it, as a number
  assert.equal(got.rows[0][1], "9223372036854775807");
  assert.equal(got.rows[1][1], "-9223372036854775808");
  assert.equal(got.rows[2][1], 42);
  assert.equal(typeof got.rows[2][1], "number");
  assert.equal(got.rows[2][2], Number.MAX_SAFE_INTEGER);
  assert.equal(got.rows[0][2], 1.5);
  assert.equal(got.rows[2][3], "unicode: é中");
  assert.ok(got.rows[0][4] instanceof Uint8Array);
  assert.deepEqual([...got.rows[0][4]], [...blob]);
  assert.equal(got.rows[1][4].length, 0, "empty blob stays a zero-length blob");
  // types: TEXT INTEGER FLOAT TEXT BLOB
  assert.deepEqual(got.types[0], [3, 1, 2, 3, 4]);

  // nothing that crossed may be a BigInt
  for (const row of got.rows) {
    for (const v of row) assert.notEqual(typeof v, "bigint", "a BigInt would panic syscall/js");
  }
  db.close(h);
  db.drop("types.db");
});

test("NULL and the empty string stay distinguishable", () => {
  const h = db.open("nulls.db");
  db.exec(h, "CREATE TABLE n(v TEXT)");
  const { stmt } = db.prepare(h, "INSERT INTO n(v) VALUES(?)");
  db.bindNull(stmt, 1);
  db.step(stmt);
  db.reset(stmt);
  db.bindText(stmt, 1, "");
  db.step(stmt);
  db.finalize(stmt);

  const got = query(h, "SELECT v, typeof(v) FROM n ORDER BY rowid");
  assert.deepEqual(got.rows, [[null, "null"], ["", "text"]]);
  assert.deepEqual(got.types.map((t) => t[0]), [5, 3]);
  db.close(h);
  db.drop("nulls.db");
});

test("exec runs multi-statement SQL; prepare reports the tail", () => {
  const h = db.open("multi.db");
  db.exec(h, `
    PRAGMA foreign_keys = ON;
    CREATE TABLE a(x);
    CREATE TABLE b(y);
    INSERT INTO a VALUES(1),(2),(3);
  `);
  assert.equal(query(h, "SELECT count(*) FROM a").rows[0][0], 3);
  assert.equal(query(h, "PRAGMA foreign_keys").rows[0][0], 1);

  const first = db.prepare(h, "SELECT 1; SELECT 2;");
  assert.equal(first.tail, " SELECT 2;");
  db.finalize(first.stmt);
  const second = db.prepare(h, first.tail);
  assert.equal(second.tail, "");
  db.finalize(second.stmt);
  // whitespace-only text yields no statement
  assert.deepEqual(db.prepare(h, '  -- just a comment\n'), { stmt: 0, tail: "" });
  db.finalize(0);
  db.close(h);
  db.drop("multi.db");
});

test("transactions commit and roll back", () => {
  const h = db.open("tx.db");
  db.exec(h, "CREATE TABLE t(v)");
  db.begin(h);
  db.exec(h, "INSERT INTO t VALUES(1)");
  db.rollback(h);
  assert.equal(query(h, "SELECT count(*) FROM t").rows[0][0], 0);

  db.begin(h);
  db.exec(h, "INSERT INTO t VALUES(1),(2)");
  db.commit(h);
  assert.equal(query(h, "SELECT count(*) FROM t").rows[0][0], 2);
  assert.equal(db.changes(h), 2);
  db.close(h);
  db.drop("tx.db");
});

test("limitAttachedZero produces the exact refusal text Ptah matches on", () => {
  const h = db.open("restrict.db");
  db.limitAttachedZero(h);
  const err = capture(() => db.exec(h, "ATTACH 'file:/somewhere-else?vfs=memdb' AS other"));
  assert.ok(err instanceof SqliteError, `expected SqliteError, got ${err}`);
  // internal/dbschema/sqlite/restrict.go:77 does
  //   strings.Contains(err.Error(), "too many attached databases")
  assert.ok(err.message.includes("too many attached databases"), `got: ${err.message}`);
  assert.equal(err.message, "too many attached databases - max 0");
  assert.equal(err.sqliteCode, 1);
  assert.equal(err.sqliteExtended, 1);
  console.log("  attach refused with: %s", err.message);
  db.close(h);
  db.drop("restrict.db");
});

test("a deadline aborts a running statement with SQLITE_INTERRUPT", () => {
  const h = db.open("slow.db");
  const SLOW = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<200000000) SELECT count(*) FROM c";
  db.setDeadline(h, Date.now() + 150);
  const t0 = Date.now();
  const err = capture(() => query(h, SLOW));
  const elapsed = Date.now() - t0;
  assert.ok(err instanceof SqliteError, `expected SqliteError, got ${err}`);
  assert.equal(err.sqliteCode, 9, "SQLITE_INTERRUPT");
  assert.equal(err.message, "interrupted");
  assert.ok(elapsed < 1000, `deadline overshoot too large: ${elapsed} ms`);
  console.log("  deadline fired after %d ms (budget 150 ms), rc=%d %j", elapsed, err.sqliteCode, err.message);

  // clearing the deadline lets work proceed again
  db.setDeadline(h, 0);
  assert.equal(query(h, "SELECT 1").rows[0][0], 1);
  db.close(h);
  db.drop("slow.db");
});

test("serialize produces a file the native sqlite3 binary can open", () => {
  const h = db.open("export.db");
  db.exec(h, `
    CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, meta BLOB);
    CREATE INDEX idx_users_email ON users(email);
    CREATE VIEW active AS SELECT * FROM users WHERE id > 0;
    INSERT INTO users(email, meta) VALUES('a@example.com', x'deadbeef'), ('b@example.com', NULL);
  `);
  db.close(h);

  const bytes = db.serialize("export.db");
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 15)), "SQLite format 3");

  const dir = mkdtempSync(join(tmpdir(), "ptah-sqlite-"));
  const file = join(dir, "export.db");
  writeFileSync(file, bytes);

  const out = execFileSync("sqlite3", [file,
    ".mode list",
    "SELECT 'integrity=' || (SELECT * FROM pragma_integrity_check());",
    "SELECT 'rows=' || count(*) FROM users;",
    "SELECT 'objects=' || group_concat(type || ':' || name, ' ') FROM sqlite_schema ORDER BY name;",
    "SELECT 'blob=' || hex(meta) FROM users WHERE email='a@example.com';",
  ], { encoding: "utf8" });
  const cliVersion = execFileSync("sqlite3", ["-version"], { encoding: "utf8" }).trim();
  console.log('  native sqlite3 %s on the serialized image:\n%s',
    cliVersion, out.trim().split('\n').map((l) => "    " + l).join('\n'));

  assert.match(out, /integrity=ok/);
  assert.match(out, /rows=2/);
  assert.match(out, /table:users/);
  assert.match(out, /index:idx_users_email/);
  assert.match(out, /view:active/);
  assert.match(out, /blob=DEADBEEF/);
});

test("deserialize replaces a logical database and later handles see it", () => {
  const bytes = db.serialize("export.db");

  // into a fresh path
  db.deserialize("restored.db", bytes);
  const h = db.open("restored.db");
  assert.equal(query(h, "SELECT count(*) FROM users").rows[0][0], 2);
  assert.equal(query(h, "SELECT email FROM active ORDER BY id").rows[0][0], "a@example.com");
  assert.equal(query(h, "SELECT count(*) FROM sqlite_schema WHERE name='idx_users_email'").rows[0][0], 1);
  // and it is writable afterwards
  db.exec(h, "INSERT INTO users(email) VALUES('c@example.com')");
  assert.equal(query(h, "SELECT count(*) FROM users").rows[0][0], 3);
  db.close(h);

  // round trip: serialize the restored copy and compare content
  const again = db.serialize("restored.db");
  db.deserialize("restored.db", again);
  const h2 = db.open("restored.db");
  assert.equal(query(h2, "SELECT count(*) FROM users").rows[0][0], 3);
  db.close(h2);

  // over an existing database with live handles, it must refuse rather than
  // silently leave those handles on the old store
  const live = db.open("restored.db");
  assert.throws(() => db.deserialize("restored.db", bytes), /every handle .* closed first/);
  db.close(live);

  // garbage is rejected before anything is destroyed
  assert.throws(() => db.deserialize("junk.db", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), SqliteError);

  db.drop("restored.db");
  db.drop("export.db");
  db.drop("junk.db");
});

test("drop() destroys the database", () => {
  const h = db.open("temp.db");
  db.exec(h, "CREATE TABLE gone(x)");
  db.close(h);
  db.drop("temp.db");
  assert.equal(db.exists("temp.db"), false);
  const h2 = db.open("temp.db");
  assert.throws(() => query(h2, "SELECT * FROM gone"), /no such table: gone/);
  db.close(h2);
  db.drop("temp.db");
});

test("bad input is refused, not mistranslated", () => {
  const h = db.open("bad.db");
  assert.throws(() => db.exec(h, "SELECT * FROM nope"), (e) => {
    assert.ok(e instanceof SqliteError);
    assert.equal(e.sqliteCode, 1);
    assert.equal(e.message, "no such table: nope");
    return true;
  });
  const { stmt } = db.prepare(h, "SELECT ?");
  assert.throws(() => db.bindInt(stmt, 1, "not a number"), /not a decimal integer/);
  assert.throws(() => db.bindInt(stmt, 1, "9223372036854775808"), /outside the int64 range/);
  db.finalize(stmt);
  assert.throws(() => db.close(9999), /unknown database handle/);
  assert.throws(() => db.serialize("never-existed.db"), /no database at/);
  db.close(h);
  db.drop("bad.db");
});

test("empty databases serialize and deserialize without special-casing", () => {
  // A workspace that was created but never written has a zero-length memdb
  // store, which is a valid empty SQLite database with no page image.
  const h = db.open("empty.db");
  db.close(h);
  const bytes = db.serialize("empty.db");
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 15)), "SQLite format 3");
  assert.equal(bytes.length, 8192, "one page at the build default page size");

  db.deserialize("fromempty.db", bytes);
  const h2 = db.open("fromempty.db");
  assert.equal(query(h2, "SELECT count(*) FROM sqlite_schema").rows[0][0], 0);
  db.exec(h2, "CREATE TABLE fresh(x)"); // and it is usable afterwards
  assert.equal(query(h2, "SELECT count(*) FROM sqlite_schema WHERE name='fresh'").rows[0][0], 1);
  db.close(h2);
  db.drop("empty.db");
  db.drop("fromempty.db");
});

test("every i64 call site carries the CI marker", () => {
  // A forgotten coercion is a deferred crash: the BigInt only appears on large
  // rowids, so it passes every small smoke test and then panics the whole Go
  // program with "bad type flag". This test is the lint that prevents it.
  const src = readFileSync(new URL("./sqlite-bridge.ts", import.meta.url), "utf8");
  const lines = src.split('\n');
  const I64_CALL = /\b(sqlite3_column_int64|sqlite3_last_insert_rowid|sqlite3_changes64|sqlite3_bind_int64|sqlite3_serialize)\s*\(/;
  const MARKER = "SQLITE-I64-COERCION";

  const sites = [];
  lines.forEach((line, i) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (!I64_CALL.test(line)) return;
    const near = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
    sites.push({ line: i + 1, text: trimmed, marked: near.includes(MARKER) });
  });

  assert.ok(sites.length >= 4, `expected the known i64 call sites, found ${sites.length}`);
  assert.deepEqual(
    sites.filter((s) => !s.marked),
    [],
    "every i64 call must sit under a " + MARKER + " comment",
  );
  console.log("  %d i64 call sites, all marked: %s",
    sites.length, sites.map((s) => `${s.line}`).join(" "));
});
