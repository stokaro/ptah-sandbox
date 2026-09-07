"use strict";
// Contract B harness. Browser-shaped: globalThis.fs / process / path are the
// pure-JS in-memory shim; node's fs is used only to read the .wasm bytes.
const nodeFs = require("fs");
const nodePath = require("path");
const nodeProc = require("process");
const { installMemFS } = require("./memfs.js");

// ---- filesystem ---------------------------------------------------------
// Deliberately NOT pre-created: /workspace, /tmp and /home/play must be made
// by the Go side, and the cwd must be moved there by the Go side.
const strayOut = [];
const strayErr = [];
const { memfs, fs, process: proc, path } = installMemFS({
  jailRoot: null,
  stdout: (s) => strayOut.push(s),
  stderr: (s) => strayErr.push(s),
});
globalThis.fs = fs;
globalThis.process = proc;
globalThis.path = path;

// ---- Contract A stub ----------------------------------------------------
// Only enough shape for the Go side to find it. No command exercised here
// opens a database.
globalThis.__sqlite = {
  open: () => 1, close: () => {}, drop: () => {}, exists: () => false,
  exec: () => {}, prepare: () => ({ stmt: 1, tail: "" }),
  info: () => ({ version: "3.53.4", sourceId: "stub", compileOptions: [], vfs: [] }),
};

// ---- Contract B ---------------------------------------------------------
const runs = new Map();
let readyInfo = null;
let readyResolve;
const readyPromise = new Promise((r) => { readyResolve = r; });
let panics = [];

function slot(runId) {
  let s = runs.get(runId);
  if (!s) {
    s = { out: [], err: [], code: null, calls: 0, truncated: null, resolve: null };
    s.finished = new Promise((r) => { s.resolve = r; });
    runs.set(runId, s);
  }
  return s;
}

globalThis.__ptahHost = {
  stdout(runId, text) { const s = slot(runId); s.out.push(text); s.calls++; },
  stderr(runId, text) { const s = slot(runId); s.err.push(text); s.calls++; },
  done(runId, code) { const s = slot(runId); s.code = code; s.resolve(code); },
  ready(info) { readyInfo = info; readyResolve(info); },
  panic(message) { panics.push(message); },
  truncated(runId, limit) { slot(runId).truncated = limit; },
};
if (nodeProc.env.NOTRUNCHOOK) delete globalThis.__ptahHost.truncated;
if (nodeProc.env.MAXOUT) globalThis.__ptahHost.maxOutputBytes = Number(nodeProc.env.MAXOUT);

// ---- Go runtime ---------------------------------------------------------
globalThis.TextEncoder = require("util").TextEncoder;
globalThis.TextDecoder = require("util").TextDecoder;
globalThis.crypto ??= require("crypto");
globalThis.performance ??= require("perf_hooks").performance;
const GOROOT = require("child_process").execSync("go env GOROOT").toString().trim();
require(nodePath.join(GOROOT, "lib/wasm/wasm_exec.js"));

const wasmPath = nodeProc.argv[2] || nodePath.join(__dirname, "ptah.wasm");
const go = new Go();
go.argv = ["ptah"];
go.env = {};            // empty on purpose: prepareEnvironment must fill it
go.exit = (code) => { console.log("!!! Go instance exited with", code); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reportRun(label, runId, s, extra) {
  console.log(`\n=== ${label} ===`);
  console.log(`--- exit: ${s.code}`);
  console.log("--- stdout ---");
  nodeProc.stdout.write(s.out.join(""));
  console.log("--- stderr ---");
  nodeProc.stdout.write(s.err.join(""));
  console.log(`--- host calls: ${s.calls}${extra ? " " + extra : ""}`);
}

async function run(label, runId, argv, opts = {}) {
  const s = slot(runId);
  let doneDuringStart = false;
  const watch = () => { if (s.code !== null) doneDuringStart = true; };
  globalThis.__ptah.start(runId, argv);
  watch();
  if (opts.stdin !== undefined) {
    await sleep(opts.stdinDelayMs ?? 20);
    for (const chunk of [].concat(opts.stdin)) globalThis.__ptah.pushStdin(runId, chunk);
  }
  if (opts.cancelAfterMs !== undefined) {
    await sleep(opts.cancelAfterMs);
    globalThis.__ptah.cancel(runId);
  }
  await s.finished;
  reportRun(label, runId, s, `done-inside-start=${doneDuringStart}` +
    (s.truncated !== null ? ` truncated-at=${s.truncated}` : ""));
  return s;
}

(async () => {
  const bytes = nodeFs.readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
  go.run(instance);                                    // never resolves by design
  await readyPromise;

  console.log("=== ready ===");
  console.log(JSON.stringify({
    version: readyInfo.version, commit: readyInfo.commit, goVersion: readyInfo.goVersion,
  }, null, 2));
  console.log("commands (" + readyInfo.commands.length + "):");
  console.log("  " + readyInfo.commands.join("\n  "));
  console.log("cwd after startup: " + proc.cwd());
  console.log("dirs: " + ["/workspace", "/tmp", "/home/play"]
    .map((d) => { try { return d + "=" + memfs.lookup(memfs.resolve(d)).type; } catch (e) { return d + "=MISSING"; } })
    .join(" "));

  await run("ptah version", 1, ["version"]);
  await run("ptah schema --help", 2, ["schema", "--help"]);
  await run("ptah --help", 3, ["--help"]);
  await run("ptah nosuchcommand", 4, ["nosuchcommand"]);
  await run("ptah schema apply (no source)", 5, ["schema", "apply"]);
  await run("argv with a leading program name", 6, ["ptah", "version"]);
  await run("bad argv type", 7, [1, 2]);

  await run("sql lint --stdin (stdin then EOF)", 20,
    ["sql", "lint", "--stdin", "--dialect", "sqlite"],
    { stdin: ["CREATE TABLE t (id INTEGER PRIMARY KEY);\n", ""] });
  await run("sql lint --stdin (EOF only)", 21,
    ["sql", "lint", "--stdin", "--dialect", "sqlite"], { stdin: [""] });
  await run("sql lint --stdin (canceled while blocked)", 22,
    ["sql", "lint", "--stdin", "--dialect", "sqlite"], { cancelAfterMs: 40 });
  await run("completion bash (large output)", 23, ["completion", "bash"]);

  // stdin pushed synchronously, before the deferred start has run at all.
  console.log("\n=== stdin pushed in the same tick as start ===");
  const early = slot(30);
  globalThis.__ptah.start(30, ["sql", "lint", "--stdin", "--dialect", "sqlite"]);
  globalThis.__ptah.pushStdin(30, "CREATE TABLE early (id INTEGER PRIMARY KEY);\n");
  globalThis.__ptah.pushStdin(30, "");
  await early.finished;
  reportRun("run 30", 30, early);

  // Two starts in flight: the second must be refused through its own done.
  console.log("\n=== concurrent start ===");
  const first = slot(10), second = slot(11);
  globalThis.__ptah.start(10, ["schema", "--help"]);
  globalThis.__ptah.start(11, ["version"]);
  await Promise.all([first.finished, second.finished]);
  reportRun("run 10", 10, first);
  reportRun("run 11 (refused)", 11, second);

  console.log("\n=== stray fd 1/2 traffic (should be empty) ===");
  console.log("fd1: " + JSON.stringify(strayOut));
  console.log("fd2: " + JSON.stringify(strayErr));
  console.log("panics: " + JSON.stringify(panics));
  nodeProc.exit(0);
})().catch((e) => { console.error("HARNESS ERROR:", e); nodeProc.exit(1); });
