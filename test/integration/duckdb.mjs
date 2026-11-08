/** Real Ptah wasm, official DuckDB provider code, and DuckDB-Wasm. */
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { boot } from "./harness.mjs";
import { duckDBCell, duckDBOID } from "../../web/src/runtime/duckdb-values.ts";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
const duckdb = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
const bundle = { mvp: { mainModule: path.join(path.dirname(require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs")), "duckdb-mvp.wasm") } };
const databases = new Map();
const connections = new Map();
let next = 0;

async function database(name) {
  if (databases.has(name)) return databases.get(name);
  const db = await duckdb.createDuckDB(bundle, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await db.instantiate();
  db.open({ path: ":memory:" });
  databases.set(name, db);
  return db;
}
const bridge = {
  async open(name) {
    const connection = (await database(name)).connect();
    const id = ++next;
    connections.set(id, connection);
    return id;
  },
  async close(id) {
    connections.get(id)?.close();
    connections.delete(id);
  },
  async query(id, sql, paramsJSON) {
    const connection = connections.get(id);
    if (!connection) throw new Error("DuckDB connection is closed");
    const params = JSON.parse(paramsJSON);
    let table;
    if (params.length) {
      try {
        const prepared = connection.prepare(sql);
        try { table = prepared.query(...params); } finally { prepared.close(); }
      } catch (error) { console.error("DuckDB prepared query failed", sql, params, String(error)); throw error; }
    } else {
      try { table = connection.query(sql); }
      catch (error) { console.error("DuckDB query failed", sql, String(error)); throw error; }
    }
    const fields = table.schema.fields.map(field => ({ Name: field.name, DataTypeID: duckDBOID(String(field.type)) }));
    const rows = table.toArray().map(row => {
      const values = row.toJSON();
      return table.schema.fields.map(field => duckDBCell(values[field.name], String(field.type)));
    });
    return JSON.stringify({ Fields: fields, Rows: rows, AffectedRows: 0 });
  },
};
globalThis.__duckdb = bridge;

const session = await boot();
const run = async (argv, code = 0, answers = []) => {
  const result = await session.run(argv, { timeoutMs: 60000, answers });
  console.log(`$ ptah ${argv.join(" ")}\nexit ${result.code}\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.code, code);
  assert.deepEqual(result.panics, []);
  return result;
};
try {
  const schema = "CREATE TABLE events (id INTEGER PRIMARY KEY, kind VARCHAR NOT NULL);\n";
  session.workspace.writeFile("schema.sql", schema);
  const url = "duckdb://:memory:";
  await run(["db", "capabilities", "--db-url", url]);
  await run(["schema", "apply", "--schema-file", "schema.sql", "--db-url", url, "--dry-run"]);
  await run(["migrations", "plan", "--schema-file", "schema.sql", "--db-url", url]);
  await run(["schema", "apply", "--schema-file", "schema.sql", "--db-url", url], 0, [[/Type 'YES'/, "YES\n"]]);
  await run(["schema", "drift", "--schema-file", "schema.sql", "--db-url", url]);
  session.workspace.writeFile("schema.sql", `${schema}CREATE INDEX events_kind_idx ON events (kind);\n`);
  const indexPlan = await run(["schema", "apply", "--schema-file", "schema.sql", "--db-url", url, "--dry-run"]);
  assert.match(indexPlan.stdout, /CREATE INDEX.*events_kind_idx/);
  await run(["schema", "apply", "--schema-file", "schema.sql", "--db-url", url], 0, [[/Type 'YES'/, "YES\n"]]);
  await run(["schema", "drift", "--schema-file", "schema.sql", "--db-url", url]);
  const id = await bridge.open(":memory:app");
  const answer = JSON.parse(await bridge.query(id, "SELECT table_name FROM duckdb_tables() WHERE table_name='events'", "[]"));
  assert.equal(answer.Rows[0][0], "events");
  await bridge.query(id, "CREATE TABLE computed (a INTEGER, b INTEGER GENERATED ALWAYS AS (a + 1))", "[]");
  const dates = JSON.parse(await bridge.query(id, "SELECT DATE '2026-01-01' AS day, TIMESTAMP '2026-01-01 12:34:56' AS moment", "[]"));
  assert.deepEqual(dates.Rows[0], ["2026-01-01", "2026-01-01T12:34:56.000Z"]);
  await bridge.close(id);
  const inspected = await run(["schema", "inspect", "--db-url", url, "--format", "sql"]);
  assert.match(inspected.stdout, /GENERATED ALWAYS AS/);

  // A separate in-memory database exercises the versioned migration route.
  databases.delete(":memory:app");
  session.memfs.mkdir("/workspace/migrations", 0o755);
  await run(["migrations", "generate", "--schema-file", "schema.sql", "--db-url", url,
    "--migrations-dir", "migrations", "--name", "init"]);
  await run(["migrations", "hash", "--dir", "migrations"]);
  await run(["migrations", "up", "--migrations-dir", "migrations", "--db-url", url]);
  const status = await run(["migrations", "status", "--migrations-dir", "migrations", "--db-url", url]);
  assert.match(status.stdout, /Applied Migrations: 1/);
  await run(["schema", "drift", "--schema-file", "schema.sql", "--db-url", url]);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearInterval(session.keepAlive);
}
