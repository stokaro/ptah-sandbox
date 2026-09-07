# The sandbox has no Go module of its own; everything is built inside a
# materialized copy of the pinned Ptah submodule. See scripts/build-wasm.sh.

SHELL := /bin/sh

.POSIX:
.PHONY: wasm dev-tree clean test test-integration test-migrations test-go capture-native

# wasm builds web/vendor/ptah/{ptah.wasm,wasm_exec.js,manifest.json}.
wasm:
	scripts/build-wasm.sh

# dev-tree materializes build/ptah-src with runtime/ptah symlinked in and
# writes a go.work, so an editor can typecheck the sandbox's Go sources against
# the real ptah module without a build.
dev-tree:
	scripts/build-wasm.sh --tree-only --link

# test runs everything, from the pinned submodule to the end-to-end suite:
# a full wasm build, the js/wasm Go tests, the TypeScript runtime unit suites,
# and the two integration suites that drive the real binary. It rebuilds the wasm
# first on purpose -- the integration suites load web/vendor/ptah/ptah.wasm, so
# testing without rebuilding would test the previous build.
test:
	scripts/build-wasm.sh
	scripts/test-go.sh
	cd web && npm test

# test-integration is the end-to-end suite alone: real ptah.wasm, real SQLite
# wasm, the MemFS and both contracts, driven through Contract B. It uses
# whatever is in web/vendor/ptah, so run `make wasm` first if Go source moved.
test-integration:
	node test/integration/run.mjs

# test-migrations is the migrations-group suite: the same real binary, driven
# through the scenario .refs/ground-truth/capture.sh captured natively, with
# every step's exit status compared to the one the native binary reported.
test-migrations:
	node test/integration/migrations.mjs

# test-go runs the js/wasm Go tests, materializing build/ptah-src if needed.
test-go:
	scripts/test-go.sh

# capture-native regenerates test/integration/expected/ from a native build.
capture-native:
	test/integration/capture-native.sh

clean:
	rm -rf build go.work go.work.sum
	rm -f web/vendor/ptah/ptah.wasm web/vendor/ptah/wasm_exec.js web/vendor/ptah/manifest.json
