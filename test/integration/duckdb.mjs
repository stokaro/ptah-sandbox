/** Real Ptah wasm, official DuckDB provider code, and DuckDB-Wasm. */
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { boot } from "./harness.mjs";
import { duckDBCell, duckDBOID } from "../../web/src/runtime/duckdb-values.ts";
import { scenarioById, scenarioForEngine, applyPatch } from "../../web/src/scenario.ts";

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
async function resetDatabase() {
  // Node's blocking binding cannot be reset and reopened reliably in this
  // version. Keep its engine alive and clear the tables between scenario runs.
  const db = await database(":memory:app");
  const connection = db.connect();
  try {
    for (const table of ["tasks", "users", "computed", "events", "schema_migrations"]) {
      connection.query(`DROP TABLE IF EXISTS "${table}"`);
    }
  } finally { connection.close(); }
}
const bridge = {
  async open(name) {
    const connection = (await database(name)).connect();
    const id = ++next;
    connections.set(id, { name, connection });
    return id;
  },
  async close(id) {
    connections.get(id)?.connection?.close();
    connections.delete(id);
  },
  async query(id, sql, paramsJSON) {
    const held = connections.get(id);
    if (!held) throw new Error("DuckDB connection is closed");
    if (!held.connection) held.connection = (await database(held.name)).connect();
    const connection = held.connection;
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
const url = "duckdb://:memory:";
const run = async (argv, code = 0, answers = []) => {
  const result = await session.run(argv, { timeoutMs: 60000, answers });
  console.log(`$ ptah ${argv.join(" ")}\nexit ${result.code}\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.code, code);
  assert.deepEqual(result.panics, []);
  return result;
};
try {
  // Run the actual presets visitors see, including their seeded data and edits.
  for (const scenarioID of ["a", "b", "c", "free"]) {
    await resetDatabase();
    for (const file of session.workspace.list("/workspace")) session.workspace.remove(file.name);
    const scenario = scenarioForEngine(scenarioById(scenarioID), "duckdb");
    for (const [file, content] of Object.entries(scenario.files)) session.workspace.writeFile(file, content);
    if (scenario.seed.trim()) {
      const connection = await bridge.open(":memory:app");
      await bridge.query(connection, scenario.seed, "[]");
      await bridge.close(connection);
    }
    console.log(`DuckDB scenario ${scenarioID}`);
    const flags = ["--schema-file", "schema.sql", "--db-url", url];
    if (scenarioID === "a") {
      await run(["schema", "drift", ...flags]);
      const edit = scenario.steps.find(step => step.action?.kind === "edit").action;
      const patched = applyPatch(scenario.files["schema.sql"], edit.patch);
      assert.equal(patched.state, "applies");
      session.workspace.writeFile("schema.sql", patched.text);
      await run(["schema", "apply", ...flags, "--dry-run"]);
      await run(["schema", "apply", ...flags], 0, [[/Type 'YES'/, "YES\n"]]);
      await run(["schema", "drift", ...flags]);
      const connection = await bridge.open(":memory:app");
      const answer = JSON.parse(await bridge.query(connection, "SELECT count(*) AS n FROM users", "[]"));
      assert.equal(Number(answer.Rows[0][0]), 3);
      await bridge.close(connection);
    } else if (scenarioID === "b") {
      await run(["schema", "drift", ...flags]);
      const connection = await bridge.open(":memory:app");
      await bridge.query(connection, "ALTER TABLE users ADD COLUMN nickname TEXT", "[]");
      await bridge.close(connection);
      await run(["schema", "drift", ...flags], 1);
      await run(["schema", "drift", ...flags, "--format", "json"], 1);
      session.workspace.writeFile("schema.sql", scenario.files["schema.sql"].replace("  email TEXT NOT NULL\n", "  email TEXT NOT NULL,\n  nickname TEXT\n"));
      await run(["schema", "drift", ...flags]);
    } else if (scenarioID === "c") {
      await run(["migrations", "plan", ...flags]);
      session.memfs.mkdir("/workspace/migrations", 0o755);
      await run(["migrations", "generate", ...flags, "--migrations-dir", "migrations", "--name", "init"]);
      await run(["migrations", "hash", "--dir", "migrations"]);
      await run(["migrations", "validate", "--dir", "migrations"]);
      await run(["migrations", "up", "--migrations-dir", "migrations", "--db-url", url]);
      await run(["migrations", "status", "--migrations-dir", "migrations", "--db-url", url]);
      await run(["schema", "drift", ...flags]);
    } else {
      await run(["schema", "drift", ...flags]);
    }
  }
  await resetDatabase();
  const schema = "CREATE TABLE events (id INTEGER PRIMARY KEY, kind VARCHAR NOT NULL);\n";
  session.workspace.writeFile("schema.sql", schema);
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
  await resetDatabase();
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
