/**
 * The typed client for the Worker.
 *
 * Everything the page asks of the runtime goes through here, and nothing else
 * in the page touches `postMessage`. Two things this file is responsible for
 * that a thinner wrapper would get wrong:
 *
 *   1. Correlation. The Worker answers requests strictly in order, so replies
 *      are matched by a FIFO queue per reply key rather than by an id bolted
 *      onto every message. Two reads of the same path in flight at once still
 *      resolve to the right promise.
 *   2. Death. A Worker can stop existing -- a failed script load, an OOM on a
 *      124 MB module, a watchdog terminating it. When that happens every
 *      pending wait rejects with the same `SessionError`, `onFailure` fires
 *      once, and no caller is left holding a promise that will never settle.
 *
 * Cancellation deserves its own note. `cancel()` posts a request; it does not
 * stop anything by itself. While SQLite is inside a synchronous step the
 * Worker's event loop is starved, so neither postMessage nor setTimeout runs
 * there -- the request lands where Ptah next yields. Callers must say that to
 * the visitor instead of showing a stopped state that has not happened.
 */

import type {
  BootPhase,
  FileEntry,
  HostEvent,
  ReadyInfo,
  SqliteInfo,
  WorkerRequest,
} from "./protocol.ts";

export class SessionError extends Error {
  /** The filesystem errno the Worker reported, when the failure had one. */
  code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

export interface RunResult {
  code: number;
  durationMs: number;
  /** The Worker cut the output at its byte limit. */
  truncated: boolean;
}

export interface RunHandlers {
  onStdout?(text: string): void;
  onStderr?(text: string): void;
  /** Output was cut. The transcript after this point is incomplete, and says so. */
  onTruncated?(limitBytes: number): void;
}

export interface RunHandle {
  readonly id: number;
  readonly argv: readonly string[];
  /** Settles with the process's exit code, or rejects if the Worker died. */
  readonly done: Promise<RunResult>;
  /**
   * Writes to the program's stdin. The apply confirmation is a `fmt.Fscan`
   * against the literal `YES`, and its prompt has no trailing newline, so the
   * caller decides when the program is asking -- this only delivers bytes.
   */
  write(data: string): void;
  /** Asks the program to stop. See the note at the top of this file. */
  cancel(): void;
}

export interface SessionHandlers {
  onProgress?(phase: BootPhase, loaded: number, total: number): void;
  /** Go's runtime panic path, which bypasses the host boundary entirely. */
  onPanic?(message: string): void;
  /** Anything written straight to fd 1 or fd 2. Normally nothing ever is. */
  onStray?(stream: "stdout" | "stderr", text: string): void;
  /** The Worker is gone. Fires once; every pending call has already rejected. */
  onFailure?(message: string): void;
}

type Pending = { resolve(event: HostEvent): void; reject(error: Error): void };

/**
 * The reply key an event answers, or null if the event is a stream rather than
 * an answer. Keys carry the path or id so an unrelated reply cannot satisfy a
 * different caller's wait.
 */
function replyKey(event: HostEvent): string | null {
  switch (event.type) {
    case "ready":
      return "ready";
    case "wrote":
      return `wrote:${event.path}`;
    case "removed":
      return `removed:${event.path}`;
    case "file":
      return `file:${event.path}`;
    case "files":
      return "files";
    case "sql":
      return `sql:${event.id}`;
    case "sqlDone":
      return `sqlDone:${event.id}`;
    case "serialized":
      return `serialized:${event.id}`;
    case "deserialized":
      return `deserialized:${event.id}`;
    case "dropped":
      return `dropped:${event.id}`;
    default:
      return null;
  }
}

interface ActiveRun {
  id: number;
  argv: readonly string[];
  startedAt: number;
  handlers: RunHandlers;
  settle(result: RunResult): void;
  fail(error: Error): void;
  truncated: boolean;
}

export class Session {
  #worker: Worker;
  #handlers: SessionHandlers;
  /** One queue per key: the Worker answers in order, so FIFO is exact. */
  #waiting = new Map<string, Pending[]>();
  #runs = new Map<number, ActiveRun>();
  #nextRun = 1;
  #nextId = 1;
  #failure: string | null = null;

  ready: ReadyInfo | null = null;
  sqlite: SqliteInfo | null = null;

  constructor(url: string, handlers: SessionHandlers = {}) {
    this.#handlers = handlers;
    this.#worker = new Worker(url, { type: "module" });
    this.#worker.onmessage = (e: MessageEvent<HostEvent>) => this.#onEvent(e.data);
    // Without these a Worker that fails to load, or throws while booting, is
    // silent and the page waits forever on a promise nothing will settle.
    this.#worker.onerror = (e: ErrorEvent) => {
      const where = e.filename ? ` (${e.filename}:${e.lineno})` : "";
      this.#die(`worker error: ${e.message || "script failed to load"}${where}`);
    };
    this.#worker.onmessageerror = () => this.#die("worker sent an unstructurable message");
  }

  get failed(): boolean {
    return this.#failure !== null;
  }

  get failure(): string | null {
    return this.#failure;
  }

  /** Boots the runtime. `base` is the URL every vendored asset resolves against. */
  async init(base: string): Promise<{ info: ReadyInfo; sqlite: SqliteInfo }> {
    const event = await this.#ask<Extract<HostEvent, { type: "ready" }>>(
      { type: "init", base },
      "ready",
    );
    this.ready = event.info;
    this.sqlite = event.sqlite;
    return { info: event.info, sqlite: event.sqlite };
  }

  /**
   * Starts a command.
   *
   * Returns as soon as the request is posted: the handle is how the caller
   * follows the run. Output arrives on the handlers as the program writes it,
   * not in a batch at the end, because a long apply must be readable while it
   * is still running.
   */
  run(argv: readonly string[], handlers: RunHandlers = {}): RunHandle {
    const id = this.#nextRun++;
    let settle!: (result: RunResult) => void;
    let fail!: (error: Error) => void;
    const done = new Promise<RunResult>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const active: ActiveRun = {
      id,
      argv,
      startedAt: performance.now(),
      handlers,
      settle,
      fail,
      truncated: false,
    };
    this.#runs.set(id, active);

    if (this.#failure !== null) {
      this.#runs.delete(id);
      fail(new SessionError(this.#failure));
    } else {
      this.#send({ type: "run", runId: id, argv: [...argv] });
    }

    return {
      id,
      argv,
      done,
      write: (data: string) => {
        if (this.#failure !== null || !this.#runs.has(id)) return;
        this.#send({ type: "stdin", runId: id, data });
      },
      cancel: () => {
        if (this.#failure !== null || !this.#runs.has(id)) return;
        this.#send({ type: "cancel", runId: id });
      },
    };
  }

  /* ---------- Files ---------- */

  async writeFile(path: string, text: string): Promise<number> {
    const event = await this.#ask<Extract<HostEvent, { type: "wrote" }>>(
      { type: "writeFile", path, text },
      `wrote:${path}`,
    );
    return event.revision;
  }

  async readFile(path: string): Promise<string> {
    const event = await this.#ask<Extract<HostEvent, { type: "file" }>>(
      { type: "readFile", path },
      `file:${path}`,
    );
    return event.text;
  }

  async listFiles(dir: string): Promise<FileEntry[]> {
    const event = await this.#ask<Extract<HostEvent, { type: "files" }>>(
      { type: "listFiles", dir },
      "files",
    );
    return event.entries;
  }

  async remove(path: string): Promise<number> {
    const event = await this.#ask<Extract<HostEvent, { type: "removed" }>>(
      { type: "remove", path },
      `removed:${path}`,
    );
    return event.revision;
  }

  /* ---------- SQL ---------- */

  async sql(path: string, sql: string): Promise<{ columns: string[]; rows: unknown[][] }> {
    const id = this.#nextId++;
    const event = await this.#ask<Extract<HostEvent, { type: "sql" }>>(
      { type: "sql", id, path, sql },
      `sql:${id}`,
    );
    return event.rows;
  }

  async execSQL(path: string, sql: string): Promise<void> {
    const id = this.#nextId++;
    await this.#ask({ type: "execSQL", id, path, sql }, `sqlDone:${id}`);
  }

  /**
   * The database's real bytes.
   *
   * `sqlite://app.db` reaches the bridge as the bare key `app.db` and the
   * workspace cannot see it, so export, the file rail's size and any checkpoint
   * have to come through here or the visitor's data is silently missing.
   */
  async serialize(path: string): Promise<Uint8Array> {
    const id = this.#nextId++;
    const event = await this.#ask<Extract<HostEvent, { type: "serialized" }>>(
      { type: "serialize", id, path },
      `serialized:${id}`,
    );
    return event.bytes;
  }

  async deserialize(path: string, bytes: Uint8Array): Promise<void> {
    const id = this.#nextId++;
    await this.#ask({ type: "deserialize", id, path, bytes }, `deserialized:${id}`);
  }

  async dropDB(path: string): Promise<void> {
    const id = this.#nextId++;
    await this.#ask({ type: "dropDB", id, path }, `dropped:${id}`);
  }

  /**
   * Ends the Worker.
   *
   * The one way to stop a command that has stopped yielding: the watchdog owns
   * this, and everything waiting rejects with the reason it was killed.
   */
  terminate(reason: string): void {
    this.#worker.terminate();
    this.#die(reason);
  }

  /* ---------- Internals ---------- */

  #send(request: WorkerRequest): void {
    this.#worker.postMessage(request);
  }

  #ask<T extends HostEvent>(request: WorkerRequest, key: string): Promise<T> {
    if (this.#failure !== null) return Promise.reject(new SessionError(this.#failure));
    return new Promise<T>((resolve, reject) => {
      const queue = this.#waiting.get(key);
      const pending: Pending = { resolve: resolve as (event: HostEvent) => void, reject };
      if (queue) queue.push(pending);
      else this.#waiting.set(key, [pending]);
      this.#send(request);
    });
  }

  #onEvent(event: HostEvent): void {
    switch (event.type) {
      case "stdout": {
        this.#runs.get(event.runId)?.handlers.onStdout?.(event.text);
        return;
      }
      case "stderr": {
        this.#runs.get(event.runId)?.handlers.onStderr?.(event.text);
        return;
      }
      case "truncated": {
        const run = this.#runs.get(event.runId);
        if (!run) return;
        run.truncated = true;
        run.handlers.onTruncated?.(event.limitBytes);
        return;
      }
      case "done": {
        const run = this.#runs.get(event.runId);
        if (!run) return;
        this.#runs.delete(event.runId);
        run.settle({
          code: event.code,
          durationMs: Math.round(performance.now() - run.startedAt),
          truncated: run.truncated,
        });
        return;
      }
      case "progress": {
        this.#handlers.onProgress?.(event.phase, event.loaded, event.total);
        return;
      }
      case "panic": {
        // A Go panic leaves the runtime in an undefined state: the program is
        // parked on select{} and will never answer again. Treat it as death,
        // so every waiting caller is released instead of hanging.
        this.#handlers.onPanic?.(event.message);
        this.#die(`the runtime panicked: ${event.message}`);
        return;
      }
      case "stray": {
        this.#handlers.onStray?.(event.stream, event.text);
        return;
      }
      case "fatal": {
        this.#die(event.message);
        return;
      }
      case "error": {
        // A request failed on the far side. Only one caller is waiting on any
        // given request, but the event does not carry the key, so the oldest
        // wait is the one that failed -- the Worker answers in order.
        this.#rejectOldest(new SessionError(`${event.request}: ${event.message}`, event.code));
        return;
      }
      default: {
        const key = replyKey(event);
        if (key === null) return;
        const queue = this.#waiting.get(key);
        const pending = queue?.shift();
        if (queue && queue.length === 0) this.#waiting.delete(key);
        pending?.resolve(event);
      }
    }
  }

  /**
   * Fails whichever request is oldest.
   *
   * `error` events do not name the request they answer beyond its type, and the
   * Worker handles messages one at a time in arrival order, so the request that
   * threw is the earliest one still waiting. Getting this wrong would resolve
   * the wrong promise later, which is worse than rejecting the wrong one now.
   */
  #rejectOldest(error: Error): void {
    for (const [key, queue] of this.#waiting) {
      const pending = queue.shift();
      if (queue.length === 0) this.#waiting.delete(key);
      if (pending) {
        pending.reject(error);
        return;
      }
    }
  }

  #die(message: string): void {
    if (this.#failure !== null) return;
    this.#failure = message;
    const error = new SessionError(message);
    for (const [, queue] of this.#waiting) {
      for (const pending of queue) pending.reject(error);
    }
    this.#waiting.clear();
    for (const run of this.#runs.values()) run.fail(error);
    this.#runs.clear();
    this.#handlers.onFailure?.(message);
  }
}
