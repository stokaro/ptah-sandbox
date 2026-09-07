# Integration tests

The whole playground runtime, stood up outside a browser and driven end to end.

    make test              build the wasm, then run every suite
    make test-integration  this suite alone, against whatever is in web/vendor
    cd web && npm test      same thing through npm

## What runs

`harness.mjs` boots the real stack in the order the worker must use it:

1. `createRuntime()` installs `globalThis.fs` / `process` / `path` (the MemFS).
2. `createSqliteBridge()` initializes the vendored SQLite 3.53.4 wasm and
   `installSqliteBridge()` publishes Contract A as `globalThis.__sqlite`.
3. `globalThis.__ptahHost` is installed — Contract B's host half.
4. `wasm_exec.js` is loaded, `ptah.wasm` instantiated, `go.run()` started and
   never awaited; the Go program blocks on `select{}` for the life of the page.
5. Once `ready()` fires, commands go through `__ptah.start` / `pushStdin` /
   `cancel`.

Two things are Node-specific and neither changes behavior: the `.wasm` files
are read off disk, and `sqlite3.mjs` is given an `instantiateWasm` shim because
Node's `fetch` refuses `file:` URLs.

The bridge is wrapped in a recording proxy so the suite can assert on what Go
actually asked SQLite for — which paths were opened, whether every handle was
closed — without reading the bridge's private state.

## Expected transcripts

`expected/*.txt` are captured from the **native** ptah binary running the same
argv against the same fixture on a real SQLite file:

    make capture-native

Comparison is byte for byte. The only normalization anywhere in the suite is
the absolute path in `47_err_missing_file`, where the native capture ran in a
`mktemp` directory and the browser runs in `/workspace`; the suite says so in
the test name. No timestamps or durations appear in any of these commands.

Where `test/integration/ground-truth` has a transcript for the same command shape it is
checked too, with its `$ ptah …` header stripped (that scenario used a
different schema file name). `version` and `ptah --help` cannot be identical to
the native capture, so the suite pins exactly how they differ instead of
skipping them: a third difference fails.

## Adding a case

Add the argv to `capture-native.sh` in scenario order, regenerate, then add the
matching `session.run(...)` and `assertTranscript(...)` to `run.mjs`. A command
that prompts needs an `answers` entry — `[[/pattern/, "text"]]`, where an empty
text is EOF. Without one the run is canceled after 60 s and the suite fails
rather than hanging.
