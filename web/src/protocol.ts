/**
 * The message protocol between the page and the Worker.
 *
 * Deliberately small and deliberately typed: the page never parses terminal
 * text to learn what happened. stdout is for the terminal, and every piece of
 * state the UI renders arrives as its own message.
 */

export interface ReadyInfo {
  version: string;
  commit: string;
  goVersion: string;
  commands: string[];
}

export interface SqliteInfo {
  version: string;
  sourceId: string;
  compileOptions: string[];
  vfs: string[];
}

export interface FileEntry {
  name: string;
  size: number;
  isDir: boolean;
  mtime: number;
}

export type WorkerRequest =
  /** Boot the runtime. `base` is the URL every vendored asset resolves against. */
  | { type: "init"; base: string }
  | { type: "run"; runId: number; argv: string[] }
  | { type: "stdin"; runId: number; data: string }
  | { type: "cancel"; runId: number }
  | { type: "writeFile"; path: string; text: string }
  | { type: "readFile"; path: string }
  | { type: "listFiles"; dir: string }
  | { type: "remove"; path: string }
  /** A query whose rows come back. The SQL pane's read path. */
  | { type: "sql"; id: number; path: string; sql: string }
  /** Statements with no result set, run for their effect. */
  | { type: "execSQL"; id: number; path: string; sql: string }
  /**
   * The database bytes. A database is invisible to the workspace -- it lives in
   * the SQLite bridge under the bare key `app.db`, and `Workspace.list()` does
   * not see it -- so export, the size the file rail prints and any checkpoint
   * all have to ask for it here or they silently omit the user's data.
   */
  | { type: "serialize"; id: number; path: string }
  /** Replace a database with an image, for import and for reset. */
  | { type: "deserialize"; id: number; path: string; bytes: Uint8Array }
  /** Forget a database. Reset drops before it re-runs the seed. */
  | { type: "dropDB"; id: number; path: string };

/**
 * Where the boot has got to. The phases are real work, in order, and
 * `downloading` carries real byte counts -- there is no invented percentage.
 */
export type BootPhase =
  | "downloading"
  | "compiling"
  | "initializing SQLite"
  | "starting";

export type HostEvent =
  | { type: "ready"; info: ReadyInfo; sqlite: SqliteInfo }
  /**
   * loaded/total are UNCOMPRESSED bytes. Content-Length would be the encoded
   * length on a gzipped response while response.body yields decoded bytes, so
   * the denominator is the size the manifest publishes for this exact build.
   */
  | { type: "progress"; phase: BootPhase; loaded: number; total: number }
  | { type: "stdout"; runId: number; text: string }
  | { type: "stderr"; runId: number; text: string }
  | { type: "done"; runId: number; code: number }
  | { type: "truncated"; runId: number; limitBytes: number }
  /** Go's runtime panic path, which bypasses the host boundary entirely. */
  | { type: "panic"; message: string }
  /** Anything written straight to fd 1 or fd 2; normally nothing ever is. */
  | { type: "stray"; stream: "stdout" | "stderr"; text: string }
  | { type: "wrote"; path: string; revision: number }
  | { type: "removed"; path: string; revision: number }
  | { type: "file"; path: string; text: string }
  | { type: "files"; entries: FileEntry[] }
  | { type: "sql"; id: number; rows: { columns: string[]; rows: unknown[][] } }
  | { type: "sqlDone"; id: number }
  | { type: "serialized"; id: number; bytes: Uint8Array }
  | { type: "deserialized"; id: number }
  | { type: "dropped"; id: number }
  /**
   * A request failed on the far side.
   *
   * `code` carries the filesystem errno when there is one -- ENOENT for a path
   * that is not there, ENOTDIR for one that is not a directory. The page has to
   * tell "this directory does not exist yet", which is an ordinary answer, from
   * "the runtime cannot answer", which is not, and matching on the message text
   * to do it would be exactly the guessing this protocol exists to avoid.
   */
  | { type: "error"; request: string; message: string; code?: string }
  | { type: "fatal"; message: string };
