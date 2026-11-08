/** DuckDB-Wasm databases live in nested workers owned by the Ptah worker. */
import * as duckdb from "@duckdb/duckdb-wasm";
import { DUCKDB_WASM_VERSION } from "./engine-versions.ts";
import { duckDBCell, duckDBOID } from "./duckdb-values.ts";

type Connection = duckdb.AsyncDuckDBConnection;
type Database = { engine: duckdb.AsyncDuckDB; worker: Worker; connections: Set<number> };

export async function createDuckDBBridge(base: string) {
  const asset = (name: string) => new URL(`dist/duckdb-${DUCKDB_WASM_VERSION}/${name}`, base).href;
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: asset("duckdb-mvp.wasm"), mainWorker: asset("duckdb-browser-mvp.worker.js") },
    eh: { mainModule: asset("duckdb-eh.wasm"), mainWorker: asset("duckdb-browser-eh.worker.js") },
  });
  const databases = new Map<string, Database>();
  const connections = new Map<number, { database: string; connection: Connection }>();
  let nextHandle = 0;

  async function database(name: string): Promise<Database> {
    let current = databases.get(name);
    if (current) return current;
    const worker = new Worker(bundle.mainWorker!);
    const engine = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    try {
      await engine.instantiate(bundle.mainModule, bundle.pthreadWorker);
      await engine.open({ path: ":memory:", allowUnsignedExtensions: false });
      const conn = await engine.connect();
      try {
        for (const sql of [
          "SET autoinstall_known_extensions = false",
          "SET autoload_known_extensions = false",
          "SET allow_community_extensions = false",
          "SET allow_persistent_secrets = false",
          "SET enable_external_access = false",
        ]) await conn.query(sql);
      } finally { await conn.close(); }
    } catch (error) {
      await engine.terminate();
      worker.terminate();
      throw error;
    }
    current = { engine, worker, connections: new Set() };
    databases.set(name, current);
    return current;
  }

  async function open(name: string): Promise<number> {
    const db = await database(name);
    const connection = await db.engine.connect();
    const id = ++nextHandle;
    connections.set(id, { database: name, connection });
    db.connections.add(id);
    return id;
  }
  async function close(id: number): Promise<void> {
    const held = connections.get(id);
    if (!held) return;
    connections.delete(id);
    databases.get(held.database)?.connections.delete(id);
    await held.connection.close();
  }
  function held(id: number): Connection {
    const conn = connections.get(id);
    if (!conn) throw new Error("DuckDB connection is closed");
    return conn.connection;
  }

  async function query(id: number, sql: string, paramsJSON: string) {
    const conn = held(id);
    const params = JSON.parse(paramsJSON) as unknown[];
    let result;
    if (params.length === 0) result = await conn.query(sql);
    else {
      const prepared = await conn.prepare(sql);
      try { result = await prepared.query(...params); }
      finally { await prepared.close(); }
    }
    const fields = result.schema.fields.map(field => ({ Name: field.name, DataTypeID: duckDBOID(String(field.type)) }));
    const rows = result.toArray().map(row => {
      const values = row.toJSON() as Record<string, unknown>;
      return result.schema.fields.map(field => duckDBCell(values[field.name], String(field.type)));
    });
    const affectedRows = fields.length === 1 && /^Count$/i.test(fields[0]!.Name) ? Number(rows[0]?.[0] ?? 0) : 0;
    return JSON.stringify({ Fields: fields, Rows: rows, AffectedRows: affectedRows });
  }
  async function sql(name: string, text: string) {
    const id = await open(name);
    try {
      const result = JSON.parse(await query(id, text, "[]")) as { Fields: { Name: string }[]; Rows: (string | null)[][] };
      return { columns: result.Fields.map(field => field.Name), rows: result.Rows };
    } finally { await close(id); }
  }
  async function exec(name: string, text: string) {
    const id = await open(name);
    try { await query(id, text, "[]"); }
    finally { await close(id); }
  }
  async function drop(name: string) {
    const db = databases.get(name);
    if (!db) return;
    if (db.connections.size !== 0) throw new Error("Cannot reset DuckDB while a command is using it");
    databases.delete(name);
    await db.engine.terminate();
    db.worker.terminate();
  }
  async function info() {
    const version = (await sql(":memory:app", "SELECT version()" )).rows[0]?.[0] ?? "unknown";
    return { engine: "duckdb" as const, version, packageVersion: DUCKDB_WASM_VERSION };
  }
  return { open, close, query, sql, exec, drop, info };
}

export type DuckDBBridge = Awaited<ReturnType<typeof createDuckDBBridge>>;
