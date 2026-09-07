/**
 * The migrations lifecycle, end to end, in the browser build.
 *
 *   node test/integration/migrations.mjs
 *
 * run.mjs covers the schema group against transcripts captured from a native
 * build of the same tree. This covers the group run.mjs does not touch, and it
 * anchors on test/integration/ground-truth scenario D directly: the argv is the argv
 * capture.sh ran, on the schema capture.sh used, and every step's exit status
 * is compared with the status the native binary reported.
 *
 * Only the statuses are compared, not the bodies. These commands print
 * generated migration versions (a unix timestamp), absolute paths and slog
 * records with wall-clock times, none of which two runs can agree on. What the
 * statuses catch is the failure mode this file exists for: a platform gap that
 * turns a working command into a non-zero exit. `migrations generate` was
 * exactly that until upstream-patch/0002 gave js/wasm a conditional rename.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodeProcess from "node:process";

import { boot } from "./harness.mjs";

const REPO = new URL("../../", import.meta.url);
const GROUND_TRUTH = new URL("test/integration/ground-truth/", REPO);
const DB_URL = "sqlite://app.db";

// The schema test/integration/ground-truth/capture.sh used for scenario D. Kept here
// rather than read from fixtures/, because the fixture is the demo workspace
// and is free to change without invalidating a native capture.
const SCHEMA = `CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
`;

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL ${name}`);
    console.log(String(err && err.message ? err.message : err).split("\n").map((l) => "       " + l).join("\n"));
  }
}

/** The status the native binary reported for this capture. */
function nativeExit(name) {
  const text = readFileSync(new URL(`${name}.txt`, GROUND_TRUTH), "utf8");
  const match = /^--- exit: (\d+)$/m.exec(text);
  assert.notEqual(match, null, `${name}.txt has no "--- exit:" line`);
  return Number(match[1]);
}

// The steps of scenario D that need no second schema file, in order. Each is
// the argv capture.sh ran under the same name.
const STEPS = [
  ["23_mig_plan", ["migrations", "plan", "--schema-file", "schema.sql", "--db-url", DB_URL]],
  ["24_mig_generate_init", ["migrations", "generate", "--schema-file", "schema.sql", "--db-url", DB_URL,
    "--migrations-dir", "migrations", "--name", "init"]],
  ["25_mig_ls", ["migrations", "ls", "--migrations-dir", "migrations"]],
  ["26_mig_validate_no_sum", ["migrations", "validate", "--dir", "migrations"]],
  ["27_mig_hash", ["migrations", "hash", "--dir", "migrations"]],
  ["28_mig_validate_ok", ["migrations", "validate", "--dir", "migrations"]],
  ["29_mig_lint", ["migrations", "lint", "--dir", "migrations", "--dialect", "sqlite"]],
  ["30_mig_status_pending", ["migrations", "status", "--migrations-dir", "migrations", "--db-url", DB_URL]],
  ["31_mig_status_json", ["migrations", "status", "--migrations-dir", "migrations", "--db-url", DB_URL, "--json"]],
  ["32_mig_up_dryrun", ["migrations", "up", "--migrations-dir", "migrations", "--db-url", DB_URL, "--dry-run"]],
  ["33_mig_up", ["migrations", "up", "--migrations-dir", "migrations", "--db-url", DB_URL]],
  ["34_mig_status_applied", ["migrations", "status", "--migrations-dir", "migrations", "--db-url", DB_URL]],
  ["52_mig_create", ["migrations", "create", "--migrations-dir", "migrations", "--name", "manual_tweak"]],
];

const session = await boot();
const sqlite = session.sqlite;

/** One query through the same Contract A the driver uses. */
function query(sql) {
  const h = sqlite.open("app.db");
  try {
    const { stmt } = sqlite.prepare(h, sql);
    if (stmt === 0) return [];
    const columns = sqlite.columns(stmt);
    const rows = [];
    for (;;) {
      const batch = sqlite.fetch(stmt, 256);
      for (let r = 0; r < batch.n; r++) {
        rows.push(batch.values.slice(r * columns.length, (r + 1) * columns.length));
      }
      if (batch.done) break;
    }
    sqlite.finalize(stmt);
    return rows;
  } finally {
    sqlite.close(h);
  }
}

session.workspace.writeFile("schema.sql", SCHEMA);
session.memfs.mkdir("/workspace/migrations", 0o755);

console.log("--- scenario D, statuses against test/integration/ground-truth ---");

const runs = new Map();
for (const [name, argv] of STEPS) {
  const run = await session.run(argv);
  runs.set(name, run);
  check(`${name}: exits ${nativeExit(name)}, as the native binary did`, () => {
    assert.equal(run.code, nativeExit(name),
      `stderr: ${run.stderr.slice(0, 600)}`);
    assert.deepEqual(run.panics, []);
  });
}

console.log("\n--- what the lifecycle actually did ---");

check("generate wrote the pair of migration files into the workspace", () => {
  const files = session.workspace.walk("/workspace");
  assert.ok(files.some((f) => /\/migrations\/\d+_init\.up\.sql$/.test(f)), files.join(" "));
  assert.ok(files.some((f) => /\/migrations\/\d+_init\.down\.sql$/.test(f)), files.join(" "));
});

check("generate left no publication journal behind", () => {
  // Until upstream-patch/0002 the conditional rename failed closed and the
  // journal it could not retire stayed in the workspace. A native run leaves
  // the lock file and nothing else.
  const stray = session.workspace.walk("/workspace")
    .filter((f) => /ptah-migrate-diff/.test(f) && !f.endsWith(".lock"));
  assert.deepEqual(stray, []);
});

check("hash wrote ptah.sum and validate then accepted it", () => {
  assert.match(session.workspace.readText("migrations/ptah.sum"), /h1:/);
});

check("up applied the migration to the real database", () => {
  const tables = query("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .map((r) => r[0]);
  assert.ok(tables.includes("users"), tables.join(","));
  assert.ok(tables.includes("tasks"), tables.join(","));
});

check("the dry run before it changed nothing", () => {
  // 32 ran before 33 and reported success; if it had applied anything, 33
  // would have found no pending migration and said so.
  assert.match(runs.get("32_mig_up_dryrun").stdout, /DRY RUN/);
  assert.match(runs.get("33_mig_up").stdout, /Pending migrations: 1/);
});

check("status tracks the version across the boundary", () => {
  assert.match(runs.get("30_mig_status_pending").stdout, /Current Version: 0/);
  assert.match(runs.get("34_mig_status_applied").stdout, /Applied Migrations: 1/);
});

const drift = await session.run(["schema", "drift", "--schema-file", "schema.sql", "--db-url", DB_URL]);
check("schema drift agrees the database now matches the schema", () => {
  assert.equal(drift.code, 0, drift.stdout + drift.stderr);
  assert.equal(drift.stdout, "No schema drift detected.\n");
});

console.log("\n--- hygiene ---");

check("no run panicked and every one reported an exit code", () => {
  for (const run of session.runs.values()) {
    assert.deepEqual(run.panics, [], `run ${run.id} (${run.argv.join(" ")}) panicked`);
    assert.notEqual(run.code, null, `run ${run.id} never reported done()`);
  }
});

check("nothing reached fd 1 or fd 2", () => {
  assert.equal(session.stray.stdout, "");
  assert.equal(session.stray.stderr, "");
});

check("no command left a SQLite handle open", () => {
  assert.deepEqual(session.sqlite.__stats().liveHandles, []);
});

session.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nfailures:");
  for (const name of failures) console.log(`  - ${name}`);
  nodeProcess.exitCode = 1;
} else {
  nodeProcess.exitCode = 0;
}
