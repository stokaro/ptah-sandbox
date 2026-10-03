import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPostgresAssets } from "./postgres-assets.ts";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const data = new Uint8Array([1, 2, 3]);
const sizes = { "pglite.wasm": 8, "initdb.wasm": 8, "pglite.data": 3 };

function fixture(url) {
  const name = new URL(url).pathname.split("/").at(-1);
  if (name === "assets.json") return Response.json(sizes);
  const bytes = name.endsWith(".wasm") ? wasm : data;
  // Simulate decoding a compressed response: its header is not its body size.
  return new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(bytes.slice(0, 2));
      stream.enqueue(bytes.slice(2));
      stream.close();
    },
  }), { headers: { "Content-Length": "1", "Content-Encoding": "gzip" } });
}

test("PostgreSQL progress measures all decoded assets and finishes before initialization", async t => {
  t.mock.method(globalThis, "fetch", async url => fixture(url));
  const events = [];
  const assets = await loadPostgresAssets("https://example.test/play/", (...event) => events.push(event));
  assert.ok(assets.pgliteWasmModule instanceof WebAssembly.Module);
  assert.ok(assets.initdbWasmModule instanceof WebAssembly.Module);
  assert.equal(assets.fsBundle.size, 3);
  assert.deepEqual(events[0], ["downloading PostgreSQL", 0, 19]);
  assert.deepEqual(events.slice(-2), [["downloading PostgreSQL", 19, 19], ["compiling PostgreSQL", 19, 19]]);
  assert.ok(events.every(([, loaded, total], i) => total === 19 && loaded <= total && (i === 0 || loaded >= events[i - 1][1])));
});

test("a failed asset cancels the other downloads and permits a fresh retry", async t => {
  const signals = [];
  t.mock.method(globalThis, "fetch", async (url, { signal }) => {
    signals.push(signal);
    if (String(url).endsWith("initdb.wasm")) return new Response("missing", { status: 503 });
    return fixture(url);
  });
  const events = [];
  await assert.rejects(loadPostgresAssets("https://example.test/", (...event) => events.push(event)), /initdb.wasm: HTTP 503/);
  assert.ok(signals.every(signal => signal.aborted));
  const eventCount = events.length;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(events.length, eventCount, "failed streams cannot emit late progress");
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async url => fixture(url));
  const result = await loadPostgresAssets("https://example.test/");
  assert.equal(result.fsBundle.size, 3);
});

test("a stale asset manifest rejects instead of reporting false completion", async t => {
  t.mock.method(globalThis, "fetch", async url => String(url).endsWith("assets.json")
    ? Response.json({ ...sizes, "pglite.data": 50 }) : fixture(url));
  const events = [];
  await assert.rejects(loadPostgresAssets("https://example.test/", (...event) => events.push(event)), /download size does not match/);
  assert.ok(events.every(([phase]) => phase === "downloading PostgreSQL"));
});

test("an invalid size manifest fails before starting asset downloads", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async url => { calls.push(String(url)); return Response.json({}); });
  await assert.rejects(loadPostgresAssets("https://example.test/"), /asset sizes are missing or invalid/);
  assert.equal(calls.length, 1);
});
