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
