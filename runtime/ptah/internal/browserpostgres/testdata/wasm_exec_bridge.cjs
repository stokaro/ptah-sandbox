// Runs a Go js/wasm test binary with the PostgreSQL bridge's globalThis.__postgres already
// installed, which is the arrangement the playground itself uses: the host
// installs the bridge before the Go program starts.
//
// It is the stock $GOROOT/lib/wasm/wasm_exec_node.js with the bridge import in
// front of go.run.
"use strict";

const path = require("path");
const { pathToFileURL } = require("url");

if (process.argv.length < 3) {
  console.error("usage: wasm_exec_bridge.cjs [wasm binary] [arguments]");
  process.exit(1);
}

const goroot = process.env.GOROOT;
if (!goroot) {
  console.error("wasm_exec_bridge.cjs: GOROOT is not set");
  process.exit(1);
}

globalThis.require = require;
globalThis.fs = require("fs");
globalThis.path = path;
globalThis.TextEncoder = require("util").TextEncoder;
globalThis.TextDecoder = require("util").TextDecoder;
globalThis.performance ??= require("perf_hooks").performance;
globalThis.crypto ??= require("crypto");

require(path.join(goroot, "lib", "wasm", "wasm_exec.js"));

(async () => {
  const bridge = pathToFileURL(path.join(process.env.PTAH_SANDBOX_ROOT, "web/src/runtime/postgres-bridge.ts")).href;
  const { createPostgresBridge } = await import(bridge);
  globalThis.__postgres = await createPostgresBridge();

  const go = new Go();
  go.argv = process.argv.slice(2);
  go.env = Object.assign({ TMPDIR: require("os").tmpdir() }, process.env);
  go.exit = process.exit;
  const result = await WebAssembly.instantiate(fs.readFileSync(process.argv[2]), go.importObject);
  process.on("exit", (code) => {
    // Node exits when nothing is pending; make Go report the deadlock.
    if (code === 0 && !go.exited) {
      go._pendingEvent = { id: 0 };
      go._resume();
    }
  });
  await go.run(result.instance);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
