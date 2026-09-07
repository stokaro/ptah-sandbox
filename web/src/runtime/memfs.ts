/**
 * An in-memory filesystem that implements the `globalThis.fs` contract Go's
 * `syscall/fs_js.go` calls on GOOS=js GOARCH=wasm.
 *
 * Go grabs `js.Global().Get("fs")` once at package init and routes every file
 * syscall through it, so supplying a complete implementation gives the wasm
 * program a working `os` package with zero Go changes. `wasm_exec.js` only
 * installs a read-only ENOSYS stub, and only when the global is absent, so this
 * must be assigned before the loader script runs.
 *
 * The contract is internal to the Go toolchain and carries no compatibility
 * promise: it is verified against go1.27.1 exactly. `memfs.test.mjs` is the
 * gate for a toolchain bump.
 *
 * Callbacks fire synchronously. `fsCall` in fs_js.go uses a buffered channel,
 * so an inline callback is safe, and it keeps one CLI run a single continuous
 * wasm execution instead of a chain of microtasks.
 */

// ---------------------------------------------------------------------------
// errno
// ---------------------------------------------------------------------------

/**
 * The subset of `syscall/tables_js.go` errnoByCode this filesystem produces.
 * A code outside that table makes `mapJSError` panic in Go rather than return
 * an error, so never invent one.
 */
export type ErrnoCode =
  | "EACCES"
  | "EBADF"
  | "EBUSY"
  | "EEXIST"
  | "EFBIG"
  | "EINVAL"
  | "EIO"
  | "EISDIR"
  | "ELOOP"
  | "EMFILE"
  | "ENAMETOOLONG"
  | "ENOENT"
  | "ENOSPC"
  | "ENOSYS"
  | "ENOTDIR"
  | "ENOTEMPTY"
  | "EPERM"
  | "ESPIPE"
  | "EXDEV";

/** An Error shaped the way `mapJSError` in fs_js.go expects: `.code` is read. */
export class FsError extends Error {
  code: ErrnoCode;
  path: string | undefined;

  constructor(code: ErrnoCode, path?: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : path ? `${code}: ${path}` : code);
    this.name = "FsError";
    this.code = code;
    this.path = path;
  }
}

function fail(code: ErrnoCode, path?: string, detail?: string): never {
  throw new FsError(code, path, detail);
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** File-type bits. `os/stat_js.go` masks these out of the reported mode. */
export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFCHR = 0o020000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

/**
 * Open flags. Go maps its own O_* onto whatever numbers `fs.constants` reports,
 * so these only have to be self-consistent; the Linux/node values are used so a
 * stray hard-coded constant behaves.
 */
export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR = 2;
export const O_ACCMODE = 3;
export const O_CREAT = 64;
export const O_EXCL = 128;
export const O_TRUNC = 512;
export const O_APPEND = 1024;
export const O_DIRECTORY = 65536;

/** Not optional: os.ReadDir opens with O_DIRECTORY and Go errors out if the
 *  constant is missing, with a message that blames Windows. */
export const FS_CONSTANTS = {
  O_WRONLY,
  O_RDWR,
  O_CREAT,
  O_EXCL,
  O_TRUNC,
  O_APPEND,
  O_DIRECTORY,
} as const;

const MAX_SYMLINK_DEPTH = 40;
const MAX_PATH_BYTES = 4096;
const MAX_NAME_BYTES = 255;
const MAX_OPEN_FILES = 1024;

const FD_STDIN = 0;
const FD_STDOUT = 1;
const FD_STDERR = 2;
const FIRST_FD = 3;

// ---------------------------------------------------------------------------
// inodes
// ---------------------------------------------------------------------------

export type InodeKind = "file" | "dir" | "link";

/**
 * A single inode. Directory entries hold references to these, so a hard link is
 * just a second entry pointing at the same object and `ino` stays stable, which
 * is what makes `os.SameFile` work.
 */
class Inode {
  kind: InodeKind;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;

  /** Backing store for a file. May be larger than `size`; see `size`. */
  data: Uint8Array;
  /** Logical file length. Bytes past it in `data` are slack, not content. */
  size: number;
  /**
   * True when `data` is also referenced by a snapshot. Any mutation must clone
   * first, which is what keeps `snapshot()` O(nodes) instead of O(bytes)
   * without ever aliasing a live buffer into a snapshot.
   */
  shared: boolean;

  /** Directory children, insertion-ordered (readdir returns this order). */
  entries: Map<string, Inode> | null;
  /** Symlink target. Creation is refused, but the field keeps lstat honest. */
  target: string;
  /** Open descriptors referencing this inode; keeps quota accounting honest. */
  openCount: number;

  constructor(kind: InodeKind, ino: number, mode: number, now: number) {
    this.kind = kind;
    this.ino = ino;
    this.mode = mode & 0o7777;
    this.uid = 0;
    this.gid = 0;
    this.nlink = 1;
    this.atimeMs = now;
    this.mtimeMs = now;
    this.ctimeMs = now;
    this.data = EMPTY;
    this.size = 0;
    this.shared = false;
    this.entries = kind === "dir" ? new Map() : null;
    this.target = "";
    this.openCount = 0;
  }
}

const EMPTY = new Uint8Array(0);

/** The 13 numeric fields `setStat` reads, plus the `isDirectory()` method
 *  `syscall.Open` calls on an fstat result. */
export interface Stats {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface OpenFile {
  node: Inode;
  /** Absolute, already normalized. `Fchdir` reads it back through fs_js. */
  path: string;
  flags: number;
  pos: number;
}

// ---------------------------------------------------------------------------
// quota
// ---------------------------------------------------------------------------

export interface Limits {
  /** Sum of logical file sizes across every subtree. */
  maxTotalBytes: number;
  /** Live inodes below the roots: regular files, directories and links. */
  maxFiles: number;
  /** Largest a single file may grow. */
  maxFileBytes: number;
}

/**
 * Safety-net defaults, deliberately looser than the product limits in the spec
 * (2 MiB of text, 200 files) so that legitimate scratch traffic under /tmp does
 * not trip them. The host is expected to enforce the tighter, user-visible
 * numbers on import/export and to pass its own values here.
 */
export const DEFAULT_LIMITS: Limits = {
  maxTotalBytes: 16 * 1024 * 1024,
  maxFiles: 4096,
  maxFileBytes: 8 * 1024 * 1024,
};

export interface Usage {
  /** Sum of logical file sizes. */
  bytes: number;
  /** Regular files only. */
  files: number;
  /** Every inode below the roots; this is what `maxFiles` caps. */
  nodes: number;
  /** How many operations have been refused with ENOSPC since construction. */
  denials: number;
  limits: Limits;
}

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

export const SNAPSHOT_FORMAT_VERSION = 1;

export interface SnapshotFile {
  kind: "file";
  ino: number;
  mode: number;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  /** A view of the live buffer, protected by copy-on-write. Never mutated. */
  data: Uint8Array;
}

export interface SnapshotLink {
  kind: "link";
  ino: number;
  mode: number;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  target: string;
}

export interface SnapshotDir {
  kind: "dir";
  ino: number;
  mode: number;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  entries: Array<[string, SnapshotEntry]>;
}

/** A second reference to an inode already emitted elsewhere (a hard link). */
export interface SnapshotRef {
  kind: "ref";
  ino: number;
}

export type SnapshotEntry = SnapshotFile | SnapshotDir | SnapshotLink | SnapshotRef;

export interface WorkspaceSnapshot {
  formatVersion: number;
  root: SnapshotDir;
  cwd: string;
  revision: number;
  bytes: number;
  files: number;
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

export type OutputSink = (chunk: string) => void;

export interface MemFSOptions {
  /**
   * Jail roots. Everything the program may touch lives under one of these, and
   * they share one instance because Ptah renames and hard-links across them;
   * separate instances would need EXDEV, which Go's os has no fallback for.
   */
  roots?: readonly string[];
  /** Initial working directory. Must be inside a root. Defaults to roots[0]. */
  cwd?: string;
  /** Subtree wiped by `clearTemp()` and excluded from the workspace revision. */
  tempRoot?: string;
  limits?: Partial<Limits>;
  stdout?: OutputSink;
  stderr?: OutputSink;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

export const DEFAULT_ROOTS = ["/workspace", "/tmp", "/home/play"] as const;

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

/** Collapse `.`/`..` lexically. No store access, so `..` cannot walk through a
 *  symlink to somewhere the jail check would then approve. */
export function normalizePath(input: string): string {
  const out: string[] = [];
  for (const seg of input.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return "/" + out.join("/");
}

function splitPath(abs: string): string[] {
  return abs === "/" ? [] : abs.slice(1).split("/");
}

function parentPath(abs: string): string {
  const i = abs.lastIndexOf("/");
  return i <= 0 ? "/" : abs.slice(0, i);
}

function baseName(abs: string): string {
  return abs.slice(abs.lastIndexOf("/") + 1);
}

/** Ancestors of a root, e.g. `/home/play` contributes `/` and `/home`. Those
 *  must be statable and listable or `os.MkdirTemp` and `filepath.Walk` break,
 *  but they are never writable. */
function spineOf(roots: readonly string[]): Set<string> {
  const spine = new Set<string>(["/"]);
  for (const root of roots) {
    const parts = splitPath(root);
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      cur += "/" + parts[i];
      spine.add(cur);
    }
  }
  return spine;
}

type Access = "read" | "write";

// ---------------------------------------------------------------------------
// MemFS
// ---------------------------------------------------------------------------

export class MemFS {
  readonly roots: readonly string[];
  readonly tempRoot: string;
  limits: Limits;

  private readonly spine: Set<string>;
  private readonly clock: () => number;
  private root: Inode;
  private nextIno: number;
  private cwdPath: string;
  private fds: Map<number, OpenFile>;
  private nextFd: number;

  private bytes: number;
  private files: number;
  private nodes: number;
  private denials: number;

  private rev: number;
  private wsRev: number;

  private stdoutSink: OutputSink;
  private stderrSink: OutputSink;
  private readonly outDecoder: TextDecoder;
  private readonly errDecoder: TextDecoder;
  private stdinQueue: Uint8Array;
  private stdinClosed: boolean;

  constructor(options: MemFSOptions = {}) {
    const roots = (options.roots ?? DEFAULT_ROOTS).map((r) => normalizePath(r));
    if (roots.length === 0) throw new Error("memfs: at least one root is required");
    this.roots = roots;
    this.spine = spineOf(roots);
    this.tempRoot = normalizePath(options.tempRoot ?? "/tmp");
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.clock = options.now ?? Date.now;

    this.nextIno = 1;
    this.root = new Inode("dir", this.nextIno++, 0o755, this.clock());
    this.fds = new Map();
    this.nextFd = FIRST_FD;
    this.bytes = 0;
    this.files = 0;
    this.nodes = 0;
    this.denials = 0;
    this.rev = 0;
    this.wsRev = 0;

    this.stdoutSink = options.stdout ?? consoleSink("log");
    this.stderrSink = options.stderr ?? consoleSink("error");
    this.outDecoder = new TextDecoder("utf-8");
    this.errDecoder = new TextDecoder("utf-8");
    this.stdinQueue = EMPTY;
    this.stdinClosed = false;

    for (const r of roots) this.seedDir(r);
    this.cwdPath = normalizePath(options.cwd ?? roots[0]);
    if (!this.insideRoot(this.cwdPath)) {
      throw new Error(`memfs: cwd ${this.cwdPath} is outside every root`);
    }
  }

  // -- jail ---------------------------------------------------------------

  private insideRoot(abs: string): boolean {
    for (const r of this.roots) {
      if (abs === r || abs.startsWith(r + "/")) return true;
    }
    return false;
  }

  private isRoot(abs: string): boolean {
    return this.roots.indexOf(abs) !== -1;
  }

  /**
   * Layer 2 and 3 of the jail: normalize against the cwd first, then check the
   * result. `/workspace/../etc/passwd` becomes `/etc/passwd` and is refused
   * with EACCES rather than silently reported as ENOENT, so an escape attempt
   * is distinguishable from a typo.
   */
  private resolvePath(raw: unknown, access: Access): string {
    const p = typeof raw === "string" ? raw : String(raw);
    // Layer 1. Go rejects these too (fs_js.go checkPath); belt and braces,
    // because process.chdir and path.resolve do not go through checkPath.
    if (p === "") fail("EINVAL", p, "empty path");
    if (p.indexOf("\u0000") !== -1) fail("EINVAL", "<path>", "NUL byte in path");
    if (p.length > MAX_PATH_BYTES) fail("ENAMETOOLONG", "<path>");

    const abs = normalizePath(p.charCodeAt(0) === 47 ? p : this.cwdPath + "/" + p);
    if (this.insideRoot(abs)) return abs;
    if (access === "read" && this.spine.has(abs)) return abs;
    fail("EACCES", abs, `path escapes the sandbox: ${abs}`);
  }

  // -- lookup -------------------------------------------------------------

  private seedDir(abs: string): Inode {
    let node = this.root;
    for (const part of splitPath(abs)) {
      const entries = node.entries;
      if (entries === null) throw new Error(`memfs: ${abs} crosses a non-directory`);
      let child = entries.get(part);
      if (child === undefined) {
        child = new Inode("dir", this.nextIno++, 0o755, this.clock());
        entries.set(part, child);
        this.nodes++;
      }
      node = child;
    }
    return node;
  }

  private lookup(abs: string, followFinal: boolean, depth = 0): Inode {
    if (depth > MAX_SYMLINK_DEPTH) fail("ELOOP", abs);
    const parts = splitPath(abs);
    let node = this.root;
    for (let i = 0; i < parts.length; i++) {
      if (node.entries === null) fail("ENOTDIR", abs);
      const child = node.entries.get(parts[i]);
      if (child === undefined) fail("ENOENT", abs);
      const last = i === parts.length - 1;
      if (child.kind === "link" && (!last || followFinal)) {
        const here = "/" + parts.slice(0, i).join("/");
        const target = child.target.charCodeAt(0) === 47
          ? normalizePath(child.target)
          : normalizePath(here + "/" + child.target);
        if (!this.insideRoot(target) && !this.spine.has(target)) fail("EACCES", abs);
        node = this.lookup(target, true, depth + 1);
      } else {
        node = child;
      }
    }
    return node;
  }

  private lookupParent(abs: string): { dir: Inode; name: string } {
    if (abs === "/") fail("EINVAL", abs, "the root has no parent");
    const name = baseName(abs);
    if (name.length > MAX_NAME_BYTES) fail("ENAMETOOLONG", abs);
    const dir = this.lookup(parentPath(abs), true);
    if (dir.entries === null) fail("ENOTDIR", abs);
    return { dir, name };
  }

  // -- accounting ---------------------------------------------------------

  private touched(abs: string): void {
    this.rev++;
    if (abs !== this.tempRoot && !abs.startsWith(this.tempRoot + "/")) this.wsRev++;
  }

  private denyQuota(path: string, detail: string): never {
    this.denials++;
    fail("ENOSPC", path, detail);
  }

  private reserveNode(path: string): void {
    if (this.nodes + 1 > this.limits.maxFiles) {
      this.denyQuota(path, `file count limit reached (${this.limits.maxFiles})`);
    }
    this.nodes++;
  }

  /** Charge a size change against the byte quotas before applying it. */
  private reserveBytes(node: Inode, newSize: number, path: string): void {
    if (newSize > this.limits.maxFileBytes) {
      this.denyQuota(path, `file size limit reached (${this.limits.maxFileBytes} bytes)`);
    }
    const delta = newSize - node.size;
    if (delta > 0 && this.bytes + delta > this.limits.maxTotalBytes) {
      this.denyQuota(path, `total size limit reached (${this.limits.maxTotalBytes} bytes)`);
    }
    this.bytes += delta;
  }

  /** Drop accounting once nothing references the inode: no directory entry and
   *  no open descriptor. An unlinked-but-open file still costs memory. */
  private release(node: Inode): void {
    if (node.nlink > 0 || node.openCount > 0) return;
    this.nodes--;
    if (node.kind === "file") {
      this.files--;
      this.bytes -= node.size;
      node.data = EMPTY;
      node.size = 0;
    }
  }

  private unlinkEntry(dir: Inode, name: string, node: Inode): void {
    dir.entries!.delete(name);
    dir.mtimeMs = this.clock();
    node.nlink--;
    this.release(node);
  }

  // -- file bytes ---------------------------------------------------------

  private bytesOf(node: Inode): Uint8Array {
    return node.data.subarray(0, node.size);
  }

  /** Give the inode a private buffer with room for `needed` bytes. Slack is
   *  doubled so a bufio-driven append does not reallocate every 4 KiB. */
  private ensureCapacity(node: Inode, needed: number): void {
    if (!node.shared && node.data.length >= needed) return;
    const cap = Math.max(needed, node.data.length * 2, 64);
    const next = new Uint8Array(cap);
    next.set(node.data.subarray(0, node.size));
    node.data = next;
    node.shared = false;
  }

  private setSize(node: Inode, size: number, path: string): void {
    this.reserveBytes(node, size, path);
    if (size > node.size) {
      this.ensureCapacity(node, size);
      node.data.fill(0, node.size, size);
    } else if (node.shared) {
      // Shrinking a shared buffer would leave the snapshot holding a longer
      // view of a buffer we are about to write into; unshare now.
      this.ensureCapacity(node, node.size);
    }
    node.size = size;
    node.mtimeMs = this.clock();
    node.ctimeMs = node.mtimeMs;
  }

  private writeInto(node: Inode, offset: number, chunk: Uint8Array, path: string): number {
    const end = offset + chunk.length;
    if (end > node.size) {
      this.reserveBytes(node, end, path);
      this.ensureCapacity(node, end);
      if (offset > node.size) node.data.fill(0, node.size, offset);
      node.size = end;
    } else {
      this.ensureCapacity(node, node.size);
    }
    node.data.set(chunk, offset);
    const now = this.clock();
    node.mtimeMs = now;
    node.ctimeMs = now;
    return chunk.length;
  }

  // -- stats --------------------------------------------------------------

  private statsOf(node: Inode): Stats {
    const ifmt = node.kind === "dir" ? S_IFDIR : node.kind === "link" ? S_IFLNK : S_IFREG;
    const size = node.kind === "dir" ? 4096 : node.kind === "link" ? node.target.length : node.size;
    const isDir = node.kind === "dir";
    const isFile = node.kind === "file";
    const isLink = node.kind === "link";
    return {
      dev: 1,
      ino: node.ino,
      mode: (node.mode & 0o7777) | ifmt,
      nlink: node.nlink,
      uid: node.uid,
      gid: node.gid,
      rdev: 0,
      size,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
      atimeMs: Math.floor(node.atimeMs),
      mtimeMs: Math.floor(node.mtimeMs),
      ctimeMs: Math.floor(node.ctimeMs),
      isDirectory: () => isDir,
      isFile: () => isFile,
      isSymbolicLink: () => isLink,
    };
  }

  private stdioStats(): Stats {
    const now = Math.floor(this.clock());
    return {
      dev: 1,
      ino: 0,
      mode: S_IFCHR | 0o620,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size: 0,
      blksize: 4096,
      blocks: 0,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
    };
  }

  // -- descriptors --------------------------------------------------------

  private lookupFd(fd: number): OpenFile {
    const f = this.fds.get(fd);
    if (f === undefined) fail("EBADF", `fd ${fd}`);
    return f;
  }

  // =========================================================================
  // syscall surface
  // =========================================================================

  open(path: unknown, flags: number, mode: number): number {
    const wantsWrite = (flags & O_ACCMODE) !== O_RDONLY || (flags & (O_CREAT | O_TRUNC)) !== 0;
    const abs = this.resolvePath(path, wantsWrite ? "write" : "read");

    let node: Inode | null = null;
    try {
      node = this.lookup(abs, true);
    } catch (e) {
      if (!(e instanceof FsError) || e.code !== "ENOENT") throw e;
      // Fall through to the O_CREAT branch.
    }

    if (node !== null && (flags & O_CREAT) !== 0 && (flags & O_EXCL) !== 0) fail("EEXIST", abs);

    if (node === null) {
      if ((flags & O_CREAT) === 0) fail("ENOENT", abs);
      const { dir, name } = this.lookupParent(abs);
      this.reserveNode(abs);
      node = new Inode("file", this.nextIno++, mode & 0o7777, this.clock());
      this.files++;
      dir.entries!.set(name, node);
      dir.mtimeMs = this.clock();
      this.touched(abs);
    }

    const acc = flags & O_ACCMODE;
    if (node.kind === "dir") {
      if (acc !== O_RDONLY) fail("EISDIR", abs);
    } else if ((flags & O_DIRECTORY) !== 0) {
      fail("ENOTDIR", abs);
    }
    if ((flags & O_TRUNC) !== 0 && node.kind === "file" && acc !== O_RDONLY && node.size !== 0) {
      this.setSize(node, 0, abs);
      this.touched(abs);
    }

    if (this.fds.size >= MAX_OPEN_FILES) fail("EMFILE", abs);
    const fd = this.nextFd++;
    node.openCount++;
    node.atimeMs = this.clock();
    this.fds.set(fd, { node, path: abs, flags, pos: 0 });
    return fd;
  }

  close(fd: number): void {
    if (fd === FD_STDIN || fd === FD_STDOUT || fd === FD_STDERR) return;
    const f = this.lookupFd(fd);
    this.fds.delete(fd);
    f.node.openCount--;
    this.release(f.node);
  }

  fstat(fd: number): Stats {
    if (fd === FD_STDIN || fd === FD_STDOUT || fd === FD_STDERR) return this.stdioStats();
    return this.statsOf(this.lookupFd(fd).node);
  }

  stat(path: unknown): Stats {
    return this.statsOf(this.lookup(this.resolvePath(path, "read"), true));
  }

  lstat(path: unknown): Stats {
    return this.statsOf(this.lookup(this.resolvePath(path, "read"), false));
  }

  /** Go reads this as a flat array of name strings, not Dirent objects, and
   *  snapshots it at open() time. */
  readdir(path: unknown): string[] {
    const abs = this.resolvePath(path, "read");
    const node = this.lookup(abs, true);
    if (node.entries === null) fail("ENOTDIR", abs);
    return Array.from(node.entries.keys());
  }

  mkdir(path: unknown, mode: number): void {
    const abs = this.resolvePath(path, "write");
    const { dir, name } = this.lookupParent(abs);
    if (dir.entries!.has(name)) fail("EEXIST", abs);
    this.reserveNode(abs);
    dir.entries!.set(name, new Inode("dir", this.nextIno++, mode & 0o7777, this.clock()));
    dir.mtimeMs = this.clock();
    this.touched(abs);
  }

  rmdir(path: unknown): void {
    const abs = this.resolvePath(path, "write");
    if (this.isRoot(abs)) fail("EBUSY", abs, "a sandbox root cannot be removed");
    const { dir, name } = this.lookupParent(abs);
    const node = dir.entries!.get(name);
    if (node === undefined) fail("ENOENT", abs);
    if (node.kind !== "dir") fail("ENOTDIR", abs);
    if (node.entries!.size > 0) fail("ENOTEMPTY", abs);
    this.unlinkEntry(dir, name, node);
    this.touched(abs);
  }

  unlink(path: unknown): void {
    const abs = this.resolvePath(path, "write");
    if (this.isRoot(abs)) fail("EBUSY", abs, "a sandbox root cannot be removed");
    const { dir, name } = this.lookupParent(abs);
    const node = dir.entries!.get(name);
    if (node === undefined) fail("ENOENT", abs);
    // os.Remove tries unlink first and falls back to rmdir, so a directory has
    // to fail here without being destroyed.
    if (node.kind === "dir") fail("EPERM", abs, "is a directory");
    this.unlinkEntry(dir, name, node);
    this.touched(abs);
  }

  rename(from: unknown, to: unknown): void {
    const src = this.resolvePath(from, "write");
    const dst = this.resolvePath(to, "write");
    if (src === dst) return;
    if (this.isRoot(src) || this.isRoot(dst)) fail("EBUSY", src, "a sandbox root cannot be renamed");
    if (dst.startsWith(src + "/")) fail("EINVAL", src, "cannot rename a directory into itself");

    const s = this.lookupParent(src);
    const node = s.dir.entries!.get(s.name);
    if (node === undefined) fail("ENOENT", src);

    const d = this.lookupParent(dst);
    const existing = d.dir.entries!.get(d.name);
    if (existing !== undefined) {
      if (existing === node) return;
      if (node.kind === "dir" && existing.kind !== "dir") fail("ENOTDIR", dst);
      if (node.kind !== "dir" && existing.kind === "dir") fail("EISDIR", dst);
      if (existing.kind === "dir" && existing.entries!.size > 0) fail("ENOTEMPTY", dst);
      this.unlinkEntry(d.dir, d.name, existing);
    }

    s.dir.entries!.delete(s.name);
    d.dir.entries!.set(d.name, node);
    const now = this.clock();
    s.dir.mtimeMs = now;
    d.dir.mtimeMs = now;
    node.ctimeMs = now;
    this.touched(src);
    this.touched(dst);
  }

  truncate(path: unknown, length: number): void {
    const abs = this.resolvePath(path, "write");
    const node = this.lookup(abs, true);
    if (node.kind === "dir") fail("EISDIR", abs);
    if (length < 0) fail("EINVAL", abs);
    this.setSize(node, length, abs);
    this.touched(abs);
  }

  ftruncate(fd: number, length: number): void {
    const f = this.lookupFd(fd);
    if (f.node.kind === "dir") fail("EISDIR", f.path);
    if (length < 0) fail("EINVAL", f.path);
    this.setSize(f.node, length, f.path);
    this.touched(f.path);
  }

  chmod(path: unknown, mode: number): void {
    const abs = this.resolvePath(path, "write");
    const node = this.lookup(abs, true);
    node.mode = mode & 0o7777;
    node.ctimeMs = this.clock();
    this.touched(abs);
  }

  fchmod(fd: number, mode: number): void {
    const f = this.lookupFd(fd);
    f.node.mode = mode & 0o7777;
    f.node.ctimeMs = this.clock();
    this.touched(f.path);
  }

  chown(path: unknown, uid: number, gid: number): void {
    const abs = this.resolvePath(path, "write");
    this.applyOwner(this.lookup(abs, true), uid, gid);
    this.touched(abs);
  }

  fchown(fd: number, uid: number, gid: number): void {
    const f = this.lookupFd(fd);
    this.applyOwner(f.node, uid, gid);
    this.touched(f.path);
  }

  lchown(path: unknown, uid: number, gid: number): void {
    const abs = this.resolvePath(path, "write");
    this.applyOwner(this.lookup(abs, false), uid, gid);
    this.touched(abs);
  }

  private applyOwner(node: Inode, uid: number, gid: number): void {
    // -1 means "leave alone", as in POSIX chown(2).
    if (uid >= 0 && uid !== 0xffffffff) node.uid = uid;
    if (gid >= 0 && gid !== 0xffffffff) node.gid = gid;
    node.ctimeMs = this.clock();
  }

  /** Go passes whole seconds (Timespec.Sec), already resolved for UTIME_OMIT. */
  utimes(path: unknown, atimeSec: number, mtimeSec: number): void {
    const abs = this.resolvePath(path, "write");
    const node = this.lookup(abs, true);
    node.atimeMs = atimeSec * 1000;
    node.mtimeMs = mtimeSec * 1000;
    node.ctimeMs = this.clock();
    this.touched(abs);
  }

  readlink(path: unknown): string {
    const abs = this.resolvePath(path, "read");
    const node = this.lookup(abs, false);
    if (node.kind !== "link") fail("EINVAL", abs, "not a symlink");
    return node.target;
  }

  link(existing: unknown, newPath: unknown): void {
    const src = this.resolvePath(existing, "read");
    const dst = this.resolvePath(newPath, "write");
    const node = this.lookup(src, true);
    if (node.kind === "dir") fail("EPERM", src, "hard link to a directory");
    const { dir, name } = this.lookupParent(dst);
    if (dir.entries!.has(name)) fail("EEXIST", dst);
    node.nlink++;
    node.ctimeMs = this.clock();
    dir.entries!.set(name, node);
    dir.mtimeMs = this.clock();
    this.touched(dst);
  }

  /**
   * Third layer of the jail. A symlink is the one construct that could make a
   * lexically clean path resolve outside the sandbox, so creation is refused
   * outright rather than validated.
   */
  symlink(_target: unknown, linkPath: unknown): void {
    const abs = this.resolvePath(linkPath, "write");
    fail("EPERM", abs, "symlinks are not supported in the sandbox");
  }

  fsync(_fd: number): void {
    // Everything is already in memory; there is nothing to flush.
  }

  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number {
    if (fd === FD_STDIN) return this.readStdin(buffer, offset, length);
    if (fd === FD_STDOUT || fd === FD_STDERR) fail("EBADF", `fd ${fd}`);
    const f = this.lookupFd(fd);
    if ((f.flags & O_ACCMODE) === O_WRONLY) fail("EBADF", f.path, "opened write-only");
    if (f.node.kind === "dir") fail("EISDIR", f.path);
    const pos = position === null || position === undefined ? f.pos : position;
    if (pos < 0) fail("EINVAL", f.path);
    const n = Math.max(0, Math.min(length, f.node.size - pos));
    if (n > 0) buffer.set(this.bytesOf(f.node).subarray(pos, pos + n), offset);
    if (position === null || position === undefined) f.pos = pos + n;
    f.node.atimeMs = this.clock();
    return n;
  }

  write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number {
    const chunk = buffer.subarray(offset, offset + length);
    if (fd === FD_STDOUT || fd === FD_STDERR) return this.writeStdio(fd, chunk);
    if (fd === FD_STDIN) fail("EBADF", "fd 0");
    const f = this.lookupFd(fd);
    if ((f.flags & O_ACCMODE) === O_RDONLY) fail("EBADF", f.path, "opened read-only");
    if (f.node.kind === "dir") fail("EISDIR", f.path);

    let pos: number;
    const useCursor = position === null || position === undefined;
    if ((f.flags & O_APPEND) !== 0) {
      pos = f.node.size;
    } else if (useCursor) {
      pos = f.pos;
    } else {
      pos = position;
    }
    if (pos < 0) fail("EINVAL", f.path);

    const n = this.writeInto(f.node, pos, chunk, f.path);
    if (useCursor || (f.flags & O_APPEND) !== 0) f.pos = pos + n;
    this.touched(f.path);
    return n;
  }

  /**
   * Never throws. `runtime.wasmWrite` calls this from Go's panic and throw
   * paths, where an exception would replace the diagnostic with a JS stack
   * trace pointing at the shim.
   */
  writeSync(fd: number, buffer: Uint8Array): number {
    try {
      if (fd === FD_STDOUT || fd === FD_STDERR) return this.writeStdio(fd, buffer);
      const f = this.fds.get(fd);
      if (f === undefined || f.node.kind !== "file") return buffer.length;
      const pos = (f.flags & O_APPEND) !== 0 ? f.node.size : f.pos;
      this.writeInto(f.node, pos, buffer, f.path);
      f.pos = pos + buffer.length;
      this.touched(f.path);
      return buffer.length;
    } catch {
      // Report a full write; a short count would make Go retry forever.
      return buffer.length;
    }
  }

  // -- stdio --------------------------------------------------------------

  private writeStdio(fd: number, chunk: Uint8Array): number {
    // stream:true so a multi-byte rune split across two writes is not mangled.
    if (fd === FD_STDOUT) {
      this.stdoutSink(this.outDecoder.decode(chunk, { stream: true }));
    } else {
      this.stderrSink(this.errDecoder.decode(chunk, { stream: true }));
    }
    return chunk.length;
  }

  setStdout(sink: OutputSink): void {
    this.stdoutSink = sink;
  }

  setStderr(sink: OutputSink): void {
    this.stderrSink = sink;
  }

  /**
   * Queue bytes for fd 0. Interactive stdin belongs on the host boundary
   * (Contract B `pushStdin`); this exists so that anything reading os.Stdin
   * directly sees a well-defined stream instead of EBADF.
   */
  pushStdin(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const merged = new Uint8Array(this.stdinQueue.length + bytes.length);
    merged.set(this.stdinQueue);
    merged.set(bytes, this.stdinQueue.length);
    this.stdinQueue = merged;
  }

  closeStdin(): void {
    this.stdinClosed = true;
  }

  resetStdin(): void {
    this.stdinQueue = EMPTY;
    this.stdinClosed = false;
  }

  private readStdin(buffer: Uint8Array, offset: number, length: number): number {
    const n = Math.min(length, this.stdinQueue.length);
    if (n === 0) {
      // Nothing queued. There is no way to block a wasm thread here, so an
      // empty queue reads as EOF whether or not the host called closeStdin.
      return 0;
    }
    buffer.set(this.stdinQueue.subarray(0, n), offset);
    this.stdinQueue = this.stdinQueue.subarray(n);
    if (this.stdinQueue.length === 0 && this.stdinClosed) this.stdinQueue = EMPTY;
    return n;
  }

  // =========================================================================
  // host surface (not reachable from Go)
  // =========================================================================

  cwd(): string {
    return this.cwdPath;
  }

  chdir(path: unknown): void {
    const abs = this.resolvePath(path, "read");
    if (!this.insideRoot(abs)) fail("EACCES", abs);
    const node = this.lookup(abs, true);
    if (node.kind !== "dir") fail("ENOTDIR", abs);
    this.cwdPath = abs;
  }

  /** `path.resolve` for the shim. Never jails: Go calls it on paths that have
   *  already been accepted by open(). */
  resolve(...segments: unknown[]): string {
    let acc = "";
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = typeof segments[i] === "string" ? (segments[i] as string) : String(segments[i]);
      if (seg === "") continue;
      acc = acc === "" ? seg : seg + "/" + acc;
      if (seg.charCodeAt(0) === 47) break;
    }
    if (acc.charCodeAt(0) !== 47) acc = this.cwdPath + "/" + acc;
    return normalizePath(acc);
  }

  /** Monotone counter over every mutation anywhere in the filesystem. */
  revision(): number {
    return this.rev;
  }

  /** Monotone counter over mutations outside the temp subtree. This is the one
   *  the UI wants: /tmp churn between commands is not a workspace change. */
  workspaceRevision(): number {
    return this.wsRev;
  }

  usage(): Usage {
    return {
      bytes: this.bytes,
      files: this.files,
      nodes: this.nodes,
      denials: this.denials,
      limits: { ...this.limits },
    };
  }

  /** Replace the temp subtree with an empty directory. Descriptors already open
   *  on temp files keep working against detached inodes, which is what POSIX
   *  unlink-while-open does too. */
  clearTemp(): void {
    const abs = this.tempRoot;
    let dir: Inode;
    try {
      dir = this.lookup(abs, true);
    } catch {
      this.seedDir(abs);
      return;
    }
    if (dir.entries === null) return;
    for (const [name, child] of Array.from(dir.entries)) {
      this.detach(dir, name, child);
    }
    dir.mtimeMs = this.clock();
    this.rev++;
  }

  private detach(dir: Inode, name: string, node: Inode): void {
    if (node.kind === "dir" && node.entries !== null) {
      for (const [childName, child] of Array.from(node.entries)) {
        this.detach(node, childName, child);
      }
    }
    this.unlinkEntry(dir, name, node);
  }

  // -- snapshot / restore -------------------------------------------------

  /**
   * A consistent, deep copy of the whole tree. O(inodes), not O(bytes): file
   * buffers are shared with the live filesystem under copy-on-write, so the
   * snapshot can never observe a later write.
   */
  snapshot(): WorkspaceSnapshot {
    const seen = new Map<Inode, number>();
    return {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      root: this.snapshotDir(this.root, seen),
      cwd: this.cwdPath,
      revision: this.rev,
      bytes: this.bytes,
      files: this.files,
    };
  }

  private snapshotDir(node: Inode, seen: Map<Inode, number>): SnapshotDir {
    seen.set(node, node.ino);
    const entries: Array<[string, SnapshotEntry]> = [];
    if (node.entries !== null) {
      for (const [name, child] of node.entries) {
        entries.push([name, this.snapshotEntry(child, seen)]);
      }
    }
    return {
      kind: "dir",
      ino: node.ino,
      mode: node.mode,
      mtimeMs: node.mtimeMs,
      atimeMs: node.atimeMs,
      ctimeMs: node.ctimeMs,
      entries,
    };
  }

  private snapshotEntry(node: Inode, seen: Map<Inode, number>): SnapshotEntry {
    if (seen.has(node)) return { kind: "ref", ino: node.ino };
    if (node.kind === "dir") return this.snapshotDir(node, seen);
    seen.set(node, node.ino);
    if (node.kind === "link") {
      return {
        kind: "link",
        ino: node.ino,
        mode: node.mode,
        mtimeMs: node.mtimeMs,
        atimeMs: node.atimeMs,
        ctimeMs: node.ctimeMs,
        target: node.target,
      };
    }
    node.shared = true;
    return {
      kind: "file",
      ino: node.ino,
      mode: node.mode,
      mtimeMs: node.mtimeMs,
      atimeMs: node.atimeMs,
      ctimeMs: node.ctimeMs,
      data: this.bytesOf(node),
    };
  }

  /**
   * Replace the entire tree with a snapshot. Every open descriptor is closed:
   * a restore is a rollback of the world, and letting a stale fd write into the
   * restored tree would silently corrupt it.
   */
  restore(snap: WorkspaceSnapshot): void {
    if (snap.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
      throw new Error(
        `memfs: unsupported snapshot format ${snap.formatVersion}, expected ${SNAPSHOT_FORMAT_VERSION}`,
      );
    }
    for (const f of this.fds.values()) {
      f.node.openCount--;
    }
    this.fds.clear();

    const byIno = new Map<number, Inode>();
    let maxIno = 0;
    const rebuild = (entry: SnapshotEntry): Inode => {
      if (entry.kind === "ref") {
        const existing = byIno.get(entry.ino);
        if (existing === undefined) throw new Error(`memfs: dangling snapshot ref ${entry.ino}`);
        // Only files and links can be referenced twice. Allowing a directory
        // ref would let a crafted snapshot build a cyclic tree, and every
        // recursive walk below would then not terminate.
        if (existing.kind === "dir") {
          throw new Error(`memfs: snapshot ref ${entry.ino} points at a directory`);
        }
        existing.nlink++;
        return existing;
      }
      if (entry.ino > maxIno) maxIno = entry.ino;
      const kind: InodeKind = entry.kind;
      const node = new Inode(kind, entry.ino, entry.mode, entry.mtimeMs);
      node.atimeMs = entry.atimeMs;
      node.ctimeMs = entry.ctimeMs;
      byIno.set(entry.ino, node);
      if (entry.kind === "file") {
        // Both sides now reference one buffer; the CoW flag keeps them honest.
        node.data = entry.data;
        node.size = entry.data.length;
        node.shared = true;
      } else if (entry.kind === "link") {
        node.target = entry.target;
      } else {
        for (const [name, child] of entry.entries) {
          node.entries!.set(name, rebuild(child));
        }
      }
      return node;
    };

    this.root = rebuild(snap.root);
    this.nextIno = Math.max(this.nextIno, maxIno + 1);
    this.recount();

    // Roots may be missing if the snapshot predates a configuration change.
    for (const r of this.roots) this.seedDir(r);

    const cwd = normalizePath(snap.cwd);
    this.cwdPath = this.insideRoot(cwd) && this.dirExists(cwd) ? cwd : this.roots[0];
    this.rev++;
    this.wsRev++;
  }

  private dirExists(abs: string): boolean {
    try {
      return this.lookup(abs, true).kind === "dir";
    } catch {
      return false;
    }
  }

  /** Recompute the quota counters from the tree. Cheaper than trusting a
   *  snapshot's stored totals, and it is the only place they can drift. */
  private recount(): void {
    let bytes = 0;
    let files = 0;
    let nodes = 0;
    const counted = new Set<Inode>();
    const walk = (node: Inode): void => {
      if (node.entries === null) return;
      for (const child of node.entries.values()) {
        if (!counted.has(child)) {
          counted.add(child);
          nodes++;
          if (child.kind === "file") {
            files++;
            bytes += child.size;
          }
        }
        walk(child);
      }
    };
    walk(this.root);
    this.bytes = bytes;
    this.files = files;
    this.nodes = nodes;
  }

  // -- direct host access -------------------------------------------------

  /** Create a directory and every missing parent. Host-side helper; still
   *  jailed and still quota-checked. */
  mkdirp(path: unknown, mode = 0o755): void {
    const abs = this.resolvePath(path, "write");
    const parts = splitPath(abs);
    let node = this.root;
    let cur = "";
    for (const part of parts) {
      cur += "/" + part;
      const entries = node.entries;
      if (entries === null) fail("ENOTDIR", cur);
      let child = entries.get(part);
      if (child === undefined) {
        this.reserveNode(cur);
        child = new Inode("dir", this.nextIno++, mode, this.clock());
        entries.set(part, child);
        node.mtimeMs = this.clock();
        this.touched(cur);
      } else if (child.kind !== "dir") {
        fail("ENOTDIR", cur);
      }
      node = child;
    }
  }

  /** Whole-file write from the host. Creates parents. */
  writeFile(path: unknown, data: string | Uint8Array, mode = 0o644): void {
    const abs = this.resolvePath(path, "write");
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const parent = parentPath(abs);
    if (parent !== "/") this.mkdirp(parent);
    const { dir, name } = this.lookupParent(abs);
    let node = dir.entries!.get(name);
    if (node === undefined) {
      this.reserveNode(abs);
      node = new Inode("file", this.nextIno++, mode, this.clock());
      this.files++;
      dir.entries!.set(name, node);
      dir.mtimeMs = this.clock();
    } else if (node.kind !== "file") {
      fail("EISDIR", abs);
    }
    this.setSize(node, 0, abs);
    this.writeInto(node, 0, bytes, abs);
    this.touched(abs);
  }

  /** Whole-file read. Returns a private copy; the caller may keep or mutate it
   *  without touching the filesystem. */
  readFile(path: unknown): Uint8Array {
    const abs = this.resolvePath(path, "read");
    const node = this.lookup(abs, true);
    if (node.kind === "dir") fail("EISDIR", abs);
    return new Uint8Array(this.bytesOf(node));
  }

  exists(path: unknown): boolean {
    try {
      this.lookup(this.resolvePath(path, "read"), false);
      return true;
    } catch {
      return false;
    }
  }

  /** Recursive remove, like `rm -rf`. Missing paths are not an error. */
  removeAll(path: unknown): void {
    const abs = this.resolvePath(path, "write");
    if (this.isRoot(abs)) fail("EBUSY", abs, "a sandbox root cannot be removed");
    let parent: { dir: Inode; name: string };
    try {
      parent = this.lookupParent(abs);
    } catch (e) {
      if (e instanceof FsError && (e.code === "ENOENT" || e.code === "ENOTDIR")) return;
      throw e;
    }
    const node = parent.dir.entries!.get(parent.name);
    if (node === undefined) return;
    this.detach(parent.dir, parent.name, node);
    this.touched(abs);
  }

  /** Directory listing with metadata, for the file pane. */
  listDir(path: unknown): Array<{ name: string; size: number; isDir: boolean; mtime: number }> {
    const abs = this.resolvePath(path, "read");
    const node = this.lookup(abs, true);
    if (node.entries === null) fail("ENOTDIR", abs);
    const out: Array<{ name: string; size: number; isDir: boolean; mtime: number }> = [];
    for (const [name, child] of node.entries) {
      out.push({
        name,
        size: child.kind === "file" ? child.size : 0,
        isDir: child.kind === "dir",
        mtime: Math.floor(child.mtimeMs),
      });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Every regular file under `path`, depth first, as absolute paths. */
  walkFiles(path: unknown): string[] {
    const abs = this.resolvePath(path, "read");
    const out: string[] = [];
    const walk = (node: Inode, prefix: string): void => {
      if (node.entries === null) return;
      const names = Array.from(node.entries.keys()).sort();
      for (const name of names) {
        const child = node.entries.get(name)!;
        const childPath = prefix === "/" ? "/" + name : prefix + "/" + name;
        if (child.kind === "dir") walk(child, childPath);
        else out.push(childPath);
      }
    };
    walk(this.lookup(abs, true), abs);
    return out;
  }
}

function consoleSink(method: "log" | "error"): OutputSink {
  let buffered = "";
  return (chunk: string) => {
    buffered += chunk;
    const nl = buffered.lastIndexOf("\n");
    if (nl === -1) return;
    console[method](buffered.slice(0, nl));
    buffered = buffered.slice(nl + 1);
  };
}

// ---------------------------------------------------------------------------
// the globalThis.fs facade
// ---------------------------------------------------------------------------

/** `cb(null, value)` on success, `cb(err)` on failure. Go reads args[0] for the
 *  error and args[1] for the value. */
export type FsCallback = (err: FsError | null, value?: unknown) => void;

export interface FsShim {
  constants: typeof FS_CONSTANTS;
  writeSync(fd: number, buf: Uint8Array): number;
  write(
    fd: number,
    buf: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
    cb: FsCallback,
  ): void;
  read(
    fd: number,
    buf: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
    cb: FsCallback,
  ): void;
  open(path: string, flags: number, mode: number, cb: FsCallback): void;
  close(fd: number, cb: FsCallback): void;
  fstat(fd: number, cb: FsCallback): void;
  stat(path: string, cb: FsCallback): void;
  lstat(path: string, cb: FsCallback): void;
  readdir(path: string, cb: FsCallback): void;
  mkdir(path: string, perm: number, cb: FsCallback): void;
  rmdir(path: string, cb: FsCallback): void;
  unlink(path: string, cb: FsCallback): void;
  rename(from: string, to: string, cb: FsCallback): void;
  truncate(path: string, length: number, cb: FsCallback): void;
  ftruncate(fd: number, length: number, cb: FsCallback): void;
  chmod(path: string, mode: number, cb: FsCallback): void;
  fchmod(fd: number, mode: number, cb: FsCallback): void;
  chown(path: string, uid: number, gid: number, cb: FsCallback): void;
  fchown(fd: number, uid: number, gid: number, cb: FsCallback): void;
  lchown(path: string, uid: number, gid: number, cb: FsCallback): void;
  utimes(path: string, atime: number, mtime: number, cb: FsCallback): void;
  readlink(path: string, cb: FsCallback): void;
  link(path: string, link: string, cb: FsCallback): void;
  symlink(path: string, link: string, cb: FsCallback): void;
  fsync(fd: number, cb: FsCallback): void;
}

/** Normalize anything thrown inside the shim into an errno Go can map. An
 *  unmapped code makes `mapJSError` panic, so this must never let one out. */
function toFsError(e: unknown): FsError {
  if (e instanceof FsError) return e;
  const err = new FsError("EIO", undefined, e instanceof Error ? e.message : String(e));
  if (e instanceof Error && e.stack !== undefined) err.stack = e.stack;
  return err;
}

export function createFsShim(m: MemFS): FsShim {
  const call = (cb: FsCallback, fn: () => unknown): void => {
    let value: unknown;
    try {
      value = fn();
    } catch (e) {
      cb(toFsError(e));
      return;
    }
    cb(null, value);
  };

  return {
    constants: FS_CONSTANTS,

    writeSync(fd, buf) {
      return m.writeSync(fd, buf);
    },
    write(fd, buf, offset, length, position, cb) {
      call(cb, () => m.write(fd, buf, offset, length, position));
    },
    read(fd, buf, offset, length, position, cb) {
      call(cb, () => m.read(fd, buf, offset, length, position));
    },
    open(path, flags, mode, cb) {
      call(cb, () => m.open(path, flags, mode));
    },
    close(fd, cb) {
      call(cb, () => m.close(fd));
    },
    fstat(fd, cb) {
      call(cb, () => m.fstat(fd));
    },
    stat(path, cb) {
      call(cb, () => m.stat(path));
    },
    lstat(path, cb) {
      call(cb, () => m.lstat(path));
    },
    readdir(path, cb) {
      call(cb, () => m.readdir(path));
    },
    mkdir(path, perm, cb) {
      call(cb, () => m.mkdir(path, perm));
    },
    rmdir(path, cb) {
      call(cb, () => m.rmdir(path));
    },
    unlink(path, cb) {
      call(cb, () => m.unlink(path));
    },
    rename(from, to, cb) {
      call(cb, () => m.rename(from, to));
    },
    truncate(path, length, cb) {
      call(cb, () => m.truncate(path, length));
    },
    ftruncate(fd, length, cb) {
      call(cb, () => m.ftruncate(fd, length));
    },
    chmod(path, mode, cb) {
      call(cb, () => m.chmod(path, mode));
    },
    fchmod(fd, mode, cb) {
      call(cb, () => m.fchmod(fd, mode));
    },
    chown(path, uid, gid, cb) {
      call(cb, () => m.chown(path, uid, gid));
    },
    fchown(fd, uid, gid, cb) {
      call(cb, () => m.fchown(fd, uid, gid));
    },
    lchown(path, uid, gid, cb) {
      call(cb, () => m.lchown(path, uid, gid));
    },
    utimes(path, atime, mtime, cb) {
      call(cb, () => m.utimes(path, atime, mtime));
    },
    readlink(path, cb) {
      call(cb, () => m.readlink(path));
    },
    link(path, link, cb) {
      call(cb, () => m.link(path, link));
    },
    symlink(path, link, cb) {
      call(cb, () => m.symlink(path, link));
    },
    fsync(fd, cb) {
      call(cb, () => m.fsync(fd));
    },
  };
}
