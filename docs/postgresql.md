# PostgreSQL in the playground

Issue [#8](https://github.com/stokaro/ptah-sandbox/issues/8) asked whether a
real PostgreSQL could fit the browser runtime and GitHub Pages hosting.
The implementation uses PGlite 0.5.8; `SELECT version()` reports PostgreSQL
18.3. Ptah is pinned to v0.10.0, commit
`0688d16e46aa5925a1821a4c457e8b45c5b8e4dc`.

## Promise bridge and hosting

PGlite's [query and exec APIs](https://pglite.dev/docs/api) return Promises.
The Go driver awaits them on a buffered channel from a command goroutine.
The callback starting the command returns first, and Go yields to the worker
while the Promise settles. The existing runner already schedules commands on
a later event-loop turn. Blocking inside the initiating JavaScript callback
would deadlock; this implementation does not do that.

The page needs no service worker, SharedArrayBuffer, Atomics.wait, COOP, or
COEP headers. The Chromium UI suite runs on Python's ordinary static HTTP
server, asserts `crossOriginIsolated === false`, executes the PostgreSQL
scenario, and reloads into a fresh SQLite session. Cold-load checks verify
that the schema is readable before the database runtime finishes loading.
Desktop and 390px phone layouts were also inspected. Firefox and Safari have
not been exercised by this suite.

PGlite's code loads through a dynamic import only when PostgreSQL is selected.
Its three assets are copied from the pinned npm package into a versioned
`dist/pglite-0.5.8/` directory, following its
[esbuild guidance](https://pglite.dev/docs/bundler-support). Asset failures
surface as errors; they do not fall back to another engine.

## Size measurements

Measured with gzip level 9, against the previous main branch's build. These
are compressed-file measurements, not claims about a server's Content-Encoding.

| Component | Before | With this change |
| --- | ---: | ---: |
| Initial page + worker JavaScript, including static chunks | 57.3 KiB gzip | about 62 KiB gzip |
| Ptah wasm | 23,201,421 B gzip (v0.8.0) | 23,969,875 B gzip (v0.10.0) |
| PostgreSQL JavaScript, loaded on selection | absent | about 136 KiB gzip |
| `pglite.wasm` | absent | 3,389,845 B gzip / 10,088,161 B raw |
| `initdb.wasm` | absent | 144,501 B gzip / 395,242 B raw |
| `pglite.data` | absent | 1,859,673 B gzip / 6,295,316 B raw |

The PostgreSQL selection adds approximately 5.28 MiB compressed, including its
JavaScript. The Ptah binary increase also includes the requested v0.8.0 to
v0.10.0 upgrade. SQLite and the page's fonts are unchanged.

## Real catalogs, values, and sessions

A small upstream patch selects `browser-postgres` instead of pgx on js/wasm
and sends that driver to the existing PostgreSQL reader and writer. All Ptah
catalog queries, capability resolution, and plans remain upstream code.
The UI separately reads `pg_catalog` and `information_schema` for the public
schema, including columns, primary keys, foreign keys, indexes, and row counts.
The desired-state comparison uses a separate real PGlite database.

The bridge requests PostgreSQL text values before PGlite can convert int8 or
JSON into JavaScript numbers. Go decodes values by PostgreSQL OID, preserving
bigint, numeric precision, arrays, JSON, bytea, booleans, dates, and timestamps.
Both synchronous exceptions and rejected Promises become Go errors. SQLSTATE
is retained as `pgconn.PgError`. A command cancellation waits for any in-flight
PGlite operation to settle; synchronous PostgreSQL work cannot be interrupted
by a same-worker message. The existing terminal watchdog can restart a stalled
worker, discarding its in-memory state.

PGlite provides one SQL session. The driver refuses simultaneous independent
connections, which PostgreSQL versioned migrations require for locking and
execution. Scenario C therefore declares SQLite-only capability. A, B, and
free exploration support both engines; PostgresOnly defaults to PostgreSQL
and refuses SQLite. Selecting a scenario applies its default; changing the
engine resets the current scenario. The picker states this before the change.
Commands against an inactive engine or an external-looking PostgreSQL URL are
refused, so the displayed engine identifies the database being used.

## Persistence and export

Both PGlite instances use `memory://`. No IndexedDB database is created;
a reload starts from the default SQLite scenario. Reset replaces the active
database, including PostgreSQL roles and session state, with a fresh instance.

PostgreSQL export uses `dumpDataDir("gzip")` and names the archive
`postgres-data.tar.gz`. The ZIP includes restoration instructions and workspace
SQL files. An automated test restores the archive with
`PGlite.create({loadDataDir: blob})` and verifies an exact 64-bit value. SQLite
imports remain SQLite-only; PostgreSQL exports are not presented as `.db` files.

## Evidence and reproduction

- `make test`: rebuilds the pinned wasm, runs Go driver/runtime tests, unit
  tests, SQLite integration/migration suites, and PostgreSQL scenarios.
- `make build-web`, `make serve`, and `make ui-probe`: run the browser checks
  against ordinary static hosting, including engine presets and reload.
- `test/integration/postgres.mjs`: exercises A, B, PostgresOnly, and free
  exploration with real Ptah wasm and real PostgreSQL, including error paths.
- Native captures 53 and 54 in `test/integration/ground-truth/` use Ptah v0.10.0
  and PostgreSQL 18.6. The PostgresOnly GIN plan matches the browser output
  byte for byte. Native apply preserved both event rows and ended with clean
  drift. The temporary remote Docker container and its volume were removed.

PR CI rebuilds and tests the Go runtime and drives the browser suite before
merge. Deployment remains the existing GitHub Pages workflow.
