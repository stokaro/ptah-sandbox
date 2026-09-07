/**
 * The Worker the playground runs Ptah in.
 *
 * Boot order matters and is not negotiable:
 *
 *   1. install globalThis.fs / process / path, BEFORE wasm_exec.js loads --
 *      Go reads them the moment the program starts, and wasm_exec.js installs
 *      read-only ENOSYS stubs over anything missing;
 *   2. initialize SQLite and install the bridge, because the Go driver
 *      resolves globalThis.__sqlite on its first connection;
 *   3. install __ptahHost, because Go resolves it once at startup and holds
 *      the object, so it cannot be swapped afterwards;
 *   4. instantiate ptah.wasm and go.run() -- never awaited, since the program
 *      parks on select{} and only ends with the Worker.
 *
 * Everything here is synchronous once booted. sqlite3.mjs is async only to
 * initialize; after that its C API is a plain call, which is what lets Go
 * drive it through syscall/js at all.
 */

import { createRuntime, type Runtime } from "./runtime/index.ts";
import {
  createSqliteBridge,
  installSqliteBridge,
  type SqliteBridge,
} from "./runtime/sqlite-bridge.ts";

import type {
  BootPhase,
  HostEvent,
  WorkerRequest,
  ReadyInfo,
} from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

/** Set by wasm_exec.js. */
declare class Go {
  argv: string[];
  env: Record<string, string>;
  exit: (code: number) => void;
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

/** Contract B, Go's half. Installed by cmd/ptah-wasm once it is running. */
interface PtahGoHalf {
  start(runId: number, argv: string[]): void;
  pushStdin(runId: number, data: string): void;
  cancel(runId: number): void;
}

let runtime: Runtime | null = null;
let sqlite: SqliteBridge | null = null;
let ptah: PtahGoHalf | null = null;

function post(event: HostEvent): void {
  self.postMessage(event);
}

/**
 * Loads wasm_exec.js, which installs globalThis.Go.
 *
 * Through import() rather than importScripts(): this is a module worker, where
 * importScripts does not exist at all. The file is a plain IIFE that assigns
 * `globalThis.Go = class` and touches no CommonJS, so evaluating it as a
 * module has the same effect a <script> tag would.
 *
 * It is loaded rather than bundled because it must byte-match the toolchain
 * that built ptah.wasm; a minifier or a version bump would desync the pair
 * silently, and the manifest records its hash for exactly that reason.
 */
async function loadWasmExec(base: string): Promise<void> {
  await import(/* @vite-ignore */ new URL("vendor/ptah/wasm_exec.js", base).href);
  if (typeof (self as unknown as { Go?: unknown }).Go !== "function") {
    throw new Error("wasm_exec.js did not install globalThis.Go");
  }
}

/**
 * Downloads and compiles ptah.wasm, reporting real bytes as they arrive.
 *
 * The counting stream sits between fetch and compileStreaming rather than
 * replacing it, so the module still compiles as it downloads instead of being
 * buffered first. `total` comes from the manifest because Content-Length on a
 * gzipped response is the ENCODED length while response.body yields decoded
 * bytes -- dividing one by the other would show 500%.
 */
async function compileWithProgress(url: string, total: number): Promise<WebAssembly.Module> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`fetch ${url}: ${response.status} ${response.statusText}`);
  }

  let loaded = 0;
  let lastPost = 0;
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        // One message per ~50 ms. A 124 MB module arrives in thousands of
        // chunks, and a postMessage per chunk would cost more than the render.
        const now = Date.now();
        if (now - lastPost > 50) {
          lastPost = now;
          post({ type: "progress", phase: "downloading", loaded, total });
        }
        controller.enqueue(chunk);
      },
      flush() {
        post({ type: "progress", phase: "downloading", loaded, total: Math.max(total, loaded) });
        post({ type: "progress", phase: "compiling", loaded, total: Math.max(total, loaded) });
      },
    }),
  );

  return WebAssembly.compileStreaming(
    new Response(counted, { headers: { "content-type": "application/wasm" } }),
  );
}

function phase(name: BootPhase): void {
  post({ type: "progress", phase: name, loaded: 0, total: 0 });
}

async function boot(base: string): Promise<ReadyInfo> {
  runtime = createRuntime({ install: true });

  // Go's runtime panic path calls fs.writeSync directly, bypassing Contract B
  // entirely. Without these two, a panic message is swallowed and the UI shows
  // a hung run with no diagnostic.
  runtime.memfs.setStdout((text) => post({ type: "stray", stream: "stdout", text }));
  runtime.memfs.setStderr((text) => post({ type: "stray", stream: "stderr", text }));

  const manifest = await (await fetch(new URL("vendor/ptah/manifest.json", base).href)).json();

  // SQLite is ~1 MB and Ptah is ~124 MB, so initializing the first while the
  // second downloads costs nothing and removes it from the critical path. Both
  // must finish before Go starts: the driver resolves the bridge on its first
  // connection, and nothing may run before that.
  const compiled = compileWithProgress(
    new URL("vendor/ptah/ptah.wasm", base).href,
    Number(manifest?.wasm?.bytes) || 0,
  );

  const sqliteReady = (async () => {
    const initModule = (await import(new URL("vendor/sqlite/sqlite3.mjs", base).href)).default;
    // No instantiateWasm shim here: unlike Node, the browser's fetch resolves
    // the sibling sqlite3.wasm the glue asks for.
    const bridge = await createSqliteBridge({ initModule, initArgs: { printErr: () => {} } });
    installSqliteBridge(bridge);
    return bridge;
  })();

  const [module, bridge] = await Promise.all([compiled, sqliteReady]);
  sqlite = bridge;

  phase("initializing SQLite");
  await loadWasmExec(base);
  phase("starting");

  const ready = new Promise<ReadyInfo>((resolve) => {
    (self as unknown as { __ptahHost: unknown }).__ptahHost = {
      stdout: (runId: number, text: string) => post({ type: "stdout", runId, text }),
      stderr: (runId: number, text: string) => post({ type: "stderr", runId, text }),
      done: (runId: number, code: number) => post({ type: "done", runId, code }),
      ready: (info: ReadyInfo) => resolve(info),
      panic: (message: string) => post({ type: "panic", message }),
      truncated: (runId: number, limitBytes: number) =>
        post({ type: "truncated", runId, limitBytes }),
    };
  });

  const go = new (self as unknown as { Go: typeof Go }).Go();
  go.argv = ["ptah"];
  go.env = runtime.env;
  go.exit = (code: number) => {
    throw new Error(`ptah-wasm called os.Exit(${code}); it must never exit`);
  };

  const instance = await WebAssembly.instantiate(module, go.importObject);
  void go.run(instance).catch((err: unknown) => {
    post({ type: "fatal", message: `go.run failed: ${String(err)}` });
  });

  const info = await ready;
  ptah = (self as unknown as { __ptah: PtahGoHalf }).__ptah;
  return info;
}

self.onerror = (e) => { post({ type: "fatal", message: `worker onerror: ${String(e)}` }); };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "init": {
        const info = await boot(msg.base);
        post({ type: "ready", info, sqlite: sqlite!.info() });
        return;
      }
      case "run": {
        if (!ptah) throw new Error("worker: not initialized");
        ptah.start(msg.runId, msg.argv);
        return;
      }
      case "stdin": {
        if (!ptah) throw new Error("worker: not initialized");
        ptah.pushStdin(msg.runId, msg.data);
        return;
      }
      case "cancel": {
        if (!ptah) throw new Error("worker: not initialized");
        ptah.cancel(msg.runId);
        return;
      }
      case "writeFile": {
        runtime!.workspace.writeFile(msg.path, msg.text);
        post({ type: "wrote", path: msg.path, revision: runtime!.workspace.revision() });
        return;
      }
      case "readFile": {
        post({ type: "file", path: msg.path, text: runtime!.workspace.readText(msg.path) });
        return;
      }
      case "listFiles": {
        post({ type: "files", entries: runtime!.workspace.list(msg.dir) });
        return;
      }
      case "sql": {
        const rows = querySQL(msg.path, msg.sql);
        post({ type: "sql", id: msg.id, rows });
        return;
      }
      case "execSQL": {
        const handle = sqlite!.open(msg.path);
        try {
          sqlite!.exec(handle, msg.sql);
        } finally {
          sqlite!.close(handle);
        }
        post({ type: "sqlDone", id: msg.id });
        return;
      }
      default: {
        const never: never = msg;
        throw new Error(`worker: unknown request ${JSON.stringify(never)}`);
      }
    }
  } catch (err) {
    post({ type: "error", request: msg.type, message: String(err) });
  }
};

/** Runs one statement and returns its rows as plain values. */
function querySQL(path: string, sql: string): { columns: string[]; rows: unknown[][] } {
  const handle = sqlite!.open(path);
  try {
    const { stmt } = sqlite!.prepare(handle, sql);
    try {
      const columns = sqlite!.columns(stmt);
      const rows: unknown[][] = [];
      for (;;) {
        const batch = sqlite!.fetch(stmt, 256);
        for (let r = 0; r < batch.n; r++) {
          rows.push(batch.values.slice(r * columns.length, (r + 1) * columns.length));
        }
        if (batch.done) break;
      }
      return { columns, rows };
    } finally {
      sqlite!.finalize(stmt);
    }
  } finally {
    sqlite!.close(handle);
  }
}
