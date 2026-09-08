/**
 * The playground page: boot, seed, and the composition of the panes.
 *
 * This file owns the seams and nothing else. The editor, the terminal, the
 * three result panes, the file rail and the guided route are separate modules
 * with their own tests; what lives here is the wiring between them and the
 * runtime -- which component is told what, and in which order, when a real
 * thing happens.
 *
 * Four ordering facts the rest of the file depends on:
 *
 *   1. The fixture is read out of the DOM synchronously, at module load,
 *      before any component has replaced the markup it lives in. The schema
 *      the visitor was looking at IS the schema written to
 *      /workspace/schema.sql; `npm run build` checks that copy against
 *      fixtures/scenario-a/ and the scenario suite checks scenarios/a.json
 *      against the same directory, so all three cannot disagree silently.
 *   2. The components take over the static markup in place. `#pg-terminal`
 *      keeps its id and its grid slot so the narrow layout's Console tab still
 *      points at it; the same is true of `#pg-editor` and `#pg-db`.
 *   3. Every pane renders from something the runtime returned. The rail and
 *      the structure pane render a catalog read with PRAGMA after the command
 *      finished; the data pane renders rows read back afterwards; the plan
 *      pane renders the planner's own stdout. Nothing is composed from the
 *      editor buffer.
 *   4. A step is ticked by `guide.refresh()`, which scores the scenario's
 *      checks against the real workspace and the real catalog. No click in
 *      this file advances the route.
 *
 * Nothing here waits for the runtime except running a command. The page is
 * complete and readable from the first paint; the 124 MB module arrives behind
 * it and the boot strip says how far it has got, in bytes actually
 * transferred.
 */

import { Editor } from "./editor.ts";
import { Guide, type GuideHost } from "./guide.ts";
import { Loader } from "./loader.ts";
import {
  ResultPanes,
  columnsAddedBetween,
  diffCatalogs,
  diffTable,
  parsePlanOutput,
  readCatalog,
  readDesiredCatalog,
  rowQueryFor,
  type Catalog,
  type PlanOrigin,
} from "./panes/index.ts";
import { Rail } from "./panes/rail.ts";
import {
  RunLog,
  SCENARIOS,
  type RunRecord,
  type Scenario,
  type StateProbe,
} from "./scenario.ts";
import type { FileEntry } from "./protocol.ts";
import { Session, SessionError, type RunHandle } from "./session.ts";
import {
  Store,
  canRun,
  statusOf,
  type ManifestInfo,
  type State,
} from "./store.ts";
import { Terminal, type RunSink, type TerminalHost, type TerminalRun } from "./terminal.ts";
import { zip } from "./zip.ts";

/** The database as Ptah is given it. The bridge sees the bare key `app.db`. */
const DB = "app.db";
const DB_URL = `sqlite://${DB}`;
const WORKSPACE = "/workspace";

/* ---------- DOM helpers ---------- */

function need<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (node === null) throw new Error(`playground: ${selector} is missing from the page`);
  return node;
}

function all<T extends Element>(selector: string): T[] {
  return [...document.querySelectorAll<T>(selector)];
}

function text(node: Element | null, value: string): void {
  if (node !== null && node.textContent !== value) node.textContent = value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/* ---------- The fixture, read out of the page ---------- */

export interface Fixture {
  /** Exactly the bytes the editor pane was showing before it became editable. */
  schema: string;
  readme: string;
  seed: string;
}

function readFixture(): Fixture {
  const schema = need("#pg-editor-text").textContent ?? "";
  const templates = new Map<string, string>();
  for (const node of all<HTMLTemplateElement>("template[data-fixture]")) {
    templates.set(node.dataset["fixture"] ?? "", node.content.textContent ?? "");
  }
  const readme = templates.get("README.md");
  const seed = templates.get("seed.sql");
  if (schema === "" || readme === undefined || seed === undefined) {
    throw new Error("playground: the page is missing part of the scenario fixture");
  }
  return { schema, readme, seed };
}

const FIXTURE = readFixture();

/* ---------- Scenarios ---------- */

const FIRST = SCENARIOS[0];
if (FIRST === undefined) throw new Error("playground: no scenarios are compiled in");

/**
 * The scenario the page ships showing, and the one the markup was built from.
 *
 * The build compares index.html against fixtures/scenario-a/ and the scenario
 * suite compares scenarios/a.json against the same files, so this can only
 * fire if one of those gates was bypassed. It is checked anyway because the
 * page would otherwise show one schema and seed another, which is the exact
 * failure both gates exist to prevent.
 */
if (FIRST.files["schema.sql"] !== FIXTURE.schema) {
  console.error(
    "playground: scenario A's schema.sql does not match the copy in index.html. " +
      "The page is showing one file and would seed another.",
  );
}

/* ---------- Store, session, loader ---------- */

const store = new Store({ scenarioId: FIRST.id });

const base = new URL("./", location.href).href;
const loader = new Loader(need("#pg-boot"));

const live = need("#pg-live");

/** One sentence to a screen reader. The pill is visual; this is its voice. */
function announce(message: string): void {
  live.textContent = message;
}

function makeSession(): Session {
  return new Session(new URL("dist/worker.js", base).href, {
    onProgress: (phase, loaded, total) => {
      store.bootProgress(phase, loaded, total);
      loader.update(phase, loaded, total);
    },
    onPanic: (message) => terminal.note(`the runtime panicked: ${message}`, "attention"),
    onStray: (stream, value) => {
      // Nothing should ever reach fd 1 or fd 2 directly. If something does, it
      // is a diagnostic the visitor is entitled to see rather than a bug to
      // hide.
      terminal.note(`[${stream}] ${value.replace(/\n+$/, "")}`, "attention");
    },
    onFailure: (message) => {
      store.bootFailed(message);
      loader.fail(message);
      announce(`The runtime stopped: ${message}`);
    },
  });
}

/**
 * Rebound by the terminal's hard restart, which is the only way to stop a run
 * that has stopped yielding. Every call site reads this binding at call time.
 */
let session: Session;

/* ---------- State this file owns ---------- */

/** The last catalog read out of SQLite. Null until one has actually been read. */
let catalog: Catalog | null = null;
/** The same read taken before the current run started, for "new" marking. */
let catalogBefore: Catalog | null = null;
/** schema.sql loaded into a scratch database, so the comparison is parser to parser. */
let desired: Catalog | null = null;
/** Why there is no desired catalog. An unavailable comparison is not agreement. */
let desiredError: string | null = null;
/** The table the rail, the structure pane and the data pane are showing. */
let selectedTable: string | null = null;
/**
 * True while the data pane is holding a SQL-pane result rather than a table.
 *
 * Every refresh repaints the data pane from the selected table. A visitor who
 * runs a SELECT would see the answer replaced by the users table on the very
 * next tick, which reads as the query having done nothing. Cleared when they
 * pick a table, when a command runs, and when a scenario is seeded.
 */
let showingQuery = false;
/** Every finished command, for the route's `ran` checks. argv and code only. */
const runLog = new RunLog();

function planOrigin(): PlanOrigin {
  return { revision: editor.bufferRevision("schema"), catalogAt: catalog?.readAt ?? 0 };
}

/* ---------- The seams the components are handed ---------- */
//
// These sit above the components deliberately. esbuild emits a bundle's
// top-level `const` as `var`, so a forward reference from a constructor
// argument reads `undefined` instead of raising the ReferenceError the source
// would give -- the guide was handed a host whose probe was undefined and
// reported the whole route unscorable, with nothing to point at the cause.
// Anything a constructor call reads eagerly is declared before it.

/* ---------- The terminal's view of the runtime ---------- */

/**
 * The apply confirmation, verbatim. `fmt.Fscan` against the literal `YES`, and
 * the prompt has no trailing newline, so this string is the only signal that
 * the program is blocked on stdin. It decides that the program is WAITING; it
 * never decides whether the run succeeded, which comes from the exit code.
 */
const CONFIRM_PROMPT = "Type 'YES' to confirm:";

/** stdout of the run in flight, kept so the plan pane can read a dry run. */
let runOutput = "";

function terminalHost(): TerminalHost {
  return {
    run(argv: string[], sink: RunSink): TerminalRun {
      // Typing the program name is the natural thing to do and the runtime is
      // already Ptah, so it is dropped rather than passed through as a
      // subcommand. The terminal echoed the line the visitor typed.
      const real = argv[0] === "ptah" ? argv.slice(1) : argv;
      if (real.length === 0) {
        queueMicrotask(() => sink.done(0));
        return { stdin: () => undefined, cancel: () => undefined };
      }

      let handle: RunHandle | null = null;
      const start = (): void => {
        runOutput = "";
        showingQuery = false;
        catalogBefore = catalog;
        // The id is taken from the handle rather than closed over as a mutable
        // binding, so a late event from a previous run cannot move the store's
        // idea of what is currently in flight.
        const started = session.run(real, {
          onStdout: (value) => {
            runOutput += value;
            sink.stdout(value);
            if (value.includes(CONFIRM_PROMPT)) store.runPhase(started.id, "awaiting-input");
          },
          onStderr: (value) => sink.stderr(value),
          onTruncated: (limit) => {
            store.runTruncated(started.id);
            sink.truncated(limit);
          },
        });
        handle = started;
        store.runStarted(started.id, real);
        sink.started();
        started.done.then(
          (result) => {
            store.runFinished(started.id, result.code);
            sink.done(result.code);
          },
          (err: unknown) => {
            // The Worker died under the run. That is not an exit code, and the
            // status pill says "recovering" rather than showing a number the
            // program never produced.
            store.runFailed(started.id, String(err));
            terminal.note(String(err), "attention");
            sink.done(2);
          },
        );
      };

      // The file the command is about to read has to hold what the editor
      // shows before the process opens it; see flushSave.
      const begin = (): void => void flushSave().then(start, start);
      if (store.state.boot.stage === "ready") begin();
      else void booted.then(begin, () => sink.done(2));

      return {
        stdin: (data) => handle?.write(data),
        cancel: () => {
          if (handle === null) return;
          store.runPhase(handle.id, "cancelling");
          handle.cancel();
        },
      };
    },
    isReady: () => store.state.boot.stage === "ready",
    commands: () => store.state.runtime.ready?.commands ?? [],
    paths: () => store.state.workspace.files.filter((f) => !f.isDir).map((f) => f.name),
    dbUrls: () => [DB_URL],
    restart: async () => {
      const scenario = guide.scenario;
      session.terminate("the worker was terminated from the terminal");
      session = makeSession();
      store.bootStarted();
      const { info, sqlite } = await session.init(base);
      store.runtimeReady(info, sqlite);
      store.bootProgress("seeding", 0, 0);
      await loadScenario(scenario);
      store.bootReady();
      runLog.clear();
      return (
        `A fresh runtime is up and scenario ${scenario.id.toUpperCase()} has been seeded again. ` +
        `Anything the terminated command had not committed is gone.`
      );
    },
  };
}

/* ---------- The guide's view of the runtime ---------- */

/**
 * What the route is scored against.
 *
 * Deliberately four methods and no fifth: `query`, `readFile`, `listFiles` and
 * the run log. There is no way to reach stdout from here, so a check cannot be
 * written that greps the transcript for a word.
 */
/**
 * A path that is not there is an answer, not a failure.
 *
 * The route asks whether `migrations/ptah.sum` exists and how many `.up.sql`
 * files are in a directory that `migrations generate` has not created yet. Both
 * come back as ENOENT, and the assertion engine reads any error from the probe
 * as "the runtime cannot answer" -- which would show a working page as still
 * booting. The errno comes over the protocol rather than being matched out of
 * the message, so a real failure is still a failure.
 */
function absent(err: unknown): boolean {
  const code = err instanceof SessionError ? err.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

const probe: StateProbe = {
  query: (sql) => session.sql(DB, sql),
  readFile: (path) =>
    session.readFile(path).then(
      (value) => value,
      (err: unknown) => {
        if (absent(err)) return null;
        throw err;
      },
    ),
  listFiles: (dir) =>
    session.listFiles(dir).then(
      (entries) => entries.map((e) => e.name),
      (err: unknown) => {
        if (absent(err)) return [];
        throw err;
      },
    ),
  runs: (): readonly RunRecord[] => runLog.all(),
};

function guideHost(): GuideHost {
  return {
    probe,
    run: (argv) => terminal.run(["ptah", ...argv]),
    offerSql: (sql) => {
      editor.setText("sql", sql, { baseline: null });
      editor.activate("sql");
      store.paneSelected("editor");
      editor.focus();
    },
    focusFile: (path) => void openFile(path),
    loadScenario: (scenario) => loadScenario(scenario),
    busy: () => !canRun(store.state),
  };
}

/* ---------- The components ---------- */

/**
 * The rail is mounted on the first real read, not at load.
 *
 * Until then the markup that shipped with the page is the honest answer: the
 * workspace files of the scenario and the tables its seed is about to create,
 * labelled "from the seed". Mounting the live rail immediately would replace
 * that with an empty list and make the page look emptier than the workspace
 * actually is, for as long as the 124 MB module takes to arrive.
 */
let rail: Rail | null = null;

function ensureRail(): Rail {
  rail ??= new Rail(need<HTMLElement>("#pg-rail"), {
    onSelectFile: (name) => void openFile(name),
    onSelectTable: (name) => void selectTable(name),
  });
  return rail;
}

const editor = new Editor(need<HTMLElement>("#pg-editor"), {
  onChange: (id) => {
    if (id !== "schema") return;
    // A plan produced from an older buffer stops describing the current one the
    // moment a character changes, and the pane names which input moved.
    panes.plan.reconcile(planOrigin());
    scheduleSave();
  },
  onSubmit: (sql) => void runSql(sql),
});

const panes = new ResultPanes(need<HTMLElement>("#pg-db"), {
  onTabChange: () => paintPanes(),
});
panes.setSource(DB_URL);

const terminal = new Terminal(need<HTMLElement>("#pg-terminal"), {
  host: terminalHost(),
  cwd: WORKSPACE,
  onExit: (argv, code) => void afterRun(argv, code),
});

const guide = new Guide(guideHost(), SCENARIOS);

/* ---------- Mounting ---------- */

/**
 * Swaps a component's element in for the static one the page shipped.
 *
 * The id moves with it so the pane tabs' aria-controls, the CSS grid slots and
 * anything else that addresses the region by id keep working. The static
 * markup is what a visitor with no JavaScript reads, so it stays in the HTML
 * and is only replaced once its live counterpart exists.
 */
function swap(selector: string, replacement: HTMLElement): void {
  const existing = need<HTMLElement>(selector);
  replacement.id = existing.id;
  existing.replaceWith(replacement);
}

swap("#pg-bar", guide.bar);
swap("#pg-steps", guide.steps);
swap("#pg-next", guide.next);

/* ---------- Boot ---------- */

interface RawManifest {
  ptahVersion?: string;
  ptahCommit?: string;
  goVersion?: string;
  wasm?: { bytes?: number; gzipBytes?: number };
  commands?: string[];
}

async function readManifest(): Promise<ManifestInfo | null> {
  try {
    const response = await fetch(new URL("vendor/ptah/manifest.json", base).href);
    if (!response.ok) return null;
    const raw = (await response.json()) as RawManifest;
    return {
      ptahVersion: String(raw.ptahVersion ?? ""),
      ptahCommit: String(raw.ptahCommit ?? ""),
      goVersion: String(raw.goVersion ?? ""),
      wasmBytes: Number(raw.wasm?.bytes ?? 0),
      gzipBytes: Number(raw.wasm?.gzipBytes ?? 0),
      commands: Array.isArray(raw.commands) ? raw.commands.map(String) : [],
    };
  } catch {
    // The manifest is a nicety: it lets the boot strip name the build it is
    // fetching. Its absence must not stop the boot.
    return null;
  }
}

let resolveBooted!: () => void;
let rejectBooted!: (reason: unknown) => void;
/** Resolves once the runtime is up and the scenario has been seeded. */
const booted = new Promise<void>((resolve, reject) => {
  resolveBooted = resolve;
  rejectBooted = reject;
});
// A command typed before the runtime is up waits on this. Nothing else does,
// and an unhandled rejection here would be reported as a page error rather
// than as the boot failure it already is.
booted.catch(() => undefined);

async function boot(): Promise<void> {
  store.bootStarted();
  const manifest = await readManifest();
  if (manifest !== null) store.manifestRead(manifest);

  const { info, sqlite } = await session.init(base);
  store.runtimeReady(info, sqlite);
  if (store.state.runtime.buildMismatch && recoverStaleCache()) return;
  // Booted on a matching pair, so a mismatch later in this tab's life is a new
  // one and gets its own attempt.
  try { sessionStorage.removeItem(STALE_KEY); } catch { /* storage refused */ }

  store.bootProgress("seeding", 0, 0);
  await loadScenario(guide.scenario);

  store.bootReady();
  loader.done(`ptah ${info.version} · sqlite ${sqlite.version}`);
  terminal.notifyReady();
  await guide.refresh();
  announce("The runtime is ready. Commands can be run.");
  resolveBooted();
}

/* ---------- Seeding ---------- */

async function writeFile(path: string, value: string): Promise<void> {
  const revision = await session.writeFile(path, value);
  store.workspaceChanged({ revision });
}

/**
 * The seeding in flight, so a second one queues behind it.
 *
 * Seeding drops the database and rewrites every file, with an await on each
 * step. Two of them interleaved would have one reading the workspace the other
 * is halfway through replacing: `serialize` between `dropDB` and the seed
 * rejects with "no database", and a catalog read that started before the drop
 * lands after it. Nothing about the selector or the Reset button stops a
 * visitor from asking twice -- picking a scenario and then pressing Reset is
 * two clicks -- so the second ask waits rather than racing.
 */
let seeding: Promise<void> = Promise.resolve();

function loadScenario(scenario: Scenario): Promise<void> {
  // Failures are reported by the caller; the chain must survive one so a
  // later load is not permanently blocked behind a rejected promise.
  const next = seeding.then(
    () => seedScenario(scenario),
    () => seedScenario(scenario),
  );
  seeding = next.catch(() => undefined);
  return next;
}

/**
 * Writes a scenario into the runtime: the files first, then the database.
 *
 * The database is dropped rather than cleared. A scenario's seed is written to
 * expect an empty database, and re-running it over the previous one would fail
 * on the first CREATE TABLE.
 */
async function seedScenario(scenario: Scenario): Promise<void> {
  store.scenarioSelected(scenario.id);
  // Directories are removed too, and `remove` is recursive. Skipping them left
  // one scenario's migrations/ in the next scenario's workspace: Reset says
  // the workspace is back to the seed, and a route that scores "the migrations
  // directory has an .up.sql in it" would have ticked on the previous run's
  // files before the visitor did anything.
  for (const file of await session.listFiles(WORKSPACE)) {
    const revision = await session.remove(file.name);
    store.workspaceChanged({ revision });
  }
  for (const [name, value] of Object.entries(scenario.files)) await writeFile(name, value);

  await session.dropDB(scenario.database.path);
  if (scenario.seed.trim() !== "") await session.execSQL(scenario.database.path, scenario.seed);

  // The route's `ran` checks read the log. Leaving it would tick steps done
  // against commands that ran before this workspace existed.
  runLog.clear();
  catalog = null;
  catalogBefore = null;
  selectedTable = null;
  showingQuery = false;
  panes.plan.setEmpty(
    "No plan yet. Run schema apply with --dry-run to see the exact SQL before anything runs.",
  );

  const schema = scenario.files["schema.sql"] ?? "";
  const revision = store.state.workspace.revision;
  editor.setText("schema", schema, { baseline: schema, syncedAt: revision });
  editor.setFooter("schema", "SQL · desired state", `revision r${revision}`);
  editor.activate("schema");
  await refresh();
}

/* ---------- Reading real state back ---------- */

/**
 * The workspace, one directory deep.
 *
 * `listFiles` answers about a single directory, and the scenario that
 * generates migrations puts its whole output in one: `migrations generate`
 * prints the paths it wrote and the route ticks because those files exist, so
 * a rail that showed only the top level would be hiding the artifact the step
 * is about. One level is what the scenarios produce; going deeper would need
 * a walk the protocol does not have, and a rail that quietly stopped at some
 * unstated depth would be worse than one whose depth is written down here.
 */
async function listWorkspace(): Promise<FileEntry[]> {
  const top = await session.listFiles(WORKSPACE);
  const out: FileEntry[] = [];
  for (const entry of top) {
    out.push(entry);
    if (!entry.isDir) continue;
    const inner = await session.listFiles(`${WORKSPACE}/${entry.name}`).catch(() => []);
    for (const child of inner) {
      if (child.isDir) continue; // one level; see above
      out.push({ ...child, name: `${entry.name}/${child.name}` });
    }
  }
  return out;
}

/**
 * Re-reads everything the page shows about the runtime.
 *
 * Called after every command, after every write and after import, reset and a
 * scenario switch. Six statements for the catalog plus one COUNT per table;
 * cheap enough that a single entry point is better than a set of narrower ones
 * that could each be forgotten somewhere.
 *
 * Which refresh is the current one.
 *
 * `catalog`, `desired` and `selectedTable` are module state, and a refresh
 * reads them again after every await. A second refresh starting in between --
 * a seeding, a command finishing, a save landing -- would have the two passes
 * writing the same three variables in an interleaved order, and the older one
 * would then paint what it read before the newer one changed it. So a pass
 * that has been superseded stops at its next await instead.
 */
let refreshPass = 0;

async function refresh(): Promise<void> {
  if (session.failed) return;
  const pass = ++refreshPass;

  const files = await listWorkspace();
  if (pass !== refreshPass) return;
  // The database is invisible to the workspace: `sqlite://app.db` reaches the
  // bridge as a bare key and Workspace.list() has never heard of it. Its size
  // has to be measured separately or the rail would print nothing for the one
  // file the visitor cares most about.
  const bytes = await session.serialize(DB);
  if (pass !== refreshPass) return;
  store.workspaceChanged({ files, dbBytes: bytes.byteLength });

  try {
    catalog = await readCatalog(DB, (path, sql) => session.sql(path, sql));
    if (pass !== refreshPass) return;
  } catch (err) {
    if (pass !== refreshPass) return;
    catalog = null;
    ensureRail().setDatabaseError(String(err));
    panes.structure.setError(String(err));
    panes.data.setError(String(err));
    paintFiles();
    return;
  }

  // The desired side is read the same way as the actual one: the file is
  // loaded into a scratch database and its catalog is read with the same
  // PRAGMA queries, so the comparison is SQLite's parser against SQLite's.
  try {
    const schemaOnDisk = await session.readFile("schema.sql");
    desired = await readDesiredCatalog(
      schemaOnDisk,
      (path, sql) => session.execSQL(path, sql),
      (path, sql) => session.sql(path, sql),
    );
    desiredError = null;
  } catch (err) {
    desired = null;
    desiredError = String(err);
  }
  if (pass !== refreshPass) return;

  if (selectedTable === null || !catalog.tables.some((t) => t.name === selectedTable)) {
    selectedTable = catalog.tables[0]?.name ?? null;
  }

  paintFiles();
  paintCatalog();
  await paintData();
  if (pass !== refreshPass) return;
  paintPanes();
  panes.plan.reconcile(planOrigin());
}

function paintFiles(): void {
  const state = store.state;
  const dirty = editor.isDirty("schema");
  const files = state.workspace.files
    .filter((file) => !file.isDir)
    .map((file) => ({
      name: file.name,
      size: file.size,
      isDir: false,
      modified: file.name === "schema.sql" && dirty,
    }));
  // The database is not a workspace file and never appears in a listing, so it
  // is added from a measurement rather than from the file system.
  if (state.workspace.dbBytes !== null) {
    files.push({ name: DB, size: state.workspace.dbBytes, isDir: false, modified: false });
  }
  const mounted = ensureRail();
  mounted.setFiles(files);
  mounted.selectFile(editor.active() === "schema" ? "schema.sql" : null);
}

function paintCatalog(): void {
  if (catalog === null) return;
  const diff = desired === null ? null : diffCatalogs(catalog, desired);
  const added = new Set<string>();
  for (const table of catalog.tables) {
    for (const name of columnsAddedBetween(catalogBefore, catalog, table.name)) {
      added.add(`${table.name}.${name}`);
    }
  }
  const mounted = ensureRail();
  mounted.setCatalog(catalog, { diff, addedColumns: added });
  mounted.selectTable(selectedTable);
}

function paintPanes(): void {
  if (catalog === null || selectedTable === null) return;
  panes.structure.show({
    catalog,
    table: selectedTable,
    diff: desired === null ? null : diffTable(catalog, desired, selectedTable),
    diffUnavailable:
      desiredError === null
        ? undefined
        : `schema.sql could not be loaded into a scratch database, so there is nothing to ` +
          `compare against: ${desiredError}`,
  });
}

/**
 * Rows, read back out of SQLite after the command finished.
 *
 * `newColumns` is computed by `showAfterCommand` from two catalog reads, so a
 * column is marked new because the database did not have it before and does
 * now -- never because a plan said it would.
 */
async function paintData(): Promise<void> {
  // A SQL-pane answer outranks the table view until the visitor moves on.
  if (showingQuery) return;
  if (catalog === null || selectedTable === null) {
    panes.data.setEmpty("The database has no tables yet.");
    return;
  }
  const table = catalog.tables.find((t) => t.name === selectedTable);
  if (table === undefined) return;
  const { sql, order } = rowQueryFor(catalog, selectedTable);
  try {
    const result = await session.sql(DB, sql);
    panes.data.showAfterCommand(
      {
        table: selectedTable,
        columns: result.columns,
        rows: result.rows,
        total: table.rowCount,
        order,
        rowsBefore: catalogBefore?.tables.find((t) => t.name === selectedTable)?.rowCount ?? null,
        status: catalogBefore === null ? "read from SQLite" : "read after the command finished",
      },
      catalogBefore,
      catalog,
    );
  } catch (err) {
    panes.data.setError(String(err));
  }
}

async function selectTable(name: string): Promise<void> {
  showingQuery = false;
  selectedTable = name;
  rail?.selectTable(name);
  paintPanes();
  await paintData();
}

async function openFile(name: string): Promise<void> {
  rail?.selectFile(name);

  if (name === "schema.sql") {
    // Put any file view away first, so the schema tab is what comes forward.
    editor.closeFile();
    editor.activate("schema");
    store.paneSelected("editor");
    return;
  }

  if (name === DB) {
    // The database is bytes, and the panes beside the editor are the way to
    // read it. Sending it to the editor would either show a binary or show
    // nothing; showing its structure is the thing the click was asking for.
    editor.closeFile();
    panes.show("structure");
    store.paneSelected("database");
    void paintPanes();
    return;
  }

  // Any other workspace file gets its own read-only tab. It must NOT be shown
  // in the schema tab: that replaced the desired schema with the clicked file
  // and left no way back to it, so schema.sql then looked like it did nothing.
  try {
    const value = await session.readFile(name);
    editor.showFile(name, value);
    store.paneSelected("editor");
  } catch (err) {
    store.noticed({ text: `${name} could not be read: ${String(err)}`, tone: "attention" });
  }
}

/* ---------- Writing the schema back ---------- */

let saveTimer = 0;

/** The write in flight, so a run can wait for the bytes to reach the file. */
let saving: Promise<void> = Promise.resolve();

/** True from an edit until that edit's write has been started. */
let saveOwed = false;

/**
 * Writes the editor buffer to the workspace shortly after typing stops.
 *
 * Ptah reads the file, not the buffer, so a visitor who edits and then runs a
 * command must not get a plan for the previous text. `flushSave` is what makes
 * that true: the delay only decides when an idle buffer is written, never what
 * a command sees.
 */
function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveOwed = true;
  editor.setFooter("schema", "SQL · desired state", "unsaved");
  saveTimer = window.setTimeout(() => void saveSchema(), 300);
}

/**
 * Lands whatever the editor owes the workspace, and waits for it.
 *
 * Every run goes through here first. Without it a command started inside the
 * debounce window plans against the previous bytes while the plan pane states
 * the current revision -- a plan attributed to a file it was not produced
 * from, which is the one thing this pane must never do.
 */
async function flushSave(): Promise<void> {
  if (saveOwed) await saveSchema();
  else await saving;
}

/** Serialised so two writes cannot land out of order. Never rejects. */
function saveSchema(): Promise<void> {
  window.clearTimeout(saveTimer);
  saveOwed = false;
  saving = saving.then(writeSchema, writeSchema);
  return saving;
}

async function writeSchema(): Promise<void> {
  if (store.state.boot.stage !== "ready") return;
  const value = editor.text("schema");
  try {
    const revision = await session.writeFile("schema.sql", value);
    store.workspaceChanged({ revision });
    editor.markSynced("schema", revision, value);
    editor.setFooter("schema", "SQL · desired state", `revision r${revision}`);
    await refresh();
    await guide.refresh();
  } catch (err) {
    store.noticed({ text: `schema.sql could not be written: ${String(err)}`, tone: "attention" });
  }
}

/* ---------- After a command ---------- */

/**
 * Everything that happens because a process exited.
 *
 * The plan pane is filled from the dry run's own stdout, chosen by the argv the
 * visitor ran rather than by matching words in the output. The route is scored
 * last, against state that has already been re-read.
 */
async function afterRun(argv: string[], code: number): Promise<void> {
  const real = argv[0] === "ptah" ? argv.slice(1) : argv;
  const now = Date.now();
  runLog.record(real, code, now, now);
  announce(`Command finished with exit code ${code}.`);

  const isPlan =
    real[0] === "schema" &&
    (real[1] === "apply" || real[1] === "plan") &&
    real.includes("--dry-run");

  await refresh().catch(() => undefined);

  if (isPlan) {
    if (code === 0) {
      panes.plan.show({ plan: parsePlanOutput(runOutput), origin: planOrigin(), kind: "dry run" });
      panes.show("plan");
    } else {
      panes.plan.setError(
        `The planner exited ${code}. Its output is in the terminal above.`,
        "Nothing was applied. The database is as it was.",
      );
      panes.show("plan");
    }
  }

  await guide.refresh();
}

/** Runs the SQL tab's buffer against the database the CLI is pointed at. */
async function runSql(sql: string): Promise<void> {
  if (!canRun(store.state) || sql.trim() === "") return;
  terminal.note(`[SQL pane] ${sql.replace(/\s+/g, " ").trim()}`);
  const started = performance.now();
  try {
    const result = await session.sql(DB, sql);
    terminal.note(
      `  → ${result.rows.length} ${result.rows.length === 1 ? "row" : "rows"} · ` +
        `${Math.round(performance.now() - started)} ms`,
    );
    if (result.columns.length > 0) {
      panes.data.show({
        table: "query result",
        columns: result.columns,
        rows: result.rows,
        total: result.rows.length,
        order: "the order the statement returned",
        status: "run from the SQL pane",
      });
      // The refresh below re-reads the catalog and would repaint this pane
      // with the selected table's rows, throwing the answer away before it
      // could be read. It stays until the visitor asks for something else.
      showingQuery = true;
      panes.show("data");
      store.paneSelected("database");
    }
  } catch (err) {
    terminal.note(String(err), "attention");
  }
  await refresh().catch(() => undefined);
  await guide.refresh();
}

/* ---------- Workspace actions ---------- */

function download(name: string, bytes: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next turn: revoking synchronously races the download in
  // Firefox, which reads the blob after the click handler returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const NEXT_STEPS = `# Continue outside the browser

The playground exported this workspace as it stood. To carry on with the
installed CLI:

    ptah schema drift --schema-file schema.sql --db-url sqlite://app.db
    ptah schema apply --schema-file schema.sql --db-url sqlite://app.db --dry-run
    ptah schema apply --schema-file schema.sql --db-url sqlite://app.db

Install: https://ptah.run/install/
`;

/**
 * Exports the workspace.
 *
 * The database has to be asked for separately: it is not a workspace file and
 * a listing will never mention it. Text files are read as text, which is what
 * every file in these scenarios is; there is no binary read in the protocol,
 * so a binary file a visitor added would not survive the round trip.
 */
async function exportWorkspace(): Promise<void> {
  const encoder = new TextEncoder();
  const entries: { name: string; data: Uint8Array }[] = [];
  for (const file of store.state.workspace.files) {
    if (file.isDir) continue;
    entries.push({ name: file.name, data: encoder.encode(await session.readFile(file.name)) });
  }
  entries.push({ name: DB, data: await session.serialize(DB) });
  entries.push({ name: "NEXT-STEPS.md", data: encoder.encode(NEXT_STEPS) });
  download("ptah-playground.zip", zip(entries), "application/zip");
  terminal.note(`[export] ${entries.length} files, including ${DB} read straight out of SQLite`);
}

const SQLITE_MAGIC = "SQLite format 3\0";

/**
 * Opens a database the visitor chose, as a scratch copy.
 *
 * The file on their disk is never touched: the bytes are read into memory and
 * deserialized into this tab's database. A WAL-mode file is refused rather than
 * opened, because its most recent transactions live in a sidecar this page
 * cannot see and opening it would silently show stale rows.
 */
async function importDatabase(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  if (bytes.byteLength < 100 || header !== SQLITE_MAGIC) {
    store.noticed({ text: `${file.name} is not a SQLite database file.`, tone: "attention" });
    return;
  }
  if (bytes[18] === 2 || bytes[19] === 2) {
    store.noticed({
      text:
        `${file.name} is in WAL mode. Its newest transactions are in a -wal sidecar this page ` +
        `cannot read. Run "PRAGMA wal_checkpoint(TRUNCATE);" against it first, then import again.`,
      tone: "attention",
    });
    return;
  }
  await session.deserialize(DB, bytes);
  catalogBefore = null;
  await refresh();
  terminal.note(
    `[import] ${file.name} · ${bytes.byteLength} bytes opened as a scratch copy of ${DB}`,
  );
  store.noticed({
    text: `${file.name} is open as a scratch copy. Your file on disk is untouched.`,
    tone: "normal",
  });
  await guide.refresh();
}

/** Puts the current scenario back exactly as it shipped. */
async function resetWorkspace(): Promise<void> {
  await loadScenario(guide.scenario);
  terminal.note("# Reset. The workspace and the database are back to the seed.");
  await guide.refresh();
  announce("The workspace was reset.");
}

/* ---------- The frame ---------- */

const bootStrip = need<HTMLElement>("#pg-boot-strip");
const buildVersion = need<HTMLElement>("[data-build-version]");
const buildCommit = need<HTMLElement>("[data-build-commit]");
const buildSqlite = need<HTMLElement>("[data-build-sqlite]");
const buildNote = need<HTMLElement>("[data-build-note]");
const runningLine = need<HTMLElement>("#pg-running");
const noticeLine = need<HTMLElement>("#pg-notice");
const grid = need<HTMLElement>(".pg-grid");
const importBtn = need<HTMLButtonElement>("#pg-import");
const exportBtn = need<HTMLButtonElement>("#pg-export");
const resetBtn = need<HTMLButtonElement>("#pg-reset");

/**
 * The manifest and the module disagree. Reload once, and only once.
 *
 * Both vendored files are requested at a URL carrying the hash of their own
 * bytes, so a fresh manifest cannot be paired with a stale binary. Reaching
 * here therefore means the manifest itself came from cache -- GitHub Pages
 * serves everything with a fixed max-age and no way to say otherwise, and a
 * deploy replaces both files at once. A reload re-reads it with `no-cache` and
 * lands on the matching pair.
 *
 * Guarded by sessionStorage rather than trusted to converge: if the second
 * attempt still disagrees the cause is not the cache, and a page that reloads
 * itself forever is worse than a page that says what is wrong. Returns true
 * when it has taken over and the caller should stop booting.
 */
const STALE_KEY = "ptah-playground:reloaded-for-stale-cache";

function recoverStaleCache(): boolean {
  let alreadyTried = false;
  try {
    alreadyTried = sessionStorage.getItem(STALE_KEY) !== null;
    if (!alreadyTried) sessionStorage.setItem(STALE_KEY, "1");
  } catch {
    // Private mode, or storage refused. Reloading blind could loop, so treat
    // it as already tried and say what is wrong instead.
    alreadyTried = true;
  }
  if (alreadyTried) {
    store.noticed({
      text:
        "This tab is running a different build than the one the site describes, and reloading did not " +
        "settle it. The version on the page is the one that is actually running.",
      tone: "attention",
    });
    return false;
  }
  location.reload();
  return true;
}

function renderBuild(state: State): void {
  const { ready: info, sqlite, manifest, buildMismatch } = state.runtime;
  if (info !== null && sqlite !== null) {
    text(buildVersion, info.version);
    text(buildCommit, info.commit.slice(0, 7));
    text(buildSqlite, `SQLite/WASM ${sqlite.version}`);
    text(
      buildNote,
      buildMismatch
        ? "the build manifest names a different commit"
        : "memory-only session: reloading discards changes",
    );
    buildNote.classList.toggle("pg-build-warn", buildMismatch);
    text(
      runningLine,
      `Ptah ${info.version} (${info.commit.slice(0, 12)}), built with ${info.goVersion}, ` +
        `${info.commands.length} commands registered. SQLite ${sqlite.version} ` +
        `(${sqlite.sourceId.split(" ")[0]}), VFS ${sqlite.vfs.join(", ")}. ` +
        `Every value on this line was read from the module running in this tab.`,
    );
    return;
  }
  if (manifest !== null) {
    text(buildVersion, manifest.ptahVersion);
    text(buildCommit, manifest.ptahCommit.slice(0, 7));
    text(buildNote, "declared by the build manifest; not verified until it runs");
  }
}

let ticker = 0;

function render(state: State): void {
  const status = statusOf(state);
  guide.setStatus({ glyph: status.glyph, text: status.text, tone: status.tone });
  guide.setStorage(
    state.workspace.dbBytes === null
      ? "memory-only"
      : `memory-only · ${formatBytes(state.workspace.dbBytes)}`,
  );

  renderBuild(state);
  bootStrip.hidden = state.boot.stage === "ready";

  const notice = state.ui.notice;
  noticeLine.hidden = notice === null;
  if (notice !== null) {
    text(noticeLine, notice.text);
    noticeLine.dataset["tone"] = notice.tone;
  }

  // Import replaces the database under whatever is reading it, so it is only
  // offered when nothing is running. Export and Reset are the same.
  const idle = canRun(state) || state.boot.stage !== "ready";
  importBtn.disabled = !canRun(state);
  exportBtn.disabled = !canRun(state);
  resetBtn.disabled = !idle;

  grid.dataset["pane"] = state.ui.pane;
  for (const node of all<HTMLButtonElement>(".pg-panetab")) {
    node.setAttribute("aria-selected", node.dataset["pane"] === state.ui.pane ? "true" : "false");
  }

  // The pill ticks while a command runs, so the elapsed time on screen is the
  // elapsed time and not the time the last event happened to arrive.
  const running = state.run !== null && state.run.phase === "running";
  if (running && ticker === 0) {
    ticker = window.setInterval(() => {
      const now = statusOf(store.state);
      guide.setStatus({ glyph: now.glyph, text: now.text, tone: now.tone });
    }, 100);
  } else if (!running && ticker !== 0) {
    window.clearInterval(ticker);
    ticker = 0;
  }
}

/* ---------- Site chrome ---------- */

/**
 * The theme toggle and the mobile menu, exactly as site.js does them: the
 * preference is stored under the same key so a visitor who chose dark on
 * ptah.run arrives here in dark.
 */
function wireChrome(): void {
  const root = document.documentElement;
  const themeBtn = document.querySelector<HTMLButtonElement>(".theme-btn");
  const colors = { light: "#fbfbfa", dark: "#161311" };

  const current = (): "light" | "dark" => {
    const attr = root.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") return attr;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };

  const label = (): void => {
    const theme = current();
    themeBtn?.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    for (const meta of all<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.removeAttribute("media");
      meta.setAttribute("content", colors[theme]);
    }
  };

  label();
  themeBtn?.addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("ptah-theme", next);
    } catch {
      // Storage refused; the choice lasts for this page only.
    }
    label();
  });

  const header = document.querySelector(".site-header");
  const menuBtn = document.querySelector<HTMLButtonElement>(".menu-btn");
  if (header !== null && menuBtn !== null) {
    const setMenu = (open: boolean): void => {
      header.classList.toggle("is-open", open);
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) header.querySelector<HTMLAnchorElement>(".nav-links a")?.focus();
    };
    menuBtn.addEventListener("click", () => setMenu(!header.classList.contains("is-open")));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && header.classList.contains("is-open")) {
        setMenu(false);
        menuBtn.focus();
      }
    });
    document.addEventListener("click", (e) => {
      if (header.classList.contains("is-open") && !header.contains(e.target as Node)) {
        setMenu(false);
      }
    });
  }
}

function wireEvents(): void {
  for (const node of all<HTMLButtonElement>(".pg-panetab")) {
    node.addEventListener("click", () => {
      const pane = node.dataset["pane"];
      if (pane === "editor" || pane === "console" || pane === "database") store.paneSelected(pane);
    });
  }

  resetBtn.addEventListener("click", () => void guard(resetWorkspace(), "reset"));
  exportBtn.addEventListener("click", () => void guard(exportWorkspace(), "export"));

  // The picker is created on demand rather than sitting in the markup: a file
  // input that is never used is one more thing a screen reader announces.
  importBtn.addEventListener("click", () => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = ".db,.sqlite,.sqlite3,application/vnd.sqlite3,application/x-sqlite3";
    picker.addEventListener("change", () => {
      const file = picker.files?.[0];
      if (file !== undefined) void guard(importDatabase(file), "import");
    });
    picker.click();
  });
}

/** Runs a workspace action and puts any failure in front of the visitor. */
async function guard(work: Promise<void>, what: string): Promise<void> {
  try {
    await work;
  } catch (err) {
    store.noticed({ text: `${what} failed: ${String(err)}`, tone: "attention" });
    terminal.note(`[${what}] ${String(err)}`, "attention");
  }
}

/* ---------- Go ---------- */

session = makeSession();
editor.setText("schema", FIXTURE.schema, { baseline: FIXTURE.schema });
editor.setFooter("schema", "SQL · desired state", "not written yet");

// The transcript opens with what this session is, rather than with an empty
// black rectangle. Both lines are the page talking and are marked as such.
terminal.note(`# Scenario ${FIRST.id.toUpperCase()} · ${FIRST.title}`);
terminal.note("# The workspace is seeded once the runtime is up. Nothing has run yet.");

wireChrome();
wireEvents();
store.subscribe((state) => render(state));
render(store.state);

// Running is the only thing that waits for the runtime. Everything above this
// line has already drawn.
boot().catch((err: unknown) => {
  const message = String(err);
  store.bootFailed(message);
  loader.fail(message);
  terminal.note(`the runtime did not start: ${message}`, "attention");
  rejectBooted(err);
});
