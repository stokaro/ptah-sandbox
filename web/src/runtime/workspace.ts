/**
 * The workspace API the rest of the app talks to.
 *
 * Deliberately separate from the syscall surface in `memfs.ts`: the UI, the
 * checkpoint layer and the import/export paths should never have to think about
 * file descriptors, open flags or errno. Everything here works in whole files.
 */

import { MemFS, normalizePath } from "./memfs.ts";
import type { WorkspaceSnapshot } from "./memfs.ts";

export interface FileEntry {
  name: string;
  size: number;
  isDir: boolean;
  /** Milliseconds since the epoch, matching `Date` rather than `time.Time`. */
  mtime: number;
}

export interface Workspace {
  writeFile(path: string, data: string | Uint8Array): void;
  readFile(path: string): Uint8Array;
  readText(path: string): string;
  list(dir: string): FileEntry[];
  remove(path: string): void;
  snapshot(): WorkspaceSnapshot;
  restore(s: WorkspaceSnapshot): void;
  revision(): number;
  clearTemp(): void;
  usage(): { bytes: number; files: number };
}

export class MemWorkspace implements Workspace {
  readonly fs: MemFS;
  /** Root that bare relative paths are resolved against. */
  readonly root: string;

  private readonly decoder: TextDecoder;

  constructor(fs: MemFS, root = "/workspace") {
    this.fs = fs;
    this.root = normalizePath(root);
    this.decoder = new TextDecoder("utf-8", { fatal: false });
  }

  /**
   * Relative paths resolve against the workspace root, not the process cwd.
   * A command may have chdir'd anywhere; the host's view of "schema.sql" must
   * not depend on that.
   */
  private at(path: string): string {
    if (path === "") throw new Error("workspace: empty path");
    return path.charCodeAt(0) === 47 ? normalizePath(path) : normalizePath(this.root + "/" + path);
  }

  writeFile(path: string, data: string | Uint8Array): void {
    this.fs.writeFile(this.at(path), data);
  }

  /** Returns a private copy; mutating it does not touch the filesystem. */
  readFile(path: string): Uint8Array {
    return this.fs.readFile(this.at(path));
  }

  readText(path: string): string {
    return this.decoder.decode(this.readFile(path));
  }

  list(dir: string): FileEntry[] {
    return this.fs.listDir(this.at(dir));
  }

  /** Recursive, and silent about a path that is already gone. */
  remove(path: string): void {
    this.fs.removeAll(this.at(path));
  }

  exists(path: string): boolean {
    return this.fs.exists(this.at(path));
  }

  mkdir(path: string): void {
    this.fs.mkdirp(this.at(path));
  }

  /** Every regular file under `dir`, depth first, as absolute paths. */
  walk(dir = this.root): string[] {
    return this.fs.walkFiles(this.at(dir));
  }

  /**
   * A consistent point-in-time copy of the whole filesystem. Cheap: file bytes
   * are shared under copy-on-write, so nothing here aliases a buffer the
   * running program can still write to.
   */
  snapshot(): WorkspaceSnapshot {
    return this.fs.snapshot();
  }

  /** Rolls the filesystem back. Every open descriptor is closed, so this must
   *  not run while a command is mid-flight. */
  restore(s: WorkspaceSnapshot): void {
    this.fs.restore(s);
  }

  /**
   * Bumps on every mutation of a persistent subtree. Temp-directory churn is
   * excluded on purpose: `/tmp` is scratch space for one command, and counting
   * it would make the UI report a changed workspace after a read-only run.
   */
  revision(): number {
    return this.fs.workspaceRevision();
  }

  clearTemp(): void {
    this.fs.clearTemp();
  }

  usage(): { bytes: number; files: number } {
    const u = this.fs.usage();
    return { bytes: u.bytes, files: u.files };
  }

  /** How many operations the quota has refused. Surfaced so the UI can say
   *  "the workspace is full" instead of leaving an ENOSPC unexplained. */
  quotaDenials(): number {
    return this.fs.usage().denials;
  }
}
