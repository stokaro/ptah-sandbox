/**
 * Runs scenario A in a real browser and reports what happened.
 *
 * This exists to answer the one question the Node suites cannot: does the
 * runtime behave the same in a Worker, where sqlite3.mjs loads its own wasm,
 * the OPFS VFSes actually install, and the scheduler is the browser's. It is
 * a harness, not the playground -- the interface replaces it.
 *
 * The assertions are the same ones the Node suite makes, deliberately, so a
 * divergence between the two environments shows up as a specific failed line
 * rather than as "it did not work in Chrome".
 */

import { Loader } from "./loader.ts";
import type { HostEvent, ReadyInfo, SqliteInfo, WorkerRequest } from "./protocol.ts";

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true, detail: "" });
  } catch (err) {
    results.push({ name, ok: false, detail: String(err) });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class Session {
  private worker: Worker;
  private runs = new Map<number, Run>();
  private settle = new Map<number, () => void>();
  private replies = new Map<string, (event: HostEvent) => void>();
  private nextRun = 1;
  private nextId = 1;
  /** Fed to the confirmation prompt when a run asks for it. */
  private stdinAnswer: string | null = null;

  /** Set when the worker dies; every pending wait rejects with it. */
  private failure: string | null = null;
  private onFailure: ((message: string) => void)[] = [];

  /** Called for every boot phase, so the page can show real progress. */
  onProgress: ((phase: import("./protocol.ts").BootPhase, loaded: number, total: number) => void) | null = null;

  ready!: ReadyInfo;
  sqlite!: SqliteInfo;
  strays: string[] = [];
  panics: string[] = [];

  constructor(url: string) {
    this.worker = new Worker(url, { type: "module" });
    this.worker.onmessage = (e: MessageEvent<HostEvent>) => this.onEvent(e.data);
    // Without these two a worker that fails to load or throws during boot is
    // silent, and the page just waits forever.
    this.worker.onerror = (e: ErrorEvent) => {
      const where = e.filename ? ` (${e.filename}:${e.lineno})` : "";
      this.fail(`worker error: ${e.message}${where}`);
    };
    this.worker.onmessageerror = () => this.fail("worker sent an unstructurable message");
  }

  private onEvent(event: HostEvent): void {
    switch (event.type) {
      case "stdout":
      case "stderr": {
        const run = this.runs.get(event.runId);
        if (run) run[event.type] += event.text;
        // The prompt has no trailing newline, so waiting for one would hang.
        if (this.stdinAnswer !== null && run && run.stdout.includes("Type 'YES' to confirm:")) {
          const answer = this.stdinAnswer;
          this.stdinAnswer = null;
          this.send({ type: "stdin", runId: event.runId, data: answer });
        }
        return;
      }
      case "done": {
        const run = this.runs.get(event.runId);
        if (run) run.code = event.code;
        this.settle.get(event.runId)?.();
        return;
      }
      case "panic":
        this.panics.push(event.message);
        return;
      case "stray":
        this.strays.push(`${event.stream}: ${event.text}`);
        return;
      case "progress":
        this.onProgress?.(event.phase, event.loaded, event.total);
        return;
      default: {
        const key = replyKey(event);
        if (key) {
          const waiting = this.replies.get(key);
          this.replies.delete(key);
          waiting?.(event);
        }
      }
    }
  }

  private fail(message: string): void {
    this.failure = message;
    for (const cb of this.onFailure.splice(0)) cb(message);
  }

  /** Rejects as soon as the worker fails, so nothing waits on a dead worker. */
  private guard<T>(p: Promise<T>): Promise<T> {
    if (this.failure) return Promise.reject(new Error(this.failure));
    return Promise.race([
      p,
      new Promise<never>((_, reject) => {
        this.onFailure.push((m) => reject(new Error(m)));
      }),
    ]);
  }

  private send(request: WorkerRequest): void {
    this.worker.postMessage(request);
  }

  /** Sends a request and resolves with the event that answers it. */
  private ask<T extends HostEvent>(request: WorkerRequest, key: string): Promise<T> {
    return this.guard(new Promise<T>((resolve) => {
      this.replies.set(key, resolve as (event: HostEvent) => void);
      this.send(request);
    }));
  }

  async init(base: string): Promise<void> {
    const event = await this.ask<Extract<HostEvent, { type: "ready" }>>(
      { type: "init", base },
      "ready",
    );
    this.ready = event.info;
    this.sqlite = event.sqlite;
  }

  async run(argv: string[], answer: string | null = null): Promise<Run> {
    const runId = this.nextRun++;
    const run: Run = { stdout: "", stderr: "", code: null };
    this.runs.set(runId, run);
    this.stdinAnswer = answer;
    await this.guard(new Promise<void>((resolve) => {
      this.settle.set(runId, resolve);
      this.send({ type: "run", runId, argv });
    }));
    return run;
  }

  async write(path: string, text: string): Promise<void> {
    await this.ask({ type: "writeFile", path, text }, `wrote:${path}`);
  }

  async sql(path: string, sql: string): Promise<{ columns: string[]; rows: unknown[][] }> {
    const id = this.nextId++;
    const event = await this.ask<Extract<HostEvent, { type: "sql" }>>(
      { type: "sql", id, path, sql },
      `sql:${id}`,
    );
    return event.rows;
  }

  async exec(path: string, sql: string): Promise<void> {
    const id = this.nextId++;
    await this.ask({ type: "execSQL", id, path, sql }, `sqlDone:${id}`);
  }
}

function replyKey(event: HostEvent): string | null {
  switch (event.type) {
    case "ready": return "ready";
    case "wrote": return `wrote:${event.path}`;
    case "file": return `file:${event.path}`;
    case "files": return "files";
    case "sql": return `sql:${event.id}`;
    case "sqlDone": return `sqlDone:${event.id}`;
    default: return null;
  }
}

const SCHEMA_V1 = `CREATE TABLE users (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE TABLE tasks (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title   TEXT NOT NULL,
  done    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users (id)
);
`;

const SCHEMA_V2 = SCHEMA_V1.replace(
  "  email TEXT NOT NULL\n);",
  "  email TEXT NOT NULL,\n  active INTEGER NOT NULL DEFAULT 1\n);",
) + "\nCREATE INDEX idx_users_email ON users (email);\n";

const SEED = `
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (user_id) REFERENCES users (id));
INSERT INTO users (id, name, email) VALUES
  (1,'Ada','ada@example.com'),(2,'Grace','grace@example.com'),(3,'Alan','alan@example.com');
INSERT INTO tasks (id, user_id, title, done) VALUES
  (1,1,'Draft the analytical engine notes',1),(2,1,'Review the note G example',0),
  (3,2,'Write the compiler proposal',0),(4,3,'Prepare the Bombe report',1);
`;

const DB = "app.db";
const ARGS = (extra: string[] = []) =>
  ["schema", ...extra];

async function main(): Promise<void> {
  const out = document.getElementById("out")!;
  const loader = new Loader(document.getElementById("boot")!);
  const started = performance.now();
  const base = new URL("./", location.href).href;
  const session = new Session(new URL("dist/worker.js", base).href);
  const samples: { phase: string; loaded: number; total: number }[] = [];
  session.onProgress = (phase, loaded, total) => {
    samples.push({ phase, loaded, total });
    loader.update(phase, loaded, total);
  };

  out.textContent = "";
  try {
    await session.init(base);
  } catch (err) {
    loader.fail(String(err));
    throw err;
  }
  const bootMs = Math.round(performance.now() - started);
  loader.done(`ptah ${session.ready.version} · sqlite ${session.sqlite.version}`);

  check("the runtime boots in a browser Worker", () => {
    assert(session.ready.commit.length === 40, "no commit in ready()");
    assert(session.ready.commands.length > 0, "no command list");
  });
  check("SQLite is the vendored build and its VFSes installed", () => {
    assert(session.sqlite.version.startsWith("3."), `version ${session.sqlite.version}`);
    assert(session.sqlite.vfs.includes("memdb"), `no memdb VFS: ${session.sqlite.vfs.join(",")}`);
  });

  // Seed the workspace exactly as the Node suite does.
  await session.write("schema.sql", SCHEMA_V1);
  await session.exec(DB, SEED);

  const drift1 = await session.run([...ARGS(["drift"]), "--schema-file", "schema.sql", "--db-url", `sqlite://${DB}`]);
  check("a. drift on the seeded database is clean", () => {
    assert(drift1.code === 0, `exit ${drift1.code}\n${drift1.stdout}${drift1.stderr}`);
    assert(drift1.stdout.includes("No schema drift detected."), drift1.stdout);
  });

  await session.write("schema.sql", SCHEMA_V2);

  const dry = await session.run([...ARGS(["apply"]), "--schema-file", "schema.sql", "--db-url", `sqlite://${DB}`, "--dry-run"]);
  check("c. the dry run prints a real plan", () => {
    assert(dry.code === 0, `exit ${dry.code}\n${dry.stderr}`);
    assert(dry.stdout.includes('ADD COLUMN "active"'), dry.stdout);
    assert(dry.stdout.includes('"idx_users_email"'), dry.stdout);
  });

  const afterDry = await session.sql(DB, "SELECT count(*) FROM pragma_table_info('users') WHERE name='active'");
  check("c. the dry run changed nothing in the catalog", () => {
    assert(Number(afterDry.rows[0][0]) === 0, `active column exists after a dry run`);
  });

  const apply = await session.run([...ARGS(["apply"]), "--schema-file", "schema.sql", "--db-url", `sqlite://${DB}`], "YES\n");
  check("d. the confirmation prompt was answered through stdin and apply succeeded", () => {
    assert(apply.stdout.includes("Type 'YES' to confirm:"), "no prompt");
    assert(apply.code === 0, `exit ${apply.code}\n${apply.stderr}`);
    assert(apply.stdout.includes("Schema apply completed successfully."), apply.stdout);
  });

  const rows = await session.sql(DB, "SELECT id, name, active FROM users ORDER BY id");
  check("e. the original three rows survived, each with active = 1", () => {
    assert(rows.rows.length === 3, `got ${rows.rows.length} rows`);
    assert(rows.rows.every((r) => Number(r[2]) === 1), JSON.stringify(rows.rows));
    assert(String(rows.rows[0][1]) === "Ada", JSON.stringify(rows.rows[0]));
  });

  const drift2 = await session.run([...ARGS(["drift"]), "--schema-file", "schema.sql", "--db-url", `sqlite://${DB}`]);
  check("f. drift is clean again", () => {
    assert(drift2.code === 0, `exit ${drift2.code}\n${drift2.stderr}`);
  });

  await session.exec(DB, "ALTER TABLE users ADD COLUMN nickname TEXT;");
  const drift3 = await session.run([...ARGS(["drift"]), "--schema-file", "schema.sql", "--db-url", `sqlite://${DB}`]);
  check("g. an out-of-band column makes drift exit 1", () => {
    assert(drift3.code === 1, `exit ${drift3.code}\n${drift3.stdout}${drift3.stderr}`);
  });

  check("the database survived every command boundary", () => {
    assert(rows.rows.length === 3, "rows vanished");
  });
  check("nothing was written straight to fd 1 or fd 2, and nothing panicked", () => {
    assert(session.strays.length === 0, session.strays.join("\n"));
    assert(session.panics.length === 0, session.panics.join("\n"));
  });

  const failed = results.filter((r) => !r.ok);
  const lines = [
    `ptah ${session.ready.version} (${session.ready.commit.slice(0, 12)})`,
    `go ${session.ready.goVersion} · sqlite ${session.sqlite.version} · vfs ${session.sqlite.vfs.join(", ")}`,
    `${session.ready.commands.length} commands · boot ${bootMs} ms`,
    "",
    ...results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "\n       " + r.detail}`),
    "",
    `${results.length - failed.length} passed, ${failed.length} failed`,
  ];
  out.textContent = lines.join("\n");
  document.title = failed.length === 0 ? "PROBE PASS" : `PROBE FAIL (${failed.length})`;
  (window as unknown as { __probe: unknown }).__probe = {
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    ready: session.ready,
    sqlite: session.sqlite,
    bootMs,
    progress: {
      samples: samples.length,
      phases: [...new Set(samples.map((s) => s.phase))],
      maxLoaded: samples.reduce((m, s) => Math.max(m, s.loaded), 0),
      total: samples.find((s) => s.total > 0)?.total ?? 0,
    },
  };
}

main().catch((err) => {
  document.getElementById("out")!.textContent = `probe crashed: ${String(err)}\n${(err as Error).stack ?? ""}`;
  document.title = "PROBE CRASH";
  (window as unknown as { __probe: unknown }).__probe = { failed: -1, error: String(err) };
});
