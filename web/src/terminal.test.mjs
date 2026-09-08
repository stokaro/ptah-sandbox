/**
 * Terminal unit tests.
 *
 * Two halves:
 *
 *   1. The pure parts -- tokenizer, quoting, history, completion -- tested
 *      directly. These are the parts where a bug is silent: a mis-tokenized
 *      argv runs a command that means something other than the line on screen.
 *   2. The pane itself, against a small DOM stand-in, for the one property no
 *      review can guarantee by reading: that program output reaches the screen
 *      as text and never as markup.
 *
 * Node strips the types in terminal.ts, so this imports it directly. The
 * module touches the DOM only inside the class, which is why importing it
 * without a document works at all.
 *
 * Run:  node --test src/terminal.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  tokenize,
  quoteArg,
  quoteArgv,
  History,
  complete,
  buildCommandTree,
  Terminal,
} from "./terminal.ts";

/* ------------------------------------------------------------------ *
 * Tokenizer
 * ------------------------------------------------------------------ */

function argv(line) {
  const result = tokenize(line);
  assert.equal(result.ok, true, `expected ${JSON.stringify(line)} to parse: ${result.message}`);
  return result.argv;
}

function refusal(line) {
  const result = tokenize(line);
  assert.equal(result.ok, false, `expected ${JSON.stringify(line)} to be refused`);
  return result;
}

test("tokenize: plain words", () => {
  assert.deepEqual(argv("ptah schema drift"), ["ptah", "schema", "drift"]);
  assert.deepEqual(argv("   ptah   version   "), ["ptah", "version"]);
  assert.deepEqual(argv(""), []);
  assert.deepEqual(argv("   "), []);
  assert.deepEqual(argv("ptah\tschema\tapply"), ["ptah", "schema", "apply"]);
});

test("tokenize: the real scenario A line survives intact", () => {
  assert.deepEqual(
    argv("ptah schema apply --schema-file schema.sql --db-url sqlite://app.db --dry-run"),
    [
      "ptah",
      "schema",
      "apply",
      "--schema-file",
      "schema.sql",
      "--db-url",
      "sqlite://app.db",
      "--dry-run",
    ],
  );
});

test("tokenize: single quotes are literal through to the close", () => {
  assert.deepEqual(argv("ptah sql lint 'SELECT 1'"), ["ptah", "sql", "lint", "SELECT 1"]);
  // Everything a shell would act on is inert inside quotes, exactly as in a
  // shell. This is the escape hatch every refusal message points at.
  assert.deepEqual(argv("a '|' '$(x)' '~' '#' '*'"), ["a", "|", "$(x)", "~", "#", "*"]);
  assert.deepEqual(argv("a 'b\"c'"), ["a", 'b"c']);
});

test("tokenize: double quotes take \\\" and \\\\ and nothing else", () => {
  assert.deepEqual(argv('x "a b"'), ["x", "a b"]);
  assert.deepEqual(argv('x "say \\"hi\\""'), ["x", 'say "hi"']);
  assert.deepEqual(argv('x "back\\\\slash"'), ["x", "back\\slash"]);
  // \n inside double quotes is two characters in a shell, and two here.
  assert.deepEqual(argv('x "a\\nb"'), ["x", "a\\nb"]);
  assert.deepEqual(argv("x \"it's\""), ["x", "it's"]);
});

test("tokenize: quotes join and split words the way a shell does", () => {
  assert.deepEqual(argv("--flag=\"a b\""), ["--flag=a b"]);
  assert.deepEqual(argv("'a'b'c'"), ["abc"]);
  assert.deepEqual(argv('x "" y'), ["x", "", "y"]);
  assert.deepEqual(argv("x '' y"), ["x", "", "y"]);
});

test("tokenize: a backslash outside quotes escapes one character", () => {
  assert.deepEqual(argv("cp a\\ b c"), ["cp", "a b", "c"]);
  assert.deepEqual(argv("x \\|"), ["x", "|"]);
  assert.deepEqual(argv("x \\$HOME"), ["x", "$HOME"]);
});

test("tokenize: unterminated quotes and a trailing backslash are errors", () => {
  assert.match(refusal("ptah sql lint 'SELECT 1").message, /single-quoted/);
  assert.match(refusal('ptah sql lint "SELECT 1').message, /double-quoted/);
  assert.match(refusal("ptah version \\").message, /backslash/);
});

test("tokenize: every shell metacharacter is refused by name", () => {
  const cases = [
    ["ptah version | head", "|", /pipe/],
    ["ptah version || true", "||", /pipe/],
    ["ptah version && ptah help", "&&", /chains commands/],
    ["ptah version &", "&", /backgrounds/],
    ["ptah version; ptah help", ";", /separates/],
    ["ptah version > out.txt", ">", /redirects output/],
    ["ptah version >> out.txt", ">>", /redirects output/],
    ["ptah apply < answer.txt", "<", /redirects a file into stdin/],
    ["ptah version `date`", "`", /Backticks/],
    ["ptah version $(date)", "$(", /substitutes/],
    ["ptah version ${HOME}", "${", /shell variable/],
    ["ptah version $HOME", "$H", /shell variable/],
    ["ptah (version)", "(", /groups commands/],
    ["ptah x{a,b}", "{", /brace expansion/],
    ["ptah schema apply --schema-file *.sql", "*", /glob/],
    ["ptah schema apply --schema-file a?.sql", "?", /glob/],
    ["ptah schema apply --schema-file [ab].sql", "[", /glob/],
    ["ptah schema apply --schema-file ~/schema.sql", "~", /home directory/],
    ["ptah version # comment", "#", /shell comment/],
  ];
  for (const [line, found, pattern] of cases) {
    const result = refusal(line);
    assert.equal(result.found, found, `wrong token named for ${JSON.stringify(line)}`);
    assert.match(result.message, pattern, `wrong message for ${JSON.stringify(line)}`);
    assert.ok(result.at >= 0 && result.at < line.length, "the refusal points into the line");
    // Every refusal must say what to type instead, or it is just a "no".
    assert.ok(result.message.length > 40, "the message explains rather than announces");
  }
});

test("tokenize: metacharacters that are literal in a shell stay literal here", () => {
  // Mid-word tilde and hash are not expansions in a shell either.
  assert.deepEqual(argv("ptah x a~b"), ["ptah", "x", "a~b"]);
  assert.deepEqual(argv("ptah x a#b"), ["ptah", "x", "a#b"]);
  // A "$" that begins no name is an ordinary character.
  assert.deepEqual(argv("ptah x a$ b"), ["ptah", "x", "a$", "b"]);
  assert.deepEqual(argv("ptah x 100$"), ["ptah", "x", "100$"]);
});

test("tokenize: never silently mis-tokenizes -- a refusal or an exact argv", () => {
  // The property that matters: for any line, either we refuse, or the argv
  // re-quotes back to something that parses to the same argv.
  const lines = [
    "ptah schema apply --schema-file schema.sql --db-url sqlite://app.db",
    "ptah sql lint 'SELECT * FROM users'",
    'ptah x "a b" c\\ d',
    "ptah version | head",
    "ptah x ~/y",
  ];
  for (const line of lines) {
    const result = tokenize(line);
    if (!result.ok) continue;
    assert.deepEqual(argv(quoteArgv(result.argv)), result.argv, `round trip failed for ${line}`);
  }
});

test("quoteArg: round trips anything through the tokenizer", () => {
  for (const value of ["a", "", "a b", "it's", 'say "hi"', "back\\slash", "a|b", "~", "$HOME"]) {
    assert.deepEqual(argv(`x ${quoteArg(value)}`), ["x", value], `failed for ${value}`);
  }
  assert.equal(quoteArg("schema.sql"), "schema.sql");
  assert.equal(quoteArg("sqlite://app.db"), "sqlite://app.db");
  assert.equal(quoteArg(""), "''");
});

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

test("history: up walks back, down walks forward and restores the draft", () => {
  const h = new History();
  h.add("ptah version");
  h.add("ptah schema drift");

  assert.equal(h.older("half typed"), "ptah schema drift");
  assert.equal(h.older(""), "ptah version");
  // At the oldest entry it stays put rather than clearing the line.
  assert.equal(h.older(""), null);
  assert.equal(h.newer(), "ptah schema drift");
  assert.equal(h.newer(), "half typed");
  assert.equal(h.newer(), null);
});

test("history: blank lines and immediate repeats take no slot", () => {
  const h = new History();
  h.add("ptah version");
  h.add("ptah version");
  h.add("");
  h.add("   ");
  assert.deepEqual(h.entries(), ["ptah version"]);
});

test("history: submitting stops browsing", () => {
  const h = new History();
  h.add("a");
  h.add("b");
  assert.equal(h.older("draft"), "b");
  h.add("c");
  assert.equal(h.older("fresh"), "c");
  assert.equal(h.newer(), "fresh");
});

test("history: an edit stops browsing without losing the line", () => {
  const h = new History();
  h.add("a");
  assert.equal(h.older("draft"), "a");
  h.reset();
  assert.equal(h.newer(), null);
  assert.equal(h.older("edited"), "a");
  assert.equal(h.newer(), "edited");
});

test("history: the cap drops the oldest", () => {
  const h = new History(3);
  for (const line of ["a", "b", "c", "d"]) h.add(line);
  assert.deepEqual(h.entries(), ["b", "c", "d"]);
});

/* ------------------------------------------------------------------ *
 * Completion
 * ------------------------------------------------------------------ */

// A slice of the real list: 61 paths ship in the manifest, in this shape.
const COMMANDS = [
  "db",
  "db capabilities",
  "db read",
  "help",
  "migrations",
  "migrations status",
  "migrations up",
  "schema",
  "schema apply",
  "schema annotations",
  "schema drift",
  "schema diff",
  "version",
];

const CTX = {
  commands: COMMANDS,
  paths: ["schema.sql", "README.md"],
  dbUrls: ["sqlite://app.db"],
  builtins: ["clear", "commands"],
};

function completeAtEnd(line, ctx = CTX) {
  return complete(line, line.length, ctx);
}

test("buildCommandTree: parents map to their children, from the list alone", () => {
  const tree = buildCommandTree(COMMANDS);
  assert.deepEqual(tree.get(""), ["db", "help", "migrations", "schema", "version"]);
  assert.deepEqual(tree.get("db"), ["capabilities", "read"]);
  assert.deepEqual(tree.get("schema"), ["apply", "annotations", "drift", "diff"]);
  assert.equal(tree.get("nope"), undefined);
});

test("completion: position zero offers builtins, ptah and the top-level verbs", () => {
  const result = completeAtEnd("");
  assert.deepEqual(result.candidates, [
    "clear",
    "commands",
    "ptah",
    "db",
    "help",
    "migrations",
    "schema",
    "version",
  ]);
});

test("completion: a unique match completes and adds its separator", () => {
  const result = completeAtEnd("ptah ver");
  assert.deepEqual(result.candidates, ["version"]);
  assert.equal(result.text, "version ");
  assert.equal("ptah ver".slice(0, result.start) + result.text, "ptah version ");
});

test("completion: several matches insert only the shared prefix", () => {
  const result = completeAtEnd("ptah schema a");
  assert.deepEqual(result.candidates, ["apply", "annotations"]);
  assert.equal(result.text, "a");
  // Nothing moved, which is what makes the second Tab list them.
  assert.equal("ptah schema a".slice(0, result.start) + result.text, "ptah schema a");

  const partial = completeAtEnd("ptah schema d");
  assert.deepEqual(partial.candidates, ["drift", "diff"]);
  assert.equal(partial.text, "d");
});

test("completion: subcommands come from the tree, at any depth", () => {
  assert.deepEqual(completeAtEnd("ptah migrations ").candidates, [
    "status",
    "up",
    "--help",
  ]);
  assert.deepEqual(completeAtEnd("ptah db c").candidates, ["capabilities"]);
  // The leading "ptah" is optional, because the runtime strips one itself.
  assert.deepEqual(completeAtEnd("schema dr").candidates, ["drift"]);
});

test("completion: --help is the only flag offered, because it is the only one published", () => {
  const result = completeAtEnd("ptah schema apply --");
  assert.deepEqual(result.candidates, ["--help"]);
});

test("completion: file-shaped flags offer workspace paths", () => {
  assert.deepEqual(completeAtEnd("ptah schema apply --schema-file ").candidates, [
    "schema.sql",
    "README.md",
  ]);
  assert.deepEqual(completeAtEnd("ptah schema apply --schema-file sch").candidates, [
    "schema.sql",
  ]);
  assert.deepEqual(completeAtEnd("ptah x --output ").candidates, ["schema.sql", "README.md"]);
  assert.deepEqual(completeAtEnd("ptah x -f ").candidates, ["schema.sql", "README.md"]);
});

test("completion: --db-url offers the URLs the bridge really serves", () => {
  // The database is invisible to the workspace, so this cannot come from the
  // file list; it comes from the host, which asks the bridge.
  assert.deepEqual(completeAtEnd("ptah schema apply --db-url ").candidates, [
    "sqlite://app.db",
  ]);
  assert.deepEqual(completeAtEnd("ptah schema apply --db-url sq").candidates, [
    "sqlite://app.db",
  ]);
});

test("completion: --flag=value completes the value and keeps the flag", () => {
  const result = completeAtEnd("ptah schema apply --schema-file=sch");
  assert.deepEqual(result.candidates, ["schema.sql"]);
  const line = "ptah schema apply --schema-file=sch";
  assert.equal(line.slice(0, result.start) + result.text, "ptah schema apply --schema-file=schema.sql ");
});

test("completion: nothing to offer returns null rather than a guess", () => {
  assert.equal(completeAtEnd("ptah zzz"), null);
  assert.equal(completeAtEnd("ptah schema zzz"), null);
  // Before the runtime is up the command list is empty, and completion says
  // nothing rather than inventing verbs.
  assert.equal(completeAtEnd("ptah sch", { ...CTX, commands: [] }), null);
});

test("completion: the caret, not the end of the line, decides the prefix", () => {
  const line = "ptah schema apply";
  // Caret after "sch": the "ema apply" to the right is not part of the prefix.
  const result = complete(line, 8, CTX);
  assert.deepEqual(result.candidates, ["schema"]);
});

test("completion: a value needing quotes comes back quoted", () => {
  const ctx = { ...CTX, paths: ["my schema.sql"] };
  const result = completeAtEnd("ptah schema apply --schema-file my", ctx);
  assert.equal(result.text, "'my schema.sql' ");
  assert.deepEqual(argv(`x ${result.text.trim()}`), ["x", "my schema.sql"]);
});

/* ------------------------------------------------------------------ *
 * The pane
 * ------------------------------------------------------------------ */

/**
 * The smallest DOM that Terminal actually uses.
 *
 * Not a browser: it exists to prove one property that matters more than any
 * other in this pane -- that output becomes character data and never markup.
 * A node here has no innerHTML at all, so a code path that reached for one
 * would throw rather than pass.
 */
function installDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parent = null;
      this.attributes = new Map();
      this.dataset = {};
      this.className = "";
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.listeners = new Map();
      this.scrollTop = 0;
      this.scrollHeight = 0;
      this.value = "";
    }
    append(...nodes) {
      for (const node of nodes) {
        node.parent = this;
        this.children.push(node);
      }
    }
    remove() {
      if (!this.parent) return;
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    }
    removeChild(child) {
      child.remove();
      return child;
    }
    get firstChild() {
      return this.children.length > 0 ? this.children[0] : null;
    }
    get classList() {
      const self = this;
      return {
        contains: (c) => self.className.split(" ").includes(c),
        add: (...cs) => {
          const have = self.className.split(" ").filter((c) => c !== "");
          for (const c of cs) if (!have.includes(c)) have.push(c);
          self.className = have.join(" ");
        },
      };
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    dispatch(type, event) {
      for (const fn of this.listeners.get(type) ?? []) fn(event);
    }
    setSelectionRange() {}
    focus() {}
    get textContent() {
      return this.children.map((c) => c.textContent).join("");
    }
    set textContent(value) {
      this.children = [];
      if (value !== "") this.append(new TextNode(value));
    }
    /** Element count, so a test can assert that output produced no elements. */
    get elementCount() {
      return this.children.reduce(
        (n, c) => n + (c instanceof TextNode ? 0 : 1 + c.elementCount),
        0,
      );
    }
  }

  class TextNode {
    constructor(data) {
      this.data = String(data);
      this.parent = null;
    }
    appendData(more) {
      this.data += more;
    }
    deleteData(offset, count) {
      this.data = this.data.slice(0, offset) + this.data.slice(offset + count);
    }
    get textContent() {
      return this.data;
    }
    get elementCount() {
      return 0;
    }
  }

  globalThis.document = {
    createElement: (tag) => new Node(tag),
    createTextNode: (data) => new TextNode(data),
  };
  globalThis.window = { getSelection: () => ({ toString: () => "" }) };

  return { Node, TextNode };
}

function fakeHost(overrides = {}) {
  const sinks = [];
  return {
    sinks,
    started: [],
    run(argvIn, sink) {
      this.started.push(argvIn);
      sinks.push(sink);
      return { stdin() {}, cancel() {} };
    },
    isReady: () => true,
    commands: () => COMMANDS,
    paths: () => ["schema.sql"],
    dbUrls: () => ["sqlite://app.db"],
    restart: async () => "restarted",
    ...overrides,
  };
}

function findByClass(node, className) {
  if (typeof node.className === "string" && node.className.split(" ").includes(className)) {
    return node;
  }
  for (const child of node.children ?? []) {
    const hit = findByClass(child, className);
    if (hit) return hit;
  }
  return null;
}

test("pane: a database value containing markup renders as text, not as elements", (t) => {
  installDom();
  const mount = document.createElement("div");
  const host = fakeHost();
  const term = new Terminal(mount, { host });
  t.after(() => term.destroy());

  const screen = findByClass(mount, "term-screen");
  const before = screen.elementCount;

  // Exactly the shape a SELECT over a row someone seeded reaches this pane in.
  const hostile = '<img src=x onerror="alert(1)"> & <script>steal()</script>\n';
  host.sinks.length = 0;
  term.run(["ptah", "db", "read"]);
  host.sinks[0].started();
  host.sinks[0].stdout(hostile);
  host.sinks[0].done(0);

  assert.ok(
    screen.textContent.includes(hostile),
    "the value is on screen exactly as it arrived",
  );
  // One span per block, and not one element more: nothing in that string was
  // parsed. The prompt line and the output block are the only additions.
  assert.equal(screen.elementCount - before, 3);
  assert.ok(term.transcriptText().includes(hostile));
});

test("pane: a refused line is echoed and explained, and no run starts", (t) => {
  installDom();
  const mount = document.createElement("div");
  const host = fakeHost();
  const term = new Terminal(mount, { host });
  t.after(() => term.destroy());

  const field = findByClass(mount, "term-field").children[0];
  field.value = "ptah version | head";
  field.dispatch("keydown", { key: "Enter", preventDefault() {} });

  const screen = findByClass(mount, "term-screen");
  assert.ok(screen.textContent.includes("ptah version | head"), "the line stays on screen");
  assert.match(screen.textContent, /pipe/);
  assert.equal(host.started.length, 0, "nothing ran");
});

test("pane: the exit code colours off the number, and 1 is not a failure", (t) => {
  installDom();
  const mount = document.createElement("div");
  const host = fakeHost();
  const term = new Terminal(mount, { host });
  t.after(() => term.destroy());
  const exit = findByClass(mount, "term-exit");

  term.run(["ptah", "schema", "drift"]);
  host.sinks[0].started();
  host.sinks[0].stdout("Schema drift detected.\n");
  host.sinks[0].done(1);
  assert.equal(exit.dataset.code, "nonzero");
  assert.match(exit.textContent, /△ exit 1/);

  term.run(["ptah", "version"]);
  host.sinks[1].started();
  host.sinks[1].done(0);
  assert.equal(exit.dataset.code, "0");
  assert.equal(exit.textContent, "exit 0");
});

test("pane: while a run is active the prompt feeds its stdin and echoes it", (t) => {
  installDom();
  const mount = document.createElement("div");
  const fed = [];
  const host = fakeHost();
  host.run = function (argvIn, sink) {
    this.started.push(argvIn);
    this.sinks.push(sink);
    return { stdin: (data) => fed.push(data), cancel() {} };
  };
  const term = new Terminal(mount, { host });
  t.after(() => term.destroy());

  term.run(["ptah", "schema", "apply"]);
  host.sinks[0].started();
  // The real prompt, with no trailing newline.
  host.sinks[0].stdout("Apply these schema changes? Type 'YES' to confirm: ");

  const field = findByClass(mount, "term-field").children[0];
  field.value = "YES";
  field.dispatch("keydown", { key: "Enter", preventDefault() {} });

  assert.deepEqual(fed, ["YES\n"], "the answer went to the run, not to a new command");
  assert.equal(host.started.length, 1, "no second command started");
  assert.ok(findByClass(mount, "term-screen").textContent.includes("YES"));
});

test("pane: truncation is a visible line, not a silent drop", (t) => {
  installDom();
  const mount = document.createElement("div");
  const host = fakeHost();
  const term = new Terminal(mount, { host, maxBytes: 400, maxLines: 20 });
  t.after(() => term.destroy());

  term.run(["ptah", "schema", "export"]);
  host.sinks[0].started();
  for (let i = 0; i < 60; i++) host.sinks[0].stdout(`line ${i} padded out a little\n`);
  host.sinks[0].done(0);

  const screen = findByClass(mount, "term-screen");
  assert.match(screen.textContent, /earlier lines .* were dropped/);
  assert.ok(!screen.textContent.includes("line 0 "), "the oldest lines really went");
  assert.ok(screen.textContent.includes("line 59"), "the newest lines are kept");
});

test("pane: cancel says what it is actually doing", (t) => {
  installDom();
  const mount = document.createElement("div");
  let cancelled = 0;
  const host = fakeHost();
  host.run = function (argvIn, sink) {
    this.sinks.push(sink);
    return { stdin() {}, cancel: () => cancelled++ };
  };
  const term = new Terminal(mount, { host });
  t.after(() => term.destroy());

  term.run(["ptah", "schema", "apply"]);
  host.sinks[0].started();
  const cancel = findByClass(mount, "term-cancel");
  assert.equal(cancel.hidden, false);
  cancel.dispatch("click", {});

  assert.equal(cancelled, 1);
  assert.equal(cancel.textContent, "Stopping after the current statement");
  assert.match(
    findByClass(mount, "term-screen").textContent,
    /cannot be interrupted/,
    "the transcript says why a cancel may take a moment",
  );
});

test("pane: an unknown program is refused locally, because there is no PATH", (t) => {
  installDom();
  const mount = document.createElement("div");
  const host = fakeHost();
  const term = new Terminal(mount, { host });
  t.after(() => term.destroy());

  const field = findByClass(mount, "term-field").children[0];
  field.value = "ls -la";
  field.dispatch("keydown", { key: "Enter", preventDefault() {} });

  assert.equal(host.started.length, 0);
  assert.match(findByClass(mount, "term-screen").textContent, /is not a command here/);
});

test("pane: a command typed before the runtime is up is queued, and says so", (t) => {
  installDom();
  const mount = document.createElement("div");
  const host = fakeHost({ isReady: () => false });
  const term = new Terminal(mount, { host });
  t.after(() => term.destroy());

  term.run(["ptah", "version"]);
  assert.equal(host.started.length, 1, "the run is handed over immediately");
  assert.match(findByClass(mount, "term-screen").textContent, /Queued/);

  host.sinks[0].started();
  assert.equal(findByClass(mount, "term-state").textContent, "running");
});

test("pane: completion inserts into the field over the real command list", (t) => {
  installDom();
  const mount = document.createElement("div");
  const term = new Terminal(mount, { host: fakeHost() });
  t.after(() => term.destroy());

  const field = findByClass(mount, "term-field").children[0];
  field.value = "ptah ver";
  field.selectionStart = field.value.length;
  field.dispatch("keydown", { key: "Tab", preventDefault() {} });
  assert.equal(field.value, "ptah version ");
});

test("pane: Copy transcript reproduces the session verbatim", (t) => {
  installDom();
  const mount = document.createElement("div");
  const host = fakeHost();
  const term = new Terminal(mount, { host });
  t.after(() => term.destroy());

  term.run(["ptah", "schema", "drift"]);
  host.sinks[0].started();
  host.sinks[0].stdout("No schema drift detected.\n");
  host.sinks[0].done(0);

  assert.equal(
    term.transcriptText(),
    "$ ptah schema drift\nNo schema drift detected.\n",
  );
});

test("pane: a page line after a prompt with no newline starts its own line", (t) => {
  installDom();
  const mount = document.createElement("div");
  const host = fakeHost();
  const term = new Terminal(mount, { host });
  t.after(() => term.destroy());

  term.run(["ptah", "schema", "apply"]);
  host.sinks[0].started();
  // The real prompt. No trailing newline, by design.
  host.sinks[0].stdout("Type 'YES' to confirm: ");
  term.note("checkpoint r14 saved");

  const copy = term.transcriptText();
  assert.ok(
    copy.includes("Type 'YES' to confirm: \ncheckpoint r14 saved\n"),
    `the note broke the line: ${JSON.stringify(copy)}`,
  );
  // stdout itself is untouched: the break is the page's own character.
  assert.ok(copy.includes("Type 'YES' to confirm: "), "stdout is verbatim");
});

test("pane: consecutive stdout chunks stay on one line", (t) => {
  installDom();
  const mount = document.createElement("div");
  const host = fakeHost();
  const term = new Terminal(mount, { host });
  t.after(() => term.destroy());

  term.run(["ptah", "version"]);
  host.sinks[0].started();
  host.sinks[0].stdout("ptah ");
  host.sinks[0].stdout("v0.4.0\n");
  host.sinks[0].done(0);

  assert.equal(term.transcriptText(), "$ ptah version\nptah v0.4.0\n");
});

test("pane: it takes over the page's own terminal element in place", (t) => {
  installDom();
  const grid = document.createElement("div");
  const section = document.createElement("section");
  section.className = "pg-terminal term";
  section.setAttribute("id", "pg-terminal");
  // The placeholder the page draws before this module loads.
  const placeholder = document.createElement("pre");
  placeholder.textContent = "placeholder prompt";
  section.append(placeholder);
  grid.append(section);

  const term = new Terminal(section, { host: fakeHost() });
  t.after(() => term.destroy());

  // Same element, same position, same id: the grid slot and anything pointing
  // at it by id survive.
  assert.equal(grid.children.length, 1);
  assert.equal(grid.children[0], section);
  assert.equal(section.getAttribute("id"), "pg-terminal");
  assert.ok(section.className.split(" ").includes("pg-term"));
  // And exactly one prompt is live.
  assert.ok(!section.textContent.includes("placeholder prompt"));
  assert.ok(findByClass(section, "term-field-input"));
});

test("pane: mounting into a plain element builds its own section", (t) => {
  installDom();
  const mount = document.createElement("div");
  const term = new Terminal(mount, { host: fakeHost() });
  t.after(() => term.destroy());

  assert.equal(mount.children.length, 1);
  assert.ok(mount.children[0].className.split(" ").includes("term"));
});

test("pane: a host that answers synchronously does not leave a stuck run", (t) => {
  installDom();
  const mount = document.createElement("div");
  const host = fakeHost();
  // A host that refuses the argv outright answers inside run(), before the
  // handle it returns has reached the pane.
  host.run = function (argvIn, sink) {
    this.started.push(argvIn);
    this.sinks.push(sink);
    sink.started();
    sink.stderr("ptah-wasm: refused\n");
    sink.done(2);
    return { stdin() {}, cancel() {} };
  };
  const term = new Terminal(mount, { host });
  t.after(() => term.destroy());

  term.run(["ptah", "nope"]);

  assert.equal(findByClass(mount, "term-exit").textContent, "✕ exit 2");
  assert.equal(findByClass(mount, "term-cancel").hidden, true, "the run is over");
  assert.equal(findByClass(mount, "term-state").textContent, "");
  // And the pane is idle, so the next command runs rather than being refused.
  term.run(["ptah", "version"]);
  assert.equal(host.started.length, 2);
});

test("pane: a late done from an abandoned run does not clobber the live one", (t) => {
  installDom();
  const mount = document.createElement("div");
  const host = fakeHost();
  const term = new Terminal(mount, { host });
  t.after(() => term.destroy());

  term.run(["ptah", "schema", "apply"]);
  host.sinks[0].started();
  const abandoned = host.sinks[0];
  abandoned.done(0);

  term.run(["ptah", "schema", "drift"]);
  host.sinks[1].started();
  // The worker that was killed finally reports. It is answering for a run the
  // pane has moved on from.
  abandoned.done(2);

  assert.equal(findByClass(mount, "term-state").textContent, "running");
  assert.equal(findByClass(mount, "term-cancel").hidden, false);
});

test("completion: a shared prefix that would need quoting is not inserted raw", (t) => {
  const ctx = { ...CTX, paths: ["my alpha.sql", "my beta.sql"] };
  const line = "ptah schema apply --schema-file my";
  const result = complete(line, line.length, ctx);
  assert.deepEqual(result.candidates, ["my alpha.sql", "my beta.sql"]);
  // "my " would end the word and turn the rest into a second argument.
  assert.equal(line.slice(0, result.start) + result.text, line);
});

test("completion: a unique match inside an open quote still round trips", (t) => {
  const ctx = { ...CTX, paths: ["my schema.sql"] };
  const line = "ptah schema apply --schema-file 'my sch";
  const result = complete(line, line.length, ctx);
  const completed = line.slice(0, result.start) + result.text;
  assert.deepEqual(argv(completed.trim()), [
    "ptah", "schema", "apply", "--schema-file", "my schema.sql",
  ]);
});
