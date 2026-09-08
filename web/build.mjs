// Bundles the playground, and refuses to ship a page that contradicts itself.
//
// wasm_exec.js and sqlite3.mjs are deliberately NOT bundled: the first must
// byte-match the toolchain that built ptah.wasm, and the second resolves its
// binary with new URL("sqlite3.wasm", import.meta.url), so both have to stay
// real files next to their real siblings.
//
// Two checks run before esbuild, both guarding claims the HTML makes:
//
//   * the scenario fixture in index.html is byte-identical to the fixture the
//     runtime is seeded from. The page shows the schema and then writes those
//     same bytes to /workspace/schema.sql; if the two ever diverged, the page
//     would be describing a workspace that does not exist.
//   * the Content-Security-Policy hash matches the inline theme script it is
//     supposed to allow. A stale hash silently disables the script, and the
//     only symptom is a flash of the wrong theme on every load.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const dev = process.argv.includes("--dev");
const problems = [];

const html = readFileSync("index.html", "utf8");

/* ---------- The fixture the page shows is the fixture it seeds ---------- */

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripTags(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, ""));
}

function fixture(name) {
  return readFileSync(new URL(`../fixtures/scenario-a/${name}`, import.meta.url), "utf8");
}

function compare(name, found, expected) {
  if (found === null) {
    problems.push(`index.html does not carry the ${name} fixture`);
  } else if (found !== expected) {
    problems.push(
      `index.html's copy of ${name} differs from fixtures/scenario-a/${name}. ` +
        `The page would show one schema and seed another.`,
    );
  }
}

// The editor pane is the schema file: main.ts reads its textContent and writes
// exactly that. Tags are stripped the way textContent would drop them.
const editor = /<pre class="pg-code" id="pg-editor-text">([\s\S]*?)<\/pre>/.exec(html);
compare("schema.sql", editor === null ? null : stripTags(editor[1]), fixture("schema.sql"));

for (const name of ["README.md", "seed.sql"]) {
  const match = new RegExp(`<template data-fixture="${name}">([\\s\\S]*?)</template>`).exec(html);
  compare(name, match === null ? null : decodeEntities(match[1]), fixture(name));
}

/* ---------- The CSP hash matches the script it allows ---------- */

const inline = /<script>([\s\S]*?)<\/script>/.exec(html);
if (inline === null) {
  problems.push("index.html has no inline theme script; the CSP hash has nothing to allow");
} else {
  const digest = createHash("sha256").update(inline[1], "utf8").digest("base64");
  if (!html.includes(`'sha256-${digest}'`)) {
    problems.push(
      `the Content-Security-Policy in index.html does not allow the inline theme script. ` +
        `Replace the script-src hash with 'sha256-${digest}'.`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`build: ${problem}`);
  process.exit(1);
}

/* ---------- Bundle ---------- */

await build({
  entryPoints: {
    main: "src/main.ts",
    worker: "src/worker.ts",
    probe: "src/probe.ts",
    "ui-probe": "src/ui-probe.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !dev,
  sourcemap: dev ? "inline" : "external",
  logLevel: "info",
});
