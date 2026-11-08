# upstream-patch

`0001-browser-postgres-driver.patch` selects the `browser-postgres` SQL driver
on js/wasm builds and routes that driver to the existing PostgreSQL reader
and writer. Native builds continue to use pgx. No catalog, capability, planner,
or renderer behavior is patched.

The driver itself belongs to this host and lives in
`runtime/ptah/internal/browserpostgres`. Remove the selection patch once
upstream provides the corresponding hook.

The earlier build-profile and filesystem patches merged in
[stokaro/ptah#3046](https://github.com/stokaro/ptah/pull/3046).

`0002-browser-provider.patch` lets the pinned provider SDK run a registered
provider over in-memory gRPC on js/wasm. It also makes Ptah discover that
compiled provider for DuckDB when there is no user provider configuration.
The registration and transport live under `runtime/ptah/`; native Ptah keeps
its ordinary executable provider selection. The browser registration is
identified by the wasm module digest from the build manifest.
