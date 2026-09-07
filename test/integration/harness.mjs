/**
 * Stands the whole playground runtime up outside a browser.
 *
 * Everything the worker will do, in the order it must happen:
 *
 *   1. install globalThis.fs / process / path   (the MemFS)
 *   2. install globalThis.__sqlite              (Contract A, real SQLite wasm)
 *   3. install globalThis.__ptahHost            (Contract B, host half)
 *   4. load wasm_exec.js, instantiate ptah.wasm, go.run()
 *   5. wait for __ptahHost.ready(), then drive globalThis.__ptah
 *
 * The only Node-specific pieces are reading the two .wasm files off disk and
 * the instantiateWasm shim sqlite3.mjs needs because Node's fetch refuses
 * file: URLs. Nothing else here differs from the worker bootstrap.
 */

import { readFileSync } from "node:fs";
import nodeProcess from "node:process";

import { createRuntime } from "../../web/src/runtime/index.ts";
import { createSqliteBridge, installSqliteBridge } from "../../web/src/runtime/sqlite-bridge.ts";

const REPO = new URL("../../", import.meta.url);
const SQLITE_MJS = new URL("web/vendor/sqlite/sqlite3.mjs", REPO);
const SQLITE_WASM = new URL("web/vendor/sqlite/sqlite3.wasm", REPO);
const PTAH_WASM = new URL("web/vendor/ptah/ptah.wasm", REPO);
const WASM_EXEC = new URL("web/vendor/ptah/wasm_exec.js", REPO);

/** Contract A methods, in the order the contract lists them. */
const SQLITE_METHODS = [
  "open", "close", "drop", "exists",
  "exec",
  "prepare", "bindNull", "bindInt", "bindFloat", "bindText", "bindBlob",
  "columns", "step", "fetch", "reset", "finalize",
  "changes", "lastInsertRowid",
  "begin", "commit", "rollback",
  "limitAttachedZero", "setDeadline", "interrupt",
  "serialize", "deserialize", "info",
];

/**
 * Wrap the bridge so the harness can assert on what Go actually asked for.
 *
 * The counters are the only way to prove things like "each command opened and
 * closed its own connection" from outside: the bridge keeps its handle table
 * in private fields, and reading them would be reading the implementation
 * rather than the behavior.
 */
function recordingBridge(bridge) {
  const calls = Object.create(null);
  const openPaths = [];
  const live = new Set();
  const wrapped = {};
  for (const name of SQLITE_METHODS) {
    if (typeof bridge[name] !== "function") {
      throw new Error(`sqlite bridge is missing Contract A method ${name}()`);
    }
    wrapped[name] = (...args) => {
      calls[name] = (calls[name] ?? 0) + 1;
      const result = bridge[name](...args);
      if (name === "open") {
        openPaths.push(args[0]);
        live.add(result);
      } else if (name === "close") {
        live.delete(args[0]);
      }
      return result;
    };
  }
  wrapped.__stats = () => ({ calls: { ...calls }, openPaths: [...openPaths], liveHandles: [...live] });
  wrapped.__reset = () => {
    for (const key of Object.keys(calls)) delete calls[key];
    openPaths.length = 0;
  };
  return wrapped;
}

/** Load wasm_exec.js the way a <script> tag would: it installs globalThis.Go. */
function loadWasmExec() {
  const source = readFileSync(WASM_EXEC, "utf8");
  // Indirect eval, so the IIFE runs in global scope where it expects to be.
  (0, eval)(source);
  if (typeof globalThis.Go !== "function") {
    throw new Error("wasm_exec.js did not install globalThis.Go");
  }
}

/**
 * One run of one command, as Contract B sees it.
 *
 * `answers` is how the prompt is driven: each entry is [pattern, text], and
 * the text is pushed the first time the pattern matches the stdout accumulated
 * so far. That is exactly what the UI has to do -- the confirmation prompt has
 * no trailing newline, so there is nothing else to trigger on. An empty text
 * is EOF, per Contract B; that is how a run with no answer is ended, because
 * there is no /dev/null here to close the stream on the command's behalf.
 */
class Run {
  constructor(id, argv, options = {}) {
    this.id = id;
    this.argv = argv;
    this.stdout = "";
    this.stderr = "";
    this.code = null;
    this.truncated = null;
    this.panics = [];
    this.answers = (options.answers ?? []).map(([pattern, text]) => ({ pattern, text, sent: false }));
    this.sent = [];
    this.timedOut = false;
    this.settle = null;
    this.finished = new Promise((resolve) => { this.settle = resolve; });
  }
}

export class Session {
  constructor(runtime, bridge) {
    this.runtime = runtime;
    this.memfs = runtime.memfs;
    this.workspace = runtime.workspace;
    this.sqlite = bridge;
    this.go = null;
    this.ready = null;
    /** Every run this harness has started, by run id. */
    this.runs = new Map();
    /** Contract B traffic for a run id the harness never started. */
    this.unknown = [];
    /** Anything that reached fd 1 or fd 2. Go's own output never should. */
    this.stray = { stdout: "", stderr: "" };
    this.nextRunId = 1;
    this.keepAlive = null;
  }

  /**
   * Run one command to completion.
   *
   * Mirrors the per-command lifecycle the worker owes the runtime: wipe /tmp
   * and reset the fd 0 queue before the command sees them.
   */
  async run(argv, options = {}) {
    this.memfs.clearTemp();
    this.memfs.resetStdin();
    const run = this.start(this.nextRunId++, argv, options);
    if (options.stdin !== undefined) this.pushStdin(run.id, options.stdin);
    const limit = options.timeoutMs ?? 60000;
    // A command blocked on stdin nobody feeds would hang the whole suite.
    // Cancel it instead, so the failure is a failing assertion and not silence.
    const timer = setTimeout(() => {
      run.timedOut = true;
      globalThis.__ptah.cancel(run.id);
    }, limit);
    try {
      await run.finished;
    } finally {
      clearTimeout(timer);
    }
    if (run.timedOut) {
      throw new Error(`harness: "${argv.join(" ")}" did not finish within ${limit} ms; it was canceled`);
    }
    return run;
  }

  /**
   * Register a run and call __ptah.start, without waiting. Used directly only
   * to test what a second start does while the first is still in flight.
   */
  start(runId, argv, options = {}) {
    if (this.runs.has(runId)) throw new Error(`harness: run id ${runId} is already in use`);
    const run = new Run(runId, argv, options);
    this.runs.set(runId, run);
    globalThis.__ptah.start(runId, argv);
    return run;
  }

  pushStdin(runId, text) {
    globalThis.__ptah.pushStdin(runId, text);
  }

  cancel(runId) {
    globalThis.__ptah.cancel(runId);
  }

  close() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }
}

/**
 * Deliver a Contract B chunk, then answer the prompt if this chunk completed
 * one. Answers are matched on stdout only, which is where Ptah prints the
 * confirmation prompt.
 */
function deliver(session, runId, target, text) {
  const run = session.runs.get(runId);
  if (!run) {
    session.unknown.push({ runId, target, text });
    return;
  }
  run[target] += text;
  if (target !== "stdout") return;
  for (const answer of run.answers) {
    if (answer.sent || !answer.pattern.test(run.stdout)) continue;
    answer.sent = true;
    run.sent.push(answer.text);
    globalThis.__ptah.pushStdin(runId, answer.text);
  }
}

export async function boot(options = {}) {
  const runtime = createRuntime({ install: true, limits: options.limits });

  const initModule = (await import(SQLITE_MJS.href)).default;
  const initArgs = {
    // Node's fetch refuses file: URLs; the browser takes the normal path.
    instantiateWasm(imports, onSuccess) {
      return WebAssembly.instantiate(readFileSync(SQLITE_WASM), imports)
        .then((r) => onSuccess(r.instance, r.module));
    },
    printErr: () => {},
  };
  // Under Node the glue logs two failures installing the OPFS VFSes (there is
  // no `location`). Expected here, never in a browser.
  const warn = console.warn;
  console.warn = (...a) => { if (!/Ignoring inability to install/.test(String(a[0]))) warn(...a); };
  const real = await createSqliteBridge({ initModule, initArgs });
  console.warn = warn;
  const bridge = recordingBridge(real);
  installSqliteBridge(bridge);

  loadWasmExec();

  const session = new Session(runtime, bridge);

  // Go's runtime panic and throw path calls fs.writeSync directly, bypassing
  // Contract B. Nothing else should ever reach fd 1 or fd 2, so everything
  // that does is collected separately and asserted to be empty.
  runtime.memfs.setStdout((text) => { session.stray.stdout += text; });
  runtime.memfs.setStderr((text) => { session.stray.stderr += text; });

  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

  // Contract B, host half. Go resolves this object once at startup and holds
  // it, so it cannot be swapped later.
  globalThis.__ptahHost = {
    stdout: (runId, text) => deliver(session, runId, "stdout", text),
    stderr: (runId, text) => deliver(session, runId, "stderr", text),
    done: (runId, code) => {
      const run = session.runs.get(runId);
      if (!run) {
        session.unknown.push({ runId, target: "done", code });
        return;
      }
      run.code = code;
      run.settle();
    },
    ready: (info) => { session.ready = info; resolveReady(info); },
    panic: (message) => {
      // No run id on this one; attribute it to whatever has not finished.
      const open = [...session.runs.values()].filter((r) => r.code === null);
      if (open.length === 1) open[0].panics.push(message);
      else session.stray.stderr += `[panic] ${message}\n`;
    },
    truncated: (runId, limitBytes) => {
      const run = session.runs.get(runId);
      if (run) run.truncated = limitBytes;
    },
  };

  const go = new globalThis.Go();
  go.argv = ["ptah"];
  go.env = runtime.env;
  go.exit = (code) => { throw new Error(`ptah-wasm called os.Exit(${code}); it must never exit`); };
  session.go = go;

  const { instance } = await WebAssembly.instantiate(readFileSync(PTAH_WASM), go.importObject);
  // Never awaited: the program blocks on select{} and only ends with the page.
  go.run(instance).catch((err) => {
    nodeProcess.stderr.write(`go.run failed: ${err && err.stack ? err.stack : err}\n`);
    nodeProcess.exitCode = 1;
  });

  // A Go program parked in select{} leaves Node's event loop empty between
  // runs, and an empty loop makes Node exit silently mid-suite.
  session.keepAlive = setInterval(() => {}, 1000);

  await readyPromise;
  return session;
}
