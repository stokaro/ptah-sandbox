/**
 * The playground terminal.
 *
 * Purpose-built DOM rather than xterm.js. Ptah emits no ANSI at all, so an
 * emulator would be 74 KB gzip of escape-sequence machinery we would never
 * feed -- and it would bring OSC handlers, clipboard writes and link
 * auto-opening into a pane that renders untrusted database values. What this
 * page actually needs is the opposite of an emulator: an input line with
 * history and completion over the real command tree, a stdin channel wired to
 * the CLI's own confirmation prompt, and a transcript a screen reader can read.
 *
 * Three rules hold everything here together.
 *
 *   1. Text nodes only. Schema text, SQL and database values reach this pane;
 *      a value containing markup renders as characters, never as elements.
 *      There is no innerHTML on any path that touches program output.
 *   2. Nothing is inferred from output text. State comes from the run
 *      lifecycle and from the exit code as a number. There is no matching on
 *      "error:" prefixes and no guessing which command produced what.
 *   3. argv, not shell. The line is tokenized into an argv with documented
 *      quoting rules; every shell metacharacter is refused by name with the
 *      thing to type instead. A mis-tokenized argv would be worse than a
 *      refusal, because the command would run and mean something else.
 */

/**
 * A handle on one started run. Valid until its sink's `done` fires.
 *
 * Named for this module rather than `RunHandle`, which session.ts already uses
 * for the Worker-side handle. The page owns the adapter between the two, and a
 * single name spanning that seam would be a trap.
 */
export interface TerminalRun {
  /** Feeds the process's stdin. An empty string is end of input. */
  stdin(data: string): void;
  /**
   * Asks the run to stop. It cannot interrupt a synchronous sqlite3_step:
   * while SQLite is inside one, the Worker's event loop is starved and this
   * message is not even delivered until it returns. Cancel lands where Ptah
   * yields, which is why the UI says so rather than pretending otherwise.
   */
  cancel(): void;
}

/** Everything one run reports back. The host must call `done` exactly once. */
export interface RunSink {
  /** The process actually started. Separated from `run` so a command typed
   *  before the wasm finishes loading can be shown as queued, honestly. */
  started(): void;
  stdout(text: string): void;
  stderr(text: string): void;
  /** The runtime stopped capturing this run's output at `limitBytes`. */
  truncated(limitBytes: number): void;
  done(code: number): void;
}

/**
 * What the terminal needs from the page. Deliberately narrow: the terminal
 * owns no Worker, no protocol and no scenario, so it can be tested and reasoned
 * about on its own.
 */
export interface TerminalHost {
  /**
   * Starts a run. Returns synchronously even when the runtime is still
   * loading; the host buffers and calls `sink.started` when the process really
   * begins. `sink.done` must fire even for a run cancelled before it started.
   */
  run(argv: string[], sink: RunSink): TerminalRun;
  /** True once ready() has landed. Only affects what the prompt says. */
  isReady(): boolean;
  /** The real registered command paths from ready().commands, "schema apply"
   *  style. Empty until the runtime is up; completion says so. */
  commands(): readonly string[];
  /** Workspace-relative file paths, for completing file-shaped flags. */
  paths(): readonly string[];
  /**
   * Database URLs the bridge actually serves. Optional because the workspace
   * cannot see the database: `sqlite://app.db` reaches the bridge as the bare
   * key `app.db` and never appears in Workspace.list().
   */
  dbUrls?(): readonly string[];
  /**
   * Tears the Worker down and boots a new one, then resolves with one line
   * describing what was restored. Only reached after a cancel has failed to
   * land; unfinished changes in the killed run are gone.
   */
  restart(): Promise<string>;
}

export interface TerminalOptions {
  host: TerminalHost;
  /** Shown on the left of the bar. The process's cwd, not a guess. */
  cwd?: string;
  maxBytes?: number;
  maxLines?: number;
  /** How long a cancel may go unanswered before the hard restart is offered. */
  stallMs?: number;
  /** Called after every run, so the page can refresh its panes off real state. */
  onExit?: (argv: string[], code: number, durationMs: number) => void;
}

/** 512 KiB of transcript. Past this the oldest lines go, visibly. */
export const DEFAULT_MAX_BYTES = 512 * 1024;
export const DEFAULT_MAX_LINES = 4000;
/** A cancel that has not landed in this long is a starved event loop. */
export const DEFAULT_STALL_MS = 5000;
/** Enough to recall a session, small enough to stay in memory unnoticed. */
export const HISTORY_LIMIT = 200;

/* ------------------------------------------------------------------ *
 * argv, not shell
 * ------------------------------------------------------------------ */

export interface ArgvOk {
  ok: true;
  argv: string[];
}

export interface ArgvRefusal {
  ok: false;
  /** The offending text, verbatim, so the message can name it. */
  found: string;
  /** 0-based index into the line. */
  at: number;
  /** Names what is unsupported and what to type instead. */
  message: string;
}

export type ArgvResult = ArgvOk | ArgvRefusal;

/**
 * Splits a line into an argv.
 *
 * Quoting rules, which are the shell's for the subset that survives:
 *
 *   - Words separate on spaces and tabs. Repeated separators collapse.
 *   - 'single quotes' are literal through to the next single quote. There are
 *     no escapes inside them, so a single quote cannot appear in them at all.
 *   - "double quotes" are literal except \" and \\, which produce " and \.
 *     Any other backslash inside them stays as two characters, as in a shell.
 *   - Outside quotes, a backslash makes the next character literal, so "\ " is
 *     a space inside a word. A backslash at end of line is an error, because
 *     there is no continuation line to join.
 *   - "" and '' produce an empty argument, which is how an empty flag value is
 *     passed.
 *   - An unterminated quote is an error rather than a guess.
 *
 * Everything a shell would act on -- pipes, redirects, sequencing, expansion,
 * substitution, globs, braces, tilde and comments -- is refused by name.
 * Quoting still makes any of them literal, and each message says so, because
 * the alternative is an argv that quietly means something else than the line
 * on screen.
 */
export function tokenize(line: string): ArgvResult {
  const scanned = scan(line, true);
  if (scanned.error) return scanned.error;
  return { ok: true, argv: scanned.words.map((w) => w.value) };
}

interface ScannedWord {
  value: string;
  start: number;
  /** Exclusive. */
  end: number;
  /** The quote still open at end of line, or "" when the word closed. */
  open: string;
}

interface Scan {
  words: ScannedWord[];
  error: ArgvRefusal | null;
}

function refusal(found: string, at: number, message: string): ArgvRefusal {
  return { ok: false, found, at, message };
}

const QUOTE_ESCAPE = "Quote it to pass it as literal text.";

/**
 * Names the shell metacharacter at `i`, or returns null when the character is
 * ordinary. `atWordStart` matters for the two that only act in that position,
 * exactly as in a shell: mid-word "~" and "#" are literal there too.
 */
function refuseMetacharacter(line: string, i: number, atWordStart: boolean): ArgvRefusal | null {
  const ch = line[i];
  const next = i + 1 < line.length ? line[i + 1] : "";
  switch (ch) {
    case "|": {
      const found = next === "|" ? "||" : "|";
      return refusal(
        found,
        i,
        `"${found}" is a shell pipe. This prompt builds one argv and runs one command; its output stays on screen where you can read and copy it. ${QUOTE_ESCAPE}`,
      );
    }
    case "&": {
      const found = next === "&" ? "&&" : "&";
      return refusal(
        found,
        i,
        found === "&&"
          ? `"&&" chains commands. One command runs at a time here: press Enter, read the exit code, then type the next line. ${QUOTE_ESCAPE}`
          : `"&" backgrounds a command. One command runs at a time here, in the foreground. ${QUOTE_ESCAPE}`,
      );
    }
    case ";":
      return refusal(
        ";",
        i,
        `";" separates shell commands. Type one command per line. ${QUOTE_ESCAPE}`,
      );
    case ">": {
      const found = next === ">" ? ">>" : ">";
      return refusal(
        found,
        i,
        `"${found}" redirects output to a file. Nothing writes files through this prompt: commands write their own, and the editor writes the workspace. ${QUOTE_ESCAPE}`,
      );
    }
    case "<": {
      const found = next === "<" ? "<<" : "<";
      return refusal(
        found,
        i,
        `"${found}" redirects a file into stdin. When a command asks for input, type the answer here and press Enter. ${QUOTE_ESCAPE}`,
      );
    }
    case "`":
      return refusal(
        "`",
        i,
        "Backticks substitute a command's output. Run that command first, then type the value you want. " +
          QUOTE_ESCAPE,
      );
    case "$": {
      if (next === "(") {
        return refusal(
          "$(",
          i,
          `"$(" substitutes a command's output. Run that command first, then type the value you want. ${QUOTE_ESCAPE}`,
        );
      }
      if (next === "{") {
        return refusal(
          "${",
          i,
          `"\${" expands a shell variable. There are no shell variables here; type the value. ${QUOTE_ESCAPE}`,
        );
      }
      if (next !== "" && /[A-Za-z_]/.test(next)) {
        return refusal(
          `$${next}`,
          i,
          `"$${next}" expands a shell variable. There are no shell variables here; type the value. ${QUOTE_ESCAPE}`,
        );
      }
      // A "$" that begins nothing is literal in a shell too, so it is here.
      return null;
    }
    case "(":
    case ")":
      return refusal(
        ch,
        i,
        `"${ch}" groups commands in a shell. ${QUOTE_ESCAPE}`,
      );
    case "{":
    case "}":
      return refusal(
        ch,
        i,
        `"${ch}" is shell brace expansion. Type each value on its own. ${QUOTE_ESCAPE}`,
      );
    case "*":
    case "?":
    case "[":
      return refusal(
        ch,
        i,
        `"${ch}" is a glob. Paths are not expanded here, so a pattern would reach the command unchanged and mean something different than it does in a shell. Type the exact path, or quote the pattern to pass it literally.`,
      );
    case "~":
      return atWordStart
        ? refusal(
            "~",
            i,
            '"~" expands to a home directory. This session works in /workspace: type "schema.sql", or "/workspace/schema.sql". ' +
              QUOTE_ESCAPE,
          )
        : null;
    case "#":
      return atWordStart
        ? refusal(
            "#",
            i,
            '"#" starts a shell comment. Everything on this line is passed to the command. ' +
              QUOTE_ESCAPE,
          )
        : null;
    default:
      return null;
  }
}

/**
 * The one scanner both the tokenizer and completion use.
 *
 * `strict` is the difference between running a line and completing one: while
 * typing, an unterminated quote is normal and a metacharacter has not been
 * committed to yet, so completion tolerates both and records which quote is
 * still open.
 */
function scan(line: string, strict: boolean): Scan {
  const words: ScannedWord[] = [];
  const n = line.length;
  let i = 0;

  while (i < n) {
    while (i < n && (line[i] === " " || line[i] === "\t")) i++;
    if (i >= n) break;

    const start = i;
    let value = "";
    let open = "";
    let atWordStart = true;

    while (i < n) {
      const ch = line[i];
      if (ch === " " || ch === "\t") break;

      if (ch === "'") {
        i++;
        const close = line.indexOf("'", i);
        if (close === -1) {
          if (strict) {
            return {
              words,
              error: refusal(
                "'",
                start,
                "This line ends inside a single-quoted string. Close the quote, or remove it.",
              ),
            };
          }
          value += line.slice(i);
          i = n;
          open = "'";
        } else {
          value += line.slice(i, close);
          i = close + 1;
        }
        atWordStart = false;
        continue;
      }

      if (ch === '"') {
        i++;
        let closed = false;
        while (i < n) {
          const c = line[i];
          if (c === "\\" && i + 1 < n && (line[i + 1] === '"' || line[i + 1] === "\\")) {
            value += line[i + 1];
            i += 2;
            continue;
          }
          if (c === '"') {
            i++;
            closed = true;
            break;
          }
          value += c;
          i++;
        }
        if (!closed) {
          if (strict) {
            return {
              words,
              error: refusal(
                '"',
                start,
                "This line ends inside a double-quoted string. Close the quote, or remove it.",
              ),
            };
          }
          open = '"';
        }
        atWordStart = false;
        continue;
      }

      if (ch === "\\") {
        if (i + 1 >= n) {
          if (strict) {
            return {
              words,
              error: refusal(
                "\\",
                i,
                "This line ends in a backslash. There is no continuation line to join it to; remove it, or type the character it was escaping.",
              ),
            };
          }
          i++;
          atWordStart = false;
          continue;
        }
        value += line[i + 1];
        i += 2;
        atWordStart = false;
        continue;
      }

      if (strict) {
        const bad = refuseMetacharacter(line, i, atWordStart);
        if (bad) return { words, error: bad };
      }

      value += ch;
      i++;
      atWordStart = false;
    }

    words.push({ value, start, end: i, open });
  }

  return { words, error: null };
}

/** Characters that survive an argv round trip without quoting. */
const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Re-quotes one argument so that tokenize() gives it back unchanged. */
export function quoteArg(arg: string): string {
  if (arg === "") return "''";
  if (BARE.test(arg)) return arg;
  if (!arg.includes("'")) return `'${arg}'`;
  return `"${arg.replace(/([\\"])/g, "\\$1")}"`;
}

/** The command line that produced this argv, for echoing and for Copy. */
export function quoteArgv(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ");
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

/**
 * Up and Down over submitted lines.
 *
 * The line being typed when browsing starts is kept as the draft and comes
 * back when Down walks past the newest entry, so ↑ is never destructive.
 */
export class History {
  private items: string[] = [];
  private cursor: number | null = null;
  private draft = "";
  private limit: number;

  constructor(limit = HISTORY_LIMIT) {
    this.limit = limit;
  }

  /** Blank lines and an immediate repeat are not worth a slot. */
  add(line: string): void {
    this.cursor = null;
    this.draft = "";
    if (line.trim() === "") return;
    if (this.items.length > 0 && this.items[this.items.length - 1] === line) return;
    this.items.push(line);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
  }

  /** Up. Returns null when already at the oldest entry, or when empty. */
  older(current: string): string | null {
    if (this.items.length === 0) return null;
    if (this.cursor === null) {
      this.draft = current;
      this.cursor = this.items.length - 1;
      return this.items[this.cursor];
    }
    if (this.cursor === 0) return null;
    this.cursor -= 1;
    return this.items[this.cursor];
  }

  /** Down. Returns the draft once it walks past the newest entry. */
  newer(): string | null {
    if (this.cursor === null) return null;
    if (this.cursor >= this.items.length - 1) {
      this.cursor = null;
      const draft = this.draft;
      this.draft = "";
      return draft;
    }
    this.cursor += 1;
    return this.items[this.cursor];
  }

  /** Stops browsing without changing the line. Called on every edit. */
  reset(): void {
    this.cursor = null;
  }

  entries(): readonly string[] {
    return this.items;
  }
}

/* ------------------------------------------------------------------ *
 * Completion
 * ------------------------------------------------------------------ */

export interface CompletionContext {
  /** "schema apply" style paths, exactly as ready().commands reports them. */
  commands: readonly string[];
  paths: readonly string[];
  dbUrls: readonly string[];
  /** Local commands this terminal handles itself. */
  builtins: readonly string[];
}

export interface Completion {
  /** Replacement range in the original line. */
  start: number;
  end: number;
  /** What to put there: the longest common prefix of the candidates. */
  text: string;
  /** Every candidate, for listing when the prefix does not resolve to one. */
  candidates: string[];
}

/** parent path (space-joined, "" for root) -> child names, in tree order. */
export type CommandTree = Map<string, string[]>;

/**
 * Builds the completion tree from the paths the runtime published.
 *
 * The list is the authority: no verb is spelled out anywhere in this file, so
 * a command that is added, renamed or hidden upstream changes what completes
 * here without anyone editing the playground.
 */
export function buildCommandTree(commands: readonly string[]): CommandTree {
  const tree: CommandTree = new Map();
  for (const path of commands) {
    const parts = path.split(" ").filter((p) => p !== "");
    if (parts.length === 0) continue;
    const parent = parts.slice(0, -1).join(" ");
    const name = parts[parts.length - 1];
    const children = tree.get(parent);
    if (children) {
      if (!children.includes(name)) children.push(name);
    } else {
      tree.set(parent, [name]);
    }
  }
  return tree;
}

/**
 * Flags whose value is a path, recognized by shape rather than from a list.
 *
 * ready() publishes commands, not flags, so there is no honest catalog to
 * complete against. The shape of the name the user has already typed is a
 * real signal and costs nothing when it is wrong: the worst case is that
 * workspace paths are offered where they do not apply, and Tab lists them.
 */
function looksLikePathFlag(flag: string): boolean {
  if (flag === "-f" || flag === "-o") return true;
  return /-(file|files|dir|directory|path|out|output|source|target)$/.test(flag);
}

function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === "") break;
  }
  return prefix;
}

/**
 * Completes the word under the caret.
 *
 * Position 0 offers the local builtins, "ptah" and the top-level verbs. Later
 * positions offer the children of whatever node the words so far name; a flag
 * ends the walk, because flags may appear anywhere after their command.
 * Returns null when there is nothing honest to offer, which is also what
 * happens before the runtime is up and the command list is still empty.
 */
export function complete(line: string, caret: number, ctx: CompletionContext): Completion | null {
  const words = scan(line, false).words;

  let index = words.findIndex((w) => caret >= w.start && caret <= w.end);
  let start = caret;
  let end = caret;
  let token = "";
  if (index >= 0) {
    const word = words[index];
    start = word.start;
    end = word.end;
    // Completing from the caret, not from the whole word: text to the right of
    // the caret is not a prefix of anything. Re-scanning the left part is what
    // makes "'my sch" complete as the value "my sch" rather than as the quote.
    const left = scan(line.slice(start, caret), false).words;
    token = left.length > 0 ? left[0].value : "";
  } else {
    index = words.filter((w) => w.end <= caret).length;
  }

  // "--schema-file=sch" completes the value, keeping the flag in place.
  let valuePrefixLength = 0;
  const eq = token.indexOf("=");
  if (eq > 0 && token.startsWith("-")) {
    valuePrefixLength = eq + 1;
  }
  const prefix = token.slice(valuePrefixLength);
  const keptPrefix = token.slice(0, valuePrefixLength);

  const before = words.slice(0, index).map((w) => w.value);
  const candidates = candidatesFor(before, keptPrefix, ctx);
  const matches = candidates.filter((c) => c.startsWith(prefix));
  if (matches.length === 0) return null;

  const shared = longestCommonPrefix(matches);

  // A single match is finished, so it is quoted and gets its separator.
  if (matches.length === 1) {
    return { start, end, text: `${quoteArg(keptPrefix + shared)} `, candidates: matches };
  }

  // Several matches only get as far as they agree. A partial value that would
  // need quoting is left alone instead: quoting it here would put the caret
  // outside the closing quote, so the next keystroke would land in a new word.
  // Returning the word unchanged is what makes the pane list the candidates.
  const partial = keptPrefix + shared;
  const text = quoteArg(partial) === partial ? partial : line.slice(start, end);
  return { start, end, text, candidates: matches };
}

function candidatesFor(
  before: readonly string[],
  keptPrefix: string,
  ctx: CompletionContext,
): string[] {
  const tree = buildCommandTree(ctx.commands);

  if (before.length === 0) {
    const roots = tree.get("") ?? [];
    return dedupe([...ctx.builtins, "ptah", ...roots]);
  }

  // The flag the value belongs to: either the previous word, or the "--x=" the
  // caret is still inside.
  const flag = keptPrefix.endsWith("=") ? keptPrefix.slice(0, -1) : before[before.length - 1];
  if (flag === "--db-url") return [...ctx.dbUrls];
  if (looksLikePathFlag(flag)) return [...ctx.paths];

  const walked = before[0] === "ptah" ? before.slice(1) : before.slice(0);
  const nodePath: string[] = [];
  for (const word of walked) {
    if (word.startsWith("-")) break;
    const children = tree.get(nodePath.join(" ")) ?? [];
    if (!children.includes(word)) break;
    nodePath.push(word);
  }

  const children = tree.get(nodePath.join(" ")) ?? [];
  // Cobra adds --help to every command it builds, so offering it invents
  // nothing. No other flag is guessed at, because none of them are published.
  return dedupe([...children, "--help"]);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/* ------------------------------------------------------------------ *
 * The pane
 * ------------------------------------------------------------------ */

type BlockKind = "cmd" | "out" | "err" | "echo" | "note" | "attention";

interface Block {
  kind: BlockKind;
  el: HTMLElement;
  text: Text;
  /** UTF-8 length of `text`, kept alongside so the cap costs no re-encoding. */
  bytes: number;
  lines: number;
}

type RunState = "idle" | "queued" | "running" | "stopping" | "recovering";

interface ActiveRun {
  handle: TerminalRun;
  argv: string[];
  startedAt: number;
  outLines: number;
  /** Whether the last chunk ended without a newline: a prompt, most likely. */
  partialLine: boolean;
}

/**
 * The handle a run holds for the instant between `host.run` being called and
 * its return value arriving. Only synchronous host code can run in that
 * window, so nothing a person does can reach it.
 */
const INERT_RUN: TerminalRun = { stdin() {}, cancel() {} };

/** UTF-8 byte length without allocating a buffer for every output chunk. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function countLines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function kib(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.round(bytes / 1024)} KiB`;
}

function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

const CLASS_FOR_KIND: Record<BlockKind, string> = {
  cmd: "term-cmd",
  out: "term-out",
  err: "term-err",
  echo: "term-echo",
  note: "m",
  attention: "term-attn",
};

/** The status vocabulary from the design. Glyph plus words, never colour alone. */
const EXIT_GLYPH: Record<number, string> = { 0: "", 1: "△", 2: "✕" };

export class Terminal {
  private host: TerminalHost;
  private opts: Required<Pick<TerminalOptions, "cwd" | "maxBytes" | "maxLines" | "stallMs">>;
  private onExit: TerminalOptions["onExit"];

  private root: HTMLElement;
  /** False when the pane took over an element the page already had. */
  private owned: boolean;
  private screen: HTMLPreElement;
  private truncMark: HTMLElement;
  private stateEl: HTMLElement;
  private exitEl: HTMLElement;
  private durationEl: HTMLElement;
  private cancelBtn: HTMLButtonElement;
  private killBtn: HTMLButtonElement;
  private copyBtn: HTMLButtonElement;
  private sigil: HTMLElement;
  private field: HTMLInputElement;
  private fieldWrap: HTMLElement;
  private noteEl: HTMLElement;
  private hintEl: HTMLElement;
  private live: HTMLElement;

  private blocks: Block[] = [];
  private bytes = 0;
  private lines = 0;
  private droppedBytes = 0;
  private droppedLines = 0;

  private history = new History();
  /** Set by the last Tab press, so a second Tab lists instead of re-inserting. */
  private lastCompletion: string | null = null;

  private state: RunState = "idle";
  private active: ActiveRun | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(mount: HTMLElement, options: TerminalOptions) {
    this.host = options.host;
    this.onExit = options.onExit;
    this.opts = {
      cwd: options.cwd ?? "/workspace",
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
      stallMs: options.stallMs ?? DEFAULT_STALL_MS,
    };

    // Two ways in. Given an element that is already the page's terminal --
    // it carries site.css's `.term` -- the pane takes it over in place, so its
    // position in the playground grid, its id and the aria-controls other
    // elements point at all survive the handover. Given any other element, it
    // builds its own section inside it.
    this.owned = !mount.classList.contains("term");
    this.root = this.owned ? el("section", "term") : mount;
    this.root.classList.add("term", "pg-term");
    this.root.setAttribute("aria-label", "Terminal");
    if (!this.owned) {
      // Whatever the page drew as a placeholder is replaced wholesale rather
      // than merged with: two prompts would both be live.
      while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
    }

    const bar = el("div", "term-bar");
    const where = el("span", "term-where");
    where.append(text("sh"), text(this.opts.cwd));
    this.stateEl = el("span", "term-state");
    where.append(this.stateEl);

    const right = el("span", "term-right");
    this.cancelBtn = el("button", "term-btn term-cancel") as HTMLButtonElement;
    this.cancelBtn.type = "button";
    this.killBtn = el("button", "term-btn term-kill") as HTMLButtonElement;
    this.killBtn.type = "button";
    this.killBtn.textContent = "Terminate the worker";
    // Offered only after a cancel has gone unanswered. Every other path sets
    // this; without the initial value it would sit in the bar from first paint,
    // inviting a visitor to kill a runtime that is working perfectly well.
    this.killBtn.hidden = true;
    this.exitEl = el("span", "term-exit");
    this.durationEl = el("span", "term-duration");
    this.copyBtn = el("button", "copy term-copy") as HTMLButtonElement;
    this.copyBtn.type = "button";
    this.copyBtn.textContent = "Copy transcript";
    right.append(this.cancelBtn, this.killBtn, this.exitEl, this.durationEl, this.copyBtn);
    bar.append(where, right);

    this.screen = el("pre", "term-screen") as HTMLPreElement;
    this.screen.tabIndex = 0;
    this.screen.setAttribute("role", "log");
    this.screen.setAttribute("aria-label", "Transcript");
    // Explicitly not a live region. Announcing every byte would read a schema
    // dump character by character; the summary below does the announcing.
    this.screen.setAttribute("aria-live", "off");
    this.truncMark = el("span", "term-trunc");
    this.screen.append(this.truncMark);

    const prompt = el("div", "term-prompt");
    this.sigil = el("span", "p term-sigil");
    this.sigil.textContent = "$";
    // A real label element, not el(): htmlFor is what ties it to the field,
    // and the field is the only unlabelled control in the pane.
    const label = document.createElement("label");
    label.className = "sr-only";
    label.textContent = "Command";
    this.field = document.createElement("input");
    this.field.type = "text";
    this.field.className = "term-field-input";
    this.field.autocomplete = "off";
    this.field.spellcheck = false;
    this.field.setAttribute("autocapitalize", "off");
    this.field.setAttribute("autocorrect", "off");
    this.field.setAttribute("enterkeyhint", "go");
    this.field.id = `term-input-${Math.random().toString(36).slice(2, 8)}`;
    label.htmlFor = this.field.id;
    this.fieldWrap = el("span", "term-field");
    const caret = el("span", "term-caret");
    caret.textContent = "▍";
    caret.setAttribute("aria-hidden", "true");
    this.fieldWrap.append(this.field, caret);
    this.noteEl = el("span", "term-note m");
    this.hintEl = el("span", "term-hint");
    prompt.append(this.sigil, label, this.fieldWrap, this.noteEl, this.hintEl);

    this.live = el("div", "sr-only term-live");
    this.live.setAttribute("role", "status");
    this.live.setAttribute("aria-live", "polite");

    this.root.append(bar, this.screen, prompt, this.live);
    if (this.owned) mount.append(this.root);

    this.wire();
    this.render();
  }

  /* ---- public API ---- */

  /**
   * Writes a host-level line into the transcript: the SQL pane's statements,
   * a checkpoint restore, a storage warning. Marked as the page talking, not
   * as something a command printed.
   */
  note(line: string, tone: "muted" | "attention" = "muted"): void {
    this.append(tone === "attention" ? "attention" : "note", `${line}\n`);
  }

  /** Runs an argv the page assembled, echoing exactly what the process gets. */
  run(argv: string[]): void {
    if (argv.length === 0) return;
    if (this.state !== "idle") {
      this.note("A command is already running. One runs at a time here.", "attention");
      return;
    }
    this.startRun(argv, quoteArgv(argv));
  }

  /** Re-renders the prompt after the runtime finishes booting. */
  notifyReady(): void {
    this.render();
  }

  /**
   * The transcript as text, exactly as Copy puts it on the clipboard.
   *
   * Read off the elements rather than off the text nodes: a command block
   * carries its "$" in its own span so the sigil can be coloured, and a
   * transcript that pasted back without prompts would not be a transcript.
   */
  transcriptText(): string {
    return (this.truncMark.textContent ?? "") + this.blocks.map((b) => b.el.textContent ?? "").join("");
  }

  focus(): void {
    this.field.focus();
  }

  destroy(): void {
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    // A taken-over element belongs to the page: empty it, do not unlink it.
    if (this.owned) this.root.remove();
    else while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
  }

  /* ---- input ---- */

  private wire(): void {
    this.field.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.field.addEventListener("input", () => {
      this.history.reset();
      this.lastCompletion = null;
      this.syncCaret();
    });
    this.field.addEventListener("paste", (e) => this.onPaste(e));
    this.field.addEventListener("focus", () => this.syncCaret());
    this.field.addEventListener("blur", () => this.syncCaret());

    // Clicking the transcript focuses the prompt, the way clicking a terminal
    // does -- unless text is being selected, which would be maddening.
    this.screen.addEventListener("mouseup", () => {
      const selection = window.getSelection();
      if (selection && selection.toString() !== "") return;
      this.field.focus();
    });

    this.cancelBtn.addEventListener("click", () => this.cancel());
    this.killBtn.addEventListener("click", () => void this.hardRestart());
    this.copyBtn.addEventListener("click", () => void this.copyTranscript());
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      this.submit();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      this.completeAtCaret();
      return;
    }
    if (e.key === "ArrowUp" && !e.altKey) {
      e.preventDefault();
      const line = this.history.older(this.field.value);
      if (line !== null) this.setLine(line);
      return;
    }
    if (e.key === "ArrowDown" && !e.altKey) {
      e.preventDefault();
      const line = this.history.newer();
      if (line !== null) this.setLine(line);
      return;
    }
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
      // Only when nothing is selected: Ctrl+C over a selection is a copy, and
      // stealing that from a transcript would be worse than losing the signal.
      const selection = window.getSelection();
      if (selection && selection.toString() !== "") return;
      e.preventDefault();
      this.interrupt();
      return;
    }
    if (e.ctrlKey && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      this.endOfInput();
      return;
    }
    if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      this.clearScreen();
    }
  }

  /**
   * A pasted command becomes one line.
   *
   * Documentation and the Copy control both produce multi-line text: a leading
   * "$ ", and backslash continuations wrapping a long argv. Joining them is
   * the difference between a paste that runs and one that has to be repaired
   * by hand. Nothing is dropped except the shell's own line-joining syntax.
   */
  private onPaste(e: ClipboardEvent): void {
    const raw = e.clipboardData?.getData("text/plain");
    if (raw === undefined || raw === "") return;
    e.preventDefault();

    let joined = raw
      .replace(/\r\n?/g, "\n")
      .replace(/\\\n[ \t]*/g, " ")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .join(" ");

    const start = this.field.selectionStart ?? this.field.value.length;
    const end = this.field.selectionEnd ?? start;
    if (start === 0 && this.field.value === "") {
      joined = joined.replace(/^[$%>]\s+/, "");
    }

    const value = this.field.value;
    this.field.value = value.slice(0, start) + joined + value.slice(end);
    const caret = start + joined.length;
    this.field.setSelectionRange(caret, caret);
    this.history.reset();
    this.lastCompletion = null;
    this.syncCaret();
  }

  private setLine(line: string): void {
    this.field.value = line;
    this.field.setSelectionRange(line.length, line.length);
    this.lastCompletion = null;
    this.syncCaret();
  }

  private syncCaret(): void {
    this.fieldWrap.dataset.empty = this.field.value === "" ? "1" : "0";
  }

  /* ---- submitting ---- */

  private submit(): void {
    const line = this.field.value;

    // A run owns the prompt while it lasts. There is nothing to disambiguate:
    // the runtime executes one command at a time, so a second command could
    // not start anyway, and the CLI's confirmation prompt is waiting for
    // exactly this.
    if (this.active !== null) {
      this.field.value = "";
      this.syncCaret();
      this.append("echo", `${line}\n`);
      this.active.handle.stdin(`${line}\n`);
      this.active.partialLine = false;
      this.render();
      return;
    }

    if (this.state !== "idle") return;
    this.field.value = "";
    this.syncCaret();
    this.history.add(line);

    if (line.trim() === "") {
      this.append("cmd", "");
      return;
    }

    const parsed = tokenize(line);
    if (!parsed.ok) {
      this.append("cmd", line);
      // The refused line is on screen above; the reason names the character
      // and says what to type instead, so nothing has to be guessed at.
      this.append("attention", `${parsed.message}\n`);
      this.announce(`Not run. ${parsed.message}`);
      return;
    }

    const argv = parsed.argv;
    if (argv.length === 0) {
      this.append("cmd", line);
      return;
    }

    if (this.runBuiltin(argv, line)) return;
    this.startRun(argv, line);
  }

  /**
   * The two commands this pane answers itself.
   *
   * Both are local, and both say so, because a person who types "clear" is
   * entitled to know that nothing in the workspace or the database moved.
   * There is no PATH here and no shell builtins beyond these.
   */
  private runBuiltin(argv: string[], line: string): boolean {
    const name = argv[0];

    if (name === "clear") {
      this.append("cmd", line);
      this.clearScreen();
      return true;
    }

    if (name === "commands") {
      this.append("cmd", line);
      const commands = this.host.commands();
      if (commands.length === 0) {
        this.append(
          "note",
          "The command list arrives with the runtime; it is still loading.\n",
        );
        return true;
      }
      this.append(
        "note",
        `${commands.length} commands are registered in this build:\n`,
      );
      this.append("out", `${commands.map((c) => `  ptah ${c}`).join("\n")}\n`);
      this.announce(`${commands.length} commands listed.`);
      return true;
    }

    // Anything that is not "ptah" and not a registered top-level verb would be
    // handed to the CLI and come back as a cobra error. Saying it here is
    // faster and truer: there is no other program in this session.
    if (name !== "ptah") {
      const roots = buildCommandTree(this.host.commands()).get("") ?? [];
      if (!roots.includes(name)) {
        this.append("cmd", line);
        this.append(
          "attention",
          `"${name}" is not a command here. This session runs the Ptah CLI and nothing else: start the line with "ptah", or type "commands" to see what is registered.\n`,
        );
        this.announce(`${name} is not a command here.`);
        return true;
      }
    }

    return false;
  }

  /**
   * Starts a run.
   *
   * The bookkeeping record is in place before `host.run` is called, and every
   * callback is tied to that record. A host that answers synchronously -- one
   * that refuses the argv outright, say -- would otherwise land its `done`
   * while `this.active` was still null, leaving the pane stuck on a run that
   * had already finished.
   */
  private startRun(argv: string[], echo: string): void {
    this.append("cmd", echo);

    const ready = this.host.isReady();
    const record: ActiveRun = {
      handle: INERT_RUN,
      argv,
      startedAt: Date.now(),
      outLines: 0,
      partialLine: false,
    };
    this.active = record;
    this.state = ready ? "running" : "queued";
    this.exitEl.textContent = "";
    this.durationEl.textContent = "";

    const sink: RunSink = {
      started: () => {
        if (this.active !== record) return;
        record.startedAt = Date.now();
        this.state = "running";
        this.render();
      },
      stdout: (chunk) => this.onOutput("out", chunk, record),
      stderr: (chunk) => this.onOutput("err", chunk, record),
      truncated: (limitBytes) => {
        this.append(
          "note",
          `… the runtime stopped capturing this command's output at ${kib(limitBytes)}.\n`,
        );
      },
      done: (code) => this.finish(code, record),
    };

    const handle = this.host.run(argv, sink);
    if (this.active === record) {
      record.handle = handle;
      if (!ready) {
        this.append(
          "note",
          "Queued: the runtime is still downloading. It will run as soon as the module is up.\n",
        );
      }
      this.startTicking();
    }
    this.announce(`Running ${argv.join(" ")}.`);
    this.render();
  }

  private onOutput(kind: "out" | "err", chunk: string, record: ActiveRun): void {
    if (chunk === "") return;
    this.append(kind, chunk);
    if (this.active !== record) return;
    record.outLines += countLines(chunk);
    // The confirmation prompt has no trailing newline. That is a fact about
    // the output, not a guess about intent, so it is used only to sharpen what
    // the hint says -- never to decide where the next line goes.
    record.partialLine = !chunk.endsWith("\n");
    this.render();
  }

  private finish(code: number, record: ActiveRun): void {
    // A `done` for a run this pane has already moved on from -- one killed by
    // the hard restart, say -- must not reset the bar under the live run.
    if (this.active !== record) return;
    this.active = null;
    this.state = "idle";
    this.stopTicking();
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.killBtn.hidden = true;

    const ms = Date.now() - record.startedAt;
    this.exitEl.textContent = `${EXIT_GLYPH[code] ?? "✕"} exit ${code}`.trim();
    // Off the number, never off the text. Zero is neutral; 1 is an expected
    // negative -- drift found, lint findings, migrations pending -- and 2 is
    // everything else. Neither is red, because neither is a crash of the page.
    this.exitEl.dataset.code = code === 0 ? "0" : "nonzero";
    this.exitEl.setAttribute("aria-label", `exit code ${code}`);
    this.durationEl.textContent = duration(ms);

    // What a screen reader hears: the outcome, not the bytes. The transcript
    // itself is deliberately not a live region.
    this.announce(
      `${record.argv.join(" ")} finished with exit code ${code} after ${duration(ms)}, ${record.outLines} lines of output.`,
    );
    this.onExit?.(record.argv, code, ms);
    this.render();
  }

  /* ---- cancel ---- */

  private interrupt(): void {
    if (this.active !== null) {
      this.cancel();
      return;
    }
    // Idle Ctrl+C is a real terminal's line kill: the line stays on screen,
    // marked, and the prompt starts over.
    const line = this.field.value;
    this.field.value = "";
    this.syncCaret();
    this.history.reset();
    this.append("cmd", `${line}^C`);
  }

  private cancel(): void {
    if (this.active === null || this.state === "stopping") return;
    this.state = "stopping";
    this.active.handle.cancel();
    this.append(
      "note",
      "^C · stopping after the current statement. A cancel lands where Ptah yields; a SQLite statement already running cannot be interrupted from here.\n",
    );
    this.announce("Cancelling. It stops after the current statement.");

    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.state !== "stopping") return;
      this.killBtn.hidden = false;
      this.append(
        "attention",
        `Nothing has yielded for ${Math.round(this.opts.stallMs / 1000)} s, so the cancel has not been delivered yet. Terminating the worker stops it immediately; whatever this command had not finished writing is lost.\n`,
      );
      this.announce("The cancel has not landed. Terminating the worker is offered.");
      this.render();
    }, this.opts.stallMs);

    this.render();
  }

  private async hardRestart(): Promise<void> {
    if (this.state === "recovering") return;
    this.active = null;
    this.state = "recovering";
    this.killBtn.hidden = true;
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.stopTicking();
    this.append(
      "attention",
      "✕ terminated: the worker did not respond to the cancel and was stopped.\n",
    );
    this.render();

    try {
      const summary = await this.host.restart();
      this.append("note", `${summary}\n`);
      this.announce("The runtime restarted.");
    } catch (err) {
      this.append("attention", `Restart failed: ${String(err)}\n`);
      this.announce("The restart failed.");
    } finally {
      this.state = "idle";
      this.exitEl.textContent = "";
      this.durationEl.textContent = "";
      this.render();
    }
  }

  private endOfInput(): void {
    if (this.active === null) return;
    // The empty string is end of input on the Go side. It is how the native
    // EOF path stays reachable: a confirmation that never gets an answer
    // fails to read and exits 2, exactly as the installed CLI does.
    this.append("note", "^D · end of input\n");
    this.active.handle.stdin("");
    this.active.partialLine = false;
    this.render();
  }

  /* ---- completion ---- */

  private completeAtCaret(): void {
    const line = this.field.value;
    const caret = this.field.selectionStart ?? line.length;
    const dbUrls = this.host.dbUrls?.() ?? [];
    const result = complete(line, caret, {
      commands: this.host.commands(),
      paths: this.host.paths(),
      dbUrls,
      builtins: ["clear", "commands"],
    });

    if (result === null) {
      if (this.host.commands().length === 0) {
        this.note("Completion needs the command list, which arrives with the runtime.");
      }
      return;
    }

    const next = line.slice(0, result.start) + result.text + line.slice(result.end);
    if (next !== line) {
      this.field.value = next;
      const caretAt = result.start + result.text.length;
      this.field.setSelectionRange(caretAt, caretAt);
      this.syncCaret();
      this.lastCompletion = result.candidates.length > 1 ? next : null;
      return;
    }

    // Nothing moved, so this is the second Tab: list what is on offer, the way
    // a shell does, instead of silently doing nothing.
    if (result.candidates.length > 1 && this.lastCompletion !== null) {
      this.append("note", `${result.candidates.join("  ")}\n`);
      this.lastCompletion = null;
      return;
    }
    this.lastCompletion = next;
  }

  /* ---- transcript ---- */

  /**
   * Whether the next character would land at the start of a line.
   *
   * Program output does not have to end in a newline -- the confirmation
   * prompt deliberately does not -- so anything the page writes after it has
   * to break the line first, the way a shell does when it echoes ^C.
   */
  private atLineStart(): boolean {
    const last = this.blocks[this.blocks.length - 1];
    if (!last) return true;
    const data = last.el.textContent ?? "";
    return data === "" || data.endsWith("\n");
  }

  /**
   * Adds to the transcript.
   *
   * Anything the page writes itself -- a prompt line, a note, a refusal --
   * starts at column 0, because program output does not have to end in a
   * newline and the confirmation prompt deliberately does not. The break is
   * its own block, so stdout in a copied transcript is still byte for byte
   * what the process wrote.
   */
  private append(kind: BlockKind, body: string): void {
    const continues = kind === "out" || kind === "err" || kind === "echo";
    if (!continues && !this.atLineStart()) this.appendBlock("note", "\n");
    this.appendBlock(kind, body);
  }

  private appendBlock(kind: BlockKind, body: string): void {
    let payload = body;
    let el0: HTMLElement | null = null;

    if (kind === "cmd") {
      // The sigil is its own element so that Copy still yields "$ command"
      // and the screen reader hears the prompt rather than a stray character.
      el0 = el("span", CLASS_FOR_KIND.cmd);
      const sigil = el("span", "p");
      sigil.textContent = "$";
      el0.append(sigil);
      payload = ` ${body}\n`;
    }

    // The sigil is part of the block for accounting and for Copy even though
    // it lives in its own element, so that every counter here measures the
    // same string the reader sees.
    const addedBytes = utf8Length(payload) + (kind === "cmd" ? 1 : 0);
    const addedLines = countLines(payload);

    const last = this.blocks[this.blocks.length - 1];
    if (el0 === null && last && last.kind === kind) {
      last.text.appendData(payload);
      last.bytes += addedBytes;
      last.lines += addedLines;
    } else {
      const node = el0 ?? el("span", CLASS_FOR_KIND[kind]);
      const textNode = document.createTextNode(payload);
      node.append(textNode);
      this.screen.append(node);
      this.blocks.push({
        kind,
        el: node,
        text: textNode,
        bytes: addedBytes,
        lines: addedLines,
      });
    }

    this.bytes += addedBytes;
    this.lines += addedLines;
    this.enforceLimits();
    this.scrollToEnd();
  }

  /**
   * Keeps the transcript bounded, visibly.
   *
   * Whole blocks go first, and only the oldest block is ever trimmed inside --
   * always at a newline, so no line is left half rendered and no multi-byte
   * character is cut in half. What went is stated at the top rather than
   * quietly disappearing.
   */
  private enforceLimits(): void {
    while (
      (this.bytes > this.opts.maxBytes || this.lines > this.opts.maxLines) &&
      this.blocks.length > 1
    ) {
      const block = this.blocks.shift();
      if (!block) break;
      this.bytes -= block.bytes;
      this.lines -= block.lines;
      this.droppedBytes += block.bytes;
      this.droppedLines += block.lines;
      block.el.remove();
    }

    // A single block still over budget gets trimmed inside. A command line is
    // one line and carries a sigil element that would be orphaned by a cut, so
    // it is left alone; it can only be the last block standing, and a prompt
    // is worth its few bytes.
    const only = this.blocks[0];
    if (
      only &&
      only.kind !== "cmd" &&
      (this.bytes > this.opts.maxBytes || this.lines > this.opts.maxLines)
    ) {
      const data = only.text.data;
      const cut = data.indexOf("\n", Math.floor(data.length / 2));
      if (cut >= 0) {
        const removed = data.slice(0, cut + 1);
        only.text.deleteData(0, cut + 1);
        const removedBytes = utf8Length(removed);
        const removedLines = countLines(removed);
        only.bytes -= removedBytes;
        only.lines -= removedLines;
        this.bytes -= removedBytes;
        this.lines -= removedLines;
        this.droppedBytes += removedBytes;
        this.droppedLines += removedLines;
      }
    }

    if (this.droppedLines > 0 || this.droppedBytes > 0) {
      this.truncMark.textContent = `… ${this.droppedLines} earlier lines (${kib(this.droppedBytes)}) were dropped to keep this transcript in memory.\n`;
    }
  }

  private clearScreen(): void {
    for (const block of this.blocks) block.el.remove();
    this.blocks = [];
    this.bytes = 0;
    this.lines = 0;
    this.droppedBytes = 0;
    this.droppedLines = 0;
    this.truncMark.textContent = "";
    this.append(
      "note",
      "Transcript cleared. Nothing in the workspace or the database changed.\n",
    );
  }

  private scrollToEnd(): void {
    this.screen.scrollTop = this.screen.scrollHeight;
  }

  private async copyTranscript(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.transcriptText());
      this.copyBtn.dataset.state = "done";
      this.copyBtn.textContent = "Copied";
      if (this.copyTimer !== null) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        delete this.copyBtn.dataset.state;
        this.copyBtn.textContent = "Copy transcript";
      }, 1400);
    } catch {
      // Clipboard access is blocked in some contexts. Say so rather than
      // leaving a button that appears to have done nothing.
      this.note("The clipboard is blocked here. Select the transcript above and copy it.");
    }
  }

  /* ---- rendering ---- */

  private startTicking(): void {
    this.stopTicking();
    // A long run needs a clock; a short one never sees this fire.
    this.tickTimer = setInterval(() => {
      if (this.active === null) return;
      this.durationEl.textContent = duration(Date.now() - this.active.startedAt);
    }, 200);
  }

  private stopTicking(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private announce(message: string): void {
    this.live.textContent = message;
  }

  private render(): void {
    // Waiting is a state of a run that is still going. Once a cancel is in
    // flight the pane has something more specific to say.
    const waiting = this.state === "running" && this.active !== null && this.active.partialLine;
    this.root.dataset.state = this.state;

    this.stateEl.textContent =
      this.state === "running"
        ? waiting
          ? "waiting for input"
          : "running"
        : this.state === "queued"
          ? "queued"
          : this.state === "stopping"
            ? "stopping"
            : this.state === "recovering"
              ? "recovering"
              : "";

    const busy = this.state === "running" || this.state === "queued" || this.state === "stopping";
    this.cancelBtn.hidden = !busy;
    this.cancelBtn.textContent =
      this.state === "stopping" ? "Stopping after the current statement" : "Cancel · Ctrl+C";
    this.cancelBtn.disabled = this.state === "stopping";
    this.exitEl.hidden = busy || this.exitEl.textContent === "";
    this.durationEl.hidden = this.durationEl.textContent === "";

    this.sigil.textContent = waiting ? "?" : "$";
    this.sigil.className = waiting ? "term-sigil term-sigil-ask" : "p term-sigil";

    this.field.disabled = this.state === "recovering";

    if (this.state === "recovering") {
      this.noteEl.textContent = "input disabled until recovery completes";
      this.hintEl.textContent = "the transcript is kept verbatim; nothing is replayed automatically";
    } else if (waiting) {
      // Short on purpose: the command's own prompt is on screen directly
      // above, so this says what the row is for, not what to answer.
      this.noteEl.textContent = "waiting for input · Ctrl+C cancels";
      this.hintEl.textContent = "answers go to the command over stdin · no auto-approve is injected";
    } else if (this.state === "stopping") {
      this.noteEl.textContent = "";
      this.hintEl.textContent = "stopping · the statement already running has to finish first";
    } else if (busy) {
      this.noteEl.textContent = "";
      this.hintEl.textContent = "typing goes to the running command over stdin · Ctrl+C cancels";
    } else if (!this.host.isReady()) {
      this.noteEl.textContent = "";
      this.hintEl.textContent = "the runtime is still loading · a command typed now is queued";
    } else {
      this.noteEl.textContent = "";
      this.hintEl.textContent =
        "argv only · no pipes, redirects or $(…) · ↑ history · Tab completes";
    }

    this.syncCaret();
  }
}

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/** A bar segment. Text only, because everything in the bar is a plain word. */
function text(value: string): HTMLElement {
  const node = document.createElement("span");
  node.textContent = value;
  return node;
}
