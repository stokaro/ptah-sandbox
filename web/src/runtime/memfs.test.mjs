/**
 * Contract tests for the in-memory filesystem.
 *
 * Two halves:
 *
 *   1. JS-level unit tests for the parts Go cannot observe (snapshot aliasing,
 *      the quota counters, the workspace API, the revision semantics).
 *   2. A real Go program, compiled with GOOS=js GOARCH=wasm by the toolchain on
 *      PATH and run under this shim with node's fs, process and path shadowed.
 *      That half is the actual contract test: `syscall/fs_js.go` is internal to
 *      the Go toolchain and carries no compatibility promise, so this must be
 *      re-run on every Go upgrade.
 *
 * node's own `fs` module is used here to read the compiled .wasm (the browser
 * equivalent is fetch) and to write the Go sources; the shim itself must not
 * reference it, and one of the tests below enforces that.
 *
 * Run:  node src/runtime/memfs.test.mjs
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { MemFS, createRuntime, normalizePath } from "./index.ts";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const log = console.log.bind(console);
const logErr = console.error.bind(console);

// ---------------------------------------------------------------------------
// a very small test runner (node:test is avoided: half of these tests replace
// globalThis.process, which the runner also uses)
// ---------------------------------------------------------------------------

const cases = [];
let failed = 0;
let passed = 0;

function test(name, fn) {
  cases.push({ name, fn });
}

async function run() {
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      log(`ok   ${c.name}`);
    } catch (e) {
      failed++;
      log(`FAIL ${c.name}`);
      logErr(indent(e instanceof Error ? (e.stack ?? e.message) : String(e)));
    }
  }
  log("");
  log(`${passed} passed, ${failed} failed`);
  return failed === 0;
}

function indent(text) {
  return text
    .split("\n")
    .map((l) => "       " + l)
    .join("\n");
}

// ---------------------------------------------------------------------------
// 1. JS-level unit tests
// ---------------------------------------------------------------------------

function freshRuntime(options = {}) {
  return createRuntime({ install: false, ...options });
}

test("shim sources never reach for node", () => {
  const files = ["memfs.ts", "process.ts", "workspace.ts", "index.ts"];
  const banned = /require\s*\(|from\s*["']node:|from\s*["']fs["']|import\s*\(\s*["']node:/;
  for (const f of files) {
    const src = nodeFs.readFileSync(nodePath.join(HERE, f), "utf8");
    assert.equal(banned.test(src), false, `${f} references a node module`);
  }
});

test("normalizePath collapses . and .. lexically", () => {
  assert.equal(normalizePath("/workspace/../etc/passwd"), "/etc/passwd");
  assert.equal(normalizePath("/workspace/./a//b/../c"), "/workspace/a/c");
  assert.equal(normalizePath("/../.."), "/");
  assert.equal(normalizePath("/workspace"), "/workspace");
});

test("the three subtrees exist and the cwd starts inside one", () => {
  const { memfs } = freshRuntime();
  assert.equal(memfs.cwd(), "/workspace");
  for (const d of ["/workspace", "/tmp", "/home/play"]) {
    assert.equal(memfs.stat(d).isDirectory(), true, d);
  }
  assert.deepEqual(memfs.readdir("/").sort(), ["home", "tmp", "workspace"]);
});

test("the jail refuses an escape with EACCES, not ENOENT", () => {
  const { memfs } = freshRuntime();
  for (const p of ["/workspace/../etc/passwd", "/etc/passwd", "../../etc", "/home"]) {
    assert.throws(
      () => memfs.open(p, 577 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o644),
      (e) => e.code === "EACCES",
      `expected EACCES for ${p}`,
    );
  }
  // The spine stays readable, or os.MkdirTemp and filepath.Walk break.
  assert.equal(memfs.stat("/home").isDirectory(), true);
  assert.equal(memfs.stat("/").isDirectory(), true);
});

test("symlink creation is refused outright", () => {
  const { memfs } = freshRuntime();
  assert.throws(
    () => memfs.symlink("/etc/passwd", "/workspace/link"),
    (e) => e.code === "EPERM",
  );
});

test("a NUL byte in a path is EINVAL", () => {
  const { memfs } = freshRuntime();
  assert.throws(
    () => memfs.stat("/workspace/a\u0000b"),
    (e) => e.code === "EINVAL",
  );
});

test("readFile returns a copy, not a view of live bytes", () => {
  const { workspace, memfs } = freshRuntime();
  workspace.writeFile("a.txt", "hello");
  const first = workspace.readFile("a.txt");
  first[0] = 0x58;
  assert.equal(workspace.readText("a.txt"), "hello");
  assert.equal(memfs.usage().bytes, 5);
});

/** Follow a "/"-separated path through a snapshot tree. */
function snapshotAt(snap, path) {
  let node = snap.root;
  for (const part of path.split("/").filter((s) => s !== "")) {
    const hit = node.entries.find(([name]) => name === part);
    assert.ok(hit, `snapshot has no ${part} in ${path}`);
    node = hit[1];
  }
  return node;
}

test("snapshot is consistent and never aliases a live buffer", () => {
  const { workspace } = freshRuntime();
  workspace.writeFile("schema.sql", "CREATE TABLE users (id INT);");
  workspace.mkdir("migrations");
  workspace.writeFile("migrations/0001.sql", "-- up");

  const snap = workspace.snapshot();
  const read = () => new TextDecoder().decode(snapshotAt(snap, "/workspace/schema.sql").data);
  const before = read();

  workspace.writeFile("schema.sql", "DROP TABLE users;");
  workspace.remove("migrations");
  workspace.writeFile("extra.sql", "SELECT 1;");

  // The snapshot's bytes did not follow the overwrite.
  assert.equal(read(), before);
  assert.equal(before, "CREATE TABLE users (id INT);");

  workspace.restore(snap);
  assert.equal(workspace.readText("schema.sql"), "CREATE TABLE users (id INT);");
  assert.equal(workspace.readText("migrations/0001.sql"), "-- up");
  assert.equal(workspace.exists("extra.sql"), false);
  assert.deepEqual(workspace.usage(), { bytes: 28 + 5, files: 2 });
});

test("restore twice from one snapshot stays clean", () => {
  const { workspace } = freshRuntime();
  workspace.writeFile("a.txt", "one");
  const snap = workspace.snapshot();
  workspace.writeFile("a.txt", "two");
  workspace.restore(snap);
  workspace.writeFile("a.txt", "three");
  workspace.restore(snap);
  assert.equal(workspace.readText("a.txt"), "one");
});

test("hard links survive a snapshot round trip as one inode", () => {
  const { memfs, workspace } = freshRuntime();
  workspace.writeFile("a.txt", "shared");
  memfs.link("/workspace/a.txt", "/workspace/b.txt");
  assert.equal(memfs.stat("/workspace/a.txt").ino, memfs.stat("/workspace/b.txt").ino);
  assert.equal(memfs.stat("/workspace/a.txt").nlink, 2);

  const snap = workspace.snapshot();
  workspace.remove("a.txt");
  workspace.remove("b.txt");
  workspace.restore(snap);

  const a = memfs.stat("/workspace/a.txt");
  const b = memfs.stat("/workspace/b.txt");
  assert.equal(a.ino, b.ino);
  assert.equal(a.nlink, 2);
  assert.equal(memfs.usage().files, 1, "a hard link is one file, not two");
});

test("the workspace revision ignores temp churn", () => {
  const { memfs, workspace } = freshRuntime();
  const r0 = workspace.revision();
  const g0 = memfs.revision();

  memfs.writeFile("/tmp/scratch.sql", "SELECT 1;");
  assert.equal(workspace.revision(), r0, "temp writes are not workspace changes");
  assert.ok(memfs.revision() > g0, "but they are filesystem changes");

  workspace.writeFile("real.sql", "SELECT 2;");
  assert.ok(workspace.revision() > r0);
});

test("clearTemp empties /tmp and leaves the workspace alone", () => {
  const { memfs, workspace } = freshRuntime();
  workspace.writeFile("keep.sql", "SELECT 1;");
  const clean = memfs.usage();

  memfs.mkdirp("/tmp/a/b");
  memfs.writeFile("/tmp/a/b/c.sql", "SELECT 2;");
  assert.equal(memfs.usage().nodes, clean.nodes + 3);
  assert.equal(memfs.usage().bytes, 18);

  memfs.clearTemp();
  assert.deepEqual(memfs.readdir("/tmp"), []);
  assert.equal(workspace.readText("keep.sql"), "SELECT 1;");
  assert.equal(memfs.usage().bytes, 9, "temp bytes were reclaimed");
  assert.equal(memfs.usage().nodes, clean.nodes, "temp inodes were reclaimed");
  assert.equal(memfs.usage().files, clean.files);

  // The subtree is usable again straight away.
  memfs.writeFile("/tmp/again.sql", "SELECT 3;");
  assert.equal(memfs.readdir("/tmp").length, 1);
});

test("quota refusals are ENOSPC and are counted", () => {
  const { memfs, workspace } = freshRuntime({
    limits: { maxTotalBytes: 4096, maxFiles: 8, maxFileBytes: 1024 },
  });
  assert.equal(memfs.usage().denials, 0);

  assert.throws(
    () => workspace.writeFile("big.bin", new Uint8Array(2048)),
    (e) => e.code === "ENOSPC",
    "single-file limit",
  );
  assert.equal(memfs.usage().denials, 1);

  let totalErr = null;
  for (let i = 0; i < 8 && totalErr === null; i++) {
    try {
      workspace.writeFile(`f${i}.bin`, new Uint8Array(1024));
    } catch (e) {
      totalErr = e;
    }
  }
  assert.equal(totalErr?.code, "ENOSPC", "total-byte or file-count limit");
  assert.ok(memfs.usage().denials >= 2);
  assert.equal(workspace.quotaDenials(), memfs.usage().denials);
});

test("writeSync never throws", () => {
  const { memfs } = freshRuntime({ limits: { maxTotalBytes: 0, maxFiles: 1, maxFileBytes: 0 } });
  const bytes = new TextEncoder().encode("panic: something went wrong\n");
  const seen = [];
  memfs.setStderr((s) => seen.push(s));

  assert.equal(memfs.writeSync(2, bytes), bytes.length);
  assert.equal(seen.join(""), "panic: something went wrong\n");
  // A bad descriptor, and a descriptor the quota will refuse, both report a
  // full write rather than throwing into Go's panic path.
  assert.equal(memfs.writeSync(99, bytes), bytes.length);
  assert.equal(memfs.writeSync(1, new Uint8Array(0)), 0);
});

test("fd 0 serves queued stdin and then reads as EOF", () => {
  const { memfs } = freshRuntime();
  memfs.pushStdin("YES\n");
  const buf = new Uint8Array(16);
  assert.equal(memfs.read(0, buf, 0, buf.length, null), 4);
  assert.equal(new TextDecoder().decode(buf.subarray(0, 4)), "YES\n");
  assert.equal(memfs.read(0, buf, 0, buf.length, null), 0, "drained stdin is EOF");

  assert.throws(
    () => memfs.write(0, buf, 0, 1, null),
    (e) => e.code === "EBADF",
  );
  assert.throws(
    () => memfs.read(1, buf, 0, 1, null),
    (e) => e.code === "EBADF",
  );
  assert.equal(memfs.fstat(0).isDirectory(), false);
});

test("stdout decoding survives a rune split across two writes", () => {
  const { memfs } = freshRuntime();
  const out = [];
  memfs.setStdout((s) => out.push(s));
  const bytes = new TextEncoder().encode("é\n"); // 2 bytes + newline
  memfs.writeSync(1, bytes.subarray(0, 1));
  memfs.writeSync(1, bytes.subarray(1));
  assert.equal(out.join(""), "é\n");
});

test("path.resolve and process.cwd match the filesystem", () => {
  const rt = freshRuntime();
  assert.equal(rt.process.cwd(), "/workspace");
  assert.equal(rt.process.getuid(), -1);
  assert.equal(rt.process.umask(0o077), 0o022);
  assert.equal(rt.process.umask(), 0o077);
  assert.equal(rt.path.resolve("migrations", "0001.sql"), "/workspace/migrations/0001.sql");
  assert.equal(rt.path.resolve("/tmp", "x", "..", "y"), "/tmp/y");

  rt.memfs.mkdirp("/workspace/migrations");
  rt.process.chdir("/workspace/migrations");
  assert.equal(rt.process.cwd(), "/workspace/migrations");
  assert.equal(rt.process.env.PWD, "/workspace/migrations");
  assert.equal(rt.path.resolve("a.sql"), "/workspace/migrations/a.sql");
  assert.throws(
    () => rt.process.chdir("/etc"),
    (e) => e.code === "EACCES",
  );
});

test("workspace list reports names, sizes, kinds and mtimes", () => {
  const { workspace } = freshRuntime({ now: () => 1_700_000_000_000 });
  workspace.writeFile("schema.sql", "CREATE TABLE t (id INT);");
  workspace.mkdir("migrations");
  const entries = workspace.list(".");
  assert.deepEqual(
    entries.map((e) => [e.name, e.size, e.isDir, e.mtime]),
    [
      ["migrations", 0, true, 1_700_000_000_000],
      ["schema.sql", 24, false, 1_700_000_000_000],
    ],
  );
});

// ---------------------------------------------------------------------------
// 2. the real Go program
// ---------------------------------------------------------------------------

const GO_SOURCE = String.raw`
package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

var failures int

func check(name string, ok bool, detail string) {
	status := "PASS"
	if !ok {
		status = "FAIL"
		failures++
	}
	fmt.Printf("CHECK|%s|%s|%s\n", name, status, detail)
}

func checkErr(name string, err error) {
	check(name, err == nil, fmt.Sprintf("%v", err))
}

func main() {
	env()
	basics()
	relative()
	openFlags()
	seeking()
	links()
	renaming()
	temps()
	walking()
	metadata()
	concurrency()
	jail()
	quota()
	fmt.Printf("SUMMARY|%d\n", failures)
}

func env() {
	wd, err := os.Getwd()
	check("getwd_starts_in_workspace", err == nil && wd == "/workspace", fmt.Sprintf("%q err=%v", wd, err))
	check("tempdir_is_tmp", os.TempDir() == "/tmp", os.TempDir())
	home, herr := os.UserHomeDir()
	check("home_is_home_play", herr == nil && home == "/home/play", fmt.Sprintf("%q err=%v", home, herr))
	check("getpid", os.Getpid() > 0, fmt.Sprintf("%d", os.Getpid()))
	check("getuid_is_minus_one", os.Getuid() == -1, fmt.Sprintf("%d", os.Getuid()))
}

const schema = "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);\n"

func basics() {
	checkErr("mkdirall", os.MkdirAll("/workspace/migrations/2024", 0o755))
	checkErr("mkdirall_idempotent", os.MkdirAll("/workspace/migrations/2024", 0o755))
	err := os.Mkdir("/workspace/migrations", 0o755)
	check("mkdir_existing_is_exist", os.IsExist(err), fmt.Sprintf("%v", err))

	checkErr("writefile", os.WriteFile("/workspace/schema.sql", []byte(schema), 0o644))
	b, err := os.ReadFile("/workspace/schema.sql")
	check("readfile", err == nil && string(b) == schema, fmt.Sprintf("%d bytes err=%v", len(b), err))

	checkErr("writefile_m1", os.WriteFile("/workspace/migrations/0001_init.up.sql", []byte("-- up\n"), 0o644))
	checkErr("writefile_m2", os.WriteFile("/workspace/migrations/0002_add.up.sql", []byte("-- up2\n"), 0o644))

	ents, err := os.ReadDir("/workspace/migrations")
	names := make([]string, 0, len(ents))
	dirs := 0
	sized := 0
	for _, e := range ents {
		names = append(names, e.Name())
		if e.IsDir() {
			dirs++
		}
		if info, ierr := e.Info(); ierr == nil && info.Size() == 6 {
			sized++
		}
	}
	sort.Strings(names)
	check("readdir", err == nil && strings.Join(names, ",") == "0001_init.up.sql,0002_add.up.sql,2024",
		fmt.Sprintf("%v err=%v", names, err))
	check("readdir_isdir", dirs == 1, fmt.Sprintf("%d dirs", dirs))
	check("readdir_info_size", sized == 1, fmt.Sprintf("%d entries of 6 bytes", sized))

	_, err = os.ReadDir("/workspace/schema.sql")
	check("readdir_on_file_fails", err != nil, fmt.Sprintf("%v", err))
	_, err = os.ReadFile("/workspace/migrations")
	check("readfile_on_dir_fails", err != nil, fmt.Sprintf("%v", err))
	_, err = os.Stat("/workspace/nope.sql")
	check("stat_missing_is_notexist", errors.Is(err, fs.ErrNotExist) && os.IsNotExist(err), fmt.Sprintf("%v", err))
	err = os.WriteFile("/workspace/no/such/dir/x.sql", []byte("q"), 0o644)
	check("write_missing_parent_is_notexist", os.IsNotExist(err), fmt.Sprintf("%v", err))
}

func relative() {
	checkErr("chdir", os.Chdir("/workspace/migrations"))
	wd, _ := os.Getwd()
	check("getwd_after_chdir", wd == "/workspace/migrations", wd)

	b, err := os.ReadFile("0001_init.up.sql")
	check("read_relative", err == nil && string(b) == "-- up\n", fmt.Sprintf("%q err=%v", string(b), err))

	b, err = os.ReadFile("../schema.sql")
	check("read_relative_dotdot", err == nil && string(b) == schema, fmt.Sprintf("%d bytes err=%v", len(b), err))

	abs, aerr := filepath.Abs("0002_add.up.sql")
	check("filepath_abs", aerr == nil && abs == "/workspace/migrations/0002_add.up.sql", fmt.Sprintf("%q err=%v", abs, aerr))

	checkErr("chdir_back", os.Chdir("/workspace"))
}

func openFlags() {
	for i := 0; i < 2; i++ {
		f, err := os.OpenFile("/workspace/log.txt", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			check("open_append", false, fmt.Sprintf("%v", err))
			return
		}
		if _, werr := f.WriteString(fmt.Sprintf("line%d\n", i+1)); werr != nil {
			check("open_append", false, fmt.Sprintf("%v", werr))
		}
		_ = f.Close()
	}
	b, _ := os.ReadFile("/workspace/log.txt")
	check("o_append", string(b) == "line1\nline2\n", fmt.Sprintf("%q", string(b)))

	_, err := os.OpenFile("/workspace/log.txt", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	check("o_excl_on_existing", os.IsExist(err), fmt.Sprintf("%v", err))

	f, err := os.OpenFile("/workspace/log.txt", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err == nil {
		_, _ = f.WriteString("fresh\n")
		_ = f.Close()
	}
	b, _ = os.ReadFile("/workspace/log.txt")
	check("o_trunc", string(b) == "fresh\n", fmt.Sprintf("%q", string(b)))

	_, err = os.OpenFile("/workspace/missing.sql", os.O_RDONLY, 0)
	check("open_missing_without_create", os.IsNotExist(err), fmt.Sprintf("%v", err))
}

func seeking() {
	f, err := os.OpenFile("/workspace/seek.bin", os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o644)
	if err != nil {
		check("seek_open", false, fmt.Sprintf("%v", err))
		return
	}
	if _, werr := f.Write([]byte("0123456789")); werr != nil {
		check("seek_write", false, fmt.Sprintf("%v", werr))
	}

	pos, serr := f.Seek(3, io.SeekStart)
	check("seek_start", serr == nil && pos == 3, fmt.Sprintf("%d err=%v", pos, serr))

	buf := make([]byte, 4)
	n, rerr := f.Read(buf)
	check("read_after_seek", rerr == nil && string(buf[:n]) == "3456", fmt.Sprintf("%q err=%v", string(buf[:n]), rerr))

	n, rerr = f.ReadAt(buf, 6)
	check("read_at", rerr == nil && string(buf[:n]) == "6789", fmt.Sprintf("%q err=%v", string(buf[:n]), rerr))

	_, werr := f.WriteAt([]byte("AB"), 1)
	checkErr("write_at", werr)

	end, eerr := f.Seek(0, io.SeekEnd)
	check("seek_end", eerr == nil && end == 10, fmt.Sprintf("%d err=%v", end, eerr))
	_ = f.Close()

	b, _ := os.ReadFile("/workspace/seek.bin")
	check("seek_result", string(b) == "0AB3456789", fmt.Sprintf("%q", string(b)))

	checkErr("truncate_shrink", os.Truncate("/workspace/seek.bin", 4))
	b, _ = os.ReadFile("/workspace/seek.bin")
	check("truncate_shrink_result", string(b) == "0AB3", fmt.Sprintf("%q", string(b)))

	checkErr("truncate_grow", os.Truncate("/workspace/seek.bin", 8))
	b, _ = os.ReadFile("/workspace/seek.bin")
	check("truncate_grow_zero_fills", len(b) == 8 && string(b[4:]) == "\x00\x00\x00\x00", fmt.Sprintf("%q", string(b)))
}

func links() {
	checkErr("link", os.Link("/workspace/schema.sql", "/workspace/schema.linked.sql"))
	a, aerr := os.Stat("/workspace/schema.sql")
	b, berr := os.Stat("/workspace/schema.linked.sql")
	check("same_file", aerr == nil && berr == nil && os.SameFile(a, b), fmt.Sprintf("%v %v", aerr, berr))

	// One MemFS instance for all three subtrees, so a cross-subtree link works.
	// Separate instances would have to report EXDEV, which os.Link cannot retry.
	checkErr("link_cross_subtree", os.Link("/workspace/schema.sql", "/tmp/schema.hard.sql"))
	c, cerr := os.Stat("/tmp/schema.hard.sql")
	check("same_file_cross_subtree", cerr == nil && os.SameFile(a, c), fmt.Sprintf("%v", cerr))

	f, oerr := os.OpenFile("/workspace/schema.linked.sql", os.O_WRONLY|os.O_APPEND, 0o644)
	if oerr == nil {
		_, _ = f.WriteString("-- appended\n")
		_ = f.Close()
	}
	via, _ := os.ReadFile("/tmp/schema.hard.sql")
	check("link_shares_content", strings.HasSuffix(string(via), "-- appended\n"), fmt.Sprintf("%d bytes", len(via)))

	checkErr("unlink_one_link", os.Remove("/workspace/schema.linked.sql"))
	_, serr := os.Stat("/tmp/schema.hard.sql")
	check("other_link_survives", serr == nil, fmt.Sprintf("%v", serr))
	checkErr("unlink_cross_link", os.Remove("/tmp/schema.hard.sql"))

	// Restore the canonical content for the rest of the run.
	checkErr("restore_schema", os.WriteFile("/workspace/schema.sql", []byte(schema), 0o644))

	err := os.Symlink("/workspace/schema.sql", "/workspace/schema.symlink")
	check("symlink_refused", err != nil, fmt.Sprintf("%v", err))
}

func renaming() {
	checkErr("rename", os.Rename("/workspace/schema.sql", "/workspace/schema.bak"))
	_, err := os.Stat("/workspace/schema.sql")
	check("rename_source_gone", os.IsNotExist(err), fmt.Sprintf("%v", err))
	checkErr("rename_back", os.Rename("/workspace/schema.bak", "/workspace/schema.sql"))

	checkErr("write_tmp_for_move", os.WriteFile("/tmp/moved.sql", []byte("-- moved\n"), 0o644))
	checkErr("rename_cross_subtree", os.Rename("/tmp/moved.sql", "/workspace/moved.sql"))
	b, rerr := os.ReadFile("/workspace/moved.sql")
	check("rename_cross_subtree_content", rerr == nil && string(b) == "-- moved\n", fmt.Sprintf("%q err=%v", string(b), rerr))
	checkErr("remove_moved", os.Remove("/workspace/moved.sql"))

	checkErr("mkdir_tree", os.MkdirAll("/workspace/tree/a/b", 0o755))
	checkErr("write_tree", os.WriteFile("/workspace/tree/a/b/f.txt", []byte("z"), 0o644))
	err = os.Remove("/workspace/tree")
	check("remove_nonempty_dir_fails", err != nil, fmt.Sprintf("%v", err))
	checkErr("removeall", os.RemoveAll("/workspace/tree"))
	_, err = os.Stat("/workspace/tree")
	check("removeall_gone", os.IsNotExist(err), fmt.Sprintf("%v", err))
	checkErr("removeall_missing_is_nil", os.RemoveAll("/workspace/never-existed"))
}

func temps() {
	tf, err := os.CreateTemp("", "ptah-*.sql")
	if err != nil {
		check("createtemp", false, fmt.Sprintf("%v", err))
		return
	}
	check("createtemp", strings.HasPrefix(tf.Name(), "/tmp/") && strings.HasSuffix(tf.Name(), ".sql"), tf.Name())
	_, _ = tf.WriteString("-- temp\n")
	checkErr("createtemp_sync", tf.Sync())
	_ = tf.Close()
	b, rerr := os.ReadFile(tf.Name())
	check("createtemp_readback", rerr == nil && string(b) == "-- temp\n", fmt.Sprintf("%q err=%v", string(b), rerr))
	checkErr("createtemp_remove", os.Remove(tf.Name()))

	td, derr := os.MkdirTemp("", "ptahdir-*")
	check("mkdirtemp", derr == nil && strings.HasPrefix(td, "/tmp/"), fmt.Sprintf("%q err=%v", td, derr))
	if derr == nil {
		checkErr("mkdirtemp_write", os.WriteFile(filepath.Join(td, "x.sql"), []byte("x"), 0o644))
		checkErr("mkdirtemp_removeall", os.RemoveAll(td))
	}
}

func walking() {
	var walked []string
	err := filepath.Walk("/workspace", func(p string, info fs.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			walked = append(walked, p)
		}
		return nil
	})
	sort.Strings(walked)
	check("filepath_walk", err == nil && len(walked) >= 4, fmt.Sprintf("%d files err=%v", len(walked), err))
	check("filepath_walk_sees_schema", contains(walked, "/workspace/schema.sql"), strings.Join(walked, " "))

	g, gerr := filepath.Glob("/workspace/migrations/*.sql")
	sort.Strings(g)
	check("filepath_glob", gerr == nil && len(g) == 2, fmt.Sprintf("%v err=%v", g, gerr))

	var seen []string
	werr := fs.WalkDir(os.DirFS("/workspace"), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		seen = append(seen, p)
		return nil
	})
	check("dirfs_walkdir", werr == nil && contains(seen, "migrations/0001_init.up.sql"), fmt.Sprintf("%d entries err=%v", len(seen), werr))

	data, derr := fs.ReadFile(os.DirFS("/workspace"), "schema.sql")
	check("dirfs_readfile", derr == nil && string(data) == schema, fmt.Sprintf("%d bytes err=%v", len(data), derr))
}

func metadata() {
	checkErr("chmod", os.Chmod("/workspace/log.txt", 0o600))
	st, err := os.Stat("/workspace/log.txt")
	check("chmod_applied", err == nil && st.Mode().Perm() == 0o600, fmt.Sprintf("%v err=%v", st.Mode(), err))

	want := time.Unix(1700000000, 0)
	checkErr("chtimes", os.Chtimes("/workspace/log.txt", want, want))
	st, err = os.Stat("/workspace/log.txt")
	check("chtimes_applied", err == nil && st.ModTime().Unix() == 1700000000, fmt.Sprintf("%v err=%v", st.ModTime().UTC(), err))

	dir, derr := os.Stat("/workspace/migrations")
	check("stat_dir_mode", derr == nil && dir.IsDir() && dir.Mode().IsDir(), fmt.Sprintf("%v err=%v", dir.Mode(), derr))

	lst, lerr := os.Lstat("/workspace/schema.sql")
	check("lstat_regular", lerr == nil && lst.Mode().IsRegular() && lst.Size() == int64(len(schema)),
		fmt.Sprintf("%v %d err=%v", lst.Mode(), lst.Size(), lerr))

	f, oerr := os.Open("/workspace/schema.sql")
	if oerr == nil {
		fst, ferr := f.Stat()
		check("file_stat", ferr == nil && fst.Size() == int64(len(schema)), fmt.Sprintf("%v", ferr))
		checkErr("file_sync", f.Sync())
		_ = f.Close()
	} else {
		check("file_stat", false, fmt.Sprintf("%v", oerr))
	}
}

func concurrency() {
	const n = 32
	checkErr("concurrent_mkdir", os.MkdirAll("/workspace/conc", 0o755))
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			p := fmt.Sprintf("/workspace/conc/g%02d.txt", i)
			body := strings.Repeat(fmt.Sprintf("%02d", i), 64)
			if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
				errs[i] = err
				return
			}
			got, err := os.ReadFile(p)
			if err != nil {
				errs[i] = err
				return
			}
			if string(got) != body {
				errs[i] = fmt.Errorf("content mismatch in %s", p)
			}
		}(i)
	}
	wg.Wait()
	bad := 0
	var first error
	for _, e := range errs {
		if e != nil {
			bad++
			if first == nil {
				first = e
			}
		}
	}
	check("concurrent_goroutines", bad == 0, fmt.Sprintf("%d failures, first=%v", bad, first))
	ents, err := os.ReadDir("/workspace/conc")
	check("concurrent_readdir", err == nil && len(ents) == n, fmt.Sprintf("%d entries err=%v", len(ents), err))
	checkErr("concurrent_cleanup", os.RemoveAll("/workspace/conc"))
}

func jail() {
	_, err := os.ReadFile("/workspace/../etc/passwd")
	check("jail_dotdot_is_permission", errors.Is(err, fs.ErrPermission), fmt.Sprintf("%v", err))

	err = os.MkdirAll("/etc/evil", 0o755)
	check("jail_absolute_is_permission", errors.Is(err, fs.ErrPermission), fmt.Sprintf("%v", err))

	err = os.WriteFile("/workspace/../../root/.ssh/authorized_keys", []byte("k"), 0o600)
	check("jail_deep_dotdot", err != nil, fmt.Sprintf("%v", err))

	err = os.Chdir("/etc")
	check("jail_chdir_refused", err != nil, fmt.Sprintf("%v", err))
	wd, _ := os.Getwd()
	check("jail_chdir_kept_cwd", wd == "/workspace", wd)

	_, err = os.ReadFile("/workspace/sch\x00ema.sql")
	check("jail_nul_byte", err != nil, fmt.Sprintf("%v", err))

	// Deliberately os.Remove, not os.RemoveAll: RemoveAll would delete every
	// child before hitting the refusal on the root itself.
	err = os.Remove("/workspace")
	check("jail_root_not_removable", err != nil, fmt.Sprintf("%v", err))
	err = os.Rename("/workspace", "/workspace2")
	check("jail_root_not_renamable", err != nil, fmt.Sprintf("%v", err))
	_, serr := os.Stat("/workspace/schema.sql")
	check("jail_root_survived", serr == nil, fmt.Sprintf("%v", serr))
}

func quota() {
	err := os.WriteFile("/workspace/toobig.bin", make([]byte, 300*1024), 0o644)
	check("quota_single_file", errors.Is(err, syscall.ENOSPC), fmt.Sprintf("%v", err))
	_ = os.Remove("/workspace/toobig.bin")

	ok, err := os.ReadFile("/workspace/schema.sql")
	check("quota_denial_does_not_corrupt", err == nil && string(ok) == schema, fmt.Sprintf("%v", err))

	checkErr("quota_fill_dir", os.MkdirAll("/workspace/fill", 0o755))
	chunk := make([]byte, 100*1024)
	var fillErr error
	written := 0
	for i := 0; i < 200 && fillErr == nil; i++ {
		fillErr = os.WriteFile(fmt.Sprintf("/workspace/fill/f%03d.bin", i), chunk, 0o644)
		if fillErr == nil {
			written++
		}
	}
	check("quota_total_bytes", errors.Is(fillErr, syscall.ENOSPC),
		fmt.Sprintf("after %d files: %v", written, fillErr))
	checkErr("quota_fill_cleanup", os.RemoveAll("/workspace/fill"))

	checkErr("quota_many_dir", os.MkdirAll("/workspace/many", 0o755))
	var cntErr error
	made := 0
	for i := 0; i < 400 && cntErr == nil; i++ {
		cntErr = os.WriteFile(fmt.Sprintf("/workspace/many/f%03d.txt", i), []byte("x"), 0o644)
		if cntErr == nil {
			made++
		}
	}
	check("quota_file_count", errors.Is(cntErr, syscall.ENOSPC),
		fmt.Sprintf("after %d files: %v", made, cntErr))
	checkErr("quota_many_cleanup", os.RemoveAll("/workspace/many"))

	checkErr("quota_recovers_after_cleanup", os.WriteFile("/workspace/after.sql", []byte("SELECT 1;\n"), 0o644))

	fmt.Fprintln(os.Stderr, "STDERR-PROBE")
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
`;

const GO_MOD = "module memfsprobe\n\ngo 1.26.5\n";

function goEnv(name) {
  return execFileSync("go", ["env", name], { encoding: "utf8" }).trim();
}

function buildProbe() {
  const goVersion = execFileSync("go", ["version"], { encoding: "utf8" }).trim();
  const key = createHash("sha256").update(goVersion).update(GO_SOURCE).update(GO_MOD).digest("hex").slice(0, 16);
  const dir = nodePath.join(nodeOs.tmpdir(), `ptah-memfs-probe-${key}`);
  const wasm = nodePath.join(dir, "probe.wasm");
  if (nodeFs.existsSync(wasm)) return { wasm, goVersion };

  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "go.mod"), GO_MOD);
  nodeFs.writeFileSync(nodePath.join(dir, "main.go"), GO_SOURCE);
  execFileSync("go", ["build", "-o", wasm, "."], {
    cwd: dir,
    env: { ...process.env, GOOS: "js", GOARCH: "wasm" },
    stdio: "pipe",
  });
  return { wasm, goVersion };
}

/** `wasm_exec.js` is a plain script that assigns globalThis.Go. Load it once:
 *  a second require() is a cache hit and would not reassign the global. */
let goLoaded = false;
function ensureGoLoader() {
  if (goLoaded) return;
  createRequire(import.meta.url)(nodePath.join(goEnv("GOROOT"), "lib", "wasm", "wasm_exec.js"));
  goLoaded = true;
}

/**
 * Run the probe with our shim installed as globalThis.fs / process / path,
 * exactly the way the worker will. node's globals are put back afterwards.
 */
async function runProbe(wasmPath, runtime) {
  const stdout = [];
  const stderr = [];
  runtime.memfs.setStdout((s) => stdout.push(s));
  runtime.memfs.setStderr((s) => stderr.push(s));

  ensureGoLoader();
  const bytes = nodeFs.readFileSync(wasmPath);

  const savedFs = globalThis.fs;
  const savedProcess = globalThis.process;
  const savedPath = globalThis.path;

  globalThis.fs = runtime.fs;
  globalThis.process = runtime.process;
  globalThis.path = runtime.path;
  try {
    const go = new globalThis.Go();
    go.argv = ["ptah"];
    go.env = runtime.env;
    let exitCode = 0;
    go.exit = (code) => {
      exitCode = code;
    };
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    await go.run(instance);
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
  } finally {
    globalThis.fs = savedFs;
    globalThis.process = savedProcess;
    globalThis.path = savedPath;
  }
}

function parseChecks(stdout) {
  const checks = new Map();
  let summary = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("CHECK|")) {
      const parts = line.split("|");
      checks.set(parts[1], { status: parts[2], detail: parts.slice(3).join("|") });
    } else if (line.startsWith("SUMMARY|")) {
      summary = Number(line.slice("SUMMARY|".length));
    }
  }
  return { checks, summary };
}

/** Names that must be present, so a probe that dies halfway is not a pass. */
const REQUIRED_CHECKS = [
  "getwd_starts_in_workspace",
  "tempdir_is_tmp",
  "home_is_home_play",
  "mkdirall",
  "writefile",
  "readfile",
  "readdir",
  "readdir_isdir",
  "stat_missing_is_notexist",
  "chdir",
  "read_relative",
  "read_relative_dotdot",
  "filepath_abs",
  "o_append",
  "o_excl_on_existing",
  "o_trunc",
  "seek_start",
  "read_after_seek",
  "read_at",
  "write_at",
  "seek_result",
  "truncate_grow_zero_fills",
  "link",
  "same_file",
  "link_cross_subtree",
  "same_file_cross_subtree",
  "link_shares_content",
  "symlink_refused",
  "rename",
  "rename_cross_subtree",
  "removeall",
  "createtemp",
  "mkdirtemp",
  "filepath_walk",
  "filepath_glob",
  "dirfs_walkdir",
  "dirfs_readfile",
  "chmod_applied",
  "chtimes_applied",
  "file_sync",
  "concurrent_goroutines",
  "concurrent_readdir",
  "jail_dotdot_is_permission",
  "jail_absolute_is_permission",
  "jail_chdir_refused",
  "jail_nul_byte",
  "jail_root_not_removable",
  "quota_single_file",
  "quota_total_bytes",
  "quota_file_count",
  "quota_recovers_after_cleanup",
];

test("the real Go runtime drives the shim end to end", async () => {
  const { wasm, goVersion } = buildProbe();
  log(`     built ${nodePath.basename(wasm)} with ${goVersion}`);

  const runtime = freshRuntime({
    limits: { maxTotalBytes: 4 * 1024 * 1024, maxFiles: 200, maxFileBytes: 256 * 1024 },
  });
  const { stdout, stderr } = await runProbe(wasm, runtime);

  const { checks, summary } = parseChecks(stdout);
  const failures = [];
  for (const [name, r] of checks) {
    if (r.status !== "PASS") failures.push(`${name}: ${r.detail}`);
  }
  const missing = REQUIRED_CHECKS.filter((n) => !checks.has(n));

  log(`     ${checks.size} checks from Go, ${failures.length} failed`);
  if (process.env.MEMFS_VERBOSE) {
    for (const [name, r] of checks) log(`     ${r.status} ${name}  ${r.detail}`);
  }
  for (const f of failures) log(`     - ${f}`);

  assert.deepEqual(missing, [], "the probe did not reach the end");
  assert.deepEqual(failures, [], "Go-side check failures");
  assert.equal(summary, 0, "the Go program reported failures");
  assert.match(stderr, /STDERR-PROBE/, "stderr did not reach the sink");

  // Side effects the Go program cannot see for itself.
  const usage = runtime.memfs.usage();
  assert.ok(usage.denials >= 3, `expected quota denials, got ${usage.denials}`);
  assert.ok(usage.nodes <= usage.limits.maxFiles, "node count exceeded the quota");
  assert.equal(runtime.memfs.exists("/workspace/after.sql"), true);
  assert.equal(runtime.workspace.readText("after.sql"), "SELECT 1;\n");
  assert.ok(runtime.workspace.revision() > 0, "the workspace revision never moved");

  // /tmp is scratch: it must be droppable between commands without touching
  // the workspace.
  const before = runtime.workspace.revision();
  runtime.memfs.clearTemp();
  assert.deepEqual(runtime.memfs.readdir("/tmp"), []);
  assert.equal(runtime.workspace.revision(), before);
  assert.equal(runtime.workspace.readText("schema.sql").startsWith("CREATE TABLE users"), true);
});

test("a snapshot taken after a real run restores exactly", async () => {
  const { wasm } = buildProbe();
  const runtime = freshRuntime({
    limits: { maxTotalBytes: 4 * 1024 * 1024, maxFiles: 200, maxFileBytes: 256 * 1024 },
  });
  await runProbe(wasm, runtime);

  const before = runtime.workspace.walk().map((p) => [p, runtime.workspace.readText(p)]);
  const snap = runtime.workspace.snapshot();

  runtime.workspace.remove("schema.sql");
  runtime.workspace.writeFile("junk.sql", "DROP TABLE users;");
  runtime.workspace.restore(snap);

  const after = runtime.workspace.walk().map((p) => [p, runtime.workspace.readText(p)]);
  assert.deepEqual(after, before);
  assert.equal(runtime.workspace.exists("junk.sql"), false);
});

// ---------------------------------------------------------------------------

const ok = await run();
if (!ok) process.exitCode = 1;
