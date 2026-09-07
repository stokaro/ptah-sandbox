# Contract B harness

Two node scripts that drive `cmd/ptah-wasm` the way the playground worker
does: a pure-JS in-memory `globalThis.fs`, a stub `globalThis.__sqlite`, and
`globalThis.__ptahHost` installed before the Go program starts.

    node harness.js ../../../../build/ptah.wasm          # every scenario
    MAXOUT=1200 node harness.js path/to/ptah.wasm        # truncation
    node one.js path/to/ptah.wasm schema apply --help    # raw stdout on fd 1

`one.js` writes the command's stdout and nothing else to fd 1, so its output
diffs byte for byte against `.refs/ground-truth/help/*.txt`.

`memfs.js` here is the recon prototype of the filesystem shim, kept so the
harness runs on its own. Point the harness at the shipped shim once
`web/src` owns one; nothing else in this directory depends on it.

Go's toolchain ignores `testdata`, so none of this reaches the WebAssembly
module.
