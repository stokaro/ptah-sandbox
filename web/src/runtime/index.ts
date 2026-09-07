/**
 * Wiring for the Go js/wasm runtime globals.
 *
 * `installRuntime()` must run before `wasm_exec.js` is loaded: that script only
 * installs its ENOSYS stubs when `globalThis.fs` / `process` / `path` are
 * absent, and `syscall/fs_js.go` captures all three at package init.
 */

import { MemFS, createFsShim } from "./memfs.ts";
import type { FsShim, MemFSOptions } from "./memfs.ts";
import { createPathShim, createProcessShim, defaultEnv } from "./process.ts";
import type { PathShim, ProcessShim } from "./process.ts";
import { MemWorkspace } from "./workspace.ts";

export * from "./memfs.ts";
export * from "./process.ts";
export * from "./workspace.ts";

/** The three globals Go reads. This is the whole bridge boundary. */
interface GoGlobals {
  fs: FsShim;
  process: ProcessShim;
  path: PathShim;
}

export interface Runtime {
  memfs: MemFS;
  workspace: MemWorkspace;
  fs: FsShim;
  process: ProcessShim;
  path: PathShim;
  /** Pass this as `go.env`; Go's os.Environ comes from there, not process.env. */
  env: Record<string, string>;
}

export interface InstallOptions extends MemFSOptions {
  /** Root that the workspace API resolves relative paths against. */
  workspaceRoot?: string;
  env?: Record<string, string>;
  argv?: string[];
  /** Set the globals. Off for tests that want the objects without the globals. */
  install?: boolean;
}

export function createRuntime(options: InstallOptions = {}): Runtime {
  const memfs = new MemFS(options);
  const env = { ...defaultEnv(memfs), ...options.env };
  const processShim = createProcessShim(memfs, { env, argv: options.argv });
  const runtime: Runtime = {
    memfs,
    workspace: new MemWorkspace(memfs, options.workspaceRoot ?? memfs.roots[0]),
    fs: createFsShim(memfs),
    process: processShim,
    path: createPathShim(memfs),
    env,
  };
  if (options.install !== false) {
    const g = globalThis as unknown as GoGlobals;
    g.fs = runtime.fs;
    g.process = runtime.process;
    g.path = runtime.path;
  }
  return runtime;
}

/** Alias that reads better at the call site in the worker bootstrap. */
export const installRuntime = createRuntime;
