import type { EngineLoadPhase } from "../protocol.ts";
import { PGLITE_VERSION } from "./engine-versions.ts";

export type EngineProgress = (phase: EngineLoadPhase, loaded: number, total: number) => void;

/** Count decoded bytes against the sizes shipped with this exact PGlite bundle. */
export async function loadPostgresAssets(base: string, progress?: EngineProgress) {
  const root = new URL(`dist/pglite-${PGLITE_VERSION}/`, base);
  const controller = new AbortController();
  const names = ["pglite.wasm", "initdb.wasm", "pglite.data"] as const;
  let loaded = 0;
  let completed = 0;
  let lastReport = 0;
  const fetchAsset = async (name: string) => {
    const response = await fetch(new URL(name, root), { signal: controller.signal });
    if (!response.ok) throw new Error(`PGlite ${name}: HTTP ${response.status}`);
    return response;
  };
  try {
    const sizes = await (await fetchAsset("assets.json")).json() as Record<string, number>;
    if (!names.every(name => Number.isSafeInteger(sizes[name]) && sizes[name]! > 0)) {
      throw new Error("PGlite asset sizes are missing or invalid");
    }
    const total = names.reduce((sum, name) => sum + sizes[name]!, 0);
    progress?.("downloading PostgreSQL", 0, total);
    const measured = async (name: typeof names[number]) => {
      const response = await fetchAsset(name);
      if (!response.body) throw new Error(`PGlite ${name}: empty response`);
      let bytes = 0;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          bytes += chunk.byteLength;
          loaded += chunk.byteLength;
          if (!controller.signal.aborted && performance.now() - lastReport >= 50) {
            progress?.("downloading PostgreSQL", loaded, total);
            lastReport = performance.now();
          }
          stream.enqueue(chunk);
        },
        flush() {
          if (bytes !== sizes[name]) throw new Error(`PGlite ${name}: download size does not match its manifest`);
          if (++completed === names.length && !controller.signal.aborted) {
            progress?.("downloading PostgreSQL", loaded, total);
            progress?.("compiling PostgreSQL", loaded, total);
          }
        },
      }), { signal: controller.signal });
      // Content-Length can describe compressed bytes; never use it as the total.
      return new Response(body, { headers: { "Content-Type": name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" } });
    };
    const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
      measured("pglite.wasm").then(response => WebAssembly.compileStreaming(response)),
      measured("initdb.wasm").then(response => WebAssembly.compileStreaming(response)),
      measured("pglite.data").then(response => response.blob()),
    ]);
    return { pgliteWasmModule, initdbWasmModule, fsBundle };
  } catch (error) {
    // A failed attempt must neither keep downloading nor repaint a later retry.
    controller.abort();
    throw error;
  }
}
