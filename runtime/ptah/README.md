# runtime/ptah

New Go sources that belong inside the Ptah module but not inside Ptah.

## Why the tree looks like this

The sandbox has no `go.mod`. Every Go file it owns is compiled as part of the
pinned Ptah module, so a package added here has an import path under
`ptah.run/...` and needs no new public Ptah API to reach the internals it
depends on.

Three directories make that work:

| Path                  | What it holds                                       | Tracked |
| --------------------- | --------------------------------------------------- | ------- |
| `third_party/ptah`    | Pristine upstream, a submodule pinned to one commit | yes     |
| `upstream-patch/`     | Changes to files that already exist upstream        | yes     |
| `runtime/ptah/`       | Files that do not exist upstream and never will     | yes     |
| `build/ptah-src/`     | The three of them, assembled                        | no      |

`scripts/build-wasm.sh` assembles them in that order: `git archive` the pinned
commit into `build/ptah-src`, `git apply` each patch, then copy this directory
over the result. The path of a file here is its path inside the Ptah module —
`runtime/ptah/internal/browsersqlite/browsersqlite.go` becomes
`build/ptah-src/internal/browsersqlite/browsersqlite.go`, importable as
`ptah.run/internal/browsersqlite`.

The split matters because the files in `upstream-patch/` are literally the
pull request Ptah will receive: `0001-browser-profile.patch` is the js/wasm
build profile and the shared runner, and `0002-js-conditional-rename.patch`
gives `internal/fsdurable` a conditional rename on a platform that has no
`renameat(2)`, without which every artifact publication -- `ptah migrations
generate` above all -- fails closed. Anything that would embarrass
that PR — a browser bridge, a wasm entry point, a host protocol — lives here
instead, where it never has to be justified to upstream.

`build/ptah-src` is disposable. It is deleted and rebuilt on every run of the
build script, so editing it is editing something that is about to be
overwritten.

## Editing these files with a working editor

`make dev-tree` materializes `build/ptah-src` with this directory **symlinked**
rather than copied, and writes a root `go.work` that uses it. `gopls` then
typechecks the real files under `runtime/ptah/` — opened through the symlink —
against the real Ptah module. `make wasm` copies instead of linking, so a
release build never depends on a symlink farm. `make clean` removes both.

## Rules for files placed here

**Keep every package buildable on every platform.** `go build ./...` walks the
whole materialized tree, and a package whose files are all excluded by build
constraints fails with `build constraints exclude all Go files`. A package that
is js-only in substance still needs one non-js file — a stub returning an
error is enough. `cmd/ptah-wasm` has the same obligation.

**Do not modify upstream files from here.** A file here that shadows an
existing upstream path would silently overwrite it during assembly, and the
patch would be reviewing something other than what gets built. Changes to files
that exist upstream belong in `upstream-patch/`.

**`internal/` is reachable.** These files are inside the `ptah.run` module, so
`ptah.run/internal/...` imports resolve. That is the entire reason for the copy
mechanism.

## What lives here now

- `internal/browsersqlite/` — the seam `internal/dbschema/sqlite` and
  `internal/sqlitemodule` blank-import on js builds, in place of
  `modernc.org/sqlite`. It registers the `sqlite` driver name against the
  host's `globalThis.__sqlite` bridge and supplies the `SQLITE_LIMIT_ATTACHED`
  restriction. **Currently a placeholder** that registers nothing and reports
  `browsersqlite: no SQLite engine installed`.
- `cmd/ptah-wasm/` — the js/wasm entry point. It installs the bridge, publishes
  `globalThis.__ptah` and runs commands through `root.RunContext`, which the
  patch adds for exactly this caller. **Currently a placeholder** that prints
  the build stamp and exits.
