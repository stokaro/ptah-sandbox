// Gate for anything published to play.ptah.run.
//
// Every assertion here exists because breaking it produces a site that looks
// fine in a diff and is broken in a browser: a link to a file that is not in
// the artifact, a 125 MB WebAssembly binary that does not match the manifest
// the page quotes it from, a github.io address that leaks the hosting.
//
// Run it against the source tree before the build, and against the staged
// directory that is actually uploaded:
//
//   node web/scripts/check-site.mjs --root web --no-wasm
//   node web/scripts/check-site.mjs --root _site
//
// Exit status is 0 with no findings, 1 with any.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";

const CNAME_EXPECTED = "play.ptah.run";

// The wasm binary is a build product and is gitignored on purpose: a 125 MB
// file does not belong in git history. Jobs that have not linked it pass
// --no-wasm, and only this one path is then allowed to be missing.
const WASM_BINARY = "vendor/ptah/ptah.wasm";

// dist/worker.js is loaded by `new Worker(...)` from inside a bundle, so no
// HTML attribute references it and the link check below cannot see it. It is
// named here so a build that stops producing it still fails.
const UNREFERENCED_ENTRY_POINTS = ["dist/worker.js"];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const args = process.argv.slice(2);
let root = join(repoRoot, "web");
let requireWasm = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root") root = resolve(args[++i]);
  else if (args[i] === "--no-wasm") requireWasm = false;
  else {
    console.error(`check-site: unknown option: ${args[i]}`);
    process.exit(2);
  }
}

/** @type {{ file?: string, line?: number, message: string }[]} */
const findings = [];

/** Records a failure. `file` is repo-relative and turns into a GitHub annotation. */
function fail(message, file, line) {
  findings.push({ file, line, message });
}

/** The 1-based line an offset falls on, so an annotation lands where the fix is. */
function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every file under `dir` with one of `extensions`, skipping build inputs. */
function walk(dir, extensions, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, extensions, out);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. The domain. GitHub Pages serves whatever CNAME says; a stray character
//    here takes the site down with a certificate error, not a 404.
// ---------------------------------------------------------------------------

const cnamePath = join(root, "CNAME");
if (!exists(cnamePath)) {
  fail("CNAME is missing; GitHub Pages would serve the site at stokaro.github.io", "web/CNAME");
} else {
  const cname = readText(cnamePath);
  if (cname.trim() !== CNAME_EXPECTED) {
    fail(`CNAME is ${JSON.stringify(cname.trim())}, expected ${JSON.stringify(CNAME_EXPECTED)}`, "web/CNAME");
  }
  if (cname.trim().split(/\s+/).length !== 1) {
    fail("CNAME must name exactly one host", "web/CNAME");
  }
}

// ---------------------------------------------------------------------------
// 2. The pages that have to exist. Without index.html the root of the domain
//    is a 404, which is the state this pipeline exists to end.
// ---------------------------------------------------------------------------

for (const page of ["index.html", "404.html"]) {
  if (!exists(join(root, page))) {
    fail(`${page} is missing; the site needs it at the root of the artifact`);
  }
}

// ---------------------------------------------------------------------------
// 3. Every reference resolves. Both root-absolute and page-relative, because
//    the playground uses relative paths and the site chrome uses absolute
//    ones, and a 404 on either is invisible until someone loads the page.
// ---------------------------------------------------------------------------

const pages = walk(root, [".html"]);
const attributeRef = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const cssUrlRef = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/g;

/** True for anything that is not a path into this site. */
function isExternal(ref) {
  return (
    ref === "" ||
    ref.startsWith("#") ||
    ref.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(ref)
  );
}

function checkRef(ref, fromFile, line) {
  if (isExternal(ref)) return;
  const clean = ref.split("#")[0].split("?")[0];
  if (clean === "") return;

  const where = relative(repoRoot, fromFile);
  const target = clean.startsWith("/")
    ? join(root, clean.slice(1))
    : resolve(dirname(fromFile), clean);

  const rel = relative(root, target);
  if (rel.startsWith("..")) {
    fail(`references ${ref}, which escapes the site root`, where, line);
    return;
  }

  if (isDirectory(target)) {
    // A directory link is served as its index.html or not at all.
    if (!exists(join(target, "index.html"))) {
      fail(`references ${ref}, a directory with no index.html`, where, line);
    }
    return;
  }

  if (exists(target)) return;

  const posixRel = rel.split(/[\\/]/).join(posix.sep);
  if (!requireWasm && posixRel === WASM_BINARY) return;

  fail(`references ${ref}, which does not exist`, where, line);
}

for (const page of pages) {
  const html = readText(page);
  for (const match of html.matchAll(attributeRef)) {
    checkRef(match[1] ?? match[2] ?? "", page, lineAt(html, match.index));
  }
}

// Stylesheets pull fonts and images with url(), and a missing font subset is a
// silent fallback rather than an error in the console.
for (const sheet of walk(root, [".css"])) {
  const css = readText(sheet);
  for (const match of css.matchAll(cssUrlRef)) {
    checkRef((match[1] ?? match[2] ?? match[3] ?? "").trim(), sheet, lineAt(css, match.index));
  }
}

for (const entry of UNREFERENCED_ENTRY_POINTS) {
  if (!exists(join(root, entry))) {
    fail(`${entry} is missing; it is loaded from JavaScript, so nothing else would catch this`);
  }
}

// ---------------------------------------------------------------------------
// 4. No github.io. The site is play.ptah.run; a hard-coded Pages address
//    breaks the moment the domain moves and tells visitors the wrong origin.
// ---------------------------------------------------------------------------

for (const file of [...pages, ...walk(root, [".css"])]) {
  const text = readText(file);
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line.includes("github.io")) {
      fail("contains a github.io address; the site is play.ptah.run", relative(repoRoot, file), index + 1);
    }
  });
}

// ---------------------------------------------------------------------------
// 5. The manifest and the binaries agree, and both agree with the recorded
//    pin. This is the check that keeps a stale 125 MB wasm from shipping
//    beside freshly built JavaScript: the page reads its version, its commit
//    and its byte count out of this file, so if the file describes a different
//    build than the one in the artifact, the footer is lying.
// ---------------------------------------------------------------------------

const manifestPath = join(root, "vendor/ptah/manifest.json");
if (!exists(manifestPath)) {
  fail("vendor/ptah/manifest.json is missing; the page reads its version stamp from it");
} else {
  const manifest = JSON.parse(readText(manifestPath));

  // third_party/ptah.pin is three "key value" lines under a comment header.
  // Reading it here rather than asking git keeps this check working in a
  // checkout that was exported rather than cloned.
  const pinPath = join(repoRoot, "third_party/ptah.pin");
  const pin = new Map();
  if (!exists(pinPath)) {
    fail("third_party/ptah.pin is missing; there is no pin to compare the manifest against");
  } else {
    for (const line of readText(pinPath).split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const space = trimmed.indexOf(" ");
      if (space > 0) pin.set(trimmed.slice(0, space), trimmed.slice(space + 1).trim());
    }

    for (const [key, field] of [
      ["commit", "ptahCommit"],
      ["version", "ptahVersion"],
    ]) {
      const recorded = pin.get(key);
      if (!recorded) {
        fail(`third_party/ptah.pin has no ${key} line`);
      } else if (manifest[field] !== recorded) {
        fail(
          `manifest.${field} is ${manifest[field]}, but third_party/ptah.pin records ${recorded}. ` +
            "Run `make wasm` and commit web/vendor/ptah/manifest.json.",
          "web/vendor/ptah/manifest.json",
        );
      }
    }
  }

  const binaries = [
    { key: "wasm", path: join(root, WASM_BINARY), optional: !requireWasm },
    { key: "wasmExec", path: join(root, "vendor/ptah/wasm_exec.js"), optional: false },
  ];

  for (const { key, path, optional } of binaries) {
    const entry = manifest[key];
    if (!entry) {
      fail(`manifest has no ${key} section`, "web/vendor/ptah/manifest.json");
      continue;
    }
    if (!exists(path)) {
      if (!optional) fail(`${relative(root, path)} is missing but the manifest describes it`);
      continue;
    }
    const actualSha = sha256(path);
    const actualBytes = statSync(path).size;
    if (actualSha !== entry.sha256) {
      fail(
        `${relative(root, path)} has sha256 ${actualSha}, manifest says ${entry.sha256}`,
        "web/vendor/ptah/manifest.json",
      );
    }
    if (actualBytes !== entry.bytes) {
      fail(
        `${relative(root, path)} is ${actualBytes} bytes, manifest says ${entry.bytes}`,
        "web/vendor/ptah/manifest.json",
      );
    }
  }

  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) {
    fail("manifest lists no commands; completion and help read that list", "web/vendor/ptah/manifest.json");
  }
}

// ---------------------------------------------------------------------------

const inCI = process.env.GITHUB_ACTIONS === "true";
const seen = new Set();
for (const finding of findings) {
  // The same broken reference usually appears several times on a page; report
  // each distinct place once so the output stays readable.
  const key = `${finding.file}:${finding.line}:${finding.message}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const where = finding.file
    ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
    : "";
  if (inCI) {
    const location = finding.file
      ? `file=${finding.file}${finding.line ? `,line=${finding.line}` : ""}`
      : "";
    console.log(`::error ${location}::${finding.message}`);
  }
  console.error(where ? `${where}: ${finding.message}` : finding.message);
}

const scanned = `${pages.length} page(s)`;
if (seen.size > 0) {
  console.error(`check-site: ${seen.size} problem(s) in ${relative(repoRoot, root) || "."} (${scanned})`);
  process.exit(1);
}
console.log(`check-site: ${relative(repoRoot, root) || "."} is publishable (${scanned})`);
