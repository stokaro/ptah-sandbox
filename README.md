# ptah-sandbox

The source of [play.ptah.run](https://play.ptah.run) — Ptah running in a
browser tab. Real Ptah, compiled to WebAssembly, against a real SQLite,
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
- The database is SQLite compiled to WebAssembly, reached through a
  `database/sql` driver, so Ptah's readers and writers run unchanged.
- The exit code you see is the exit code the command returned. The confirmation
  prompt is the real prompt, reading a real stdin.
- The version in the footer is the version of the WebAssembly that is actually
  running, read out of the binary — never the latest release number stamped on
  top of an older build.

The one thing that is not Ptah is the SQL pane. `ptah sql` is a linter, not a
query tool, so the pane is the playground's own and is labeled as such.

## Layout

    third_party/ptah      pinned upstream, a submodule, never edited
    upstream-patch/       empty, and meant to stay that way -- see below
    runtime/ptah/         new Go packages copied into Ptah's module at build time
    web/                  the playground itself, and its vendored runtime
    fixtures/             the demo workspaces
    test/integration/     the runtime driven outside a browser, under node
    docs/                 how it fits together, and what it deliberately is not

There is no `go.mod` here. The build materializes a copy of pinned Ptah and
builds inside Ptah's own module, so the browser entry point and the browser
SQLite driver are ordinary internal packages and Ptah grows no public API for
the sake of a website.

## Build

    make wasm        # materialize, build ptah.wasm, write the manifest
    make build-web   # npm ci and bundle web/src into web/dist
    make test        # drive the whole runtime under node, no browser needed
    make serve       # serve web/ on http://127.0.0.1:8788/
    make check-site  # the gate CI runs before publishing
    make ui-probe    # drive the real page in headless Chrome (needs `make serve`)

`make wasm` needs the Go toolchain the pinned Ptah declares; `wasm_exec.js` is
copied from that same toolchain, because the pair has to match.

`make test` proves the runtime and the components; it never opens a browser.
`make ui-probe` is the one that proves they are wired to each other. It loads
`web/index.html` in an iframe and drives it through the controls a visitor uses
-- typing into the terminal, typing into the editor, clicking the panes -- then
asserts by reading the DOM the page produced. Add `SHOTS=.refs` to write the
1440px light and dark renders and the 390px one as well.

## Deploy

The site is [play.ptah.run](https://play.ptah.run): GitHub Pages, with the
source set to *GitHub Actions* and the domain in `web/CNAME`. Every push to
`main` runs `.github/workflows/deploy.yml`; a pull request runs the checks and
stops. `workflow_dispatch` re-runs a deploy by hand.

Two things about the tree matter before anything else:

`ptah.wasm` is **not** in git. It is 124 MB, it is a build product, and it is
rebuilt in CI. `manifest.json` and `wasm_exec.js` *are* in git, because the page
reads its version stamp out of the manifest and because `wasm_exec.js` has to
match the toolchain that linked the binary. So when the `third_party/ptah` pin
moves, run `make wasm` and commit the manifest and the shim the build rewrote.
CI fails the deploy if you forget: it compares the manifest's `ptahCommit`
against the submodule gitlink, and compares what it built against what you
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
the submodule is pinned at. No Go and no 124 MB link, so it fails fast.

**deploy** — checks out the submodule with its tags (`git describe` inside it is
where the version in the footer comes from; a shallow clone would stamp a bare
hash), restores or builds the wasm, verifies it against what is committed,
bundles, stages `_site`, runs the same site check with nothing exempt — the
binary's sha256 and byte count against the manifest this time — and uploads.

The wasm cache is keyed on the pin plus a hash of `runtime/`,
`upstream-patch/` and the build script, with **no** restore-keys: a near miss
would hand the deploy a binary built from different sources, which is worse
than a slow build. When the key hits, the Go toolchain is not even installed.
The Go build and module caches sit behind a second, looser key so a change under
`runtime/` still reuses Ptah's whole dependency tree.

**smoke** — fetches the deployed site: 200 on the root, the site's own 404 page
on an unknown address, `application/wasm` on the binary, and the sha256 of the
bytes the CDN actually returned against the manifest that same origin serves.

### The open question: compression

A cold visit downloads a 124 MB WebAssembly binary. It compresses to 22.6 MB,
and the whole design of the loading experience assumes that is what crosses the
wire. Whether the CDN in front of GitHub Pages compresses an asset that large
has not been tested by anyone we can find, so the smoke test measures it rather
than assuming it, sending `Accept-Encoding: gzip` by hand and reporting the wire
bytes.

If it is compressed, the run says so and the budget holds. If it is not, the run
raises a warning with the measured numbers: 118 MiB per cold visit instead of
22 MiB, and the 100 GB/month Pages bandwidth allowance covering roughly 865
visits instead of 4600. That would need a real fix — a CDN in front that does
compress, or a pre-compressed copy served deliberately — not a smaller loader
animation.

To measure it yourself against anything, including `make serve`:

    make smoke BASE=http://127.0.0.1:8788/

## Upstream

The Go changes that make Ptah build for `js/wasm` belong in Ptah, not here, so
`upstream-patch/` is empty: they landed in
[stokaro/ptah#3046](https://github.com/stokaro/ptah/pull/3046), closing
[#3045](https://github.com/stokaro/ptah/issues/3045), and the submodule now
pins a commit that carries them. The build applies no patches at all.

If something the browser needs cannot be done from outside Ptah again, a patch
goes back in that directory in the shape it will be proposed as, and leaves
again when it merges. An empty directory there is the goal state, not an
oversight, and `scripts/build-wasm.sh` treats it as one.

## License

MIT. The vendored SQLite build and the web fonts carry their own terms; see
`web/vendor/sqlite/PROVENANCE.md` and `web/assets/fonts/LICENSES.md`.
