// A test-only implementation of Contract A (globalThis.__sqlite) over the
// canonical sqlite.org WASM build vendored at web/vendor/sqlite.
//
// This is NOT the bridge the playground ships. It exists so the Go driver can
// be tested against a real SQLite engine rather than a mock: the values that
// matter here -- int64 at its extremes, NULL against an empty blob, the
// engine's own text for a refused ATTACH -- are exactly the ones a mock would
// get wrong in the same direction as the code under test.
//
// It implements every Contract A method. Where the shipping bridge has to
// think about workers, OPFS and page lifetime, this one uses the memdb VFS
// and keeps one never-closed handle per logical database so the database
// outlives the handles opened on it, which is the part of the contract the
// driver can observe.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_LIMIT_ATTACHED = 7;

function locateSqliteDir() {
  if (process.env.PTAH_SANDBOX_SQLITE_DIR) return process.env.PTAH_SANDBOX_SQLITE_DIR;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'web', 'vendor', 'sqlite');
    if (existsSync(join(candidate, 'sqlite3.mjs'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('cannot find web/vendor/sqlite; set PTAH_SANDBOX_SQLITE_DIR');
}

export async function installBridge() {
  const sqliteDir = locateSqliteDir();
  const { default: init } = await import(pathToFileURL(join(sqliteDir, 'sqlite3.mjs')).href);
  // The OPFS VFS probes globalThis.location, which node does not have, and
  // reports its absence through console.warn. Silence just the load.
  const warn = console.warn, error = console.error;
  console.warn = () => {};
  console.error = () => {};
  let sqlite3;
  try {
    sqlite3 = await init({
      print() {},
      printErr() {},
      instantiateWasm(imports, onSuccess) {
        const bytes = readFileSync(join(sqliteDir, 'sqlite3.wasm'));
        WebAssembly.instantiate(bytes, imports).then((arg) => onSuccess(arg.instance, arg.module));
        return {};
      },
    });
  } finally {
    console.warn = warn;
    console.error = error;
  }
  globalThis.__sqlite = makeBridge(sqlite3);
  return globalThis.__sqlite;
}

function makeBridge(sqlite3) {
  const capi = sqlite3.capi;
  const wasm = sqlite3.wasm;

  // One entry per logical database. keeper is a handle nobody hands out: it
  // is what keeps the memdb store alive across close().
  const databases = new Map();
  // Open handles, by the id the driver sees.
  const handles = new Map();
  // Prepared statements, by the id the driver sees.
  const statements = new Map();
  let nextHandle = 1;
  let nextStatement = 1;

  function fail(db, rc, what) {
    const message = db ? capi.sqlite3_errmsg(db) : (what || 'sqlite error');
    const err = new Error(message);
    err.sqliteCode = rc & 0xff;
    err.sqliteExtended = db ? capi.sqlite3_extended_errcode(db) : rc;
    throw err;
  }

  function uriFor(path) {
    return 'file:/' + encodeURIComponent(path) + '?vfs=memdb';
  }

  function openHandle(uri) {
    const pp = wasm.allocPtr();
    try {
      const rc = capi.sqlite3_open_v2(
        uri, pp,
        capi.SQLITE_OPEN_READWRITE | capi.SQLITE_OPEN_CREATE | capi.SQLITE_OPEN_URI,
        null);
      const db = wasm.peekPtr(pp);
      if (rc !== SQLITE_OK) fail(db, rc, 'cannot open ' + uri);
      capi.sqlite3_extended_result_codes(db, 1);
      return db;
    } finally {
      wasm.dealloc(pp);
    }
  }

  function handleOf(id) {
    const record = handles.get(id);
    if (!record) throw new Error('unknown database handle ' + id);
    return record;
  }

  function statementOf(id) {
    const record = statements.get(id);
    if (!record) throw new Error('unknown statement ' + id);
    return record;
  }

  function execOn(db, sql) {
    const rc = capi.sqlite3_exec(db, sql, null, null, null);
    if (rc !== SQLITE_OK) fail(db, rc);
  }

  return {
    open(path) {
      let entry = databases.get(path);
      if (!entry) {
        const uri = uriFor(path);
        entry = { uri, keeper: openHandle(uri) };
        databases.set(path, entry);
      }
      const id = nextHandle++;
      handles.set(id, { db: openHandle(entry.uri), path, deadline: 0, progress: null });
      return id;
    },

    close(id) {
      const record = handles.get(id);
      if (!record) return;
      handles.delete(id);
      if (record.progress) {
        capi.sqlite3_progress_handler(record.db, 0, 0, 0);
      }
      capi.sqlite3_close_v2(record.db);
    },

    drop(path) {
      for (const [id, record] of [...handles]) {
        if (record.path === path) {
          handles.delete(id);
          capi.sqlite3_close_v2(record.db);
        }
      }
      const entry = databases.get(path);
      if (entry) {
        capi.sqlite3_close_v2(entry.keeper);
        databases.delete(path);
      }
    },

    exists(path) {
      return databases.has(path);
    },

    exec(id, sql) {
      execOn(handleOf(id).db, sql);
    },

    prepare(id, sql) {
      const { db } = handleOf(id);
      const pSql = wasm.allocCString(sql);
      const stack = wasm.pstack.pointer;
      try {
        const ppStmt = wasm.pstack.allocPtr();
        const pzTail = wasm.pstack.allocPtr();
        const rc = capi.sqlite3_prepare_v3(db, pSql, wasm.cstrlen(pSql), 0, ppStmt, pzTail);
        if (rc !== SQLITE_OK) fail(db, rc);
        const pStmt = wasm.peekPtr(ppStmt);
        const tail = wasm.cstrToJs(wasm.peekPtr(pzTail));
        if (!pStmt) return { stmt: 0, tail };
        const sid = nextStatement++;
        statements.set(sid, { db, pStmt });
        return { stmt: sid, tail };
      } finally {
        wasm.pstack.restore(stack);
        wasm.dealloc(pSql);
      }
    },

    bindNull(sid, index) {
      // The JS binding declares sqlite3_bind_null void, so there is no result
      // code to check here.
      capi.sqlite3_bind_null(statementOf(sid).pStmt, index);
    },

    bindInt(sid, index, decimal) {
      const { db, pStmt } = statementOf(sid);
      const rc = capi.sqlite3_bind_int64(pStmt, index, BigInt(decimal));
      if (rc !== SQLITE_OK) fail(db, rc);
    },

    bindFloat(sid, index, value) {
      const { db, pStmt } = statementOf(sid);
      const rc = capi.sqlite3_bind_double(pStmt, index, value);
      if (rc !== SQLITE_OK) fail(db, rc);
    },

    bindText(sid, index, value) {
      const { db, pStmt } = statementOf(sid);
      // The string overload of capi.sqlite3_bind_text is broken in the
      // 3.53.4 build vendored here: it reaches an undeclared `pMem` and
      // throws a ReferenceError. Allocate the C string and pass the pointer.
      const [pointer, length] = wasm.allocCString(value, true);
      const rc = capi.sqlite3_bind_text(pStmt, index, pointer, length, capi.SQLITE_WASM_DEALLOC);
      if (rc !== SQLITE_OK) fail(db, rc);
    },

    bindBlob(sid, index, bytes) {
      const { db, pStmt } = statementOf(sid);
      const rc = capi.sqlite3_bind_blob(pStmt, index, bytes, bytes.length, capi.SQLITE_TRANSIENT);
      if (rc !== SQLITE_OK) fail(db, rc);
    },

    columns(sid) {
      const { pStmt } = statementOf(sid);
      const count = capi.sqlite3_column_count(pStmt);
      const names = [];
      for (let i = 0; i < count; i++) names.push(capi.sqlite3_column_name(pStmt, i));
      return names;
    },

    step(sid) {
      const { db, pStmt } = statementOf(sid);
      const rc = capi.sqlite3_step(pStmt);
      if (rc === SQLITE_ROW) return true;
      if (rc === SQLITE_DONE) return false;
      fail(db, rc);
    },

    fetch(sid, maxRows) {
      const { db, pStmt } = statementOf(sid);
      const columns = capi.sqlite3_column_count(pStmt);
      const types = [];
      const values = [];
      let n = 0;
      let done = false;
      while (n < maxRows) {
        const rc = capi.sqlite3_step(pStmt);
        if (rc === SQLITE_DONE) { done = true; break; }
        if (rc !== SQLITE_ROW) fail(db, rc);
        for (let c = 0; c < columns; c++) {
          switch (capi.sqlite3_column_type(pStmt, c)) {
            case capi.SQLITE_INTEGER: {
              const big = capi.sqlite3_column_int64(pStmt, c);
              const asNumber = Number(big);
              types.push(1);
              values.push(Number.isSafeInteger(asNumber) ? asNumber : big.toString());
              break;
            }
            case capi.SQLITE_FLOAT:
              types.push(2);
              values.push(capi.sqlite3_column_double(pStmt, c));
              break;
            case capi.SQLITE_TEXT:
              types.push(3);
              values.push(capi.sqlite3_column_text(pStmt, c));
              break;
            case capi.SQLITE_BLOB: {
              const size = capi.sqlite3_column_bytes(pStmt, c);
              const pointer = capi.sqlite3_column_blob(pStmt, c);
              types.push(4);
              values.push(size ? new Uint8Array(wasm.heap8u().subarray(pointer, pointer + size)) : new Uint8Array(0));
              break;
            }
            default:
              types.push(5);
              values.push(null);
              break;
          }
        }
        n++;
      }
      return { n, types, values, done };
    },

    reset(sid) {
      const { pStmt } = statementOf(sid);
      // sqlite3_reset reports the error of the statement's last run, which
      // the caller has already been told about. Only the reset itself
      // matters here, and it cannot fail on its own.
      capi.sqlite3_reset(pStmt);
    },

    finalize(sid) {
      const record = statements.get(sid);
      if (!record) return;
      statements.delete(sid);
      capi.sqlite3_finalize(record.pStmt);
    },

    changes(id) {
      return capi.sqlite3_changes(handleOf(id).db);
    },

    lastInsertRowid(id) {
      return capi.sqlite3_last_insert_rowid(handleOf(id).db).toString();
    },

    begin(id) { execOn(handleOf(id).db, 'BEGIN'); },
    commit(id) { execOn(handleOf(id).db, 'COMMIT'); },
    rollback(id) { execOn(handleOf(id).db, 'ROLLBACK'); },

    limitAttachedZero(id) {
      capi.sqlite3_limit(handleOf(id).db, SQLITE_LIMIT_ATTACHED, 0);
    },

    setDeadline(id, epochMillis) {
      const record = handleOf(id);
      record.deadline = epochMillis;
      if (!epochMillis) {
        if (record.progress) {
          capi.sqlite3_progress_handler(record.db, 0, 0, 0);
          record.progress = null;
        }
        return;
      }
      if (!record.progress) {
        record.progress = () => (Date.now() >= record.deadline ? 1 : 0);
      }
      capi.sqlite3_progress_handler(record.db, 200, record.progress, 0);
    },

    interrupt(id) {
      capi.sqlite3_interrupt(handleOf(id).db);
    },

    serialize(path) {
      const entry = databases.get(path);
      if (!entry) throw new Error('no such database ' + path);
      return capi.sqlite3_js_db_export(entry.keeper);
    },

    deserialize(path, bytes) {
      // Replace the store by dropping it and replaying the bytes into a
      // fresh one. The shipping bridge would use sqlite3_deserialize; this
      // is enough to prove the driver reads what a native file holds.
      this.drop(path);
      const uri = uriFor(path);
      const keeper = openHandle(uri);
      databases.set(path, { uri, keeper });
      const pointer = wasm.allocFromTypedArray(bytes);
      try {
        const rc = capi.sqlite3_deserialize(
          keeper, 'main', pointer, BigInt(bytes.length), BigInt(bytes.length),
          capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
        if (rc !== SQLITE_OK) fail(keeper, rc);
      } catch (e) {
        wasm.dealloc(pointer);
        throw e;
      }
    },

    info() {
      return {
        version: capi.sqlite3_libversion(),
        sourceId: capi.sqlite3_sourceid(),
        compileOptions: [],
        vfs: capi.sqlite3_js_vfs_list ? capi.sqlite3_js_vfs_list() : [],
      };
    },
  };
}
