# DuckDB in the browser

The DuckDB option at [play.ptah.run](https://play.ptah.run/?engine=duckdb)
executes Ptah's real commands against an in-memory DuckDB-Wasm database. The
official [Ptah DuckDB plugin](https://github.com/stokaro/ptah-duckdb-plugin)
supplies the catalog reader, schema model, planner, and SQL renderer. The SQL
pane is the playground's own query interface, as it is for the other engines.

## Runtime path

```text
Ptah CLI (Go WebAssembly)
  → provider SDK, in-process gRPC transport
  → official DuckDB provider code (Go WebAssembly)
  → browser database/sql driver
  → JavaScript Promise bridge
  → DuckDB-Wasm in a nested Web Worker
```

The in-process transport replaces the native plugin's child process only in
the browser build. It performs the same provider protocol negotiation and
session calls. Ptah and the provider are pinned separately in
`third_party/ptah.pin` and `third_party/duckdb.pin`. `scripts/build-wasm.sh`
checks the exact commits, applies the browser patches, and links the provider
into the Ptah module. The generated manifest records both source commits and
the module checksum used for the provider's in-process identity.

The browser package is `@duckdb/duckdb-wasm@1.33.1-dev57.0`, which reports
DuckDB 1.5.4. The official plugin's native driver embeds DuckDB 2.0.0. The
browser patch adapts catalog reads for the older catalog shape; tests use the
actual browser package rather than treating the native version as equivalent.

Each database key owns a separate DuckDB-Wasm instance. The Ptah URL
`duckdb://:memory:` maps to the `:memory:app` key. The desired-schema scratch
database has another key, so reading the editor's schema does not alter the
live database. Reset discards the active database. Reload discards all data.
DuckDB-Wasm is configured to reject automatic extension loading, community
extensions, persistent secrets, unsigned extensions, and external access.

## Try it

Choose DuckDB in the database picker or use the link above. The same general
scenarios work with DuckDB:

| Scenario | Result |
| --- | --- |
| Change a schema, keep the data | Edit `schema.sql`, preview and apply a column and index, then verify the rows remain. |
| Detect drift | Change DuckDB directly, detect the difference, then reconcile it. |
| Versioned migrations | Plan, generate, hash, validate, and apply a reviewed migration. |
| Free exploration | Query the seeded data and run Ptah commands without a guide. |

The schema change route offers these commands:

```sh
ptah schema apply --schema-file schema.sql --db-url duckdb://:memory: --dry-run
ptah schema apply --schema-file schema.sql --db-url duckdb://:memory:
ptah schema drift --schema-file schema.sql --db-url duckdb://:memory:
```

The dry run prints the provider's plan. The second command asks for `YES` and
applies the column and index to a populated database. The drift command reads
the live DuckDB catalog again. The migration route does not offer `migrations
lint`: the linter does not currently accept DuckDB as a dialect.
`ptah db capabilities --db-url duckdb://:memory:` reports the engine version
and the capability selection Ptah uses.

DuckDB in this playground is in memory. The Export button preserves workspace
files, including SQL, and tells the user that it does not include the database.
The SQLite file import control is not offered in DuckDB mode.

## Verification

`npm run test:duckdb --prefix web` boots the generated Ptah module under Node,
connects it to the pinned DuckDB-Wasm package, previews and applies a schema,
checks drift, adds an index, reads a generated column, and runs the
`migrations generate` → `migrations hash` → `migrations up` →
`migrations status` lifecycle on a fresh in-memory database. It also exercises
the four DuckDB-compatible scenario presets against the real provider. The ordinary
web typecheck, build, integration suite, and browser probe cover the remaining
site behavior. The database picker and scenario are also exercised in the
browser probe.

The browser driver and in-process provider transport are local adaptations.
When updating either upstream pin, rebuild the module and rerun the DuckDB
integration test; a successful native plugin test alone does not validate the
browser engine's catalog shape.
