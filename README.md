# ptah-sandbox

The source of [play.ptah.run](https://play.ptah.run) — Ptah running in a
browser tab. Real Ptah, compiled to WebAssembly, against real SQLite or PostgreSQL,
compiled to WebAssembly. No server, no account, nothing installed, and no
recorded output.

You edit a schema file, run the same commands you would run in a terminal, read
the plan Ptah's own planner produced, apply it, and query the database to see
what happened to your rows.

## Why it is built this way

A playground that fakes its output teaches people something false. So this one
does not fake anything:

- The commands are Ptah's own Cobra commands, from a pinned upstream commit.
  The parser, planner, lint rules and migration engine are the ones in the
  release, not a JavaScript imitation of them.
- Both databases run as WebAssembly, reached through a
  `database/sql` driver, so Ptah's readers and writers run unchanged.
- The exit code you see is the exit code the command returned. The confirmation
  prompt is the real prompt, reading a real stdin.
- The version in the footer is the version of the WebAssembly that is actually
  running, read out of the binary — never the latest release number stamped on
  top of an older build.

The one thing that is not Ptah is the SQL pane. `ptah sql` is a linter, not a
query tool, so the pane is the playground's own and is labeled as such.

## Layout

    third_party/ptah.pin  the upstream commit every build is made from
    upstream-patch/       the browser PostgreSQL driver selection hook
    runtime/ptah/         new Go packages copied into Ptah's module at build time
    web/                  the playground itself, and its vendored runtime
    fixtures/             the demo workspaces
    test/integration/     the runtime driven outside a browser, under node
    docs/                 how it fits together, and what it deliberately is not

There is no `go.mod` here. The build materializes a copy of pinned Ptah and
builds inside Ptah's own module, so the browser entry point and the browser
database drivers are ordinary internal packages and Ptah grows no public API for
the sake of a website.

## Build

    make wasm        # materialize, build ptah.wasm, write the manifest
    make pin         # move the pin to another Ptah commit
    make build-web   # npm ci and bundle web/src into web/dist
    make test        # drive the whole runtime under node, no browser needed
    make serve       # serve web/ on http://127.0.0.1:8788/
    make check-site  # the gate CI runs before publishing
    make ui-probe    # drive the real page in headless Chrome (needs `make serve`)

`make wasm` needs the Go toolchain `.go-version` names, and refuses to build
with any other; `wasm_exec.js` is copied from that same toolchain, because the
pair has to match.

`make test` proves the runtime and the components; it never opens a browser.
`make ui-probe` is the one that proves they are wired to each other. It loads
`web/index.html` in an iframe and drives it through the controls a visitor uses
-- typing into the terminal, typing into the editor, clicking the panes -- then
asserts by reading the DOM the page produced. Add `SHOTS=.refs` to write the
1440px light and dark renders and the 390px one as well.

## The pin

`third_party/ptah.pin` is the pin: three lines naming the upstream commit, the
version `git describe` gives it, and its commit date. It is the only place that
records which Ptah the site is built from.

Move it with `make pin`, which takes the tip of `master`, or `make pin
REF=v0.7.0` for a tag or a commit. Then `make wasm` and commit both the pin and
`web/vendor/ptah/manifest.json`.

There is no submodule. `scripts/build-wasm.sh` fetches the pinned commit into
`build/ptah-git`, a blobless bare mirror that holds the commit graph and the
tags and pulls file contents only when asked. It is 6.5 MB before the first
build and about 20 MB after it, against 88 MB for a full clone.

The build checks the pin against git rather than trusting it: the commit must
exist, `git describe` must give the recorded version, and the commit date must
match. A hand-edited line fails the build instead of mislabeling a binary, and
`make check-site` makes the same comparison against the committed manifest.

The build then assembles a disposable tree from three tracked inputs:

1. `git archive` of the pinned commit into `build/ptah-src`, which gives a tree
   with no `.git` and with mtimes taken from the commit;
2. any patch in `upstream-patch/`, applied with `--directory` so a hunk that
   tried to escape the overlay would land outside it and fail;
3. `runtime/ptah/`, copied in at its target paths inside the module.

`build/ptah-src` is gitignored and rebuilt from scratch on every run, and so is
the mirror it is archived from.

The Go toolchain is `.go-version`, not whatever the pinned Ptah's `go.mod`
declares. The deploy re-links the binary and compares it against the committed
manifest, so the runner and the desk have to agree on one compiler; tying that
to the pin would move the compiler — and with it the committed `wasm_exec.js` —
whenever Ptah's own `go.mod` moves. The two agree today at `go1.27.1`, and
keeping them in step is a deliberate edit rather than a side effect.

## Deploy

The site is [play.ptah.run](https://play.ptah.run): GitHub Pages, with the
source set to *GitHub Actions* and the domain in `web/CNAME`. Every push to
`main` runs `.github/workflows/deploy.yml`; a pull request runs the checks and
stops. `workflow_dispatch` re-runs a deploy by hand.

Two things about the tree matter before anything else:

`ptah.wasm` is **not** in git. It is 125 MB, it is a build product, and it is
rebuilt in CI. `manifest.json` and `wasm_exec.js` *are* in git, because the page
reads its version stamp out of the manifest and because `wasm_exec.js` has to
match the toolchain that linked the binary. So when the pin moves, run `make
wasm` and commit the manifest and the shim the build rewrote. CI fails the
deploy if you forget: it compares the manifest's `ptahCommit` and `ptahVersion`
against `third_party/ptah.pin`, and compares what it built against what you
committed.

`web/dist` is not in git either. CI bundles it. Locally, `make build-web`.

(`web/.nojekyll` is not needed by the Actions deploy path, which uploads the
directory as-is. It is there so that pointing Pages at a branch instead would
still publish every file rather than quietly dropping the ones Jekyll ignores.)

### What the workflow does

**check** — typecheck, unit tests, bundle, then `web/scripts/check-site.mjs`:
the CNAME says exactly `play.ptah.run`; `index.html` and `404.html` exist; every
`href`, `src` and CSS `url()` on every page resolves to a real file; no
`github.io` address appears anywhere; the committed manifest names the commit
the pin records. No Go and no 125 MB link, so it fails fast.

**deploy** — reads the pin, restores or builds the wasm, verifies it against
what is committed, bundles, stages `_site`, runs the same site check with
nothing exempt — the binary's sha256 and byte count against the manifest this
time — and uploads. It checks out the sandbox alone; the build fetches the
pinned commit itself.

The wasm cache is keyed on the pin plus a hash of `runtime/`,
`upstream-patch/` and the two build scripts, with **no** restore-keys: a near
miss would hand the deploy a binary built from different sources, which is
worse than a slow build. When the key hits, the Go toolchain is not even
installed.
The Go build and module caches sit behind a second, looser key so a change under
`runtime/` still reuses Ptah's whole dependency tree.

**smoke** — fetches the deployed site: 200 on the root, the site's own 404 page
on an unknown address, `application/wasm` on the binary, and the sha256 of the
bytes the CDN actually returned against the manifest that same origin serves.

### The open question: compression

A cold visit downloads a 125 MB WebAssembly binary. It compresses to 23 MB,
and the whole design of the loading experience assumes that is what crosses the
wire. Whether the CDN in front of GitHub Pages compresses an asset that large
has not been tested by anyone we can find, so the smoke test measures it rather
than assuming it, sending `Accept-Encoding: gzip` by hand and reporting the wire
bytes.

If it is compressed, the run says so and the budget holds. If it is not, the run
raises a warning with the measured numbers: 119 MiB per cold visit instead of
22 MiB, and the 100 GB/month Pages bandwidth allowance covering roughly 865
visits instead of 4600. That would need a real fix — a CDN in front that does
compress, or a pre-compressed copy served deliberately — not a smaller loader
animation.

To measure it yourself against anything, including `make serve`:

    make smoke BASE=http://127.0.0.1:8788/

## Upstream

The original Go changes for `js/wasm` landed in
[stokaro/ptah#3046](https://github.com/stokaro/ptah/pull/3046). The current
`upstream-patch/0001-browser-postgres-driver.patch` selects the browser driver
on `js` builds and routes it to the existing PostgreSQL reader and writer.
It changes no catalog query, capability, planner rule, or generated SQL.
Remove this hook when upstream provides it. The browser driver and its host
bridge live under `runtime/ptah/` and `web/src/runtime/`.

## Database engines and scenario capabilities

The database picker selects SQLite or PostgreSQL and resets the current
scenario. Every scenario declares its supported engines and default engine
in `capabilities`; choosing a scenario loads its default automatically.
The picker opens a dialog with the database and runtime versions before loading
them. On a first visit, finishing or skipping the tour requires a database
choice. The explicit choice is remembered in this browser.

Targeted links override that preference and skip the required choice:

- [Open PostgreSQL](https://play.ptah.run/?engine=postgres)
- [Open SQLite](https://play.ptah.run/?engine=sqlite)

Unknown `engine` values are treated as unspecified. Tour highlights the picker.

| Scenario | Engines | Default |
| --- | --- | --- |
| A: Change a schema | SQLite, PostgreSQL | SQLite |
| B: Detect drift | SQLite, PostgreSQL | SQLite |
| C: Versioned migrations | SQLite | SQLite |
| JSONB and a GIN index | PostgreSQL | PostgreSQL |
| Free exploration | SQLite, PostgreSQL | SQLite |

PostgreSQL is PGlite 0.5.8, whose `SELECT version()` reports PostgreSQL 18.3.
The package is pinned in `web/package-lock.json`. Its code and assets load
only after PostgreSQL is selected. The loading bar counts decoded bytes across
the PostgreSQL assets against their bundled size manifest, then shows compilation
and initialization until the scenario is ready. Both engines are memory-only: reloads
start from a fresh seed for the linked or remembered engine, and Reset creates a fresh database. Nothing is
stored in IndexedDB. The database panes show the PostgreSQL `public` schema;
Ptah's terminal output uses its own catalog reader.

Go awaits PGlite Promises from command goroutines. Waiting yields to the
worker's event loop; the JavaScript callback that starts a command has already
returned. No `Atomics.wait`, `SharedArrayBuffer`, service worker, or special
hosting headers are needed. The browser suite exercises this on an ordinary
static HTTP server with `crossOriginIsolated === false`.

PGlite has one physical SQL session. The driver refuses a second simultaneous
connection. PostgreSQL versioned migrations need separate lock and execution
sessions, so scenario C is SQLite-only. The engine picker disables unsupported
choices. A remote-looking PostgreSQL URL is refused; the local URL is
`postgres://pglite/app`.

SQLite exports contain `app.db`. PostgreSQL exports contain
`postgres-data.tar.gz`, produced by PGlite's `dumpDataDir`, with restoration
instructions in `NEXT-STEPS.md`. This is a PGlite data directory, not a SQLite
file or a `pg_dump` script. SQLite file import is available only on SQLite.
Its button and help hint are hidden while PostgreSQL is selected.

Every guided scenario has five steps. The JSONB scenario checks a successful
SQL-pane query, then groups Apply and Verify as two parts of its final step.
SQL errors leave the query step incomplete and release the next-command button.

Click a Data row (or focus it and press Enter) to inspect every field without
cell truncation. The expand button opens the entire Data / Structure / Plan
panel as a dialog. Close or Escape returns to the workspace without losing
the selected tab or query result.

Validation includes real PostgreSQL driver tests, all supported scenario
variants against Ptah wasm, a byte-for-byte GIN plan comparison with native
Ptah v0.10.0 on PostgreSQL 18.6, and browser engine-switch checks. PR CI rebuilds
the runtime before these checks. Details and measurements are in
[docs/postgresql.md](docs/postgresql.md).

## License

MIT. PGlite is distributed under Apache-2.0 and PostgreSQL license terms.
The vendored SQLite build and the web fonts carry their own terms; see
`web/vendor/sqlite/PROVENANCE.md` and `web/assets/fonts/LICENSES.md`.
