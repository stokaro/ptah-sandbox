/**
 * Contract tests for the pure half of the editor and the three result panes.
 *
 * Everything here is a function that decides what the interface will claim:
 * how a value out of SQLite is rendered, when a row set is truncated, when a
 * plan stops being about the present, and when a column is marked as being in
 * the database but not in the schema file. Those are the claims the product
 * is built on, so they are tested away from the DOM where they are cheap to
 * pin down.
 *
 * The plan fixtures are the real CLI's output, copied from the captured
 * ground truth (.refs/ground-truth/10, /17 and /C_add_active.plan.json, which
 * is working material and not committed). They are inlined rather than read
 * from disk so this suite runs from a clean checkout.
 *
 * Run:  node --test src/panes/panes.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCatalog,
  columnConstraint,
  columnsAddedBetween,
  diffCatalogs,
  diffTable,
  explicitIndexes,
  foreignKeyLabel,
  isWithoutRowid,
  quoteIdent,
  quoteLiteral,
  referencedBy,
  rowCountSQL,
} from "./catalog.ts";
import { capRows, compareCells, formatCell, rowQuery, sortRows, CELL_LIMIT } from "./data.ts";
import { parsePlanJSON, parsePlanOutput, planStaleReason } from "./plan.ts";
import { columnNote, formatRowCount, formatSize } from "./rail.ts";
import { structureMark } from "./structure.ts";
import { tokenizeSQL } from "../editor.ts";

// --------------------------------------------------------------------------
// Building a catalog out of the six row sets
// --------------------------------------------------------------------------

/** The shape a `sql` host event carries. */
const rs = (columns, rows) => ({ columns, rows });

/**
 * Scenario A after the apply, plus the drifted `nickname` column from
 * scenario B, expressed exactly as the PRAGMA queries return it.
 */
function fixtureCatalog({ withNickname = false, withIndex = true } = {}) {
  const usersColumns = [
    ["users", 0, "id", "INTEGER", 0, null, 1],
    ["users", 1, "name", "TEXT", 1, null, 0],
    ["users", 2, "email", "TEXT", 1, null, 0],
    ["users", 3, "active", "INTEGER", 1, "1", 0],
  ];
  if (withNickname) usersColumns.push(["users", 4, "nickname", "TEXT", 0, null, 0]);

  return buildCatalog(
    "app.db",
    {
      tables: rs(
        ["name", "sql"],
        [
          ["users", 'CREATE TABLE "users" (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'],
          ["tasks", 'CREATE TABLE "tasks" (id INTEGER PRIMARY KEY)'],
        ],
      ),
      columns: rs(
        ["tbl", "cid", "name", "type", "notnull", "dflt_value", "pk"],
        [
          ...usersColumns,
          ["tasks", 0, "id", "INTEGER", 0, null, 1],
          ["tasks", 1, "user_id", "INTEGER", 1, null, 0],
          ["tasks", 2, "title", "TEXT", 1, null, 0],
        ],
      ),
      foreignKeys: rs(
        ["tbl", "table", "from", "to", "id", "seq"],
        [["tasks", "users", "user_id", "id", 0, 0]],
      ),
      indexes: withIndex
        ? rs(["tbl", "name", "unique", "origin"], [["users", "idx_users_email", 0, "c"]])
        : rs(["tbl", "name", "unique", "origin"], []),
      indexColumns: withIndex
        ? rs(["tbl", "idx", "seqno", "name"], [["users", "idx_users_email", 0, "email"]])
        : rs(["tbl", "idx", "seqno", "name"], []),
      rowCounts: rs(
        ["tbl", "n"],
        [
          ["users", 3],
          ["tasks", 4],
        ],
      ),
    },
    1000,
  );
}

test("buildCatalog keeps definition order and attaches every part", () => {
  const catalog = fixtureCatalog();
  assert.deepEqual(
    catalog.tables.map((t) => t.name),
    ["users", "tasks"],
  );

  const users = catalog.tables[0];
  assert.deepEqual(
    users.columns.map((c) => c.name),
    ["id", "name", "email", "active"],
  );
  assert.equal(users.rowCount, 3);
  assert.equal(users.columns[0].pk, 1);
  assert.equal(users.columns[3].defaultExpr, "1");
  assert.equal(users.columns[1].notNull, true);
  assert.deepEqual(users.indexes[0], {
    name: "idx_users_email",
    columns: ["email"],
    unique: false,
    origin: "c",
  });

  const tasks = catalog.tables[1];
  assert.deepEqual(tasks.foreignKeys, [{ table: "users", column: "user_id", toColumn: "id" }]);
});

test("a row count that has not run is null rather than zero", () => {
  const catalog = buildCatalog(
    "app.db",
    {
      tables: rs(["name", "sql"], [["users", "CREATE TABLE users (id)"]]),
      columns: rs(
        ["tbl", "cid", "name", "type", "notnull", "dflt_value", "pk"],
        [["users", 0, "id", "", 0, null, 0]],
      ),
      foreignKeys: rs([], []),
      indexes: rs([], []),
      indexColumns: rs([], []),
      rowCounts: null,
    },
    1,
  );
  assert.equal(catalog.tables[0].rowCount, null);
  assert.equal(formatRowCount(null), "counting…");
});

test("constraints read in SQLite's order, and a composite key says so", () => {
  const catalog = fixtureCatalog();
  const users = catalog.tables[0];
  assert.equal(columnConstraint(users, users.columns[0]), "PRIMARY KEY");
  assert.equal(columnConstraint(users, users.columns[1]), "NOT NULL");
  assert.equal(columnConstraint(users, users.columns[3]), "NOT NULL DEFAULT 1");

  const composite = {
    name: "membership",
    ddl: "",
    columns: [
      { name: "a", type: "TEXT", notNull: true, defaultExpr: null, pk: 1 },
      { name: "b", type: "TEXT", notNull: true, defaultExpr: null, pk: 2 },
    ],
    foreignKeys: [],
    indexes: [],
    rowCount: null,
  };
  assert.equal(columnConstraint(composite, composite.columns[0]), "PRIMARY KEY (1 of 2) NOT NULL");
});

test("a foreign key with no named column resolves to the target's key", () => {
  const catalog = fixtureCatalog();
  assert.equal(
    foreignKeyLabel(catalog, { table: "users", column: "user_id", toColumn: null }),
    "FK → users.id",
  );
  assert.equal(
    foreignKeyLabel(catalog, { table: "users", column: "user_id", toColumn: "email" }),
    "FK → users.email",
  );
  // Nothing to resolve against: the label stops at the table rather than
  // inventing a column name.
  assert.equal(
    foreignKeyLabel(null, { table: "elsewhere", column: "x", toColumn: null }),
    "FK → elsewhere",
  );
});

test("referencedBy finds the inbound side", () => {
  const catalog = fixtureCatalog();
  assert.deepEqual(referencedBy(catalog, "users"), [{ from: "tasks.user_id", to: "users.id" }]);
  assert.deepEqual(referencedBy(catalog, "tasks"), []);
});

test("explicitIndexes leaves out the ones a constraint created", () => {
  const table = {
    name: "t",
    ddl: "",
    columns: [],
    foreignKeys: [],
    indexes: [
      { name: "idx_email", columns: ["email"], unique: false, origin: "c" },
      { name: "sqlite_autoindex_t_1", columns: ["email"], unique: true, origin: "u" },
    ],
    rowCount: null,
  };
  assert.deepEqual(
    explicitIndexes(table).map((i) => i.name),
    ["idx_email"],
  );
});

test("WITHOUT ROWID is read off the stored DDL", () => {
  const withRowid = { ddl: "CREATE TABLE t (a TEXT PRIMARY KEY)" };
  const without = { ddl: "CREATE TABLE t (a TEXT PRIMARY KEY) WITHOUT ROWID" };
  assert.equal(isWithoutRowid(withRowid), false);
  assert.equal(isWithoutRowid(without), true);
  // The words appearing in a column name must not trip it.
  assert.equal(isWithoutRowid({ ddl: 'CREATE TABLE t ("without rowid" TEXT)' }), false);
});

// --------------------------------------------------------------------------
// Identifier quoting
// --------------------------------------------------------------------------

test("generated SQL quotes identifiers and literals", () => {
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
  assert.equal(quoteLiteral("O'Hara"), "'O''Hara'");
  assert.equal(
    rowCountSQL(['a"b']),
    "SELECT 'a\"b' AS tbl, COUNT(*) AS n FROM \"a\"\"b\"",
  );
  assert.equal(rowCountSQL([]), null);
});

test("the row read orders by rowid, and says when it cannot", () => {
  assert.deepEqual(rowQuery("users", { limit: 50 }), {
    sql: 'SELECT * FROM "users" ORDER BY rowid LIMIT 51',
    order: "ordered by rowid",
  });
  const noRowid = rowQuery("users", { limit: 50, withoutRowid: true });
  assert.equal(noRowid.sql, 'SELECT * FROM "users" LIMIT 51');
  assert.match(noRowid.order, /no rowid/);
});

// --------------------------------------------------------------------------
// Rendering values
// --------------------------------------------------------------------------

test("NULL and the empty string stay distinguishable", () => {
  assert.deepEqual(formatCell(null), {
    text: "NULL",
    kind: "null",
    escaped: false,
    truncated: false,
    full: "NULL",
  });
  const empty = formatCell("");
  assert.equal(empty.text, "");
  assert.equal(empty.kind, "text");
});

test("markup in a value is text, not markup", () => {
  const cell = formatCell('<img src=x onerror="alert(1)">');
  assert.equal(cell.text, '<img src=x onerror="alert(1)">');
  assert.equal(cell.kind, "text");
  assert.equal(cell.escaped, false);
});

test("a blob reports its length instead of pretending to be characters", () => {
  assert.equal(formatCell(new Uint8Array([1, 2, 3])).text, "BLOB · 3 bytes");
  assert.equal(formatCell(new Uint8Array(1)).text, "BLOB · 1 byte");
  assert.equal(formatCell(new Uint8Array(0)).kind, "blob");
});

test("control characters are escaped, and the cell says it happened", () => {
  const cell = formatCell("a\nb\tc\u0000d");
  assert.equal(cell.text, "a\\nb\\tc\\x00d");
  assert.equal(cell.escaped, true);
  assert.equal(cell.full, "a\nb\tc\u0000d");
});

test("a long value is cut, marked, and keeps the original", () => {
  const long = "x".repeat(CELL_LIMIT + 40);
  const cell = formatCell(long);
  assert.equal(cell.truncated, true);
  assert.equal(cell.text.length, CELL_LIMIT + 1); // the cut plus the ellipsis
  assert.equal(cell.text.endsWith("…"), true);
  assert.equal(cell.full, long);

  const exact = formatCell("y".repeat(CELL_LIMIT));
  assert.equal(exact.truncated, false);
});

test("numbers keep their identity, including negative zero", () => {
  assert.equal(formatCell(0).text, "0");
  assert.equal(formatCell(-0).text, "-0");
  assert.equal(formatCell(1.5).kind, "number");
  // An i64 too large for a double reaches the page as a decimal string; it is
  // rendered, not reinterpreted.
  assert.equal(formatCell("9007199254740993").text, "9007199254740993");
});

// --------------------------------------------------------------------------
// Truncation and sorting
// --------------------------------------------------------------------------

test("capRows reports the cut instead of hiding it", () => {
  const rows = Array.from({ length: 7 }, (_, i) => [i]);
  assert.deepEqual(capRows(rows, 10), { rows, shown: 7, truncated: false });

  const capped = capRows(rows, 3);
  assert.equal(capped.shown, 3);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.rows, [[0], [1], [2]]);
  // The input is left alone; the caller still holds everything it fetched.
  assert.equal(rows.length, 7);
});

test("the browser sort is stable and follows SQLite's storage-class order", () => {
  assert.equal(compareCells(null, 1) < 0, true);
  assert.equal(compareCells(1, "a") < 0, true);
  assert.equal(compareCells("a", new Uint8Array(1)) < 0, true);
  assert.equal(compareCells(2, 10) < 0, true);

  // Two rows tie on column 0; they must keep their input order both ways.
  const rows = [
    ["a", "first"],
    ["a", "second"],
    ["b", "third"],
  ];
  assert.deepEqual(sortRows(rows, 0, "asc"), [
    ["a", "first"],
    ["a", "second"],
    ["b", "third"],
  ]);
  assert.deepEqual(sortRows(rows, 0, "desc"), [
    ["b", "third"],
    ["a", "first"],
    ["a", "second"],
  ]);
  // And the original is untouched, so re-sorting starts from the database's
  // order rather than from the last sort.
  assert.deepEqual(rows[0], ["a", "first"]);
});

// --------------------------------------------------------------------------
// Desired minus actual
// --------------------------------------------------------------------------

/** The catalog SQLite builds from schema.sql, which has no `nickname`. */
function desiredCatalog() {
  return buildCatalog(
    "__desired.db",
    {
      tables: rs(["name", "sql"], [["users", "CREATE TABLE users (...)"]]),
      columns: rs(
        ["tbl", "cid", "name", "type", "notnull", "dflt_value", "pk"],
        [
          ["users", 0, "id", "INTEGER", 0, null, 1],
          ["users", 1, "name", "TEXT", 1, null, 0],
          ["users", 2, "email", "TEXT", 1, null, 0],
          ["users", 3, "active", "INTEGER", 1, "1", 0],
        ],
      ),
      foreignKeys: rs([], []),
      indexes: rs([], []),
      indexColumns: rs([], []),
      rowCounts: null,
    },
    2000,
  );
}

test("a column only the database has is marked, and only that one", () => {
  const diff = diffTable(fixtureCatalog({ withNickname: true }), desiredCatalog(), "users");
  assert.equal(diff.hasDrift, true);
  assert.equal(diff.columns.get("nickname"), "only-in-database");
  assert.equal(diff.columns.get("active"), "in-both");
  assert.equal(diff.columns.get("id"), "in-both");
});

test("a column only the file has is not drift", () => {
  // The database is still on the pre-apply shape; schema.sql already has
  // `active`. That is the ordinary state between an edit and an apply.
  const actual = buildCatalog(
    "app.db",
    {
      tables: rs(["name", "sql"], [["users", "CREATE TABLE users (...)"]]),
      columns: rs(
        ["tbl", "cid", "name", "type", "notnull", "dflt_value", "pk"],
        [
          ["users", 0, "id", "INTEGER", 0, null, 1],
          ["users", 1, "name", "TEXT", 1, null, 0],
          ["users", 2, "email", "TEXT", 1, null, 0],
        ],
      ),
      foreignKeys: rs([], []),
      indexes: rs([], []),
      indexColumns: rs([], []),
      rowCounts: null,
    },
    1500,
  );
  const diff = diffTable(actual, desiredCatalog(), "users");
  assert.equal(diff.hasDrift, false);
  assert.equal(diff.columns.get("active"), "only-in-schema");
});

test("with no desired catalog nothing is marked, in either direction", () => {
  const diff = diffTable(fixtureCatalog({ withNickname: true }), null, "users");
  assert.equal(diff.hasDrift, false);
  for (const mark of diff.columns.values()) assert.equal(mark, "in-both");
});

test("diffCatalogs keys marks by table.column and finds extra tables", () => {
  const diff = diffCatalogs(fixtureCatalog({ withNickname: true }), desiredCatalog());
  assert.equal(diff.columns.get("users.nickname"), "only-in-database");
  assert.equal(diff.columns.get("tasks.title"), "in-both");
  assert.deepEqual(diff.extraTables, ["tasks"]);
  assert.equal(diff.hasDrift, true);
});

test("a new column is found by comparing two catalog reads, not by being told", () => {
  const before = buildCatalog(
    "app.db",
    {
      tables: rs(["name", "sql"], [["users", ""]]),
      columns: rs(
        ["tbl", "cid", "name", "type", "notnull", "dflt_value", "pk"],
        [
          ["users", 0, "id", "INTEGER", 0, null, 1],
          ["users", 1, "name", "TEXT", 1, null, 0],
        ],
      ),
      foreignKeys: rs([], []),
      indexes: rs([], []),
      indexColumns: rs([], []),
      rowCounts: null,
    },
    1,
  );
  const after = fixtureCatalog();
  assert.deepEqual(columnsAddedBetween(before, after, "users"), ["email", "active"]);
  assert.deepEqual(columnsAddedBetween(after, after, "users"), []);
  // A table missing from either read yields nothing rather than a guess.
  assert.deepEqual(columnsAddedBetween(before, after, "absent"), []);
  assert.deepEqual(columnsAddedBetween(null, after, "users"), []);
});

// --------------------------------------------------------------------------
// The marking vocabulary
// --------------------------------------------------------------------------

test("amber is reserved for the drift case", () => {
  assert.deepEqual(columnNote("only-in-database", false), {
    text: "not in schema.sql",
    tone: "amber",
  });
  assert.equal(columnNote("only-in-schema", false).tone, "mute");
  assert.equal(columnNote("in-both", true).tone, "mute");
  assert.equal(columnNote("in-both", false), null);
  assert.equal(columnNote(undefined, false), null);

  assert.equal(structureMark("only-in-database").tone, "amber");
  assert.equal(structureMark("only-in-schema").tone, "mute");
  assert.equal(structureMark("in-both"), null);
});

test("sizes and row counts read the way the mock writes them", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(28 * 1024), "28 KiB");
  assert.equal(formatSize(3 * 1024 * 1024), "3.0 MiB");
  assert.equal(formatRowCount(0), "0 rows");
  assert.equal(formatRowCount(1), "1 row");
  assert.equal(formatRowCount(3), "3 rows");
  assert.equal(formatRowCount(12345), "12,345 rows");
});

// --------------------------------------------------------------------------
// The plan
// --------------------------------------------------------------------------

/** Captured from `ptah schema apply --schema-file schema_v2.sql --dry-run`. */
const APPLY_DRY_RUN = `Planned schema changes:
ALTER TABLE "users" ADD COLUMN "active" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS "idx_users_email" ON "users" ("email");
`;

/** The same command against a schema that forces a SQLite table rebuild. */
const APPLY_DRY_RUN_REBUILD = `Planned schema changes:
-- Disable foreign-key enforcement for the table rebuild below
PRAGMA foreign_keys = off;
-- SQLite table rebuild for changes ALTER TABLE cannot express on users
CREATE TABLE "__ptah_rebuild_users" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "email" TEXT NOT NULL UNIQUE,
  "active" INTEGER NOT NULL DEFAULT 1
);
DROP TABLE "users";
ALTER TABLE "__ptah_rebuild_users" RENAME TO "users";
-- Restore foreign-key enforcement after the table rebuild
PRAGMA foreign_keys = on;
`;

/** Captured from `ptah schema plan --dry-run --name add_active`. */
const PLAN_JSON = `{
  "format_version": 1,
  "name": "add_active",
  "dialect": "sqlite",
  "destructive": false,
  "statements": [
    {
      "sql": "ALTER TABLE \\"users\\" ADD COLUMN \\"active\\" INTEGER NOT NULL DEFAULT 1",
      "severity": "safe",
      "reason": "does not remove data or tighten constraints"
    },
    {
      "sql": "CREATE INDEX IF NOT EXISTS \\"idx_users_email\\" ON \\"users\\" (\\"email\\")",
      "severity": "safe",
      "reason": "does not remove data or tighten constraints"
    }
  ]
}`;

test("the dry-run output splits into whole statements", () => {
  const plan = parsePlanOutput(APPLY_DRY_RUN);
  assert.equal(plan.confident, true);
  assert.equal(plan.statements.length, 2);
  assert.equal(
    plan.statements[0].sql,
    'ALTER TABLE "users" ADD COLUMN "active" INTEGER NOT NULL DEFAULT 1;',
  );
  assert.equal(plan.statements[1].sql.startsWith("CREATE INDEX IF NOT EXISTS"), true);
  assert.equal(plan.raw, APPLY_DRY_RUN);
});

test("a multi-line statement stays one statement, with its comment attached", () => {
  const plan = parsePlanOutput(APPLY_DRY_RUN_REBUILD);
  assert.equal(plan.confident, true);
  assert.deepEqual(
    plan.statements.map((s) => s.sql.split("\n")[0]),
    [
      "PRAGMA foreign_keys = off;",
      'CREATE TABLE "__ptah_rebuild_users" (',
      'DROP TABLE "users";',
      'ALTER TABLE "__ptah_rebuild_users" RENAME TO "users";',
      "PRAGMA foreign_keys = on;",
    ],
  );
  assert.equal(plan.statements[0].note, "Disable foreign-key enforcement for the table rebuild below");
  assert.equal(
    plan.statements[1].note,
    "SQLite table rebuild for changes ALTER TABLE cannot express on users",
  );
  assert.equal(plan.statements[1].sql.includes('"active" INTEGER NOT NULL DEFAULT 1'), true);
  assert.equal(plan.statements[2].note, "");
});

test("output that does not split cleanly is reported as such, not guessed at", () => {
  const plan = parsePlanOutput("Planned schema changes:\nALTER TABLE users ADD COLUMN x TEXT\n");
  assert.equal(plan.confident, false);
  assert.equal(plan.raw.includes("ALTER TABLE users ADD COLUMN x TEXT"), true);
});

test("a plan with no statements is confident about being empty", () => {
  assert.deepEqual(parsePlanOutput(""), { statements: [], raw: "", confident: true });
  const header = parsePlanOutput("Planned schema changes:\n");
  assert.equal(header.confident, true);
  assert.equal(header.statements.length, 0);
});

test("the JSON plan carries the planner's own severity and reason", () => {
  const plan = parsePlanJSON(PLAN_JSON);
  assert.equal(plan.confident, true);
  assert.equal(plan.statements.length, 2);
  assert.equal(plan.statements[0].severity, "safe");
  assert.equal(plan.statements[0].reason, "does not remove data or tighten constraints");
  // The JSON omits the terminator; the pane shows statements as they'd be typed.
  assert.equal(plan.statements[0].sql.endsWith(";"), true);
});

test("bad plan JSON throws rather than showing an empty plan", () => {
  assert.throws(() => parsePlanJSON("not json"));
  assert.throws(() => parsePlanJSON("{}"), /no statements array/);
  assert.throws(() => parsePlanJSON('{"statements":[{"severity":"safe"}]}'), /has no sql/);
});

test("a plan goes stale when either input moves, and says which", () => {
  const origin = { revision: 12, catalogAt: 1000 };
  assert.equal(planStaleReason(origin, { revision: 12, catalogAt: 1000 }), null);
  assert.match(planStaleReason(origin, { revision: 13, catalogAt: 1000 }), /schema\.sql has changed/);
  assert.match(planStaleReason(origin, { revision: 12, catalogAt: 2000 }), /database has changed/);
  assert.match(planStaleReason(origin, { revision: 13, catalogAt: 2000 }), /both changed/);
});

// --------------------------------------------------------------------------
// The editor's two pure parts
// --------------------------------------------------------------------------

const flat = (text) => tokenizeSQL(text).map((line) => line.map((t) => `${t.kind}:${t.text}`));

test("keywords are coloured and quoted identifiers are not", () => {
  assert.deepEqual(flat("CREATE TABLE users ("), [
    ["keyword:CREATE", "plain: ", "keyword:TABLE", "plain: ", "plain:users", "plain: ("],
  ]);
  // A table deliberately named "select" is an identifier, not a keyword.
  assert.deepEqual(flat('SELECT * FROM "select"'), [
    ["keyword:SELECT", "plain: * ", "keyword:FROM", "plain: ", 'plain:"select"'],
  ]);
});

test("a keyword inside a string literal stays a string", () => {
  assert.deepEqual(flat("INSERT INTO t VALUES ('not null')"), [
    [
      "keyword:INSERT",
      "plain: ",
      "keyword:INTO",
      "plain: ",
      "plain:t",
      "plain: ",
      "keyword:VALUES",
      "plain: (",
      "string:'not null'",
      "plain:)",
    ],
  ]);
  // The doubled quote is an escape, not the end of the literal.
  assert.deepEqual(flat("'O''Hara'"), [["string:'O''Hara'"]]);
});

test("comments run to the end of the line and across lines", () => {
  assert.deepEqual(flat("-- CREATE TABLE\nSELECT"), [["comment:-- CREATE TABLE"], ["keyword:SELECT"]]);
  assert.deepEqual(flat("/* select\n   from */ 1"), [
    ["comment:/* select"],
    ["comment:   from */", "plain: 1"],
  ]);
});

test("tokenize keeps one entry per line, blank lines included", () => {
  const lines = tokenizeSQL("a\n\nb");
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[1], []);
});

test("an unterminated string or comment does not swallow the file silently", () => {
  // It is coloured to the end, which is what an editor should show; the
  // important part is that tokenizing terminates and keeps every character.
  const text = "SELECT 'unterminated\nnext line";
  const joined = tokenizeSQL(text)
    .map((line) => line.map((t) => t.text).join(""))
    .join("\n");
  assert.equal(joined, text);
});

test("tokenizing is lossless for a real schema file", () => {
  const text = [
    "-- The schema you want the database to have.",
    "CREATE TABLE users (",
    "  id    INTEGER PRIMARY KEY,",
    "  name  TEXT NOT NULL,",
    "  email TEXT NOT NULL",
    ");",
    "",
    "CREATE INDEX idx_users_email ON users (email);",
  ].join("\n");
  const joined = tokenizeSQL(text)
    .map((line) => line.map((t) => t.text).join(""))
    .join("\n");
  assert.equal(joined, text);
});

