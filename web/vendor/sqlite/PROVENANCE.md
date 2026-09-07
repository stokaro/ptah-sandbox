# Vendored SQLite WASM build

SQLite **3.53.4**, the canonical WASM/JS distribution published by sqlite.org.
Taken from `sqlite-wasm-3530400.zip`, entries `sqlite-wasm-3530400/jswasm/sqlite3.mjs`
and `sqlite-wasm-3530400/jswasm/sqlite3.wasm`, copied verbatim with no edits.

Not the `@sqlite.org/sqlite-wasm` npm package: it lags the canonical release
(3.53.0 at the time of vendoring) and repackages the glue.

## Files

| File | Bytes | SHA-256 | SHA3-256 |
| --- | ---: | --- | --- |
| `sqlite3.mjs` | 431992 | `41d84d3fcb2a1eefa66d52348e94353d5d248a545f5bff6cf632eea017764ca5` | `d267ea2e3412b019fc5a76e628214fcfb726e05dd3cc9ee986d0718f68b62263` |
| `sqlite3.wasm` | 869277 | `3929b5b2a1cd7d7c32171e1f654fce0355191b7c9bc84afc61d9b2b99b96531f` | `e12d846e56d049efcebbee316bd983e9b0400e47be90248f0acb161d6b7c792f` |
| `sqlite-capabilities.json` | 2758 | — | `0e83e28f95e723c015a6535095454b0364731598a3bb54d41ceb1df8ee977830` |

`sqlite3.mjs` resolves the binary with `new URL("sqlite3.wasm", import.meta.url)`,
so the two files must stay siblings. Moving either one breaks loading with no
error message beyond a failed fetch.

`README.upstream.txt` is the distribution's own README, kept for reference.

## Build identity

Reported by the running module (`sqlite3.version`):

- `libVersion` 3.53.4, `libVersionNumber` 3053004, `downloadVersion` 3530400
- `sourceId` `2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc`
- SCM branch `branch-3.53`, tag `version-3.53.4`, SHA3-256
  `bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc`

The full compile-option list, registered VFSes and virtual-table module list are
in `sqlite-capabilities.json`, recorded by running the module in a Worker in
Chrome 152 (headless) — the same context the playground uses. To re-record after
a build bump: load `sqlite3.mjs` in a Worker over HTTP, then read
`sqlite3.version`, `capi.sqlite3_compileoption_get(i)` until it returns falsy,
`capi.sqlite3_js_vfs_list()`, and `PRAGMA module_list` on any connection.

Points worth knowing before reading query results:

- `DQS=0` — double-quoted string literals are errors here but are accepted by
  most local `sqlite3` CLIs. The same SQL can behave differently in the two.
- `THREADSAFE=0`, `MUTEX_OMIT` — one thread per module instance.
- `OMIT_LOAD_EXTENSION`, `OMIT_UTF16`, `OMIT_SHARED_CACHE`, `OMIT_DEPRECATED`.
- `MAX_ATTACHED=10`, default page size 8192.
- `memdb` is registered, which is what makes cross-invocation persistence work
  (see the header of `web/src/runtime/sqlite-bridge.ts`).

## Licensing

- **SQLite itself** (`sqlite3.wasm`, and the SQLite-authored JS in
  `sqlite3.mjs`) is in the **public domain**. The authors disclaim copyright;
  the distribution carries the usual blessing ("May you do good and not evil").
  No attribution is required, and none is imposed.
- **The Emscripten runtime glue** that sqlite.org's build embeds in
  `sqlite3.mjs` comes from Emscripten, which is dual licensed **MIT / University
  of Illinois-NCSA Open Source License**. Both are permissive and require the
  copyright notice and permission notice to be preserved in redistributions;
  the notices are inside `sqlite3.mjs`, which we ship byte-for-byte, so that
  obligation is met by shipping the file unmodified.

Neither license imposes a copyleft obligation on the playground.

## Do not edit these files

Any local change must instead go in `web/src/runtime/sqlite-bridge.ts`, so a
version bump stays a straight file swap. One upstream defect is worked around
there and is worth carrying forward:

> `capi.sqlite3_bind_text()` throws `ReferenceError: pMem is not defined` when
> handed a JS string. `sqlite3.mjs:8985` tests `Array.isArray(pMem)` inside
> `sqlite3_bind_text`, where the parameter is named `text`; `pMem` is the name
> from the neighbouring `sqlite3_bind_blob`. The bridge sidesteps it by
> allocating the string itself and passing a pointer.
