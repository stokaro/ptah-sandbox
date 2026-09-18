/**
 * The whole playground, end to end, outside a browser.
 *
 *   node test/integration/run.mjs          (or: npm test, make test)
 *
 * Real Ptah compiled to js/wasm, real SQLite 3.53.4 compiled to wasm, the real
 * MemFS, the real Contract A bridge, driven through Contract B. Nothing here is
 * mocked and nothing is canned: every transcript below came out of the wasm
 * build during the run that printed it.
 *
 * The expected transcripts in expected/*.txt were captured from the NATIVE
 * ptah binary running the same argv against the same fixture on a real SQLite
 * file (test/integration/capture-native.sh). Comparison is byte for byte, with
 * no normalization: none of these commands prints a timestamp, a duration or
 * an absolute path. Where test/integration/ground-truth has a transcript for the same
 * command shape it is checked too, so a change in Ptah's wording fails here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodeProcess from "node:process";

import { boot } from "./harness.mjs";

const REPO = new URL("../../", import.meta.url);

/**
 * The commit third_party/ptah.pin records. That file is what
 * scripts/build-wasm.sh materializes from, so it is what the binary was
 * actually built from.
 */
function recordedPin() {
  const text = readFileSync(new URL("third_party/ptah.pin", REPO), "utf8");
  const match = /^commit[ \t]+(\S+)/m.exec(text);
  assert.ok(match, "third_party/ptah.pin has no commit line");
  return match[1];
}
const FIXTURE = new URL("fixtures/scenario-a/", REPO);
const EXPECTED = new URL("test/integration/expected/", REPO);
const GROUND_TRUTH = new URL("test/integration/ground-truth/", REPO);

const DB_URL = "sqlite://app.db";
// What convertSQLiteURL turns DB_URL into, minus the query string that
// browsersqlite's parseDSN cuts off. This is the key the bridge sees.
const DB_PATH = "app.db";

// --------------------------------------------------------------------------
// assertions
// --------------------------------------------------------------------------

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL ${name}`);
    console.log(indent(err && err.message ? err.message : String(err)));
  }
}

function indent(text) {
  return String(text).split("\n").map((l) => "       " + l).join("\n");
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

/** The transcript shape both capture scripts write. */
function transcript(run) {
  return `--- exit: ${run.code}\n--- stdout ---\n${run.stdout}--- stderr ---\n${run.stderr}`;
}

function readExpected(name) {
  return readFileSync(new URL(`${name}.txt`, EXPECTED), "utf8");
}

/**
 * A test/integration/ground-truth file without its header. The header carries the argv
 * and the stdin bytes; the scenario there used a different schema file name,
 * so only the body is comparable.
 */
function groundTruthBody(name) {
  const text = readFileSync(new URL(`${name}.txt`, GROUND_TRUTH), "utf8");
  const at = text.indexOf("--- exit: ");
  assert.notEqual(at, -1, `${name}.txt has no "--- exit:" line`);
  return text.slice(at);
}

function assertTranscript(run, expectedText, label) {
  const got = transcript(run);
  if (got === expectedText) return;
  throw new Error(
    `${label}: transcript differs\n` +
      `--- expected ---\n${expectedText}\n--- got ---\n${got}\n--- end ---`,
  );
}

// --------------------------------------------------------------------------
// SQLite helpers that go through the same Contract A the Go driver uses
// --------------------------------------------------------------------------

function query(sqlite, sql) {
  const h = sqlite.open(DB_PATH);
  try {
    const { stmt } = sqlite.prepare(h, sql);
    if (stmt === 0) return { columns: [], rows: [] };
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
    return { columns, rows };
  } finally {
    sqlite.close(h);
  }
}

function exec(sqlite, sql) {
  const h = sqlite.open(DB_PATH);
  try {
    sqlite.exec(h, sql);
  } finally {
    sqlite.close(h);
  }
}

/** The catalog as SQLite itself reports it, for "did anything change" checks. */
function catalog(sqlite) {
  return query(sqlite, "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name;")
    .rows.map((r) => r.join("")).join("\n");
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --------------------------------------------------------------------------

const session = await boot();

section("boot");

check("ready() reports the pinned build and a usable command list", () => {
  assert.equal(typeof session.ready, "object");
  assert.match(session.ready.version, /^v\d+\./);
  assert.equal(session.ready.commit.length, 40);
  assert.equal(session.ready.goVersion, "go1.27.1");
  assert.ok(Array.isArray(session.ready.commands));
  for (const want of ["schema apply", "schema drift", "version"]) {
    assert.ok(session.ready.commands.includes(want), `commands is missing ${want}`);
  }
});

check("the SQLite engine under the bridge is the vendored 3.53.4 build", () => {
  const info = session.sqlite.info();
  assert.equal(info.version, "3.53.4");
  assert.ok(info.vfs.includes("memdb"), "memdb VFS is required for cross-command persistence");
});

check("the manifest describes the binary that is actually loaded", () => {
  const manifest = JSON.parse(readFileSync(new URL("web/vendor/ptah/manifest.json", REPO), "utf8"));
  assert.equal(manifest.ptahCommit, session.ready.commit);
  assert.equal(manifest.ptahVersion, session.ready.version);
  assert.equal(manifest.goVersion, session.ready.goVersion);
  // The build script and the running binary must agree on the command list.
  // They are derived from one tree (cmd/internal/browsercmd) for this reason.
  assert.deepEqual(manifest.commands, session.ready.commands);
});

check("globalThis.__ptah exposes exactly Contract B's Go half", () => {
  for (const name of ["start", "pushStdin", "cancel"]) {
    assert.equal(typeof globalThis.__ptah[name], "function", `__ptah.${name}`);
  }
});

// --------------------------------------------------------------------------

section("seed the workspace from fixtures/scenario-a");

session.workspace.writeFile("schema.sql", readFileSync(new URL("schema.sql", FIXTURE)));
session.workspace.writeFile("README.md", readFileSync(new URL("README.md", FIXTURE)));
exec(session.sqlite, readFileSync(new URL("seed.sql", FIXTURE), "utf8"));

check("the workspace holds the two files and nothing else", () => {
  assert.deepEqual(session.workspace.list("/workspace").map((e) => e.name).sort(), ["README.md", "schema.sql"]);
});

check("app.db exists and carries the seeded rows", () => {
  assert.equal(session.sqlite.exists(DB_PATH), true);
  const { rows } = query(session.sqlite, "SELECT id, name, email FROM users ORDER BY id;");
  assert.deepEqual(rows, [
    [1, "Ada", "ada@example.com"],
    [2, "Grace", "grace@example.com"],
    [3, "Alan", "alan@example.com"],
  ]);
  assert.equal(query(session.sqlite, "SELECT count(*) FROM tasks;").rows[0][0], 4);
});

const seededCatalog = catalog(session.sqlite);

// --------------------------------------------------------------------------

section("vertical slice");

session.sqlite.__reset();
const a = await session.run(["schema", "drift", "--schema-file", "schema.sql", "--db-url", DB_URL]);
console.log(indent(transcript(a)));

check("a. drift on the seeded database is clean", () => {
  assertTranscript(a, readExpected("a_drift_clean"), "a");
});
check("a. matches test/integration/ground-truth/06_drift_v1_clean", () => {
  assertTranscript(a, groundTruthBody("06_drift_v1_clean"), "a");
});
check("a. the command opened app.db through the bridge and closed everything", () => {
  const stats = session.sqlite.__stats();
  assert.ok(stats.openPaths.includes(DB_PATH), `openPaths=${JSON.stringify(stats.openPaths)}`);
  assert.deepEqual(stats.liveHandles, [], "the command leaked a SQLite handle");
});

// b. the edit the fixture README tells the user to make.
{
  let text = session.workspace.readText("schema.sql");
  text = text.replace(
    "  email TEXT NOT NULL\n);",
    "  email TEXT NOT NULL,\n  active INTEGER NOT NULL DEFAULT 1\n);",
  );
  text += "\nCREATE INDEX idx_users_email ON users (email);\n";
  session.workspace.writeFile("schema.sql", text);
  check("b. schema.sql now asks for the column and the index", () => {
    assert.match(session.workspace.readText("schema.sql"), /active INTEGER NOT NULL DEFAULT 1/);
    assert.match(session.workspace.readText("schema.sql"), /CREATE INDEX idx_users_email/);
  });
}

const beforeDryRun = session.sqlite.serialize(DB_PATH);
session.sqlite.__reset();
const c = await session.run(["schema", "apply", "--schema-file", "schema.sql", "--db-url", DB_URL, "--dry-run"]);
console.log(indent(transcript(c)));
const afterDryRun = session.sqlite.serialize(DB_PATH);

check("c. the dry run prints a real plan", () => {
  assertTranscript(c, readExpected("c_apply_dryrun"), "c");
});
check("c. matches test/integration/ground-truth/10_apply_v2_dryrun", () => {
  assertTranscript(c, groundTruthBody("10_apply_v2_dryrun"), "c");
});
check("c. the catalog is unchanged, read back out of the database", () => {
  assert.equal(catalog(session.sqlite), seededCatalog);
  const cols = query(session.sqlite, "PRAGMA table_info(users);").rows.map((r) => r[1]);
  assert.deepEqual(cols, ["id", "name", "email"], "the dry run added a column");
});
check("c. the serialized database is byte-identical across the dry run", () => {
  assert.ok(sameBytes(beforeDryRun, afterDryRun),
    `${beforeDryRun.length} bytes before, ${afterDryRun.length} after`);
});

session.sqlite.__reset();
const d = await session.run(
  ["schema", "apply", "--schema-file", "schema.sql", "--db-url", DB_URL],
  { answers: [[/Type 'YES' to confirm: $/, "YES\n"]] },
);
console.log(indent(transcript(d)));

check("d. the confirmation prompt was answered through pushStdin and the apply succeeded", () => {
  assert.deepEqual(d.sent, ["YES\n"], "the prompt never reached the host, so nothing was answered");
  assertTranscript(d, readExpected("d_apply_yes"), "d");
});
check("d. matches test/integration/ground-truth/11_apply_v2_stdin_yes", () => {
  assertTranscript(d, groundTruthBody("11_apply_v2_stdin_yes"), "d");
});

check("e. the original three rows survived, each with active = 1", () => {
  const { columns, rows } = query(session.sqlite, "SELECT id, name, active FROM users ORDER BY id;");
  assert.deepEqual(columns, ["id", "name", "active"]);
  assert.deepEqual(rows, [[1, "Ada", 1], [2, "Grace", 1], [3, "Alan", 1]]);
  const asText = rows.map((r) => r.join("|")).join("\n") + "\n";
  assert.equal(asText, readExpected("e_rows"), "rows differ from the native run");
});
check("e. the index the plan promised is really in the catalog", () => {
  const names = query(session.sqlite, "SELECT name FROM sqlite_schema WHERE type='index' ORDER BY name;")
    .rows.map((r) => r[0]);
  assert.ok(names.includes("idx_users_email"), `indexes=${JSON.stringify(names)}`);
});

const f = await session.run(["schema", "drift", "--schema-file", "schema.sql", "--db-url", DB_URL]);
console.log(indent(transcript(f)));
check("f. drift is clean again", () => {
  assertTranscript(f, readExpected("f_drift_clean_again"), "f");
});
check("f. matches test/integration/ground-truth/12_drift_v2_after_apply", () => {
  assertTranscript(f, groundTruthBody("12_drift_v2_after_apply"), "f");
});

exec(session.sqlite, "ALTER TABLE users ADD COLUMN nickname TEXT;");
const g = await session.run(["schema", "drift", "--schema-file", "schema.sql", "--db-url", DB_URL]);
console.log(indent(transcript(g)));
check("g. an out-of-band column is reported as destructive drift, exit 1", () => {
  assert.equal(g.code, 1);
  assertTranscript(g, readExpected("g_drift_detected"), "g");
});
check("g. matches test/integration/ground-truth/15_drift_v3_destructive", () => {
  assertTranscript(g, groundTruthBody("15_drift_v3_destructive"), "g");
});

// --------------------------------------------------------------------------

section("invariants");

check("the database survived every command boundary", () => {
  // Nothing re-seeded it, no command was told to create it, and every command
  // opened and closed its own sql.DB. The rows from step e are still there.
  const { rows } = query(session.sqlite, "SELECT id, name, active, nickname FROM users ORDER BY id;");
  assert.deepEqual(rows, [[1, "Ada", 1, null], [2, "Grace", 1, null], [3, "Alan", 1, null]]);
});

check("no command left a SQLite handle open", () => {
  assert.deepEqual(session.sqlite.__stats().liveHandles, []);
});

{
  // Flag leakage, stated the other way round from c -> d: run --dry-run twice
  // and then check the catalog never moved, so the earlier real apply did not
  // leave "already applied" or "not a dry run" state behind either.
  const catalogBefore = catalog(session.sqlite);
  const dry1 = await session.run(["schema", "apply", "--schema-file", "schema.sql", "--db-url", DB_URL, "--dry-run"]);
  const dry2 = await session.run(["schema", "apply", "--schema-file", "schema.sql", "--db-url", DB_URL, "--dry-run"]);
  check("--dry-run does not leak into, or out of, a neighboring run", () => {
    assert.equal(dry1.code, 0);
    assert.equal(dry2.code, 0);
    assert.equal(dry1.stdout, dry2.stdout, "two identical dry runs printed different plans");
    assert.equal(catalog(session.sqlite), catalogBefore, "a dry run changed the catalog");
    assert.doesNotMatch(dry1.stdout, /Schema apply completed successfully/);
    assert.doesNotMatch(dry2.stdout, /Schema apply completed successfully/);
  });
}

// EOF has to be sent: there is no /dev/null in a browser, so the host closes
// the stream with pushStdin(runId, "") once the prompt has been printed.
const h = await session.run(
  ["schema", "apply", "--schema-file", "schema.sql", "--db-url", DB_URL],
  { answers: [[/Type 'YES' to confirm: $/, ""]] },
);
console.log(indent(transcript(h)));
check("h. stdin EOF cancels the apply with exit 2 and the real message", () => {
  assert.equal(h.code, 2);
  assert.deepEqual(h.sent, [""], "EOF was never delivered");
  assert.equal(h.stderr, "error: read schema apply confirmation: EOF\n");
  assertTranscript(h, readExpected("h_apply_eof"), "h");
});

const i = await session.run(
  ["schema", "apply", "--schema-file", "schema.sql", "--db-url", DB_URL],
  { answers: [[/Type 'YES' to confirm: $/, "no\n"]] },
);
console.log(indent(transcript(i)));
check("i. any answer but YES cancels with exit 0", () => {
  assert.equal(i.code, 0);
  assert.deepEqual(i.sent, ["no\n"]);
  assertTranscript(i, readExpected("i_apply_no"), "i");
});

check("neither refusal touched the catalog", () => {
  const cols = query(session.sqlite, "PRAGMA table_info(users);").rows.map((r) => r[1]);
  assert.deepEqual(cols, ["id", "name", "email", "active", "nickname"]);
});

check("the workspace still holds exactly the two files it started with", () => {
  assert.deepEqual(session.workspace.list("/workspace").map((e) => e.name).sort(), ["README.md", "schema.sql"]);
});

check("no temp file leaked out of /tmp", () => {
  // clearTemp() runs before each command, so what is left here was created by
  // the last one. Nothing outside /tmp may have appeared either way.
  const walked = session.workspace.walk("/workspace");
  assert.deepEqual(walked.sort(), ["/workspace/README.md", "/workspace/schema.sql"]);
});


// --------------------------------------------------------------------------

section("host boundary");

{
  // Contract B: one run at a time. The refusal for the second start arrives on
  // the second run's own id, through done(), not as an exception in start().
  const first = session.start(9000, ["version"]);
  const second = session.start(9001, ["version"]);
  await first.finished;
  await second.finished;
  check("a second start while a run is in flight is refused through done(runId, 2)", () => {
    assert.equal(first.code, 0, "the first run should have completed normally");
    assert.equal(second.code, 2, "the concurrent start was not refused");
    assert.equal(second.stdout, "");
    assert.match(second.stderr, /is still running; this runtime executes one command at a time/);
  });
  check("start() returned before the command ran, as Contract B requires", () => {
    // If start had run the command inline, run 9000 would already have been
    // finished by the time start(9001) was called, and 9001 would have been
    // accepted rather than refused. The refusal above is that proof.
    assert.equal(second.code, 2);
  });
}

// --------------------------------------------------------------------------

section("error paths against test/integration/ground-truth");

for (const [name, argv, note] of [
  ["43_err_no_source", ["schema", "apply", "--db-url", DB_URL]],
  ["44_err_no_db_url", ["schema", "apply", "--schema-file", "schema.sql"]],
  ["45_err_bad_flag", ["schema", "apply", "--schema-file", "schema.sql", "--db-url", DB_URL, "--nope"]],
  ["46_err_unknown_cmd", ["schema", "nosuchverb"]],
  ["47_err_missing_file", ["schema", "drift", "--schema-file", "nope.sql", "--db-url", DB_URL], "path"],
]) {
  const run = await session.run(argv);
  check(`${name}: byte-identical to the native transcript${note ? ` (${note} normalized)` : ""}`, () => {
    let got = transcript(run);
    let want = groundTruthBody(name);
    if (note === "path") {
      // The only normalization in this suite. The native capture ran in a
      // mktemp directory, the browser runs in /workspace; both print the
      // absolute path of the file that is missing.
      const strip = (t) => t.replace(/schema file does not exist: \S+/, "schema file does not exist: <abs>");
      assert.match(got, /schema file does not exist: \/workspace\/nope\.sql/);
      got = strip(got);
      want = strip(want);
    }
    assert.equal(got, want);
  });
}

// --------------------------------------------------------------------------

section("known divergences from the native binary");

// These two commands cannot be byte-identical, and both differences are
// deliberate. Pinning them here means a THIRD difference fails the suite.

{
  const v = await session.run(["version"]);
  const want = groundTruthBody("49_version");
  check("version differs only in the build stamp, the date's offset and the platform", () => {
    const got = transcript(v);
    const lines = (t) => t.split("\n");
    const gotL = lines(got);
    const wantL = lines(want);
    assert.equal(gotL.length, wantL.length, "the version output grew or shrank a line");
    const differing = [];
    for (let i = 0; i < gotL.length; i++) if (gotL[i] !== wantL[i]) differing.push(gotL[i].split(":")[0]);
    assert.deepEqual(differing, ["Version", "Commit", "Date", "Platform"]);
    // Commit and Date differ because the ground truth is a frozen capture from
    // whatever commit it was taken at, while this build tracks the recorded
    // pin; the two are not required to agree, and the version block is the one
    // place that shows it. What must agree is the binary and its manifest --
    // the point of printing a commit at all is that it names the code actually
    // running, never a release number stamped over an older artifact.
    assert.match(v.stdout, new RegExp(`^Version: ${session.ready.version}$`, "m"));
    assert.match(v.stdout, new RegExp(`^Commit: ${session.ready.commit}$`, "m"));
    assert.equal(session.ready.commit, recordedPin());
    // Date is the same shape, rendered in the commit's own offset rather than
    // UTC, so it parses even though the instant is a different commit's.
    assert.equal(Number.isNaN(Date.parse(/^Date: (.+)$/m.exec(v.stdout)[1])), false);
    assert.match(v.stdout, /^Platform: js\/wasm$/m);
  });
}

{
  const rootHelp = await session.run(["--help"]);
  const want = groundTruthBody("50_root_help_nontty");
  check("ptah --help differs only by the command groups this build omits", () => {
    assert.equal(rootHelp.code, 0);
    const body = (t) => t.slice(t.indexOf("--- stdout ---\n") + 15, t.indexOf("--- stderr ---"));
    const gotLines = body(transcript(rootHelp)).split("\n");
    const wantLines = body(want).split("\n");
    const missing = wantLines.filter((l) => !gotLines.includes(l));
    const extra = gotLines.filter((l) => !wantLines.includes(l));
    assert.deepEqual(extra, [], "the browser help has lines the native help does not");
    assert.deepEqual(
      missing.map((l) => l.trim().split(/\s+/)[0]).sort(),
      ["assist", "inference", "license", "mcp", "oci", "project", "seed"],
      "the set of omitted command groups changed",
    );
  });
}

// --------------------------------------------------------------------------

section("whole-session hygiene");

check("nothing was written to fd 1 or fd 2, and no output was orphaned", () => {
  assert.equal(session.stray.stdout, "", `stray stdout: ${JSON.stringify(session.stray.stdout)}`);
  assert.equal(session.stray.stderr, "", `stray stderr: ${JSON.stringify(session.stray.stderr)}`);
  assert.deepEqual(session.unknown, [], "Contract B traffic arrived for a run nobody started");
});

check("no run panicked, none was truncated, and every one reported an exit code", () => {
  for (const run of session.runs.values()) {
    assert.deepEqual(run.panics, [], `run ${run.id} (${run.argv.join(" ")}) panicked`);
    assert.equal(run.truncated, null, `run ${run.id} was truncated`);
    assert.notEqual(run.code, null, `run ${run.id} never reported done()`);
  }
});

check("the workspace and /tmp are still clean at the end of the session", () => {
  assert.deepEqual(session.workspace.walk("/workspace").sort(),
    ["/workspace/README.md", "/workspace/schema.sql"]);
  assert.deepEqual(session.memfs.readdir("/tmp"), []);
});

session.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f.name}`);
  nodeProcess.exitCode = 1;
} else {
  nodeProcess.exitCode = 0;
}
