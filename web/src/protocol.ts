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
  /** A query whose rows come back. The SQL pane's read path. */
  | { type: "sql"; id: number; path: string; sql: string }
  /** Statements with no result set, run for their effect. */
  | { type: "execSQL"; id: number; path: string; sql: string };

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
  | { type: "file"; path: string; text: string }
  | { type: "files"; entries: FileEntry[] }
  | { type: "sql"; id: number; rows: { columns: string[]; rows: unknown[][] } }
  | { type: "sqlDone"; id: number }
  | { type: "error"; request: string; message: string }
  | { type: "fatal"; message: string };
