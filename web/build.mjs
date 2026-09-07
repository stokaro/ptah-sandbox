// Bundles the playground. Two entry points, both ESM.
//
// wasm_exec.js and sqlite3.mjs are deliberately NOT bundled: the first must
// byte-match the toolchain that built ptah.wasm, and the second resolves its
// binary with new URL("sqlite3.wasm", import.meta.url), so both have to stay
// real files next to their real siblings.
import { build } from "esbuild";

const dev = process.argv.includes("--dev");

await build({
  entryPoints: { worker: "src/worker.ts", probe: "src/probe.ts" },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !dev,
  sourcemap: dev ? "inline" : "external",
  logLevel: "info",
});
