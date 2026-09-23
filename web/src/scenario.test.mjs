/**
 * What the guided route is allowed to believe.
 *
 *   node --test src/scenario.test.mjs       (or: npm run test:unit)
 *
 * The route's whole claim is that a step advances because the state says so.
 * These tests attack that claim from both sides:
 *
 *   - a run log full of successful commands must not make a step done while
 *     the catalog disagrees;
 *   - flipping the catalog alone, with no new run and no output at all, must
 *     make it done.
 *
 * The engine is never handed a transcript -- `RunRecord` has no stdout field --
 * so the tests also record every query it issues and assert that none of them
 * is anything but a catalog read. And the second half checks that a workspace
 * edited into a shape no step expects is reported and keeps working, rather
 * than throwing.
 *
 * The scenario JSON is checked against two sources it must not drift from:
 * fixtures/scenario-a, and the native captures in test/integration/ground-truth.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import {
  RunLog,
  SCENARIOS,
  applyPatch,
  evaluateCheck,
  evaluateRoute,
  parseScenario,
  readDeclarations,
  scenarioById,
} from "./scenario.ts";

const REPO = new URL("../../", import.meta.url);
const FIXTURE = new URL("fixtures/scenario-a/", REPO);
const GROUND_TRUTH = new URL("test/integration/ground-truth/", REPO);

const A = scenarioById("a");
const B = scenarioById("b");
const C = scenarioById("c");

// ---------------------------------------------------------------------------
// a probe over plain objects: a catalog, a workspace, a run log
// ---------------------------------------------------------------------------

/**
 * Answers the same questions the real probe answers, from a literal
 * description of the world. `asked` records every query so a test can prove
 * the engine looked at the catalog and nowhere else.
 */
function fakeProbe(world) {
  const tables = new Map(Object.entries(world.tables ?? {}));
  const indexes = new Set(world.indexes ?? []);
  const files = new Map(Object.entries(world.files ?? {}));
  const runs = world.runs ?? [];
  const asked = [];

  return {
    asked,
    async query(sql) {
      asked.push(sql);
      if (world.broken) throw new Error("the worker has not booted");
      let m = /^SELECT name FROM sqlite_schema WHERE type = '(\w+)';$/.exec(sql);
      if (m) {
        const names = m[1] === "table" ? [...tables.keys()] : [...indexes];
        return { columns: ["name"], rows: names.map((n) => [n]) };
      }
      m = /^PRAGMA table_info\("(.+)"\);$/.exec(sql);
      if (m) {
        const cols = tables.get(m[1].replace(/""/g, '"')) ?? [];
        return { columns: ["cid", "name"], rows: cols.map((c, i) => [i, c]) };
      }
      m = /^SELECT count\(\*\) FROM "(.+)";$/.exec(sql);
      if (m) {
        const name = m[1].replace(/""/g, '"');
        if (!tables.has(name)) throw new Error(`no such table: ${name}`);
        return { columns: ["count(*)"], rows: [[world.rows?.[name] ?? 0]] };
      }
      throw new Error(`the route asked something that is not a catalog read: ${sql}`);
    },
    async readFile(path) {
      return files.has(path) ? files.get(path) : null;
    },
    async listFiles(dir) {
      const prefix = `${dir}/`;
      return [...files.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => p.slice(prefix.length));
    },
    runs: () => runs,
  };
}

/** A run log, built from [argv, exitCode] pairs, in order. */
function runsFrom(...pairs) {
  const log = new RunLog();
  let t = 1000;
  for (const [argv, code] of pairs) log.record(argv, code, t, (t += 10));
  return log.all();
}

const DB_URL = "sqlite://app.db";
const DRIFT = ["schema", "drift", "--schema-file", "schema.sql", "--db-url", DB_URL];
const DRY_RUN = ["schema", "apply", "--schema-file", "schema.sql", "--db-url", DB_URL, "--dry-run"];
const APPLY = ["schema", "apply", "--schema-file", "schema.sql", "--db-url", DB_URL];

const SCHEMA_V1 = readFileSync(new URL("schema.sql", FIXTURE), "utf8");
const SCHEMA_V2 = SCHEMA_V1
  .replace("  email TEXT NOT NULL\n);", "  email TEXT NOT NULL,\n  active INTEGER NOT NULL DEFAULT 1\n);")
  + "\nCREATE INDEX idx_users_email ON users (email);\n";

/** The seeded workspace of scenario A, before anything has been done to it. */
function seededWorld(overrides = {}) {
  return {
    tables: { users: ["id", "name", "email"], tasks: ["id", "user_id", "title", "done"] },
    indexes: [],
    rows: { users: 3, tasks: 4 },
    files: { "schema.sql": SCHEMA_V1, "README.md": "# Workspace\n" },
    runs: [],
    ...overrides,
  };
}

/** The same workspace after a real apply: new column, new index, same rows. */
function appliedWorld(overrides = {}) {
  return seededWorld({
    tables: { users: ["id", "name", "email", "active"], tasks: ["id", "user_id", "title", "done"] },
    indexes: ["idx_users_email"],
    files: { "schema.sql": SCHEMA_V2, "README.md": "# Workspace\n" },
    ...overrides,
  });
}

const byId = (route, id) => route.steps.find((s) => s.step.id === id);

// ---------------------------------------------------------------------------
// assertions are evaluated against state, not against output
// ---------------------------------------------------------------------------

test("a successful run does not make a step done while the catalog disagrees", async () => {
  // Every command in the route has run and every one exited 0. If the engine
  // trusted exit codes or transcripts, Apply would read as done.
  const route = await evaluateRoute(A, fakeProbe(seededWorld({
    runs: runsFrom([DRIFT, 0], [DRY_RUN, 0], [APPLY, 0]),
  })));

  const apply = byId(route, "apply");
  assert.notEqual(apply.status, "done", "Apply passed on the strength of a run record alone");
  assert.match(apply.detail, /users has id, name, email and no active/);
});

test("changing only the catalog makes the step done, with no new run", async () => {
  const runs = runsFrom([DRIFT, 0], [DRY_RUN, 0], [APPLY, 0]);

  const before = await evaluateRoute(A, fakeProbe(seededWorld({ runs })));
  const after = await evaluateRoute(A, fakeProbe(appliedWorld({ runs })));

  assert.notEqual(byId(before, "apply").status, "done");
  assert.equal(byId(after, "apply").status, "done");
  assert.match(byId(after, "apply").detail, /users.active is in the catalog/);
});

test("a step never asks for anything but catalog reads", async () => {
  const probe = fakeProbe(appliedWorld({ runs: runsFrom([DRIFT, 0], [DRY_RUN, 0], [APPLY, 0]) }));
  await evaluateRoute(A, probe);

  assert.ok(probe.asked.length > 0, "the route asked the database nothing at all");
  for (const sql of probe.asked) {
    assert.match(
      sql,
      /^(SELECT name FROM sqlite_schema|PRAGMA table_info|SELECT count\(\*\) FROM)/,
      `not a catalog read: ${sql}`,
    );
  }
});

test("RunRecord carries argv and an exit code and nothing else", () => {
  const [record] = runsFrom([APPLY, 0]);
  assert.deepEqual(Object.keys(record).sort(), ["argv", "code", "endedAt", "seq", "startedAt"]);
  // The point of the shape: there is nowhere to put output, so no check can
  // ever be written against it.
  assert.equal(record.stdout, undefined);
  assert.equal(record.stderr, undefined);
});

test("a comment that mentions the column is not a declaration of it", async () => {
  const commented = SCHEMA_V1.replace(
    "CREATE TABLE users (",
    "-- TODO: add active INTEGER NOT NULL DEFAULT 1 here\nCREATE TABLE users (",
  );
  const probe = fakeProbe(seededWorld({ files: { "schema.sql": commented } }));
  const result = await evaluateCheck(
    { kind: "declares", file: "schema.sql", table: "users", column: "active", present: true },
    probe,
  );
  assert.equal(result.ok, false, "a commented-out column counted as declared");
});

test("the exit code decides, not the wording of the command", async () => {
  const drifted = seededWorld({
    tables: { users: ["id", "name", "email", "nickname"], tasks: ["id", "user_id", "title", "done"] },
  });

  // Scenario B step 3 wants a drift run that exited 1. A drift run that
  // exited 0 is a different answer to the same question, and must not pass.
  const zero = await evaluateRoute(B, fakeProbe({ ...drifted, runs: runsFrom([DRIFT, 0]) }));
  assert.notEqual(byId(zero, "drift").status, "done");
  assert.match(byId(zero, "drift").detail, /exited 0, not 1/);

  const one = await evaluateRoute(B, fakeProbe({ ...drifted, runs: runsFrom([DRIFT, 0], [DRIFT, 1]) }));
  assert.equal(byId(one, "drift").status, "done");
});

test("undoing a change on purpose is part of the route, not a fall from it", async () => {
  // Scenario B ends by reverting the column it added. If step 2 only asked
  // whether the column is there, finishing the route would report the route
  // as broken -- so it also accepts the drift run that exited 1, which is a
  // durable fact about a process and stays true afterwards.
  const drifted = seededWorld({
    tables: { users: ["id", "name", "email", "nickname"], tasks: ["id", "user_id", "title", "done"] },
    runs: runsFrom([DRIFT, 0], [DRIFT, 1]),
  });
  const mid = await evaluateRoute(B, fakeProbe(drifted));
  assert.equal(byId(mid, "change").status, "done");

  const reverted = await evaluateRoute(B, fakeProbe(seededWorld({
    runs: runsFrom([DRIFT, 0], [DRIFT, 1], [DRIFT, 0]),
  })));
  assert.equal(byId(reverted, "change").status, "done", "reverting the column un-did an earlier step");
  assert.equal(reverted.offScript, null, "finishing the route was reported as going off it");
  assert.equal(reverted.currentIndex, -1, "the route did not finish");
});

test("a step with nothing to check is stepped over once something after it is done", async () => {
  const world = seededWorld({ runs: runsFrom([DRIFT, 0], [DRIFT, 1]) });
  const mid = await evaluateRoute(B, fakeProbe({
    ...world,
    tables: { users: ["id", "name", "email", "nickname"], tasks: ["id", "user_id", "title", "done"] },
  }));
  // Read the report is the current step while it is the furthest the route has got.
  assert.equal(mid.steps[mid.currentIndex].step.id, "report");
  assert.equal(byId(mid, "report").status, "unverifiable");

  const finished = await evaluateRoute(B, fakeProbe(seededWorld({
    runs: runsFrom([DRIFT, 0], [DRIFT, 1], [DRIFT, 0]),
  })));
  assert.equal(byId(finished, "report").status, "unverifiable", "an unverifiable step was ticked");
  assert.equal(finished.currentIndex, -1, "the unverifiable step parked the route");
});

test("order matters: the verifying run has to come after the thing it verifies", async () => {
  const runs = runsFrom([DRIFT, 0], [DRY_RUN, 0], [APPLY, 0]);
  const before = await evaluateRoute(A, fakeProbe(appliedWorld({ runs })));
  assert.notEqual(byId(before, "verify").status, "done", "a drift from before the apply verified it");

  const after = await evaluateRoute(A, fakeProbe(appliedWorld({
    runs: runsFrom([DRIFT, 0], [DRY_RUN, 0], [APPLY, 0], [DRIFT, 0]),
  })));
  assert.equal(byId(after, "verify").status, "done");
});

test("a dry run is told apart from the apply by its argv, not by its output", async () => {
  const runs = runsFrom([DRY_RUN, 0]);
  const route = await evaluateRoute(A, fakeProbe(seededWorld({ files: { "schema.sql": SCHEMA_V2 }, runs })));
  assert.equal(byId(route, "preview").status, "done");

  // The same verb without --dry-run is a different command and does not
  // satisfy the preview step.
  const other = await evaluateRoute(A, fakeProbe(seededWorld({
    files: { "schema.sql": SCHEMA_V2 },
    runs: runsFrom([APPLY, 0]),
  })));
  assert.notEqual(byId(other, "preview").status, "done");
});

// ---------------------------------------------------------------------------
// off-script is reported, never fatal
// ---------------------------------------------------------------------------

test("a later step done before an earlier one is reported, and everything still works", async () => {
  // The schema is edited and applied by hand, without ever running drift.
  const route = await evaluateRoute(A, fakeProbe(appliedWorld({ runs: [] })));

  assert.equal(byId(route, "apply").status, "done");
  assert.equal(byId(route, "explore").status, "current");
  assert.ok(route.offScript, "going off the route was not reported");
  assert.match(route.offScript, /Step 04 Apply is done while step 01 Explore is not/);
  assert.match(route.offScript, /suggestion/);
  assert.equal(route.steps.length, A.steps.length);
});

test("a workspace that lost the file the route reads is reported against the baseline", async () => {
  const route = await evaluateRoute(A, fakeProbe(seededWorld({ files: {} })));
  assert.ok(route.offScript);
  assert.match(route.offScript, /Reset puts the scenario back/);
  assert.match(route.offScript, /schema.sql is not in the workspace/);
  assert.equal(route.unavailable, null);
});

test("a database with the table dropped out from under it is reported, not thrown", async () => {
  const route = await evaluateRoute(A, fakeProbe(seededWorld({ tables: {}, rows: {} })));
  assert.ok(route.offScript);
  assert.match(route.offScript, /there is no users table/);
  for (const s of route.steps) assert.ok(typeof s.detail === "string");
});

test("arbitrary text in the schema file yields no declarations and no exception", async () => {
  const world = seededWorld({
    files: { "schema.sql": "hello world, this is not SQL at all\n" },
    runs: runsFrom([DRIFT, 0]),
  });
  const route = await evaluateRoute(A, fakeProbe(world));
  assert.equal(byId(route, "edit").status, "current");
  assert.match(byId(route, "edit").detail, /does not declare a users table/);
  assert.equal(route.offScript, null, "an unfinished edit is not off-script; it is just unfinished");
});

test("a half-typed CREATE TABLE does not throw", () => {
  const decls = readDeclarations("CREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  na");
  assert.ok(decls.tables.has("users"));
  assert.deepEqual(decls.tables.get("users"), ["id", "na"]);
});

test("a runtime that cannot answer leaves the steps unknown, not undone", async () => {
  const route = await evaluateRoute(A, fakeProbe(seededWorld({ broken: true })));
  assert.ok(route.unavailable, "a dead probe was mistaken for a clean workspace");
  assert.equal(route.offScript, null, "a booting runtime was reported as going off-script");
  for (const s of route.steps) {
    assert.ok(s.status === "unknown" || s.status === "unverifiable", `status was ${s.status}`);
  }
});

test("evaluateCheck never throws, whatever the probe does", async () => {
  const angry = {
    query: () => Promise.reject(new Error("boom")),
    readFile: () => Promise.reject(new Error("boom")),
    listFiles: () => Promise.reject(new Error("boom")),
    runs: () => [],
  };
  for (const check of [
    { kind: "table", name: "users", present: true },
    { kind: "declares", file: "schema.sql", table: "users", column: "active", present: true },
    { kind: "files", dir: "migrations", suffix: ".up.sql", atLeast: 1 },
  ]) {
    const r = await evaluateCheck(check, angry);
    assert.equal(r.ok, false);
    assert.match(r.detail, /has not answered/);
  }
});

// ---------------------------------------------------------------------------
// the declarative reader
// ---------------------------------------------------------------------------

test("the fixture schema declares its two tables and no index", () => {
  const decls = readDeclarations(SCHEMA_V1);
  assert.deepEqual(decls.tables.get("users"), ["id", "name", "email"]);
  // FOREIGN KEY is a table constraint, not a column.
  assert.deepEqual(decls.tables.get("tasks"), ["id", "user_id", "title", "done"]);
  assert.equal(decls.indexes.size, 0);
});

test("the edit scenario A asks for reads back as a column and an index", () => {
  const decls = readDeclarations(SCHEMA_V2);
  assert.ok(decls.tables.get("users").includes("active"));
  assert.ok(decls.indexes.has("idx_users_email"));
});

test("quoted identifiers, IF NOT EXISTS and nested parentheses read the same", () => {
  const decls = readDeclarations(`
    CREATE TABLE IF NOT EXISTS "Users" (
      "id"     INTEGER PRIMARY KEY,
      [name]   TEXT NOT NULL,
      email    TEXT NOT NULL CHECK (length(email) > 3),
      CONSTRAINT uq_email UNIQUE (email),
      PRIMARY KEY (id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS main.idx_users_email ON "Users" ("email");
  `);
  assert.deepEqual(decls.tables.get("users"), ["id", "name", "email"]);
  assert.ok(decls.indexes.has("idx_users_email"));
});

test("a string literal that looks like DDL is not read as DDL", () => {
  const decls = readDeclarations(`
    CREATE TABLE notes (
      id   INTEGER PRIMARY KEY,
      body TEXT NOT NULL DEFAULT 'CREATE TABLE secret (id INTEGER)'
    );
  `);
  assert.deepEqual([...decls.tables.keys()], ["notes"]);
});

// ---------------------------------------------------------------------------
// the shipped scenarios
// ---------------------------------------------------------------------------

test("three guided scenarios ship with five steps each, then free exploration with none", () => {
  assert.deepEqual(SCENARIOS.map((s) => s.id), ["a", "b", "c", "free"]);
  assert.deepEqual(SCENARIOS.map((s) => s.steps.length), [5, 5, 5, 0]);
});

test("every step either has a check or says why it has none", () => {
  for (const s of SCENARIOS) {
    for (const step of s.steps) {
      if (step.check === null) {
        assert.ok(step.unverified, `${s.id}/${step.id} has no check and no explanation`);
        assert.match(step.unverified, /not something this page can observe|cannot/i);
      } else {
        assert.ok(step.check.kind, `${s.id}/${step.id} has a malformed check`);
      }
    }
  }
});

test("scenario A ships the fixture byte for byte", () => {
  assert.equal(A.files["schema.sql"], SCHEMA_V1);
  assert.equal(A.seed, readFileSync(new URL("seed.sql", FIXTURE), "utf8"));
  assert.equal(A.files["README.md"], readFileSync(new URL("README.md", FIXTURE), "utf8"));
});

test("scenarios A and B start from the same seeded database, C from an empty one", () => {
  assert.equal(B.seed, A.seed);
  assert.match(C.seed, /empty database/);
  assert.doesNotMatch(C.seed, /INSERT INTO/);
});

test("scenario C says how it differs from a direct apply", () => {
  assert.match(C.note, /different ways of working/);
  assert.match(C.note, /schema apply writes nothing into migrations\//);
});

test("no suggested command can approve on the user's behalf", () => {
  for (const s of SCENARIOS) {
    for (const step of s.steps) {
      const argvs = [...(step.action?.kind === "run" ? [step.action.argv] : []), ...(step.also ?? [])];
      for (const argv of argvs) {
        for (const token of argv) {
          assert.doesNotMatch(token, /^--(auto-approve|yes|force|no-confirm)/, `${s.id}/${step.id}: ${token}`);
        }
      }
    }
  }
});

test("parseScenario refuses a scenario that smuggles in an approval flag", () => {
  const evil = structuredClone(JSON.parse(readFileSync(new URL("../scenarios/a.json", import.meta.url), "utf8")));
  const apply = evil.steps.find((s) => s.id === "apply");
  apply.action.argv.push("--auto-approve");
  assert.throws(() => parseScenario(evil), /must not carry --auto-approve/);
});

test("parseScenario refuses a step with no check and no explanation", () => {
  const evil = JSON.parse(readFileSync(new URL("../scenarios/b.json", import.meta.url), "utf8"));
  delete evil.steps.find((s) => s.id === "report").unverified;
  assert.throws(() => parseScenario(evil), /must say why in `unverified`/);
});

// ---------------------------------------------------------------------------
// the argv came from captures of the native binary, not from memory
// ---------------------------------------------------------------------------

/** Every `$ ptah ...` header line in test/integration/ground-truth. */
function groundTruthArgvs() {
  const out = [];
  for (const name of readdirSync(GROUND_TRUTH).filter((n) => n.endsWith(".txt"))) {
    const first = readFileSync(new URL(name, GROUND_TRUTH), "utf8").split("\n")[0];
    if (first.startsWith("$ ptah ")) out.push(first.slice("$ ptah ".length).trim().split(/\s+/));
  }
  return out;
}

/** The verb path (leading non-flag tokens) and the set of flag names. */
function shape(argv) {
  const verbs = [];
  const flags = new Set();
  for (const token of argv) {
    if (token.startsWith("--")) flags.add(token.split("=")[0]);
    else if (flags.size === 0) verbs.push(token);
  }
  return { verbs: verbs.join(" "), flags: [...flags].sort().join(" ") };
}

test("every suggested command matches a native capture, flag for flag", () => {
  const captured = groundTruthArgvs().map(shape);
  for (const s of SCENARIOS) {
    for (const step of s.steps) {
      const argvs = [...(step.action?.kind === "run" ? [step.action.argv] : []), ...(step.also ?? [])];
      for (const argv of argvs) {
        const want = shape(argv);
        assert.ok(
          captured.some((c) => c.verbs === want.verbs && c.flags === want.flags),
          `${s.id}/${step.id}: "ptah ${argv.join(" ")}" has no capture in test/integration/ground-truth `
          + `with verbs "${want.verbs}" and flags "${want.flags}"`,
        );
      }
    }
  }
});

test("the migrations verbs keep the CLI's own two spellings of the directory flag", () => {
  const flagsFor = (verb) => {
    const step = C.steps.find((s) => s.action?.kind === "run" && s.action.argv[1] === verb)
      ?? { action: { argv: (C.steps.flatMap((s) => s.also ?? []).find((a) => a[1] === verb)) } };
    return step.action.argv;
  };
  // Taken from the captures, where they differ per verb. Not from memory.
  assert.ok(flagsFor("generate").includes("--migrations-dir"));
  assert.ok(flagsFor("up").includes("--migrations-dir"));
  assert.ok(flagsFor("status").includes("--migrations-dir"));
  assert.ok(flagsFor("hash").includes("--dir"));
  assert.ok(flagsFor("validate").includes("--dir"));
  assert.ok(flagsFor("lint").includes("--dir"));
  assert.ok(!flagsFor("hash").includes("--migrations-dir"));
  assert.ok(!flagsFor("generate").includes("--dir"));
});

test("the commands the route suggests are commands this build registers", () => {
  const manifest = JSON.parse(readFileSync(new URL("web/vendor/ptah/manifest.json", REPO), "utf8"));
  assert.ok(Array.isArray(manifest.commands) && manifest.commands.length > 0, "manifest has no command list");
  for (const s of SCENARIOS) {
    for (const step of s.steps) {
      const argvs = [...(step.action?.kind === "run" ? [step.action.argv] : []), ...(step.also ?? [])];
      for (const argv of argvs) {
        const path = argv.filter((t) => !t.startsWith("--")).slice(0, 2).join(" ");
        assert.ok(manifest.commands.includes(path), `${path} is not a registered command`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// the edit step's patch
// ---------------------------------------------------------------------------

const EDIT = A.steps.find((s) => s.id === "edit");
const PATCH = EDIT.action.patch;

test("scenario A's patch turns the seeded schema into the one its step checks for", async () => {
  const result = applyPatch(SCHEMA_V1, PATCH);
  assert.equal(result.state, "applies");
  assert.equal(result.text, SCHEMA_V2);
  const after = await evaluateCheck(EDIT.check, fakeProbe(seededWorld({ files: { "schema.sql": result.text } })));
  assert.equal(after.ok, true, after.detail);
  // The control: the seeded file does not pass, so the patch is what made it.
  const before = await evaluateCheck(EDIT.check, fakeProbe(seededWorld()));
  assert.equal(before.ok, false, before.detail);
});

test("a patch already in the file reports applied rather than applying twice", () => {
  assert.deepEqual(applyPatch(SCHEMA_V2, PATCH), { state: "applied" });
});

test("a column typed in by hand leaves only the index to apply", () => {
  const byHand = SCHEMA_V1.replace(PATCH[0].find, PATCH[0].replace);
  assert.deepEqual(applyPatch(byHand, PATCH), { state: "applies", text: SCHEMA_V2 });
});

test("a file changed where the patch goes is a conflict, and nothing is applied", () => {
  const moved = SCHEMA_V1.replace("  email TEXT NOT NULL\n", "  email TEXT\n");
  assert.deepEqual(applyPatch(moved, PATCH), { state: "conflict", hunk: 0, reason: "missing" });
});

test("an anchor that appears twice is a conflict, not a guess", () => {
  const twice = `${SCHEMA_V1}\nCREATE TABLE people (\n  email TEXT NOT NULL\n);\n`;
  assert.deepEqual(applyPatch(twice, PATCH), { state: "conflict", hunk: 0, reason: "ambiguous" });
});

test("a patch that cannot be told apart from its result is refused at load", () => {
  const raw = JSON.parse(readFileSync(new URL("../scenarios/a.json", import.meta.url), "utf8"));
  const edit = raw.steps.find((s) => s.id === "edit");
  edit.action.patch = [{ find: "  email TEXT NOT NULL\n);", replace: "email TEXT NOT NULL" }];
  assert.throws(() => parseScenario(raw), /replacement is inside the text it replaces/);
});

test("a patch is refused for any file but schema.sql", () => {
  const raw = JSON.parse(readFileSync(new URL("../scenarios/a.json", import.meta.url), "utf8"));
  raw.steps.find((s) => s.id === "edit").action.file = "README.md";
  assert.throws(() => parseScenario(raw), /can only be applied to schema.sql/);
});

// ---------------------------------------------------------------------------
// free exploration: a workspace and no route
// ---------------------------------------------------------------------------

const FREE = scenarioById("free");

test("free exploration has no steps, and starts from scenario A's schema and data", () => {
  assert.equal(FREE.steps.length, 0);
  assert.equal(FREE.baseline, undefined);
  assert.equal(FREE.files["schema.sql"], A.files["schema.sql"]);
  assert.equal(FREE.seed, A.seed);
  assert.deepEqual(FREE.database, A.database);
});

test("a scenario with no steps points at no step and warns of nothing, whatever the workspace holds", async () => {
  const emptied = await evaluateRoute(FREE, fakeProbe({ tables: {}, files: {} }));
  assert.equal(emptied.currentIndex, -1);
  assert.equal(emptied.offScript, null);
  assert.deepEqual(emptied.steps, []);
});

test("a scenario with steps must say what state they assume", () => {
  const raw = JSON.parse(readFileSync(new URL("../scenarios/a.json", import.meta.url), "utf8"));
  delete raw.baseline;
  assert.throws(() => parseScenario(raw), /must say what state they assume/);
});
