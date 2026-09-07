"use strict";
// A self-contained in-memory implementation of the JS object that Go's
// syscall/fs_js.go talks to (globalThis.fs), plus globalThis.process and
// globalThis.path. No node "fs" is used anywhere.

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

// Node-compatible open flags (values taken from Linux/node fs.constants).
const O_RDONLY = 0;
const O_WRONLY = 1;
const O_RDWR = 2;
const O_CREAT = 64;
const O_EXCL = 128;
const O_TRUNC = 512;
const O_APPEND = 1024;
const O_DIRECTORY = 65536;

function mkErr(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}

let nextIno = 1;

class Node {
  constructor(type, mode) {
    this.type = type; // "file" | "dir" | "symlink"
    this.ino = nextIno++;
    this.mode = mode;
    this.uid = 0;
    this.gid = 0;
    this.nlink = 1;
    const now = Date.now();
    this.atimeMs = now;
    this.mtimeMs = now;
    this.ctimeMs = now;
    if (type === "dir") this.entries = new Map(); // name -> Node
    if (type === "file") this.data = new Uint8Array(0);
    if (type === "symlink") this.target = "";
  }
  get size() {
    if (this.type === "file") return this.data.length;
    if (this.type === "symlink") return this.target.length;
    return 4096;
  }
  ifmt() {
    if (this.type === "dir") return S_IFDIR;
    if (this.type === "symlink") return S_IFLNK;
    return S_IFREG;
  }
  stats() {
    const self = this;
    return {
      dev: 1,
      ino: self.ino,
      mode: (self.mode & 0o7777) | self.ifmt(),
      nlink: self.nlink,
      uid: self.uid,
      gid: self.gid,
      rdev: 0,
      size: self.size,
      blksize: 4096,
      blocks: Math.ceil(self.size / 512),
      atimeMs: Math.floor(self.atimeMs),
      mtimeMs: Math.floor(self.mtimeMs),
      ctimeMs: Math.floor(self.ctimeMs),
      isDirectory() { return self.type === "dir"; },
      isFile() { return self.type === "file"; },
      isSymbolicLink() { return self.type === "symlink"; },
    };
  }
}

class MemFS {
  constructor(opts = {}) {
    this.root = new Node("dir", 0o755);
    this.cwd = "/";
    this.fds = new Map();
    this.nextFd = 3;
    this.jailRoot = opts.jailRoot || null; // e.g. "/" or "/workspace"
    this.stdout = opts.stdout || ((s) => console.log(s));
    this.stderr = opts.stderr || ((s) => console.error(s));
    this._outBuf = "";
    this._errBuf = "";
    this.decoder = new TextDecoder("utf-8");
  }

  // ---- path handling ------------------------------------------------
  resolve(p) {
    if (typeof p !== "string") p = String(p);
    if (p.indexOf("\u0000") !== -1) throw mkErr("EINVAL", "null byte in path");
    let abs = p.startsWith("/") ? p : this.cwd + "/" + p;
    const out = [];
    for (const seg of abs.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") { out.pop(); continue; }
      out.push(seg);
    }
    const norm = "/" + out.join("/");
    if (this.jailRoot && this.jailRoot !== "/") {
      if (norm !== this.jailRoot && !norm.startsWith(this.jailRoot + "/")) {
        throw mkErr("EACCES", "path escapes jail: " + norm);
      }
    }
    return norm;
  }

  split(abs) {
    const parts = abs.split("/").filter((s) => s !== "");
    return parts;
  }

  // returns Node or throws
  lookup(abs, { followFinal = true, depth = 0 } = {}) {
    if (depth > 40) throw mkErr("ELOOP", "too many symlinks");
    const parts = this.split(abs);
    let node = this.root;
    for (let i = 0; i < parts.length; i++) {
      if (node.type === "symlink") {
        node = this.lookup(this.resolveLink(node, parts.slice(0, i)), { depth: depth + 1 });
      }
      if (node.type !== "dir") throw mkErr("ENOTDIR", abs);
      const child = node.entries.get(parts[i]);
      if (!child) throw mkErr("ENOENT", abs);
      const last = i === parts.length - 1;
      if (child.type === "symlink" && (!last || followFinal)) {
        const target = child.target.startsWith("/")
          ? child.target
          : "/" + parts.slice(0, i).join("/") + "/" + child.target;
        node = this.lookup(this.resolve(target), { followFinal: true, depth: depth + 1 });
      } else {
        node = child;
      }
    }
    return node;
  }

  parentOf(abs) {
    const parts = this.split(abs);
    if (parts.length === 0) throw mkErr("EINVAL", "/ has no parent");
    const name = parts[parts.length - 1];
    const dirAbs = "/" + parts.slice(0, -1).join("/");
    const dir = this.lookup(dirAbs);
    if (dir.type !== "dir") throw mkErr("ENOTDIR", dirAbs);
    return { dir, name };
  }

  // ---- syscalls -----------------------------------------------------
  _open(pathStr, flags, mode) {
    const abs = this.resolve(pathStr);
    let node = null;
    try {
      node = this.lookup(abs);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (node && (flags & O_CREAT) && (flags & O_EXCL)) throw mkErr("EEXIST", abs);
    if (!node) {
      if (!(flags & O_CREAT)) throw mkErr("ENOENT", abs);
      const { dir, name } = this.parentOf(abs);
      node = new Node("file", mode & 0o7777);
      dir.entries.set(name, node);
      dir.mtimeMs = Date.now();
    }
    const acc = flags & 3;
    if (node.type === "dir" && acc !== O_RDONLY) throw mkErr("EISDIR", abs);
    if ((flags & O_DIRECTORY) && node.type !== "dir") throw mkErr("ENOTDIR", abs);
    if ((flags & O_TRUNC) && node.type === "file" && acc !== O_RDONLY) {
      node.data = new Uint8Array(0);
      node.mtimeMs = Date.now();
    }
    const fd = this.nextFd++;
    this.fds.set(fd, { node, path: abs, flags, pos: 0 });
    return fd;
  }

  mkdirpSync(abs, mode = 0o755) {
    const parts = this.split(abs);
    let node = this.root;
    for (const part of parts) {
      let child = node.entries.get(part);
      if (!child) { child = new Node("dir", mode); node.entries.set(part, child); }
      node = child;
    }
    return node;
  }

  _fd(fd) {
    const f = this.fds.get(fd);
    if (!f) throw mkErr("EBADF", "fd " + fd);
    return f;
  }

  _writeStd(fd, buf) {
    const s = this.decoder.decode(buf);
    if (fd === 1) {
      this._outBuf += s;
      const nl = this._outBuf.lastIndexOf("\n");
      if (nl !== -1) { this.stdout(this._outBuf.substring(0, nl)); this._outBuf = this._outBuf.substring(nl + 1); }
    } else {
      this._errBuf += s;
      const nl = this._errBuf.lastIndexOf("\n");
      if (nl !== -1) { this.stderr(this._errBuf.substring(0, nl)); this._errBuf = this._errBuf.substring(nl + 1); }
    }
    return buf.length;
  }


  _writeAt(node, offset, chunk) {
    const need = offset + chunk.length;
    if (need > node.data.length) {
      const nd = new Uint8Array(need);
      nd.set(node.data);
      node.data = nd;
    }
    node.data.set(chunk, offset);
    node.mtimeMs = Date.now();
  }
}

// ---- the globalThis.fs facade --------------------------------------
function installMemFS(opts) {
  const m = new MemFS(opts);

  const wrap = (fn) => function (...args) {
    const cb = args[args.length - 1];
    let res;
    try {
      res = fn.apply(null, args.slice(0, -1));
    } catch (e) {
      if (!e.code) { console.error("memfs internal error", e); e.code = "EIO"; }
      cb(e);
      return;
    }
    cb(null, res);
  };

  const fsObj = {
    constants: {
      O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL, O_DIRECTORY,
    },

    writeSync(fd, buf) {
      if (fd === 1 || fd === 2) return m._writeStd(fd, buf);
      const f = m._fd(fd);
      m._writeAt(f.node, f.pos, buf);
      f.pos += buf.length;
      return buf.length;
    },

    write(fd, buf, offset, length, position, callback) {
      try {
        const chunk = buf.subarray(offset, offset + length);
        if (fd === 1 || fd === 2) { callback(null, m._writeStd(fd, chunk)); return; }
        const f = m._fd(fd);
        let pos;
        if (position === null || position === undefined) {
          pos = (f.flags & O_APPEND) ? f.node.data.length : f.pos;
        } else {
          pos = position;
        }
        m._writeAt(f.node, pos, chunk);
        if (position === null || position === undefined) f.pos = pos + length;
        callback(null, length);
      } catch (e) { callback(e); }
    },

    read(fd, buf, offset, length, position, callback) {
      try {
        const f = m._fd(fd);
        if (f.node.type === "dir") { callback(mkErr("EISDIR", f.path)); return; }
        const pos = (position === null || position === undefined) ? f.pos : position;
        const data = f.node.data;
        const n = Math.max(0, Math.min(length, data.length - pos));
        if (n > 0) buf.set(data.subarray(pos, pos + n), offset);
        if (position === null || position === undefined) f.pos = pos + n;
        f.node.atimeMs = Date.now();
        callback(null, n);
      } catch (e) { callback(e); }
    },

    open: wrap((path, flags, mode) => m._open(path, flags, mode)),
    close: wrap((fd) => { m._fd(fd); m.fds.delete(fd); }),
    fstat: wrap((fd) => m._fd(fd).node.stats()),
    stat: wrap((p) => m.lookup(m.resolve(p)).stats()),
    lstat: wrap((p) => m.lookup(m.resolve(p), { followFinal: false }).stats()),
    readdir: wrap((p) => {
      const n = m.lookup(m.resolve(p));
      if (n.type !== "dir") throw mkErr("ENOTDIR", p);
      return Array.from(n.entries.keys());
    }),
    mkdir: wrap((p, perm) => {
      const abs = m.resolve(p);
      const { dir, name } = m.parentOf(abs);
      if (dir.entries.has(name)) throw mkErr("EEXIST", abs);
      dir.entries.set(name, new Node("dir", perm & 0o7777));
      dir.mtimeMs = Date.now();
    }),
    rmdir: wrap((p) => {
      const abs = m.resolve(p);
      const { dir, name } = m.parentOf(abs);
      const n = dir.entries.get(name);
      if (!n) throw mkErr("ENOENT", abs);
      if (n.type !== "dir") throw mkErr("ENOTDIR", abs);
      if (n.entries.size > 0) throw mkErr("ENOTEMPTY", abs);
      dir.entries.delete(name);
    }),
    unlink: wrap((p) => {
      const abs = m.resolve(p);
      const { dir, name } = m.parentOf(abs);
      const n = dir.entries.get(name);
      if (!n) throw mkErr("ENOENT", abs);
      if (n.type === "dir") throw mkErr("EPERM", abs);
      dir.entries.delete(name);
    }),
    rename: wrap((from, to) => {
      const a = m.resolve(from), b = m.resolve(to);
      const src = m.parentOf(a);
      const n = src.dir.entries.get(src.name);
      if (!n) throw mkErr("ENOENT", a);
      const dst = m.parentOf(b);
      const existing = dst.dir.entries.get(dst.name);
      if (existing && existing.type === "dir" && existing.entries.size > 0) throw mkErr("ENOTEMPTY", b);
      src.dir.entries.delete(src.name);
      dst.dir.entries.set(dst.name, n);
    }),
    truncate: wrap((p, length) => {
      const n = m.lookup(m.resolve(p));
      const nd = new Uint8Array(length);
      nd.set(n.data.subarray(0, Math.min(length, n.data.length)));
      n.data = nd;
    }),
    ftruncate: wrap((fd, length) => {
      const n = m._fd(fd).node;
      const nd = new Uint8Array(length);
      nd.set(n.data.subarray(0, Math.min(length, n.data.length)));
      n.data = nd;
    }),
    chmod: wrap((p, mode) => { m.lookup(m.resolve(p)).mode = mode & 0o7777; }),
    fchmod: wrap((fd, mode) => { m._fd(fd).node.mode = mode & 0o7777; }),
    chown: wrap((p, uid, gid) => { const n = m.lookup(m.resolve(p)); n.uid = uid; n.gid = gid; }),
    fchown: wrap((fd, uid, gid) => { const n = m._fd(fd).node; n.uid = uid; n.gid = gid; }),
    lchown: wrap((p, uid, gid) => { const n = m.lookup(m.resolve(p), { followFinal: false }); n.uid = uid; n.gid = gid; }),
    utimes: wrap((p, atime, mtime) => {
      const n = m.lookup(m.resolve(p));
      n.atimeMs = atime * 1000; n.mtimeMs = mtime * 1000;
    }),
    readlink: wrap((p) => {
      const n = m.lookup(m.resolve(p), { followFinal: false });
      if (n.type !== "symlink") throw mkErr("EINVAL", p);
      return n.target;
    }),
    symlink: wrap((target, linkPath) => {
      const abs = m.resolve(linkPath);
      const { dir, name } = m.parentOf(abs);
      if (dir.entries.has(name)) throw mkErr("EEXIST", abs);
      const n = new Node("symlink", 0o777);
      n.target = target;
      dir.entries.set(name, n);
    }),
    link: wrap((existing, newPath) => {
      const n = m.lookup(m.resolve(existing));
      const abs = m.resolve(newPath);
      const { dir, name } = m.parentOf(abs);
      if (dir.entries.has(name)) throw mkErr("EEXIST", abs);
      n.nlink++;
      dir.entries.set(name, n);
    }),
    fsync(fd, callback) { callback(null); },
  };

  const processObj = {
    getuid() { return 1000; },
    getgid() { return 1000; },
    geteuid() { return 1000; },
    getegid() { return 1000; },
    getgroups() { return [1000]; },
    pid: 42,
    ppid: 1,
    umask() { return 0o22; },
    cwd() { return m.cwd; },
    chdir(dir) {
      const abs = m.resolve(dir);
      const n = m.lookup(abs);
      if (n.type !== "dir") throw mkErr("ENOTDIR", abs);
      m.cwd = abs;
    },
  };

  const pathObj = {
    resolve(...segs) {
      let out = "";
      for (let i = segs.length - 1; i >= 0; i--) {
        const s = segs[i];
        if (!s) continue;
        out = out ? s + "/" + out : s;
        if (s.startsWith("/")) break;
      }
      if (!out.startsWith("/")) out = m.cwd + "/" + out;
      const parts = [];
      for (const seg of out.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") { parts.pop(); continue; }
        parts.push(seg);
      }
      return "/" + parts.join("/");
    },
  };

  return { memfs: m, fs: fsObj, process: processObj, path: pathObj };
}

if (typeof module !== "undefined" && module.exports) { module.exports = { installMemFS, MemFS }; }
if (typeof globalThis !== "undefined") { globalThis.__memfs = { installMemFS, MemFS }; }
