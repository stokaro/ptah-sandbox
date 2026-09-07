/**
 * Contract A: the JS bridge between the Go/wasm SQLite driver and the vendored
 * SQLite WASM build. Installed as `globalThis.__sqlite` in the Worker before
 * the Go program starts. Every method is synchronous, because syscall/js calls
 * from Go cannot await.
 *
 * Three properties of the environment shape everything in this file.
 *
 * 1. No BigInt may reach Go. Go's wasm_exec.js stores a BigInt with typeFlag 0,
 *    so `js.Value.Type()` hits `panic("bad type flag")` and the value leaks a
 *    JS-side reference slot. Every i64-producing SQLite call is therefore
 *    coerced here, on the JS side, to a JS number when Number.isSafeInteger
 *    holds and to a decimal string otherwise. Each such site is tagged with the
 *    marker SQLITE-I64-COERCION so CI can assert the set never shrinks and that
 *    no i64 call appears outside a tagged site.
 *
 * 2. Ptah opens and closes a fresh *sql.DB on every CLI invocation, yet
 *    `sqlite://app.db` has to be the same database across commands, and some
 *    commands hold two live handles at once (db vs dev). SQLite's built-in
 *    shared named memdb VFS gives exactly that: `file:/<name>?vfs=memdb` is one
 *    store shared by every connection that names it, with real locking.
 *    Verified in Chrome 152 (headless, Worker) against this pinned build:
 *      sqlite3_vfs_find('memdb')                     -> 93056 (registered)
 *      two handles on one name see each other's writes -> yes
 *      store survives closing one of two handles       -> yes
 *      store dies when the last handle closes          -> yes ("no such table")
 *    The last line is why each logical database holds a keeper connection that
 *    is opened once and never closed until drop(). memdb refcounts the store
 *    (src/memdb.c nRef) and frees it at zero.
 *
 * 3. An exception thrown from a progress handler propagates out through
 *    SQLite's wasm frames as a raw JS exception with no result code — unlike
 *    sqlite3_exec, whose glue catches. The deadline callback therefore catches
 *    everything and returns 1 (abort).
 */

import type {
  Ptr,
  Sqlite3Capi,
  Sqlite3InitArgs,
  Sqlite3InitModule,
  Sqlite3Namespace,
  Sqlite3Wasm,
} from "./sqlite-types.ts";

// --------------------------------------------------------------------------
// Contract A surface
// --------------------------------------------------------------------------

/** A value as it crosses into Go. Never a BigInt. See rule 1 above. */
export type SqliteValue = number | string | Uint8Array | null;

export interface PrepareResult {
  /** Bridge-local statement id. 0 means the text held no statement (comment or whitespace only). */
  stmt: number;
  /** The unconsumed remainder of the SQL text. */
  tail: string;
}

export interface FetchResult {
  /** Number of rows in this batch. */
  n: number;
  /** Row-major, length n*ncols. 1=int 2=float 3=text 4=blob 5=null. */
  types: number[];
  /** Row-major, length n*ncols. */
  values: SqliteValue[];
  /** True when the statement is exhausted. */
  done: boolean;
}

export interface SqliteInfo {
  version: string;
  sourceId: string;
  compileOptions: string[];
  vfs: string[];
}

export interface SqliteBridge {
  open(path: string): number;
  close(h: number): void;
  drop(path: string): void;
  exists(path: string): boolean;

  exec(h: number, sql: string): void;

  prepare(h: number, sql: string): PrepareResult;
  bindNull(s: number, i: number): void;
  bindInt(s: number, i: number, decimal: string): void;
  bindFloat(s: number, i: number, v: number): void;
  bindText(s: number, i: number, v: string): void;
  bindBlob(s: number, i: number, v: Uint8Array): void;
  columns(s: number): string[];
  step(s: number): boolean;
  fetch(s: number, maxRows: number): FetchResult;
  reset(s: number): void;
  finalize(s: number): void;
  changes(h: number): number;
  lastInsertRowid(h: number): string;

  begin(h: number): void;
  commit(h: number): void;
  rollback(h: number): void;

  limitAttachedZero(h: number): void;
  setDeadline(h: number, epochMillis: number): void;
  interrupt(h: number): void;

  serialize(path: string): Uint8Array;
  deserialize(path: string, bytes: Uint8Array): void;
  info(): SqliteInfo;
}

/**
 * Every failure crosses to Go as one of these. `.message` is the verbatim
 * sqlite3_errmsg text whenever a connection was available to ask, because
 * internal/dbschema/sqlite/restrict.go matches on the substring
 * "too many attached databases".
 */
export class SqliteError extends Error {
  sqliteCode = 0;
  sqliteExtended = 0;
  sqliteApi = "";

  constructor(message: string, code: number, extended: number, api: string) {
    super(message);
    this.name = "SqliteError";
    this.sqliteCode = code;
    this.sqliteExtended = extended;
    this.sqliteApi = api;
  }
}

export interface SqliteBridgeOptions {
  /** An already-initialized sqlite3 namespace. Wins over every other loading option. */
  sqlite3?: Sqlite3Namespace;
  /** The Emscripten init function, when the caller imported sqlite3.mjs itself. */
  initModule?: Sqlite3InitModule;
  /** URL to import sqlite3.mjs from. Defaults to the vendored copy next to this file. */
  moduleUrl?: string;
  /** Passed straight to the init function (Node needs instantiateWasm; browsers need nothing). */
  initArgs?: Sqlite3InitArgs;
  /**
   * VM opcodes between progress-handler callbacks. See PROGRESS_OPS for the
   * measured sweep behind the default.
   */
  progressOps?: number;
  /** memdb name prefix. Only matters if two bridges share one wasm instance. */
  namePrefix?: string;
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/**
 * Opcodes between progress-handler callbacks. Swept in Chrome 152 headless
 * (Worker, this build) against a 3M-row recursive CTE, 9 interleaved runs per
 * value, median reported, baseline 397.56 ms:
 *
 *   nOps   callbacks   median    overhead   ns/callback   max deadline overshoot
 *    500     102000    400.32 ms   +0.69 %       27.0            -0.10 ms
 *   1000      51000    397.19 ms   -0.09 %       (noise)         -0.07 ms
 *   5000      10200    397.44 ms   -0.03 %       (noise)         -0.04 ms
 *  20000       2550    396.02 ms   -0.39 %       (noise)          0.00 ms
 *
 * Every value aborts with rc 9 / "interrupted" and holds the deadline to well
 * under a millisecond. 500 is the smallest whose overhead is under 2 %, and it
 * buys the tightest check interval, so it is the default; the cost is one
 * JS callback per 500 VM opcodes at ~27 ns each.
 */
const PROGRESS_OPS = 500;

/** Rows per fetch() when the caller passes a nonsensical batch size. */
const MIN_FETCH_ROWS = 1;

const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

const DEFAULT_MODULE_URL = new URL("../../vendor/sqlite/sqlite3.mjs", import.meta.url).href;

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

// --------------------------------------------------------------------------
// i64 coercion — the only place BigInt is allowed to exist
// --------------------------------------------------------------------------

/**
 * Coerce an i64 to something syscall/js can represent: a JS number when it is
 * exactly representable, else a decimal string. Values of magnitude above 2^53
 * round to a multiple of 2 that is greater than MAX_SAFE_INTEGER, so
 * Number.isSafeInteger is an exact test for "converts without loss".
 */
function i64ToJs(v: bigint): number | string {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : String(v);
}

/** Coerce an i64 that the contract types as a plain number. Refuses to lie. */
function i64ToNumber(v: bigint, api: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new SqliteError(`${api} returned ${v} which cannot be represented exactly as a JS number`, 0, 0, api);
  }
  return n;
}

// --------------------------------------------------------------------------
// memdb naming
// --------------------------------------------------------------------------

const SAFE_NAME_CHAR = /[A-Za-z0-9._-]/;

/**
 * Map an arbitrary logical path to a memdb store name.
 *
 * memdb treats a leading "/" as "shared by name" (src/memdb.c:556), and the
 * name travels through both a URI (`file:/<name>?vfs=memdb`) and a bare SQL
 * string literal (`VACUUM main INTO '/<name>'`), so the encoding is restricted
 * to characters that need no escaping in either. "~" is the escape introducer
 * and encodes itself, which keeps the mapping injective.
 */
function encodeStoreName(prefix: string, path: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(path)) {
    const ch = String.fromCharCode(byte);
    out += SAFE_NAME_CHAR.test(ch) ? ch : "~" + byte.toString(16).padStart(2, "0");
  }
  return `/${prefix}-${out}`;
}

// --------------------------------------------------------------------------
// Internal records
// --------------------------------------------------------------------------

interface LogicalDb {
  path: string;
  storeName: string;
  /** Held open for the life of the logical database; memdb frees the store at refcount zero. */
  keeper: Ptr;
  handles: Set<number>;
}

interface Handle {
  id: number;
  db: LogicalDb;
  ptr: Ptr;
  stmts: Set<number>;
  /** Epoch millis; 0 means no deadline. Read by the progress callback. */
  deadline: number;
  /** Stable closure, installed at most once per handle. */
  progress: (() => number) | null;
}

interface Stmt {
  id: number;
  handle: Handle;
  ptr: Ptr;
  ncols: number;
  names: string[];
  exhausted: boolean;
}

// --------------------------------------------------------------------------
// Implementation
// --------------------------------------------------------------------------

class Bridge implements SqliteBridge {
  #capi: Sqlite3Capi;
  #wasm: Sqlite3Wasm;
  #ns: Sqlite3Namespace;
  #prefix: string;
  #progressOps: number;

  #dbs = new Map<string, LogicalDb>();
  #handles = new Map<number, Handle>();
  #stmts = new Map<number, Stmt>();
  #nextHandle = 1;
  #nextStmt = 1;
  #nextNonce = 1;
  #compileOptions: string[] | null = null;

  #openFlags: number;
  #memdbVfs: Ptr;

  constructor(ns: Sqlite3Namespace, options: SqliteBridgeOptions) {
    this.#ns = ns;
    this.#capi = ns.capi;
    this.#wasm = ns.wasm;
    this.#prefix = options.namePrefix ?? "ptah";
    this.#progressOps = options.progressOps ?? PROGRESS_OPS;

    const capi = this.#capi;
    this.#openFlags = capi.SQLITE_OPEN_READWRITE | capi.SQLITE_OPEN_CREATE | capi.SQLITE_OPEN_URI;
    this.#memdbVfs = capi.sqlite3_vfs_find("memdb");
    if (!this.#memdbVfs) {
      // Without memdb there is no way to give two live connections one store,
      // and no way to keep a database alive across Ptah's open/close cycle.
      throw new SqliteError(
        "the vendored SQLite build does not register the memdb VFS; " +
          "cross-invocation persistence is impossible with this build",
        0, 0, "sqlite3_vfs_find",
      );
    }
  }

  // ---- errors -----------------------------------------------------------

  #dbError(dbPtr: Ptr, rc: number, api: string): SqliteError {
    const capi = this.#capi;
    const msg = dbPtr ? capi.sqlite3_errmsg(dbPtr) : capi.sqlite3_errstr(rc);
    const ext = dbPtr ? capi.sqlite3_extended_errcode(dbPtr) : rc;
    return new SqliteError(msg, rc, ext, api);
  }

  #misuse(message: string, api: string): SqliteError {
    // SQLITE_MISUSE is 21; it is the honest code for "the caller broke the contract".
    return new SqliteError(message, 21, 21, api);
  }

  // ---- lookups ----------------------------------------------------------

  #handle(h: number): Handle {
    const rec = this.#handles.get(h);
    if (!rec) throw this.#misuse(`unknown database handle ${h}`, "handle");
    return rec;
  }

  #stmt(s: number): Stmt {
    const rec = this.#stmts.get(s);
    if (!rec) throw this.#misuse(`unknown statement ${s}`, "statement");
    return rec;
  }

  // ---- raw open ---------------------------------------------------------

  #openRaw(uri: string, api: string): Ptr {
    const capi = this.#capi;
    const wasm = this.#wasm;
    const pp = wasm.allocPtr();
    try {
      const rc = capi.sqlite3_open_v2(uri, pp, this.#openFlags, null);
      const ptr = wasm.peekPtr(pp);
      if (rc !== capi.SQLITE_OK) {
        const err = this.#dbError(ptr, rc, api);
        // sqlite3_open_v2 hands back a handle even on failure so the message
        // can be read; it still has to be closed.
        if (ptr) capi.sqlite3_close_v2(ptr);
        throw err;
      }
      return ptr;
    } finally {
      wasm.dealloc(pp);
    }
  }

  #storeUri(storeName: string): string {
    return `file:${storeName}?vfs=memdb`;
  }

  #logical(path: string, api: string): LogicalDb {
    const db = this.#dbs.get(path);
    if (!db) throw this.#misuse(`no database at ${JSON.stringify(path)}`, api);
    return db;
  }

  #ensureLogical(path: string): LogicalDb {
    let db = this.#dbs.get(path);
    if (db) return db;
    const storeName = encodeStoreName(this.#prefix, path);
    const keeper = this.#openRaw(this.#storeUri(storeName), "open");
    db = { path, storeName, keeper, handles: new Set() };
    this.#dbs.set(path, db);
    return db;
  }

  // ---- Contract A: lifecycle -------------------------------------------

  open(path: string): number {
    if (typeof path !== "string" || path.length === 0) {
      throw this.#misuse("open() requires a non-empty path", "open");
    }
    const db = this.#ensureLogical(path);
    const ptr = this.#openRaw(this.#storeUri(db.storeName), "open");
    const id = this.#nextHandle++;
    const handle: Handle = { id, db, ptr, stmts: new Set(), deadline: 0, progress: null };
    this.#handles.set(id, handle);
    db.handles.add(id);
    return id;
  }

  close(h: number): void {
    const handle = this.#handle(h);
    this.#closeHandle(handle);
  }

  #closeHandle(handle: Handle): void {
    const capi = this.#capi;
    for (const s of [...handle.stmts]) {
      const stmt = this.#stmts.get(s);
      if (stmt) {
        capi.sqlite3_finalize(stmt.ptr);
        this.#stmts.delete(s);
      }
    }
    handle.stmts.clear();
    if (handle.progress) {
      capi.sqlite3_progress_handler(handle.ptr, 0, null, 0);
      handle.progress = null;
    }
    capi.sqlite3_close_v2(handle.ptr);
    handle.db.handles.delete(handle.id);
    this.#handles.delete(handle.id);
  }

  drop(path: string): void {
    const db = this.#dbs.get(path);
    if (!db) return;
    for (const h of [...db.handles]) {
      const handle = this.#handles.get(h);
      if (handle) this.#closeHandle(handle);
    }
    // Closing the keeper drops the memdb refcount to zero, which frees the
    // store and everything in it (src/memdb.c:221-236).
    this.#capi.sqlite3_close_v2(db.keeper);
    this.#dbs.delete(path);
  }

  exists(path: string): boolean {
    return this.#dbs.has(path);
  }

  // ---- Contract A: statements ------------------------------------------

  exec(h: number, sql: string): void {
    const handle = this.#handle(h);
    const capi = this.#capi;
    const rc = capi.sqlite3_exec(handle.ptr, sql, 0, 0, 0);
    if (rc !== capi.SQLITE_OK) throw this.#dbError(handle.ptr, rc, "sqlite3_exec");
  }

  prepare(h: number, sql: string): PrepareResult {
    const handle = this.#handle(h);
    const capi = this.#capi;
    const wasm = this.#wasm;

    // The glue's prepare wrapper only forwards pzTail when the SQL arrives as a
    // pointer; a JS string takes the "basic" path and passes null. Ptah's driver
    // needs the tail to walk multi-statement SQL, so allocate the text here.
    const [pSql, nSql] = wasm.allocCString(sql, true);
    const ppStmt = wasm.allocPtr();
    const pzTail = wasm.allocPtr();
    try {
      const rc = capi.sqlite3_prepare_v3(handle.ptr, pSql, nSql, 0, ppStmt, pzTail);
      if (rc !== capi.SQLITE_OK) throw this.#dbError(handle.ptr, rc, "sqlite3_prepare_v3");

      const tailPtr = wasm.peekPtr(pzTail);
      const tail = tailPtr ? wasm.cstrToJs(tailPtr) : "";
      const stmtPtr = wasm.peekPtr(ppStmt);
      // A NULL statement with rc==OK means the text was only whitespace or a
      // comment. Report id 0 rather than inventing a statement to finalize.
      if (!stmtPtr) return { stmt: 0, tail };

      const ncols = capi.sqlite3_column_count(stmtPtr);
      const names: string[] = [];
      for (let i = 0; i < ncols; i++) names.push(capi.sqlite3_column_name(stmtPtr, i));

      const id = this.#nextStmt++;
      this.#stmts.set(id, { id, handle, ptr: stmtPtr, ncols, names, exhausted: false });
      handle.stmts.add(id);
      return { stmt: id, tail };
    } finally {
      // prepare_v2/v3 keep their own copy of the SQL text, and `tail` was read
      // out of this buffer before it was freed.
      wasm.dealloc(pSql);
      wasm.dealloc(ppStmt);
      wasm.dealloc(pzTail);
    }
  }

  #checkBind(stmt: Stmt, rc: number, api: string): void {
    if (rc !== this.#capi.SQLITE_OK) {
      throw this.#dbError(this.#capi.sqlite3_db_handle(stmt.ptr), rc, api);
    }
  }

  bindNull(s: number, i: number): void {
    const stmt = this.#stmt(s);
    const capi = this.#capi;
    // Upstream binds sqlite3_bind_null with a void return (sqlite3.mjs:7788),
    // so its result code is unreachable. Validate the index here instead, or a
    // driver bug would bind nothing at all and report success.
    const count = capi.sqlite3_bind_parameter_count(stmt.ptr);
    if (!Number.isInteger(i) || i < 1 || i > count) {
      // 25 is SQLITE_RANGE, which is what sqlite3_bind_null would have returned.
      throw new SqliteError(`column index out of range: ${i} of ${count}`, 25, 25, "sqlite3_bind_null");
    }
    capi.sqlite3_bind_null(stmt.ptr, i);
  }

  bindInt(s: number, i: number, decimal: string): void {
    const stmt = this.#stmt(s);
    let v: bigint;
    try {
      // SQLITE-I64-COERCION: inbound half. The BigInt is built from the decimal
      // string and consumed by sqlite3_bind_int64 without ever leaving JS,
      // which is what keeps it away from syscall/js.
      v = BigInt(decimal);
    } catch {
      throw this.#misuse(`bindInt: ${JSON.stringify(decimal)} is not a decimal integer`, "sqlite3_bind_int64");
    }
    if (v < I64_MIN || v > I64_MAX) {
      throw this.#misuse(`bindInt: ${decimal} is outside the int64 range`, "sqlite3_bind_int64");
    }
    // SQLITE-I64-COERCION: the BigInt dies here, inside JS.
    this.#checkBind(stmt, this.#capi.sqlite3_bind_int64(stmt.ptr, i, v), "sqlite3_bind_int64");
  }

  bindFloat(s: number, i: number, v: number): void {
    const stmt = this.#stmt(s);
    this.#checkBind(stmt, this.#capi.sqlite3_bind_double(stmt.ptr, i, v), "sqlite3_bind_double");
  }

  bindText(s: number, i: number, v: string): void {
    const stmt = this.#stmt(s);
    const capi = this.#capi;
    const wasm = this.#wasm;
    // The string is allocated here rather than handed to the glue, because
    // sqlite3_bind_text() in this build throws "ReferenceError: pMem is not
    // defined" on the JS-string path (sqlite3.mjs:8985 tests `pMem`, a name
    // copied from sqlite3_bind_blob and never bound in this function). Passing
    // a pointer takes the working branch. SQLite invokes xDestroy even when the
    // bind fails, so SQLITE_WASM_DEALLOC owns the buffer either way.
    const [p, n] = wasm.allocCString(v, true);
    this.#checkBind(
      stmt,
      capi.sqlite3_bind_text(stmt.ptr, i, p, n, capi.SQLITE_WASM_DEALLOC),
      "sqlite3_bind_text",
    );
  }

  bindBlob(s: number, i: number, v: Uint8Array): void {
    const stmt = this.#stmt(s);
    if (v.byteLength === 0) {
      // allocFromTypedArray() on an empty array would ask wasm.alloc(0), which
      // throws; and sqlite3_bind_blob with a NULL pointer means bind_null.
      this.#checkBind(stmt, this.#capi.sqlite3_bind_zeroblob(stmt.ptr, i, 0), "sqlite3_bind_zeroblob");
      return;
    }
    this.#checkBind(
      stmt,
      this.#capi.sqlite3_bind_blob(stmt.ptr, i, v, v.byteLength, 0),
      "sqlite3_bind_blob",
    );
  }

  columns(s: number): string[] {
    return this.#stmt(s).names.slice();
  }

  step(s: number): boolean {
    const stmt = this.#stmt(s);
    const capi = this.#capi;
    const rc = capi.sqlite3_step(stmt.ptr);
    if (rc === capi.SQLITE_ROW) return true;
    if (rc === capi.SQLITE_DONE) {
      stmt.exhausted = true;
      return false;
    }
    throw this.#dbError(capi.sqlite3_db_handle(stmt.ptr), rc, "sqlite3_step");
  }

  fetch(s: number, maxRows: number): FetchResult {
    const stmt = this.#stmt(s);
    const capi = this.#capi;
    const wasm = this.#wasm;
    const limit = Number.isFinite(maxRows) && maxRows >= MIN_FETCH_ROWS ? Math.floor(maxRows) : MIN_FETCH_ROWS;
    const ncols = stmt.ncols;
    const types: number[] = [];
    const values: SqliteValue[] = [];
    let n = 0;

    if (stmt.exhausted) return { n: 0, types, values, done: true };

    while (n < limit) {
      const rc = capi.sqlite3_step(stmt.ptr);
      if (rc === capi.SQLITE_DONE) {
        stmt.exhausted = true;
        break;
      }
      if (rc !== capi.SQLITE_ROW) {
        throw this.#dbError(capi.sqlite3_db_handle(stmt.ptr), rc, "sqlite3_step");
      }
      for (let c = 0; c < ncols; c++) {
        const t = capi.sqlite3_column_type(stmt.ptr, c);
        types.push(t);
        if (t === capi.SQLITE_INTEGER) {
          // SQLITE-I64-COERCION: sqlite3_column_int64 returns a JS BigInt.
          values.push(i64ToJs(capi.sqlite3_column_int64(stmt.ptr, c)));
        } else if (t === capi.SQLITE_FLOAT) {
          values.push(capi.sqlite3_column_double(stmt.ptr, c));
        } else if (t === capi.SQLITE_TEXT) {
          // Read the raw bytes rather than the glue's C-string conversion so
          // that TEXT containing an embedded NUL survives intact.
          const p = capi.sqlite3_column_blob(stmt.ptr, c);
          const len = capi.sqlite3_column_bytes(stmt.ptr, c);
          values.push(len === 0 || !p ? "" : TEXT_DECODER.decode(wasm.heap8u().subarray(p, p + len)));
        } else if (t === capi.SQLITE_BLOB) {
          const p = capi.sqlite3_column_blob(stmt.ptr, c);
          const len = capi.sqlite3_column_bytes(stmt.ptr, c);
          // heap8u() is re-read per value: sqlite3_step can grow wasm memory,
          // which detaches any view taken before the call.
          values.push(len === 0 || !p ? new Uint8Array(0) : wasm.heap8u().slice(p, p + len));
        } else {
          values.push(null);
        }
      }
      n++;
    }
    return { n, types, values, done: stmt.exhausted };
  }

  reset(s: number): void {
    const stmt = this.#stmt(s);
    // sqlite3_reset repeats the error of the most recent failed step and
    // returns OK otherwise, so its result carries no news; the step that failed
    // already threw.
    this.#capi.sqlite3_reset(stmt.ptr);
    stmt.exhausted = false;
  }

  finalize(s: number): void {
    if (s === 0) return; // prepare() reports 0 for statement-free text
    const stmt = this.#stmt(s);
    this.#capi.sqlite3_finalize(stmt.ptr); // same reasoning as reset()
    stmt.handle.stmts.delete(s);
    this.#stmts.delete(s);
  }

  changes(h: number): number {
    const handle = this.#handle(h);
    // SQLITE-I64-COERCION: sqlite3_changes64 returns a JS BigInt.
    return i64ToNumber(this.#capi.sqlite3_changes64(handle.ptr), "sqlite3_changes64");
  }

  lastInsertRowid(h: number): string {
    const handle = this.#handle(h);
    // SQLITE-I64-COERCION: sqlite3_last_insert_rowid returns a JS BigInt;
    // the contract asks for a decimal string so the full range survives.
    return String(this.#capi.sqlite3_last_insert_rowid(handle.ptr));
  }

  begin(h: number): void {
    this.exec(h, "BEGIN");
  }

  commit(h: number): void {
    this.exec(h, "COMMIT");
  }

  rollback(h: number): void {
    this.exec(h, "ROLLBACK");
  }

  // ---- Contract A: restriction and cancellation -------------------------

  limitAttachedZero(h: number): void {
    const handle = this.#handle(h);
    const capi = this.#capi;
    capi.sqlite3_limit(handle.ptr, capi.SQLITE_LIMIT_ATTACHED, 0);
  }

  setDeadline(h: number, epochMillis: number): void {
    const handle = this.#handle(h);
    const capi = this.#capi;
    if (!epochMillis) {
      if (handle.progress) {
        capi.sqlite3_progress_handler(handle.ptr, 0, null, 0);
        handle.progress = null;
      }
      handle.deadline = 0;
      return;
    }
    handle.deadline = epochMillis;
    if (handle.progress) return; // the closure reads handle.deadline live
    const cb = (): number => {
      try {
        return handle.deadline !== 0 && Date.now() >= handle.deadline ? 1 : 0;
      } catch {
        // Verified against this build: an exception raised inside a progress
        // handler escapes through SQLite's wasm frames as a raw JS exception
        // with rc === undefined, leaving the statement in an unknown state.
        // Abort instead, so the caller sees a clean SQLITE_INTERRUPT.
        return 1;
      }
    };
    handle.progress = cb;
    capi.sqlite3_progress_handler(handle.ptr, this.#progressOps, cb, 0);
  }

  interrupt(h: number): void {
    const handle = this.#handle(h);
    // Only reaches a running statement from another turn of the event loop or
    // from inside the progress handler; a Worker blocked in sqlite3_step cannot
    // deliver it to itself. The deadline is the mechanism that actually stops
    // a long query.
    this.#capi.sqlite3_interrupt(handle.ptr);
  }

  // ---- Contract A: snapshots -------------------------------------------

  serialize(path: string): Uint8Array {
    const db = this.#logical(path, "serialize");
    try {
      // Exports through the keeper, which is the one handle guaranteed to
      // exist. sqlite3_js_db_export owns the scoped allocation, the i64 size
      // out-param and the sqlite3_free, and hands back a detached copy, so no
      // wasm pointer lifetime escapes this call. A never-written database
      // exports as a single empty page, not as zero bytes.
      return this.#capi.sqlite3_js_db_export(db.keeper);
    } catch (e) {
      throw this.#wrapUnknown(e, "sqlite3_js_db_export");
    }
  }

  deserialize(path: string, bytes: Uint8Array): void {
    const capi = this.#capi;
    const wasm = this.#wasm;
    const existing = this.#dbs.get(path);
    if (existing && existing.handles.size > 0) {
      // sqlite3_deserialize reattaches the *calling* connection to a private
      // store (src/memdb.c:47-48 and :871 "ATTACH x AS ..."), so it cannot be
      // used to replace a shared store under live readers. Refuse loudly rather
      // than silently leaving other handles on the old data.
      throw this.#misuse(
        `deserialize(${JSON.stringify(path)}) requires every handle on that database to be closed first ` +
          `(${existing.handles.size} still open)`,
        "deserialize",
      );
    }

    // Stage 1: load the image into a scratch connection and prove it is a
    // database, before anything existing is destroyed. The scratch connection
    // is opened on the memdb VFS because stage 2 depends on db->pVfs.
    const scratchName = `/${this.#prefix}-import-${this.#nextNonce++}`;
    const scratch = this.#openRaw(this.#storeUri(scratchName), "deserialize");
    try {
      const pData = wasm.allocFromTypedArray(bytes.byteLength === 0 ? new Uint8Array(1) : bytes);
      const rc = capi.sqlite3_deserialize(
        scratch, "main", pData, bytes.byteLength, Math.max(bytes.byteLength, 1),
        // FREEONCLOSE|RESIZEABLE are legal here only because the canonical
        // sqlite.org build routes wasm.alloc through sqlite3_malloc; a custom
        // emcc build with a different allocator would corrupt the heap.
        capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
      );
      if (rc !== capi.SQLITE_OK) {
        // On failure sqlite3_deserialize frees pData itself (FREEONCLOSE).
        throw this.#dbError(scratch, rc, "sqlite3_deserialize");
      }
      const check = capi.sqlite3_exec(scratch, "SELECT count(*) FROM sqlite_schema", 0, 0, 0);
      if (check !== capi.SQLITE_OK) throw this.#dbError(scratch, check, "sqlite3_deserialize");

      // Stage 2: replace the logical database. VACUUM INTO writes through
      // db->pVfs and does no URI parsing, so the bare "/name" lands in the
      // shared memdb store; and memdbAccess always answers "does not exist",
      // so the "output file already exists" check never fires. The keeper is
      // opened first and has never read a page, so it starts with a clean
      // pager cache over the new image.
      this.drop(path);
      const db = this.#ensureLogical(path);
      const target = db.storeName.replace(/'/g, "''");
      const vrc = capi.sqlite3_exec(scratch, `VACUUM main INTO '${target}'`, 0, 0, 0);
      if (vrc !== capi.SQLITE_OK) throw this.#dbError(scratch, vrc, "deserialize");
    } finally {
      capi.sqlite3_close_v2(scratch);
    }
  }

  info(): SqliteInfo {
    const capi = this.#capi;
    if (!this.#compileOptions) {
      const opts: string[] = [];
      for (let i = 0; ; i++) {
        const o = capi.sqlite3_compileoption_get(i);
        if (!o) break;
        opts.push(o);
      }
      this.#compileOptions = opts;
    }
    return {
      version: this.#ns.version.libVersion,
      sourceId: this.#ns.version.sourceId,
      compileOptions: this.#compileOptions.slice(),
      vfs: capi.sqlite3_js_vfs_list(),
    };
  }

  // ---- helpers ----------------------------------------------------------

  #wrapUnknown(e: unknown, api: string): SqliteError {
    if (e instanceof SqliteError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    return new SqliteError(msg, 0, 0, api);
  }
}

// --------------------------------------------------------------------------
// Construction and installation
// --------------------------------------------------------------------------

async function loadNamespace(options: SqliteBridgeOptions): Promise<Sqlite3Namespace> {
  if (options.sqlite3) return options.sqlite3;
  let factory = options.initModule;
  if (!factory) {
    const url = options.moduleUrl ?? DEFAULT_MODULE_URL;
    const mod = (await import(/* @vite-ignore */ url)) as { default: Sqlite3InitModule };
    factory = mod.default;
  }
  return factory(options.initArgs);
}

/** Initialize the vendored SQLite build and wrap it in the Contract A surface. */
export async function createSqliteBridge(options: SqliteBridgeOptions = {}): Promise<SqliteBridge> {
  const ns = await loadNamespace(options);
  if (!ns.wasm.bigIntEnabled) {
    // Without BigInt the glue replaces every i64 binding with a throwing stub,
    // so column_int64 and friends would fail at the first large rowid.
    throw new SqliteError("the vendored SQLite build was compiled without BigInt support", 0, 0, "init");
  }
  return new Bridge(ns, options);
}

/** Publish the bridge where the Go driver looks for it. Call before starting Go. */
export function installSqliteBridge(
  bridge: SqliteBridge,
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): SqliteBridge {
  target.__sqlite = bridge;
  return bridge;
}
