/**
 * Scenarios and the state assertions behind the guided route.
 *
 * A scenario is data: files, a seed, and an ordered list of steps. A step is
 * done when its CHECK passes, and every check is answered by asking the real
 * workspace and the real SQLite catalog. Nothing here reads a transcript --
 * `RunRecord` deliberately has no stdout field, so an assertion cannot be
 * written against printed text even by accident. What a command printed is the
 * terminal's business; what is true afterwards is this module's.
 *
 * That is the point of the route: a step advances because the column really is
 * in the catalog, never because a button was pressed. Going off the route is
 * normal, and is reported plainly rather than treated as an error.
 *
 * No DOM here. `guide.ts` renders; this module decides.
 */

import scenarioA from "../scenarios/a.json" with { type: "json" };
import scenarioB from "../scenarios/b.json" with { type: "json" };
import scenarioC from "../scenarios/c.json" with { type: "json" };
import scenarioFree from "../scenarios/free.json" with { type: "json" };

// ---------------------------------------------------------------------------
// the data shape
// ---------------------------------------------------------------------------

/** What a step offers to do next. Never more than one command, never a hidden flag. */
export type Action =
  /** An argv the terminal runs verbatim. Shown in full before it runs. */
  | { kind: "run"; argv: string[] }
  /** SQL put into the SQL pane. The user presses Run there; the guide does not. */
  | { kind: "sql"; sql: string }
  /**
   * An edit to schema.sql. With a patch, the strip offers to apply it and the
   * editor marks the lines it changed; without one, it shows the snippet to
   * copy. Either way the step ticks from the file's content, not the click.
   */
  | { kind: "edit"; file: string; snippet: string; hint: string; patch?: readonly PatchHunk[] };

/**
 * One change a patch makes: text that has to be in the file exactly once,
 * and what it becomes. Anchored on text rather than line numbers, so a patch
 * still applies to a file someone has edited elsewhere, and refuses when the
 * lines it changes are not the ones it was written against.
 */
export interface PatchHunk {
  find: string;
  replace: string;
}

/**
 * What applying a patch to a text would do.
 *
 * `applies` carries the patched text. `applied` means every hunk's result is
 * already in the text, so there is nothing to do. `conflict` names the first
 * hunk whose text is missing or appears more than once; nothing is changed
 * then, because half a patch is a file nobody wrote.
 */
export type PatchResult =
  | { state: "applies"; text: string }
  | { state: "applied" }
  | { state: "conflict"; hunk: number; reason: "missing" | "ambiguous" };

function occurrences(text: string, part: string): number {
  let count = 0;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + 1)) count += 1;
  return count;
}

/**
 * Applies the hunks in order. A hunk whose result is already present is
 * skipped rather than applied twice: a replacement can contain the text it
 * replaces, which adding a block after an anchor does.
 */
export function applyPatch(text: string, hunks: readonly PatchHunk[]): PatchResult {
  let out = text;
  let changed = false;
  for (const [index, hunk] of hunks.entries()) {
    if (out.includes(hunk.replace)) continue;
    const found = occurrences(out, hunk.find);
    if (found !== 1) return { state: "conflict", hunk: index, reason: found === 0 ? "missing" : "ambiguous" };
    out = out.replace(hunk.find, () => hunk.replace);
    changed = true;
  }
  return changed ? { state: "applies", text: out } : { state: "applied" };
}

/**
 * A description of state that is true once a step is done.
 *
 * `ran` is the one kind that looks at command history, and it looks only at
 * argv and exit code -- both facts about the process, not about its output.
 */
export type Check =
  | { kind: "table"; name: string; present: boolean }
  | { kind: "column"; table: string; column: string; present: boolean }
  | { kind: "index"; name: string; present: boolean }
  | { kind: "rows"; table: string; op: "eq" | "gte" | "lte"; count: number }
  /** What a schema file DECLARES, parsed out of the file in the real workspace. */
  | { kind: "declares"; file: string; table?: string; column?: string; index?: string; present: boolean }
  | { kind: "file"; path: string; present: boolean }
  | { kind: "files"; dir: string; suffix: string; atLeast: number }
  | { kind: "ran"; prefix: string[]; has?: string[]; lacks?: string[]; exit?: number; after?: RunMatch }
  | { kind: "all"; of: Check[] }
  | { kind: "any"; of: Check[] }
  | { kind: "not"; of: Check };

/** Which runs a `ran` check counts, and which run it must come after. */
export interface RunMatch {
  /** The leading argv tokens, e.g. ["schema", "drift"]. */
  prefix: string[];
  /** Tokens that must appear anywhere in the argv, e.g. ["--dry-run"]. */
  has?: string[];
  /** Tokens that must not appear. */
  lacks?: string[];
  exit?: number;
}

export interface Step {
  id: string;
  /** The word in the steps nav. */
  title: string;
  /** The small note beside it. */
  caption: string;
  /** The bold line in the strip below the terminal. */
  headline: string;
  /** The sentence under the headline. */
  instruction: string;
  action?: Action;
  /** Other commands worth running here. Offered, never required. */
  also?: string[][];
  /** State that means this step is done, or null when there is nothing to check. */
  check: Check | null;
  /** Required when `check` is null: why the page cannot verify this step. */
  unverified?: string;
  /** Shown once the check passes. Says what is now true, not "well done". */
  done?: string;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  /** How this scenario differs from the others, when that needs saying. */
  note?: string;
  database: { path: string; url: string };
  /** Written into the workspace before anything runs. */
  files: Record<string, string>;
  /** Executed against `database.path` to build the starting database. */
  seed: string;
  /**
   * The state the route assumes. When it fails, the strip says so and the
   * steps stop claiming to describe the workspace. Nothing stops working.
   * Absent only on a scenario with no steps, which assumes nothing: there is
   * no route to fall off.
   */
  baseline?: { check: Check; message: string };
  /** Empty for free exploration: a workspace to try things in, and no route. */
  steps: Step[];
  /**
   * Shown once every checkable step has passed -- the door out, not a trophy.
   * On a scenario with no steps it is what the strip says all along.
   */
  finished: { headline: string; caption: string };
}

// ---------------------------------------------------------------------------
// what the engine is allowed to look at
// ---------------------------------------------------------------------------

/**
 * One finished run, as the route sees it.
 *
 * There is no stdout or stderr here on purpose. The terminal keeps the
 * transcript; assertions get argv and the process's exit code and nothing
 * else, so "the step passed" can never mean "the output contained the right
 * words".
 */
export interface RunRecord {
  /** Monotonic within a session. Used only for ordering. */
  seq: number;
  argv: string[];
  /** 0 success, 1 expected-negative, 2 everything else. The process's own. */
  code: number;
  startedAt: number;
  endedAt: number;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

/** The real state, behind one small interface so the engine stays testable. */
export interface StateProbe {
  /** A read-only query against the scenario's database. */
  query(sql: string): Promise<QueryResult>;
  /** A file in the workspace, or null when it is not there. */
  readFile(path: string): Promise<string | null>;
  /** File names directly under `dir`. Empty when the directory is absent. */
  listFiles(dir: string): Promise<string[]>;
  /** Every finished run this session, oldest first. */
  runs(): readonly RunRecord[];
}

/**
 * Records finished runs for the route to assert against.
 *
 * A class rather than a bare array so the shape stays honest: `record()` takes
 * an argv and an exit code, and there is nowhere to put output even if a
 * caller wanted to.
 */
export class RunLog {
  private readonly entries: RunRecord[] = [];
  private seq = 0;

  record(argv: readonly string[], code: number, startedAt: number, endedAt: number): RunRecord {
    const entry: RunRecord = { seq: ++this.seq, argv: [...argv], code, startedAt, endedAt };
    this.entries.push(entry);
    return entry;
  }

  all(): readonly RunRecord[] {
    return this.entries;
  }

  /** Reset clears the history. The sequence keeps climbing, so a run from
   *  before the reset can never compare equal to one after it. */
  clear(): void {
    this.entries.length = 0;
  }
}

// ---------------------------------------------------------------------------
// reading what a schema file declares
// ---------------------------------------------------------------------------

export interface Declarations {
  /** Lower-cased table name to its lower-cased column names, in file order. */
  tables: Map<string, string[]>;
  /** Lower-cased index names. */
  indexes: Set<string>;
}

interface Token {
  value: string;
  /** `word` covers keywords and bare identifiers; `quoted` is a delimited one. */
  kind: "word" | "quoted" | "string" | "punct";
}

/** Table-level constraints, which start an item that is not a column. */
const TABLE_CONSTRAINTS = new Set(["constraint", "primary", "foreign", "unique", "check", "exclude"]);

// Non-ASCII is folded into the identifier classes so a schema written in a
// language other than English tokenizes as one word rather than as punctuation.
const IDENT_START = /[A-Za-z_\u0080-\uffff]/;
const IDENT_REST = /[A-Za-z0-9_$\u0080-\uffff]/;

/**
 * Split declarative SQL into tokens, dropping comments.
 *
 * Small on purpose. This reads DDL that describes a desired state -- which is
 * why the file is state and not output -- and it is not a SQL engine. Anything
 * it cannot make sense of is skipped, so a half-typed schema file yields fewer
 * declarations rather than an exception.
 */
function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i] as string;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'") {
      const start = ++i;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      out.push({ value: sql.slice(start, i), kind: "string" });
      i++;
      continue;
    }
    if (c === '"' || c === "`") {
      const start = ++i;
      while (i < n && sql[i] !== c) i++;
      out.push({ value: sql.slice(start, i), kind: "quoted" });
      i++;
      continue;
    }
    if (c === "[") {
      const start = ++i;
      while (i < n && sql[i] !== "]") i++;
      out.push({ value: sql.slice(start, i), kind: "quoted" });
      i++;
      continue;
    }
    if (IDENT_START.test(c)) {
      const start = i;
      while (i < n && IDENT_REST.test(sql[i] as string)) i++;
      out.push({ value: sql.slice(start, i), kind: "word" });
      continue;
    }
    if (c >= "0" && c <= "9") {
      const start = i;
      while (i < n && /[0-9.]/.test(sql[i] as string)) i++;
      out.push({ value: sql.slice(start, i), kind: "word" });
      continue;
    }
    out.push({ value: c, kind: "punct" });
    i++;
  }
  return out;
}

function isWord(t: Token | undefined, word: string): boolean {
  return t !== undefined && t.kind === "word" && t.value.toLowerCase() === word;
}

/** An identifier, with an optional `schema.` qualifier dropped. */
function readName(tokens: Token[], at: number): { name: string; next: number } | null {
  const first = tokens[at];
  if (first === undefined || first.kind === "punct" || first.kind === "string") return null;
  let name = first.value;
  let next = at + 1;
  while (tokens[next]?.value === "." && tokens[next + 1] !== undefined) {
    const part = tokens[next + 1] as Token;
    if (part.kind === "punct" || part.kind === "string") break;
    name = part.value;
    next += 2;
  }
  return { name: name.toLowerCase(), next };
}

function skipIfNotExists(tokens: Token[], at: number): number {
  if (isWord(tokens[at], "if") && isWord(tokens[at + 1], "not") && isWord(tokens[at + 2], "exists")) {
    return at + 3;
  }
  return at;
}

function pushColumn(columns: string[], tokens: Token[], start: number): void {
  const head = tokens[start];
  if (head === undefined || head.kind === "punct" || head.kind === "string") return;
  if (head.kind === "word" && TABLE_CONSTRAINTS.has(head.value.toLowerCase())) return;
  columns.push(head.value.toLowerCase());
}

/**
 * What a declarative SQL file asks for.
 *
 * Used by the `declares` check. The file is state -- it is the desired schema,
 * read back out of the real workspace -- so this is a state assertion, not a
 * search through something a command printed.
 */
export function readDeclarations(sql: string): Declarations {
  const tokens = tokenize(sql);
  const tables = new Map<string, string[]>();
  const indexes = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], "create")) continue;
    let at = i + 1;
    while (
      isWord(tokens[at], "unique") || isWord(tokens[at], "temp")
      || isWord(tokens[at], "temporary") || isWord(tokens[at], "virtual")
    ) at++;

    if (isWord(tokens[at], "index")) {
      at = skipIfNotExists(tokens, at + 1);
      const named = readName(tokens, at);
      if (named) indexes.add(named.name);
      continue;
    }
    if (!isWord(tokens[at], "table")) continue;

    at = skipIfNotExists(tokens, at + 1);
    const named = readName(tokens, at);
    if (!named) continue;
    at = named.next;
    if (tokens[at]?.value !== "(" || tokens[at]?.kind !== "punct") {
      // CREATE TABLE ... AS SELECT, or something this reader does not model.
      if (!tables.has(named.name)) tables.set(named.name, []);
      continue;
    }

    // Walk the body, splitting on commas at depth 1. The first token of an
    // item is the column name unless the item is a table constraint.
    const columns: string[] = [];
    let depth = 0;
    let itemStart = at + 1;
    let j = at;
    for (; j < tokens.length; j++) {
      const token = tokens[j] as Token;
      if (token.kind !== "punct") continue;
      if (token.value === "(") depth++;
      else if (token.value === ")") {
        depth--;
        if (depth === 0) break;
      } else if (token.value === "," && depth === 1) {
        pushColumn(columns, tokens, itemStart);
        itemStart = j + 1;
      }
    }
    if (j > itemStart) pushColumn(columns, tokens, itemStart);
    tables.set(named.name, columns);
    i = j;
  }
  return { tables, indexes };
}

// ---------------------------------------------------------------------------
// evaluating checks against real state
// ---------------------------------------------------------------------------

export interface CheckResult {
  ok: boolean;
  /** What was looked at and what came back, in the page's own words. */
  detail: string;
}

/** Thrown when the runtime cannot answer at all, as opposed to answering no. */
class ProbeUnavailable extends Error {}

/** Double-quote an identifier for PRAGMA and FROM. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * One evaluation pass.
 *
 * Caches every question inside the pass, so a five-step route asks SQLite for
 * the table list once rather than fifteen times, and so two steps can never
 * disagree about the same fact.
 */
class Pass {
  private readonly catalogCache = new Map<string, Promise<Set<string>>>();
  private readonly columnsCache = new Map<string, Promise<string[]>>();
  private readonly countCache = new Map<string, Promise<number | null>>();
  private readonly fileCache = new Map<string, Promise<string | null>>();
  private readonly listCache = new Map<string, Promise<string[]>>();
  private readonly declCache = new Map<string, Promise<Declarations | null>>();
  private readonly probe: StateProbe;

  constructor(probe: StateProbe) {
    this.probe = probe;
  }

  private ask<T>(
    cache: Map<string, Promise<T>>,
    key: string,
    make: () => Promise<T>,
  ): Promise<T> {
    let pending = cache.get(key);
    if (!pending) {
      pending = make().catch((err) => {
        throw err instanceof ProbeUnavailable ? err : new ProbeUnavailable(String(err));
      });
      cache.set(key, pending);
    }
    return pending;
  }

  private catalog(type: "table" | "index"): Promise<Set<string>> {
    return this.ask(this.catalogCache, type, async () => {
      const r = await this.probe.query(`SELECT name FROM sqlite_schema WHERE type = '${type}';`);
      return new Set(r.rows.map((row) => String(row[0]).toLowerCase()));
    });
  }

  hasTable(name: string): Promise<boolean> {
    return this.catalog("table").then((names) => names.has(name.toLowerCase()));
  }

  hasIndex(name: string): Promise<boolean> {
    return this.catalog("index").then((names) => names.has(name.toLowerCase()));
  }

  columns(table: string): Promise<string[]> {
    return this.ask(this.columnsCache, table.toLowerCase(), async () => {
      const r = await this.probe.query(`PRAGMA table_info(${quoteIdent(table)});`);
      return r.rows.map((row) => String(row[1]).toLowerCase());
    });
  }

  /**
   * Null when the table is not there.
   *
   * The catalog is consulted first on purpose. `SELECT count(*)` on a missing
   * table is an error, and an error from the bridge is otherwise read as "the
   * runtime cannot answer" -- which would turn a table someone dropped into a
   * page that says it is still booting.
   */
  rowCount(table: string): Promise<number | null> {
    return this.ask(this.countCache, table.toLowerCase(), async () => {
      if (!(await this.hasTable(table))) return null;
      const r = await this.probe.query(`SELECT count(*) FROM ${quoteIdent(table)};`);
      return Number(r.rows[0]?.[0] ?? 0);
    });
  }

  file(path: string): Promise<string | null> {
    return this.ask(this.fileCache, path, () => this.probe.readFile(path));
  }

  list(dir: string): Promise<string[]> {
    return this.ask(this.listCache, dir, () => this.probe.listFiles(dir));
  }

  declarations(path: string): Promise<Declarations | null> {
    return this.ask(this.declCache, path, async () => {
      const text = await this.file(path);
      return text === null ? null : readDeclarations(text);
    });
  }

  runs(): readonly RunRecord[] {
    return this.probe.runs();
  }
}

function matchesRun(record: RunRecord, m: RunMatch): boolean {
  if (m.prefix.some((token, i) => record.argv[i] !== token)) return false;
  if (m.has && !m.has.every((token) => record.argv.includes(token))) return false;
  if (m.lacks && m.lacks.some((token) => record.argv.includes(token))) return false;
  if (m.exit !== undefined && record.code !== m.exit) return false;
  return true;
}

/** `ptah schema drift --schema-file schema.sql ...`, for the strip and for messages. */
export function describeArgv(argv: readonly string[]): string {
  return ["ptah", ...argv].join(" ");
}

function describeMatch(m: RunMatch): string {
  const parts = [...m.prefix];
  if (m.has) parts.push(...m.has);
  if (m.lacks) parts.push(`(without ${m.lacks.join(" ")})`);
  const exit = m.exit === undefined ? "" : ` exiting ${m.exit}`;
  return `ptah ${parts.join(" ")}${exit}`;
}

const OPS: Record<"eq" | "gte" | "lte", { test: (a: number, b: number) => boolean; word: string }> = {
  eq: { test: (a, b) => a === b, word: "" },
  gte: { test: (a, b) => a >= b, word: "at least " },
  lte: { test: (a, b) => a <= b, word: "at most " },
};

async function evaluate(check: Check, pass: Pass): Promise<CheckResult> {
  switch (check.kind) {
    case "table": {
      const has = await pass.hasTable(check.name);
      return {
        ok: has === check.present,
        detail: has ? `${check.name} is in the catalog` : `there is no ${check.name} table in the database`,
      };
    }
    case "column": {
      const cols = await pass.columns(check.table);
      const has = cols.includes(check.column.toLowerCase());
      return {
        ok: has === check.present,
        detail: has
          ? `${check.table}.${check.column} is in the catalog`
          : cols.length === 0
            ? `there is no ${check.table} table to read columns from`
            : `${check.table} has ${cols.join(", ")} and no ${check.column}`,
      };
    }
    case "index": {
      const has = await pass.hasIndex(check.name);
      return {
        ok: has === check.present,
        detail: has ? `index ${check.name} exists` : `index ${check.name} is not in the catalog`,
      };
    }
    case "rows": {
      const n = await pass.rowCount(check.table);
      if (n === null) return { ok: false, detail: `there is no ${check.table} table to count` };
      const op = OPS[check.op];
      const ok = op.test(n, check.count);
      return {
        ok,
        detail: `${check.table} has ${n} ${n === 1 ? "row" : "rows"}`
          + (ok ? "" : `, not ${op.word}${check.count}`),
      };
    }
    case "declares": {
      const decls = await pass.declarations(check.file);
      if (decls === null) {
        return { ok: !check.present, detail: `${check.file} is not in the workspace` };
      }
      if (check.index !== undefined) {
        const has = decls.indexes.has(check.index.toLowerCase());
        return {
          ok: has === check.present,
          detail: has
            ? `${check.file} declares index ${check.index}`
            : `${check.file} does not declare index ${check.index}`,
        };
      }
      const table = (check.table ?? "").toLowerCase();
      const cols = decls.tables.get(table);
      if (check.column === undefined) {
        const has = cols !== undefined;
        return {
          ok: has === check.present,
          detail: has ? `${check.file} declares ${table}` : `${check.file} does not declare ${table}`,
        };
      }
      const has = cols !== undefined && cols.includes(check.column.toLowerCase());
      return {
        ok: has === check.present,
        detail: cols === undefined
          ? `${check.file} does not declare a ${table} table`
          : has
            ? `${check.file} declares ${table}.${check.column}`
            : `${check.file} declares ${table} with ${cols.join(", ")} and no ${check.column}`,
      };
    }
    case "file": {
      const text = await pass.file(check.path);
      const has = text !== null;
      return {
        ok: has === check.present,
        detail: has ? `${check.path} is in the workspace` : `${check.path} is not in the workspace`,
      };
    }
    case "files": {
      const names = await pass.list(check.dir);
      const hits = names.filter((name) => name.endsWith(check.suffix));
      return {
        ok: hits.length >= check.atLeast,
        detail: hits.length >= check.atLeast
          ? `${check.dir}/ holds ${hits.length} *${check.suffix} ${hits.length === 1 ? "file" : "files"}`
          : `${check.dir}/ holds no *${check.suffix} file yet`,
      };
    }
    case "ran": {
      const records = pass.runs();
      const self: RunMatch = { prefix: check.prefix };
      if (check.has) self.has = check.has;
      if (check.lacks) self.lacks = check.lacks;
      if (check.exit !== undefined) self.exit = check.exit;

      let floor = 0;
      if (check.after) {
        const previous = records.filter((r) => matchesRun(r, check.after as RunMatch)).at(-1);
        if (!previous) return { ok: false, detail: `${describeMatch(check.after)} has not run yet` };
        floor = previous.seq;
      }
      const hit = records.find((r) => r.seq > floor && matchesRun(r, self));
      if (hit) return { ok: true, detail: `${describeArgv(hit.argv)} exited ${hit.code}` };

      // Distinguish "never ran" from "ran and answered something else": the
      // second is a result the person needs to see, not a missing step.
      const anyExit: RunMatch = { ...self };
      delete anyExit.exit;
      const loose = records.filter((r) => r.seq > floor && matchesRun(r, anyExit)).at(-1);
      if (loose && check.exit !== undefined) {
        return {
          ok: false,
          detail: `the last ptah ${check.prefix.join(" ")} exited ${loose.code}, not ${check.exit}`,
        };
      }
      return { ok: false, detail: `${describeMatch(self)} has not run${check.after ? " since" : " yet"}` };
    }
    case "all": {
      const results = await Promise.all(check.of.map((c) => evaluate(c, pass)));
      const failed = results.filter((r) => !r.ok);
      return failed.length === 0
        ? { ok: true, detail: results.map((r) => r.detail).join("; ") }
        : { ok: false, detail: failed.map((r) => r.detail).join("; ") };
    }
    case "any": {
      const results = await Promise.all(check.of.map((c) => evaluate(c, pass)));
      const passed = results.find((r) => r.ok);
      return passed ?? { ok: false, detail: results.map((r) => r.detail).join(", or ") };
    }
    case "not": {
      const inner = await evaluate(check.of, pass);
      return { ok: !inner.ok, detail: inner.detail };
    }
  }
}

/**
 * Evaluate one check against real state.
 *
 * Never throws. A probe that cannot answer produces `ok: false` with a detail
 * saying so, because a step whose state is unknown must not claim to be either
 * done or undone.
 */
export async function evaluateCheck(check: Check, probe: StateProbe): Promise<CheckResult> {
  try {
    return await evaluate(check, new Pass(probe));
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof ProbeUnavailable
        ? "the runtime has not answered yet"
        : `this check could not be evaluated: ${String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

export type StepStatus =
  /** The check passed against real state. */
  | "done"
  /** The first step whose check has not passed. */
  | "current"
  | "todo"
  /** There is nothing this page can check. Said out loud, never faked. */
  | "unverifiable"
  /** The runtime cannot answer yet, so the truth is not known. */
  | "unknown";

export interface StepState {
  step: Step;
  index: number;
  status: StepStatus;
  /** What the check looked at and what it found. */
  detail: string;
}

export interface RouteState {
  scenario: Scenario;
  steps: StepState[];
  /** The step the strip points at, or -1 when every step is settled. */
  currentIndex: number;
  /**
   * Set when the workspace no longer matches what the route describes: the
   * baseline is gone, or the completed steps have stopped being a prefix.
   * Advice, not an error -- everything keeps working.
   */
  offScript: string | null;
  /** Set while the runtime cannot answer. Steps then read "unknown". */
  unavailable: string | null;
}

/** Step numbers are two digits in the design: 01, 02, ... */
export function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Score every step of a scenario against the real workspace and the real
 * catalog.
 *
 * The current step is the first one whose check has not passed. A later step
 * passing while an earlier one does not is neither a bug nor an error: it is
 * someone working their own way, and it is reported as such.
 */
export async function evaluateRoute(scenario: Scenario, probe: StateProbe): Promise<RouteState> {
  const pass = new Pass(probe);
  let unavailable: string | null = null;

  const score = async (check: Check): Promise<CheckResult> => {
    if (unavailable !== null) return { ok: false, detail: unavailable };
    try {
      return await evaluate(check, pass);
    } catch (err) {
      if (err instanceof ProbeUnavailable) {
        unavailable = "the runtime has not answered yet, so nothing below has been checked";
        return { ok: false, detail: unavailable };
      }
      // A bug in one check must not take the page down with it.
      return { ok: false, detail: `this check could not be evaluated: ${String(err)}` };
    }
  };

  const results: { ok: boolean; detail: string; checked: boolean }[] = [];
  for (const step of scenario.steps) {
    if (step.check === null) {
      results.push({ ok: false, detail: step.unverified ?? "", checked: false });
      continue;
    }
    const result = await score(step.check);
    results.push({ ok: result.ok, detail: result.detail, checked: true });
  }
  const baseline = scenario.baseline === undefined ? { ok: true, detail: "" } : await score(scenario.baseline.check);

  const done = results.map((r) => r.checked && r.ok && unavailable === null);
  const lastDone = done.lastIndexOf(true);

  // The step the strip points at: the first one that is not done. A step with
  // nothing to check is stepped over once something after it is done, because
  // it can never become done on its own and must not park the route forever.
  let currentIndex = -1;
  for (let i = 0; i < results.length; i++) {
    if (done[i]) continue;
    if (!results[i]?.checked && i < lastDone) continue;
    currentIndex = i;
    break;
  }

  const steps: StepState[] = scenario.steps.map((step, index) => {
    const result = results[index] as { ok: boolean; detail: string; checked: boolean };
    let status: StepStatus;
    if (!result.checked) status = "unverifiable";
    else if (unavailable !== null) status = "unknown";
    else if (result.ok) status = "done";
    else if (index === currentIndex) status = "current";
    else status = "todo";
    return { step, index, status, detail: result.detail };
  });

  let offScript: string | null = null;
  if (unavailable === null) {
    if (!baseline.ok) {
      offScript = `${scenario.baseline?.message ?? ""} (${baseline.detail})`;
    } else {
      // Off the route means the done steps are not a prefix: something later
      // is done while something earlier is not. The gap is named by its first
      // step, and the progress by the furthest step that really is done --
      // which is where the person actually got to.
      const gap = steps.find((s) => s.status !== "done" && s.status !== "unverifiable" && s.index < lastDone);
      if (gap && lastDone !== -1) {
        const ahead = steps[lastDone] as StepState;
        offScript = `Step ${pad(ahead.index + 1)} ${ahead.step.title} is done while step `
          + `${pad(gap.index + 1)} ${gap.step.title} is not: ${gap.detail}. `
          + `The route is a suggestion, so this is fine. Every step above is scored from the real `
          + `workspace, and any of them can be run again.`;
      }
    }
  }

  return { scenario, steps, currentIndex, offScript, unavailable };
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

function fail(where: string, what: string): never {
  throw new Error(`scenario ${where}: ${what}`);
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string") fail(where, `expected a string, got ${typeof value}`);
  return value;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(where, "expected an object");
  }
  return value as Record<string, unknown>;
}

const CHECK_KINDS = new Set([
  "table", "column", "index", "rows", "declares", "file", "files", "ran", "all", "any", "not",
]);

function parseCheck(value: unknown, where: string): Check {
  const raw = asRecord(value, where);
  const kind = asString(raw["kind"], `${where}.kind`);
  if (!CHECK_KINDS.has(kind)) fail(`${where}.kind`, `unknown check kind "${kind}"`);
  if (kind === "all" || kind === "any") {
    const of = raw["of"];
    if (!Array.isArray(of) || of.length === 0) fail(`${where}.of`, "expected a non-empty array");
    return { kind, of: of.map((c, i) => parseCheck(c, `${where}.of[${i}]`)) } as Check;
  }
  if (kind === "not") return { kind, of: parseCheck(raw["of"], `${where}.of`) };
  // The remaining kinds are flat records of primitives. A wrong field shows up
  // as a failing check with a readable detail, rather than as a page that
  // refuses to start.
  return raw as unknown as Check;
}

/**
 * A suggested command must never approve on the user's behalf.
 *
 * `schema apply` reads the literal string YES off stdin, and that moment is
 * what the product is about. A button carrying --auto-approve would turn it
 * into a formality, so the flag is refused at load rather than reviewed later.
 */
const FORBIDDEN_FLAGS = ["--auto-approve", "--yes", "--force", "--no-confirm"];

function assertNoHiddenApproval(argv: readonly string[], where: string): void {
  for (const token of argv) {
    const flag = token.split("=")[0] as string;
    if (FORBIDDEN_FLAGS.includes(flag)) {
      fail(where, `suggested commands must not carry ${flag}; the confirmation is the user's to give`);
    }
  }
}

/**
 * A patch is checked at load, because a hunk that cannot be told apart from
 * its result would report "applied" on a file it never touched.
 */
function parsePatch(action: Extract<Action, { kind: "edit" }>, where: string): void {
  // The editor edits one file, and the patch is applied to its buffer.
  if (action.file !== "schema.sql") fail(`${where}.file`, "a patch can only be applied to schema.sql");
  const patch: unknown = action.patch;
  if (!Array.isArray(patch) || patch.length === 0) fail(`${where}.patch`, "expected a non-empty array");
  patch.forEach((raw, i) => {
    const hunk = asRecord(raw, `${where}.patch[${i}]`);
    const find = asString(hunk["find"], `${where}.patch[${i}].find`);
    const replace = asString(hunk["replace"], `${where}.patch[${i}].replace`);
    if (find === "") fail(`${where}.patch[${i}].find`, "expected text to anchor on");
    if (find.includes(replace)) {
      fail(`${where}.patch[${i}]`, "the replacement is inside the text it replaces, so an applied patch would look unapplied");
    }
  });
}

function parseStep(value: unknown, where: string): Step {
  const raw = asRecord(value, where);
  const check = raw["check"] === null || raw["check"] === undefined
    ? null
    : parseCheck(raw["check"], `${where}.check`);
  if (check === null && typeof raw["unverified"] !== "string") {
    fail(where, "a step with no check must say why in `unverified`");
  }
  const step: Step = {
    id: asString(raw["id"], `${where}.id`),
    title: asString(raw["title"], `${where}.title`),
    caption: asString(raw["caption"], `${where}.caption`),
    headline: asString(raw["headline"], `${where}.headline`),
    instruction: asString(raw["instruction"], `${where}.instruction`),
    check,
  };
  if (raw["action"] !== undefined) step.action = raw["action"] as Action;
  if (step.action?.kind === "edit" && (step.action as { patch?: unknown }).patch !== undefined) {
    parsePatch(step.action, `${where}.action`);
  }
  if (raw["also"] !== undefined) step.also = raw["also"] as string[][];
  if (raw["unverified"] !== undefined) step.unverified = asString(raw["unverified"], `${where}.unverified`);
  if (raw["done"] !== undefined) step.done = asString(raw["done"], `${where}.done`);

  if (step.action?.kind === "run") assertNoHiddenApproval(step.action.argv, `${where}.action`);
  for (const argv of step.also ?? []) assertNoHiddenApproval(argv, `${where}.also`);
  return step;
}

/**
 * Turn parsed JSON into a Scenario, or say exactly what is wrong with it.
 *
 * Strict about the things a wrong value would make dishonest -- a step with no
 * check and no explanation, a suggested command that hides an approval flag --
 * and relaxed about everything else.
 */
export function parseScenario(value: unknown): Scenario {
  const raw = asRecord(value, "<root>");
  const id = asString(raw["id"], "id");
  const where = `"${id}"`;
  const steps = raw["steps"];
  // No steps is free exploration. A route, though, assumes a starting state
  // and has to say what it is, or falling off it could never be reported.
  if (!Array.isArray(steps)) fail(`${where}.steps`, "expected an array");
  if (steps.length > 0 && raw["baseline"] === undefined) {
    fail(`${where}.baseline`, "a scenario with steps must say what state they assume");
  }

  const database = asRecord(raw["database"], `${where}.database`);
  const finished = asRecord(raw["finished"], `${where}.finished`);

  const scenario: Scenario = {
    id,
    title: asString(raw["title"], `${where}.title`),
    description: asString(raw["description"], `${where}.description`),
    database: {
      path: asString(database["path"], `${where}.database.path`),
      url: asString(database["url"], `${where}.database.url`),
    },
    files: asRecord(raw["files"], `${where}.files`) as Record<string, string>,
    seed: asString(raw["seed"], `${where}.seed`),
    steps: steps.map((s, i) => parseStep(s, `${where}.steps[${i}]`)),
    finished: {
      headline: asString(finished["headline"], `${where}.finished.headline`),
      caption: asString(finished["caption"], `${where}.finished.caption`),
    },
  };
  if (raw["note"] !== undefined) scenario.note = asString(raw["note"], `${where}.note`);
  if (raw["baseline"] !== undefined) {
    const baseline = asRecord(raw["baseline"], `${where}.baseline`);
    scenario.baseline = {
      check: parseCheck(baseline["check"], `${where}.baseline.check`),
      message: asString(baseline["message"], `${where}.baseline.message`),
    };
  }
  return scenario;
}

/** The scenarios this build ships, parsed at load so a bad one is loud. */
export const SCENARIOS: readonly Scenario[] = [scenarioA, scenarioB, scenarioC, scenarioFree].map(parseScenario);

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
