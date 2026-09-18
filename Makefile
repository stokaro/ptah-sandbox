# The sandbox has no Go module of its own; everything is built inside a
# materialized copy of the commit third_party/ptah.pin names. See
# scripts/build-wasm.sh.

SHELL := /bin/sh

.POSIX:
.PHONY: wasm pin dev-tree clean test test-integration test-migrations test-go capture-native \
	build-web serve check-site smoke

# wasm builds web/vendor/ptah/{ptah.wasm,wasm_exec.js,manifest.json}.
wasm:
	scripts/build-wasm.sh

# pin moves the playground to another Ptah commit and records it in
# third_party/ptah.pin. `make pin REF=v0.7.0` takes a tag or a commit; with no
# REF it takes the tip of master. Run `make wasm` after it.
pin:
	scripts/pin-ptah.sh $(REF)

# build-web installs the pinned npm dependencies and bundles the page's
# TypeScript into web/dist. It does not touch the wasm; `make wasm` does that,
# and the two are independent -- the page loads and reads as a page before any
# WebAssembly arrives.
build-web:
	cd web && npm ci && npm run build

# serve serves web/ the way GitHub Pages does: a directory of static files at
# the root of the origin, nothing generated on request. Run `make build-web`
# and `make wasm` first, or the page will 404 on dist/ and on the binary.
serve:
	@echo "web/ on http://127.0.0.1:8788/ -- ^C to stop"
	cd web && python3 -m http.server 8788 --bind 127.0.0.1

# check-site is the gate the deploy workflow runs before publishing: the CNAME,
# every href/src and CSS url() resolving, no github.io address, and the
# manifest agreeing with both the wasm and the recorded pin. Run it before
# pushing and CI will not tell you anything you did not already know.
check-site:
	node web/scripts/check-site.mjs --root web

# ui-probe drives the real playground page in headless Chrome and asserts by
# reading the DOM: the fixture renders before the runtime does, the loader
# counts real bytes, a typed command exits 0, an edit marks the plan stale, the
# apply asks for YES, the rows survive it. It needs `make serve` running in
# another shell, and Chrome on the PATH or in $CHROME.
#   make ui-probe                  assert only
#   make ui-probe SHOTS=.refs      assert, then write ui-light/dark/mobile.png
SHOTS =
ui-probe:
	cd web && node scripts/ui-probe-run.mjs --base http://127.0.0.1:8788/ \
	  $(if $(SHOTS),--shots $(abspath $(SHOTS)),)

# smoke drives the deployed site over the network. With no argument it tests
# production; pass a base URL to point it at `make serve`:
#   make smoke BASE=http://127.0.0.1:8788/
BASE = https://play.ptah.run/
smoke:
	sh web/scripts/smoke.sh "$(BASE)"

# dev-tree materializes build/ptah-src with runtime/ptah symlinked in and
# writes a go.work, so an editor can typecheck the sandbox's Go sources against
# the real ptah module without a build.
dev-tree:
	scripts/build-wasm.sh --tree-only --link

# test runs everything, from the pinned commit to the end-to-end suite:
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
