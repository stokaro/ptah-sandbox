/** Real PostgreSQL. Every database is ephemeral and confined to this worker. */
import { PGlite } from "@electric-sql/pglite";

import { PGLITE_VERSION } from "./engine-versions.ts";

export async function createPostgresBridge(base?: string) {
  const assets = base === undefined ? {} : await (async () => {
    const root = new URL(`dist/pglite-${PGLITE_VERSION}/`, base);
    const fetchAsset = async (name: string) => {
      const r = await fetch(new URL(name, root));
      if (!r.ok) throw new Error(`PGlite ${name}: HTTP ${r.status}`);
      return r;
    };
    const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
      fetchAsset("pglite.wasm").then((r) => WebAssembly.compileStreaming(r)),
      fetchAsset("initdb.wasm").then((r) => WebAssembly.compileStreaming(r)),
      fetchAsset("pglite.data").then((r) => r.blob()),
    ]);
    return { pgliteWasmModule, initdbWasmModule, fsBundle };
  })();
  const databases = new Map<string, PGlite>();
  const parsers = new Map<string, Record<number, (text: string) => string>>();
  let handle = 0;
  let leased: number | null = null;
  async function database(path: string) {
    let db = databases.get(path);
    if (!db) {
      db = await PGlite.create({ dataDir: "memory://", ...assets });
      const types = await db.query<{ oid: number }>("SELECT oid FROM pg_type");
      parsers.set(path, Object.fromEntries(types.rows.map(({ oid }) => [oid, (text: string) => text])));
      databases.set(path, db);
    }
    return db;
  }
  // Initialize once before installing the bridge. Concurrent UI reads can then
  // use PGlite's query queue without racing instance creation.
  await database("app");
  const bridge = {
    async open() {
      if (leased !== null) throw new Error("PGlite has one PostgreSQL session; a connection is already in use");
      leased = ++handle;
      return leased;
    },
    async close(id: number) {
      if (leased !== id) return;
      try {
        const db = await database("app");
        await db.exec("ROLLBACK");
        await db.exec("DISCARD ALL");
      } finally { leased = null; }
    },
    async query(id: number, sql: string, paramsJSON: string) {
      if (id !== leased) throw new Error("PostgreSQL connection is closed");
      const db = await database("app");
      const params = JSON.parse(paramsJSON) as unknown[];
      const rawParsers = parsers.get("app")!;
      const serializers = Object.fromEntries(Object.keys(rawParsers).map(oid => [oid, (value: unknown) => String(value)]));
      const options = { rowMode: "array" as const, parsers: rawParsers, serializers };
      const results = params.length ? [await db.query(sql, params, options)] : await db.exec(sql, options);
      const result = results.at(-1) ?? { fields: [], rows: [], affectedRows: 0 };
      return JSON.stringify(result);
    },
    async sql(path: string, sql: string) {
      const db = await database(path);
      const results = await db.exec(sql, { rowMode: "array", parsers: parsers.get(path)! });
      const result = results.at(-1);
      return { columns: result?.fields.map((f) => f.name) ?? [], rows: (result?.rows ?? []) as unknown as unknown[][] };
    },
    async exec(path: string, sql: string) { await (await database(path)).exec(sql); },
    async drop(path: string) {
      if (leased !== null) throw new Error("Cannot reset PostgreSQL during a command");
      await databases.get(path)?.close();
      databases.delete(path); parsers.delete(path);
      await database(path);
    },
    async serialize(path: string) {
      return new Uint8Array(await (await (await database(path)).dumpDataDir("gzip")).arrayBuffer());
    },
    async info() {
      const r = await (await database("app")).query<{ version: string }>("SELECT version()");
      return { engine: "postgres" as const, version: r.rows[0]!.version, packageVersion: PGLITE_VERSION };
    },
  };
  return bridge;
}
export type PostgresBridge = Awaited<ReturnType<typeof createPostgresBridge>>;
