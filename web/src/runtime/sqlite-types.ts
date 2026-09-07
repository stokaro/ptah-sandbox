/**
 * Structural types for the vendored SQLite WASM build (web/vendor/sqlite/sqlite3.mjs).
 *
 * The upstream distribution ships no type declarations, so this file is the one
 * place where the untyped boundary is described. Everything listed here was
 * verified present in the pinned 3.53.4 build; see
 * web/vendor/sqlite/sqlite-capabilities.json.
 *
 * Pointers are plain JS numbers in this build (32-bit wasm). i64-typed C
 * functions are declared as returning `bigint` on purpose: that is what the
 * glue really hands back, and naming it here is what makes the coercion sites
 * in sqlite-bridge.ts type-checkable instead of accidental.
 */

export type Ptr = number;

export interface Sqlite3Capi {
  // --- connection lifecycle ------------------------------------------------
  sqlite3_open_v2(filename: string, ppDb: Ptr, flags: number, vfs: string | null): number;
  sqlite3_close_v2(db: Ptr): number;
  sqlite3_errmsg(db: Ptr): string;
  sqlite3_errstr(rc: number): string;
  sqlite3_extended_errcode(db: Ptr): number;
  sqlite3_exec(db: Ptr, sql: string, cb: number, arg: number, errmsg: number): number;
  sqlite3_limit(db: Ptr, id: number, newVal: number): number;
  sqlite3_interrupt(db: Ptr): void;
  sqlite3_db_handle(stmt: Ptr): Ptr;
  sqlite3_vfs_find(name: string | number): Ptr;

  // --- statements ----------------------------------------------------------
  sqlite3_prepare_v3(
    db: Ptr, sql: Ptr | string, sqlLen: number, prepFlags: number, ppStmt: Ptr, pzTail: Ptr | null,
  ): number;
  sqlite3_prepare_v2(db: Ptr, sql: Ptr | string, sqlLen: number, ppStmt: Ptr, pzTail: Ptr | null): number;
  sqlite3_step(stmt: Ptr): number;
  sqlite3_reset(stmt: Ptr): number;
  sqlite3_clear_bindings(stmt: Ptr): number;
  sqlite3_finalize(stmt: Ptr): number;

  // --- binding -------------------------------------------------------------
  sqlite3_bind_null(stmt: Ptr, idx: number): number;
  sqlite3_bind_int64(stmt: Ptr, idx: number, v: bigint): number;
  sqlite3_bind_double(stmt: Ptr, idx: number, v: number): number;
  sqlite3_bind_text(stmt: Ptr, idx: number, v: Ptr, n: number, xDestroy: number): number;
  sqlite3_bind_blob(stmt: Ptr, idx: number, v: Uint8Array | Ptr, n: number, xDestroy: number): number;
  sqlite3_bind_zeroblob(stmt: Ptr, idx: number, n: number): number;
  sqlite3_bind_parameter_count(stmt: Ptr): number;

  // --- results -------------------------------------------------------------
  sqlite3_column_count(stmt: Ptr): number;
  sqlite3_column_name(stmt: Ptr, col: number): string;
  sqlite3_column_type(stmt: Ptr, col: number): number;
  sqlite3_column_double(stmt: Ptr, col: number): number;
  sqlite3_column_int64(stmt: Ptr, col: number): bigint;
  sqlite3_column_blob(stmt: Ptr, col: number): Ptr;
  sqlite3_column_bytes(stmt: Ptr, col: number): number;

  // --- bookkeeping ---------------------------------------------------------
  sqlite3_changes64(db: Ptr): bigint;
  sqlite3_last_insert_rowid(db: Ptr): bigint;

  // --- cancellation --------------------------------------------------------
  sqlite3_progress_handler(db: Ptr, nOps: number, cb: (() => number) | null, arg: number): void;

  // --- (de)serialization ---------------------------------------------------
  sqlite3_js_db_export(db: Ptr, schema?: string): Uint8Array;
  sqlite3_deserialize(
    db: Ptr, schema: string, pData: Ptr, szDb: number | bigint, szBuf: number | bigint, flags: number,
  ): number;

  // --- build introspection -------------------------------------------------
  sqlite3_compileoption_get(n: number): string | null;
  sqlite3_js_vfs_list(): string[];

  // --- constants -----------------------------------------------------------
  readonly SQLITE_OK: number;
  readonly SQLITE_ROW: number;
  readonly SQLITE_DONE: number;
  readonly SQLITE_INTEGER: number;
  readonly SQLITE_FLOAT: number;
  readonly SQLITE_TEXT: number;
  readonly SQLITE_BLOB: number;
  readonly SQLITE_NULL: number;
  readonly SQLITE_LIMIT_ATTACHED: number;
  readonly SQLITE_INTERRUPT: number;
  readonly SQLITE_OPEN_READWRITE: number;
  readonly SQLITE_OPEN_CREATE: number;
  readonly SQLITE_OPEN_URI: number;
  readonly SQLITE_DESERIALIZE_FREEONCLOSE: number;
  readonly SQLITE_DESERIALIZE_RESIZEABLE: number;
  readonly SQLITE_WASM_DEALLOC: number;
}

export interface Sqlite3Wasm {
  alloc(n: number): Ptr;
  dealloc(p: Ptr): void;
  allocPtr(n?: number): Ptr;
  peekPtr(p: Ptr): Ptr;
  allocCString(s: string, returnWithLength: true): [Ptr, number];
  allocFromTypedArray(a: Uint8Array): Ptr;
  cstrToJs(p: Ptr): string;
  heap8u(): Uint8Array;
  readonly bigIntEnabled: boolean;
}

export interface Sqlite3Version {
  readonly libVersion: string;
  readonly libVersionNumber: number;
  readonly sourceId: string;
  readonly downloadVersion: number;
  readonly scm?: Record<string, string>;
}

export interface Sqlite3Namespace {
  readonly capi: Sqlite3Capi;
  readonly wasm: Sqlite3Wasm;
  readonly version: Sqlite3Version;
}

/** Argument bag accepted by the Emscripten init function. */
export interface Sqlite3InitArgs {
  locateFile?: (path: string, prefix: string) => string;
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    onSuccess: (inst: WebAssembly.Instance, mod: WebAssembly.Module) => void,
  ) => unknown;
  print?: (msg: string) => void;
  printErr?: (msg: string) => void;
}

export type Sqlite3InitModule = (args?: Sqlite3InitArgs) => Promise<Sqlite3Namespace>;
