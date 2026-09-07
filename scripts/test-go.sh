#!/bin/sh
# Run the sandbox's own Go tests for js/wasm inside the materialized tree.
#
# Both packages under runtime/ptah/ are js-only, so they can only be tested
# with GOOS=js GOARCH=wasm through a JavaScript host. cmd/ptah-wasm runs under
# the stock Go shim; internal/browsersqlite needs Contract A installed before
# Go starts, which is what its own -exec wrapper does.
#
#   scripts/test-go.sh
#
# build/ptah-src is materialized first if it is not already there. It is not
# rebuilt when it exists, so `make test` can share the tree the wasm build just
# produced instead of paying for a second materialization.
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo"

srcdir=build/ptah-src
[ -d "$srcdir" ] || scripts/build-wasm.sh --tree-only

GOWORK=off
GOOS=js
GOARCH=wasm
export GOWORK GOOS GOARCH

# GOROOT has to be read before GOOS is exported, or `go env` answers for js.
goroot=$(GOOS= GOARCH= go env GOROOT)

(cd "$srcdir" && go test -exec="$goroot/lib/wasm/go_js_wasm_exec" ./cmd/ptah-wasm/)

(
	cd "$srcdir/internal/browsersqlite"
	PTAH_SANDBOX_SQLITE_DIR="$repo/web/vendor/sqlite" \
		go test -exec=./testdata/go_js_wasm_exec_sqlite .
)
