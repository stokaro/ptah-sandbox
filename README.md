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

    make wasm     # materialize, build ptah.wasm, write the manifest
    make test     # drive the whole runtime under node, no browser needed
    make serve    # serve web/ on localhost

`make wasm` needs the Go toolchain the pinned Ptah declares; `wasm_exec.js` is
copied from that same toolchain, because the pair has to match.

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
