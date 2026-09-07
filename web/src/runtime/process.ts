/**
 * `globalThis.process` and `globalThis.path` for Go's js/wasm runtime.
 *
 * `wasm_exec.js` installs stubs whose every method throws ENOSYS, and
 * `syscall/syscall_js.go` calls them unconditionally: `Getcwd` goes through
 * `process.cwd()`, `Chdir` through `process.chdir()`, and `syscall.Open` runs
 * every opened path through `path.resolve()` to fill in `jsFile.path` (which is
 * what `Fchdir` later reads back). The default `path.resolve` is
 * `pathSegments.join("/")`, which is wrong for anything relative.
 *
 * Both objects must exist before `wasm_exec.js` runs, because it only installs
 * its stubs when the global is absent.
 */

import type { MemFS } from "./memfs.ts";

export interface ProcessShim {
  /** -1 throughout: there are no users in the sandbox, and Go only reports
   *  these values. Returning a plausible uid would be a lie with no upside. */
  getuid(): number;
  getgid(): number;
  geteuid(): number;
  getegid(): number;
  getgroups(): number[];
  pid: number;
  ppid: number;
  umask(mask?: number): number;
  cwd(): string;
  chdir(dir: string): void;
  /** Not read by Go (its environment comes from `go.env`); present for JS-side
   *  code that expects the node shape. */
  env: Record<string, string>;
  /** Cosmetic, but `process.platform` is a common feature probe. */
  platform: string;
  argv: string[];
  version: string;
  versions: Record<string, string>;
  exitCode: number;
}

export interface PathShim {
  resolve(...segments: string[]): string;
  sep: string;
}

export interface ProcessOptions {
  env?: Record<string, string>;
  argv?: string[];
  pid?: number;
  ppid?: number;
  umask?: number;
}

/**
 * The environment Go should be started with. `PWD` matches the initial cwd,
 * `TMPDIR` and `HOME` point at the two non-workspace subtrees, and `PATH` is a
 * dead value that only exists so `exec.LookPath` fails cleanly instead of
 * panicking on an empty variable.
 */
export function defaultEnv(fs: MemFS): Record<string, string> {
  return {
    HOME: "/home/play",
    TMPDIR: "/tmp",
    PWD: fs.cwd(),
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    TERM: "dumb",
    // Ptah reads NO_COLOR-style variables nowhere, but the CLI libraries it
    // pulls in do; the transcript must stay free of escape sequences.
    NO_COLOR: "1",
  };
}

export function createProcessShim(fs: MemFS, options: ProcessOptions = {}): ProcessShim {
  let mask = options.umask ?? 0o022;
  const env = options.env ?? defaultEnv(fs);

  return {
    getuid: () => -1,
    getgid: () => -1,
    geteuid: () => -1,
    getegid: () => -1,
    getgroups: () => [],
    pid: options.pid ?? 1,
    ppid: options.ppid ?? 0,
    umask(next?: number): number {
      const previous = mask;
      if (typeof next === "number") mask = next & 0o777;
      return previous;
    },
    // Answers from the first instant. A cwd of "/" would put os.Getwd outside
    // every jail root, and filepath.Abs would then fail for relative paths.
    cwd: () => fs.cwd(),
    chdir(dir: string): void {
      fs.chdir(dir);
      env["PWD"] = fs.cwd();
    },
    env,
    platform: "browser",
    argv: options.argv ?? ["ptah"],
    version: "",
    versions: {},
    exitCode: 0,
  };
}

export function createPathShim(fs: MemFS): PathShim {
  return {
    resolve(...segments: string[]): string {
      return fs.resolve(...segments);
    },
    sep: "/",
  };
}
