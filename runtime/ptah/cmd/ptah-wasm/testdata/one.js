"use strict";
// Runs a single argv through Contract B and writes raw stdout/stderr, so the
// bytes can be diffed against the native transcripts.
const nodeFs = require("fs");
const nodePath = require("path");
const nodeProc = require("process");
const { installMemFS } = require("./memfs.js");
const { fs, process: proc, path } = installMemFS({ jailRoot: null, stdout: () => {}, stderr: () => {} });
globalThis.fs = fs; globalThis.process = proc; globalThis.path = path;
globalThis.__sqlite = { info: () => ({}) };
const out = [], err = [];
let code = null, readyResolve;
const readyP = new Promise((r) => { readyResolve = r; });
let donePromiseResolve;
const doneP = new Promise((r) => { donePromiseResolve = r; });
globalThis.__ptahHost = {
  stdout: (_, t) => out.push(t), stderr: (_, t) => err.push(t),
  done: (_, c) => { code = c; donePromiseResolve(); },
  ready: (i) => readyResolve(i), panic: (m) => { err.push("PANIC " + m); },
};
globalThis.TextEncoder = require("util").TextEncoder;
globalThis.TextDecoder = require("util").TextDecoder;
globalThis.crypto ??= require("crypto");
globalThis.performance ??= require("perf_hooks").performance;
const GOROOT = require("child_process").execSync("go env GOROOT").toString().trim();
require(nodePath.join(GOROOT, "lib/wasm/wasm_exec.js"));
const go = new Go(); go.argv = ["ptah"]; go.env = {};
(async () => {
  const { instance } = await WebAssembly.instantiate(nodeFs.readFileSync(nodeProc.argv[2]), go.importObject);
  go.run(instance);
  await readyP;
  globalThis.__ptah.start(1, nodeProc.argv.slice(3));
  await doneP;
  // stdout carries only the command's stdout, so it can be diffed byte for
  // byte. Everything else goes to fd 2. The exit is deferred until the write
  // has actually drained: a pipe write in node is asynchronous.
  nodeProc.stderr.write("--- exit: " + code + "\n--- stderr ---\n" + err.join(""));
  nodeProc.stdout.write(out.join(""), () => nodeProc.exit(0));
})();
