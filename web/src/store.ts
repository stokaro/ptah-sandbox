/**
 * The playground's frame state, and the only place it is allowed to live.
 *
 * One shallow-immutable object, a subscribe callback and a set of typed
 * actions. No framework: every consumer is a plain function that reads the
 * slice it cares about and writes DOM. Subscribers receive the previous state
 * alongside the new one so they can compare the slice they own and do nothing
 * when it did not move -- with no virtual DOM that comparison is the whole
 * render budget.
 *
 * What is deliberately NOT here: the editor buffers, the catalog, the plan,
 * the transcript and the guided route. Each of those has exactly one owner --
 * `editor.ts`, `panes/catalog.ts`, `panes/plan.ts`, `terminal.ts` and
 * `guide.ts` -- and a second copy in the store would be a copy that can
 * disagree with the component drawing it. This file holds only what several
 * consumers genuinely share: how far the boot got, what build is running, what
 * the workspace revision is, what the current run is doing, and the narrow
 * layout's pane.
 *
 * Nothing here talks to the Worker. The store records what the runtime said;
 * `session.ts` is what says it.
 */

import type { BootPhase, FileEntry, ReadyInfo, SqliteInfo } from "./protocol.ts";

/* ---------- Boot ---------- */

/**
 * `cold` is the state the page ships in: the fixture is on screen and the
 * Worker has not been asked for anything yet. `seeding` is ours rather than the
 * Worker's -- the runtime is up and we are writing the scenario into it, which
 * is real work the visitor is waiting on.
 */
export type BootStage = "cold" | BootPhase | "seeding" | "ready" | "failed";

export interface BootState {
  stage: BootStage;
  /** Bytes actually transferred. Never a guess and never a fake ramp. */
  loaded: number;
  /** Content-Length when the server sent one, else 0. */
  total: number;
  startedAt: number;
  readyAt: number | null;
  error: string | null;
}

/* ---------- Runtime identity ---------- */

/**
 * What the build manifest claims, read before anything runs. It names the file
 * being fetched; it is never printed as a fact about a running program.
 */
export interface ManifestInfo {
  ptahVersion: string;
  ptahCommit: string;
  goVersion: string;
  wasmBytes: number;
  gzipBytes: number;
  commands: string[];
}

export interface RuntimeState {
  manifest: ManifestInfo | null;
  /** What the module in this tab answered for itself. The truth. */
  ready: ReadyInfo | null;
  sqlite: SqliteInfo | null;
  /** The manifest and the running build disagree about the commit. */
  buildMismatch: boolean;
}

/* ---------- Workspace ---------- */

export interface WorkspaceState {
  /** The revision the workspace answered with on the last write. */
  revision: number;
  files: FileEntry[];
  /**
   * The database's size in bytes, from a real `serialize`. `sqlite://app.db`
   * reaches the bridge as the bare key `app.db` and `Workspace.list()` never
   * sees it, so this cannot come out of the file listing.
   */
  dbBytes: number | null;
}

/* ---------- Runs ---------- */

export type RunPhase =
  /** Started, output arriving. */
  | "running"
  /** The program is blocked on its own stdin. Only `YES` proceeds an apply. */
  | "awaiting-input"
  /** A cancel has been posted. It lands where Ptah next yields, not now. */
  | "cancelling"
  | "done";

export interface RunState {
  id: number;
  argv: readonly string[];
  phase: RunPhase;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  truncated: boolean;
  /** Set when the Worker died under the run rather than the program exiting. */
  failure: string | null;
}

/* ---------- Status ---------- */

/**
 * The pill in the scenario bar. `tone` is the whole colour decision: graphite
 * by default, amber when the visitor has to act or read something. There is no
 * green and no red anywhere in this product.
 */
export interface Status {
  glyph: string;
  text: string;
  tone: "quiet" | "normal" | "attention";
}

export type PaneTab = "editor" | "console" | "database";

export interface UiState {
  /** Which pane the narrow layout is showing. Ignored above 720px. */
  pane: PaneTab;
  /** The scenario the guide is on. Only the status pill's wording needs it. */
  scenarioId: string;
  /** Set when a module wants a sentence in front of the visitor. */
  notice: { text: string; tone: "normal" | "attention" } | null;
}

/* ---------- The whole thing ---------- */

export interface State {
  boot: BootState;
  runtime: RuntimeState;
  workspace: WorkspaceState;
  run: RunState | null;
  ui: UiState;
}

export type Listener = (state: State, prev: State) => void;

export interface StoreInit {
  scenarioId: string;
}

function initialState(init: StoreInit): State {
  return {
    boot: { stage: "cold", loaded: 0, total: 0, startedAt: 0, readyAt: null, error: null },
    runtime: { manifest: null, ready: null, sqlite: null, buildMismatch: false },
    workspace: { revision: 0, files: [], dbBytes: null },
    run: null,
    ui: { pane: "console", scenarioId: init.scenarioId, notice: null },
  };
}

/**
 * The store.
 *
 * Actions are methods rather than dispatched objects: there is one consumer,
 * the types are the documentation, and a switch over a union would add a layer
 * that buys nothing at this size.
 */
export class Store {
  #state: State;
  #listeners = new Set<Listener>();
  /** Depth of nested `#commit` calls, so a subscriber that acts sees one notify. */
  #notifying = 0;
  #pending: State | null = null;

  constructor(init: StoreInit) {
    this.#state = initialState(init);
  }

  get state(): Readonly<State> {
    return this.#state;
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /**
   * Replaces the state and notifies.
   *
   * A subscriber that writes back would otherwise re-enter this method and
   * deliver its notifications inside the outer pass, with `prev` from the wrong
   * generation. Instead the inner write is recorded and delivered once the
   * outer pass unwinds, so every subscriber sees a consistent (prev, next) pair
   * and the last one wins.
   */
  #commit(next: State): void {
    if (next === this.#state) return;
    if (this.#notifying > 0) {
      this.#pending = next;
      this.#state = next;
      return;
    }
    let prev = this.#state;
    this.#state = next;
    this.#notifying++;
    try {
      for (;;) {
        for (const fn of [...this.#listeners]) {
          try {
            fn(this.#state, prev);
          } catch (err) {
            // A broken consumer must not stop the others from redrawing, and
            // must not swallow the error either.
            console.error("playground: subscriber failed", err);
          }
        }
        if (this.#pending === null) break;
        prev = next;
        next = this.#pending;
        this.#pending = null;
      }
    } finally {
      this.#notifying--;
    }
  }

  /* ---------- Boot ---------- */

  /**
   * The Worker is being created. Not "downloading" -- nothing has been asked
   * for yet, and a byte count of zero beside that word is a small lie the
   * status pill would repeat for as long as the handshake takes.
   */
  bootStarted(): void {
    this.#commit({
      ...this.#state,
      boot: { ...this.#state.boot, stage: "starting", startedAt: Date.now(), error: null },
    });
  }

  bootProgress(stage: BootStage, loaded: number, total: number): void {
    const boot = this.#state.boot;
    if (boot.stage === stage && boot.loaded === loaded && boot.total === total) return;
    this.#commit({ ...this.#state, boot: { ...boot, stage, loaded, total } });
  }

  manifestRead(manifest: ManifestInfo): void {
    this.#commit({ ...this.#state, runtime: { ...this.#state.runtime, manifest } });
  }

  /**
   * The module answered for itself.
   *
   * The mismatch flag exists because the manifest is a build artifact and the
   * wasm is what runs: if a stale manifest is deployed beside a fresh binary,
   * the page says so instead of printing the manifest's version as if the
   * running program had claimed it.
   */
  runtimeReady(ready: ReadyInfo, sqlite: SqliteInfo): void {
    const manifest = this.#state.runtime.manifest;
    const buildMismatch =
      manifest !== null &&
      manifest.ptahCommit !== "" &&
      ready.commit !== "" &&
      !manifest.ptahCommit.startsWith(ready.commit) &&
      !ready.commit.startsWith(manifest.ptahCommit);
    this.#commit({
      ...this.#state,
      runtime: { ...this.#state.runtime, ready, sqlite, buildMismatch },
    });
  }

  bootReady(): void {
    this.#commit({
      ...this.#state,
      boot: { ...this.#state.boot, stage: "ready", readyAt: Date.now(), error: null },
    });
  }

  bootFailed(message: string): void {
    this.#commit({
      ...this.#state,
      boot: { ...this.#state.boot, stage: "failed", error: message },
    });
  }

  /* ---------- Workspace ---------- */

  workspaceChanged(patch: Partial<WorkspaceState>): void {
    const next = { ...this.#state.workspace, ...patch };
    const prev = this.#state.workspace;
    if (
      next.revision === prev.revision &&
      next.files === prev.files &&
      next.dbBytes === prev.dbBytes
    ) {
      return;
    }
    this.#commit({ ...this.#state, workspace: next });
  }

  /* ---------- Runs ---------- */

  runStarted(id: number, argv: readonly string[]): void {
    this.#commit({
      ...this.#state,
      run: {
        id,
        argv,
        phase: "running",
        startedAt: Date.now(),
        endedAt: null,
        exitCode: null,
        truncated: false,
        failure: null,
      },
    });
  }

  runPhase(id: number, phase: RunPhase): void {
    const run = this.#state.run;
    if (run === null || run.id !== id || run.phase === phase || run.phase === "done") return;
    this.#commit({ ...this.#state, run: { ...run, phase } });
  }

  runTruncated(id: number): void {
    const run = this.#state.run;
    if (run === null || run.id !== id || run.truncated) return;
    this.#commit({ ...this.#state, run: { ...run, truncated: true } });
  }

  /**
   * The process exited.
   *
   * The code is recorded as a number and nothing here interprets it. Whether 1
   * means "drift found" or "lint findings" is the command's business; the page
   * only ever colours off the number.
   */
  runFinished(id: number, exitCode: number): void {
    const run = this.#state.run;
    if (run === null || run.id !== id) return;
    this.#commit({
      ...this.#state,
      run: { ...run, phase: "done", endedAt: Date.now(), exitCode },
    });
  }

  /** The Worker died under the run. Distinct from a non-zero exit code. */
  runFailed(id: number, failure: string): void {
    const run = this.#state.run;
    if (run === null || run.id !== id) return;
    this.#commit({
      ...this.#state,
      run: { ...run, phase: "done", endedAt: Date.now(), failure },
    });
  }

  /* ---------- UI ---------- */

  paneSelected(pane: PaneTab): void {
    if (this.#state.ui.pane === pane) return;
    this.#commit({ ...this.#state, ui: { ...this.#state.ui, pane } });
  }

  scenarioSelected(id: string): void {
    if (this.#state.ui.scenarioId === id) return;
    this.#commit({ ...this.#state, ui: { ...this.#state.ui, scenarioId: id } });
  }

  noticed(notice: UiState["notice"]): void {
    this.#commit({ ...this.#state, ui: { ...this.#state.ui, notice } });
  }
}

/* ---------- Derived ---------- */

const MIB = 1024 * 1024;

function mib(bytes: number): string {
  return (bytes / MIB).toFixed(1);
}

/** Whether a command may be started. Everything else on the page works before this. */
export function canRun(state: State): boolean {
  return state.boot.stage === "ready" && (state.run === null || state.run.phase === "done");
}

/**
 * The status pill.
 *
 * Derived rather than stored, so it cannot fall out of step with what the page
 * is actually doing. The colour comes off the exit CODE, never off matching
 * words in the output: 0 is success, 1 is an expected negative result (drift
 * found, lint findings, migrations pending) and 2 is everything else, and only
 * a code the visitor has to read about is amber.
 */
export function statusOf(state: State, now = Date.now()): Status {
  const { boot, run } = state;

  if (boot.stage === "failed") {
    return { glyph: "✕", text: "runtime unavailable", tone: "attention" };
  }
  if (run && run.failure !== null) {
    return { glyph: "↻", text: "recovering", tone: "attention" };
  }
  if (run && run.phase === "awaiting-input") {
    return { glyph: "?", text: "waiting for confirmation", tone: "attention" };
  }
  if (run && run.phase === "cancelling") {
    return { glyph: "■", text: "cancelling", tone: "attention" };
  }
  if (run && run.phase === "running") {
    const seconds = ((now - run.startedAt) / 1000).toFixed(1);
    return { glyph: "◌", text: `running · ${seconds} s`, tone: "normal" };
  }

  switch (boot.stage) {
    case "cold":
      return { glyph: "·", text: "runtime not started", tone: "quiet" };
    case "downloading":
      return {
        glyph: "…",
        text: boot.total > 0
          ? `downloading ${mib(boot.loaded)} / ${mib(boot.total)} MiB`
          : `downloading ${mib(boot.loaded)} MiB`,
        tone: "quiet",
      };
    case "compiling":
      return { glyph: "…", text: "compiling", tone: "quiet" };
    case "initializing SQLite":
      return { glyph: "…", text: "initializing SQLite", tone: "quiet" };
    case "starting":
      return { glyph: "…", text: "starting", tone: "quiet" };
    case "seeding":
      return {
        glyph: "…",
        text: `seeding scenario ${state.ui.scenarioId.toUpperCase()}`,
        tone: "quiet",
      };
    default:
      break;
  }

  if (run && run.phase === "done" && run.exitCode !== null) {
    if (run.exitCode === 0) return { glyph: "●", text: "ready", tone: "normal" };
    if (run.exitCode === 1) {
      return { glyph: "△", text: "exit 1 · expected negative", tone: "attention" };
    }
    return { glyph: "✕", text: `exit ${run.exitCode} · failed`, tone: "attention" };
  }
  return { glyph: "●", text: "ready", tone: "normal" };
}
