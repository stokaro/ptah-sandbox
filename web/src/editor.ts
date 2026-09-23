/**
 * The schema and SQL editor.
 *
 * A textarea with a highlight overlay behind it, not a code-editor library.
 * The mock asks for three things -- keywords in the site's blue, line
 * numbers, and marks on the lines that differ from the file as it was
 * seeded -- and an overlay does all three in a few hundred bytes of gzipped
 * JavaScript.
 * CodeMirror 6 with the SQL grammar is about 110 KB gzipped, which on a page
 * that already asks for a 22 MB WebAssembly download is a poor trade for
 * bracket matching nobody asked for.
 *
 * The overlay only works while its metrics match the textarea's exactly, so
 * the font, size, line height, padding and tab size are set once as custom
 * properties in panes.css and shared by both layers. Anything that would
 * break that -- soft wrapping, a proportional font, per-line decoration that
 * changes height -- is deliberately absent.
 *
 * Both buffers are plain text at all times. Nothing here parses SQL for
 * meaning; the tokenizer exists to colour words and to keep a keyword inside
 * a string literal from being coloured, and nothing downstream reads it.
 */

import { lineMarks, splitLines } from "./linediff.ts";
import { clear, el, fill } from "./panes/dom.ts";

/**
 * `file` is the read-only view of some other workspace file.
 *
 * It is a buffer of its own rather than a reuse of `schema`, because reusing
 * that one replaced the desired schema with whatever was clicked and left no
 * way back to it: activating the schema tab afterwards showed the other file,
 * and typing into the "read-only view" saved it over schema.sql.
 */
export type EditorTabId = "schema" | "sql" | "file";

export interface EditorHandlers {
  /** Fired on every edit, with the buffer's own revision counter. */
  onChange?(id: EditorTabId, text: string, revision: number): void;
  onTabChange?(id: EditorTabId): void;
  /** The SQL tab's Run, from the button or from Cmd/Ctrl+Enter. */
  onSubmit?(text: string): void;
}

/**
 * Above this the overlay is switched off and the strip says so.
 *
 * Re-tokenizing the whole buffer per frame is fine for a schema file and is
 * not fine for a pasted dump. Saying "highlighting off" is better than
 * shipping a keystroke latency nobody can explain.
 */
const HIGHLIGHT_LINE_LIMIT = 4000;


// --------------------------------------------------------------------------
// Tokenizer
// --------------------------------------------------------------------------

export type TokenKind = "plain" | "keyword" | "comment" | "string";

export interface Token {
  kind: TokenKind;
  text: string;
}

/**
 * SQLite's keyword list plus the type names a schema file uses.
 *
 * Type names are not reserved words in SQLite, so colouring them is a
 * presentation choice rather than a claim about the grammar. It matches the
 * mock and it is what makes a CREATE TABLE readable at a glance.
 */
const KEYWORDS = new Set(
  (
    "abort action add after all alter always analyze and as asc attach autoincrement before begin " +
    "between by cascade case cast check collate column commit conflict constraint create cross " +
    "current current_date current_time current_timestamp database default deferrable deferred delete " +
    "desc detach distinct do drop each else end escape except exclude exclusive exists explain fail " +
    "filter first following for foreign from full generated glob group groups having if ignore " +
    "immediate in index indexed initially inner insert instead intersect into is isnull join key " +
    "last left like limit match materialized natural no not nothing notnull null nulls of offset on " +
    "or order others outer over partition plan pragma preceding primary query raise range recursive " +
    "references regexp reindex release rename replace restrict returning right rollback row rows " +
    "savepoint select set table temp temporary then ties to transaction trigger unbounded union " +
    "unique update using vacuum values view virtual when where window with without " +
    "blob boolean char date datetime decimal double float int int8 integer numeric real smallint " +
    "text time timestamp tinyint varchar"
  ).split(" "),
);

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Splits SQL into coloured runs, keeping line structure.
 *
 * Comments and string literals are recognised before words, so `-- not null`
 * stays a comment and `'select'` stays a string. Quoted identifiers are
 * recognised too and come out plain: a table deliberately named "select" is
 * an identifier, and colouring it as a keyword would misrepresent the file.
 */
export function tokenizeSQL(text: string): Token[][] {
  const runs: Token[] = [];
  let i = 0;
  const n = text.length;

  const push = (kind: TokenKind, from: number, to: number): void => {
    if (to > from) runs.push({ kind, text: text.slice(from, to) });
  };

  while (i < n) {
    const ch = text[i]!;

    if (ch === "-" && text[i + 1] === "-") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      push("comment", i, stop);
      i = stop;
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      push("comment", i, stop);
      i = stop;
      continue;
    }

    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") j += 2;
          else {
            j += 1;
            break;
          }
        } else j += 1;
      }
      push("string", i, j);
      i = j;
      continue;
    }

    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < n) {
        if (text[j] === close) {
          if (close !== "]" && text[j + 1] === close) j += 2;
          else {
            j += 1;
            break;
          }
        } else j += 1;
      }
      // A quoted identifier is never a keyword, whatever it spells.
      push("plain", i, j);
      i = j;
      continue;
    }

    if (isWordChar(ch) && !/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && isWordChar(text[j]!)) j += 1;
      const word = text.slice(i, j);
      push(KEYWORDS.has(word.toLowerCase()) ? "keyword" : "plain", i, j);
      i = j;
      continue;
    }

    // Everything else: run forward to the next character that could start a
    // token, so ordinary punctuation and numbers cost one run, not one each.
    let j = i + 1;
    while (j < n) {
      const c = text[j]!;
      if (c === "'" || c === '"' || c === "`" || c === "[" || c === "\n") break;
      if (c === "-" && text[j + 1] === "-") break;
      if (c === "/" && text[j + 1] === "*") break;
      if (isWordChar(c) && !/[0-9]/.test(c)) break;
      j += 1;
    }
    push("plain", i, j);
    i = j;
  }

  // Split the runs back into lines. A block comment spanning lines becomes
  // one comment token per line, which is what the per-line rendering needs.
  const lines: Token[][] = [[]];
  for (const run of runs) {
    const parts = run.text.split("\n");
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) lines.push([]);
      if (parts[p] !== "") lines[lines.length - 1]!.push({ kind: run.kind, text: parts[p]! });
    }
  }
  return lines;
}

// --------------------------------------------------------------------------
// The editor
// --------------------------------------------------------------------------

interface Buffer {
  id: EditorTabId;
  label: string;
  text: string;
  /**
   * The text the change marks are measured against: the file as the
   * workspace was seeded or imported, the way an editor's gutter measures
   * against the last commit. It is not what was saved last. Every edit is
   * saved a moment after it is typed, so marks measured against the save
   * vanished before anyone could read them.
   *
   * null means there is nothing to compare with -- the scratch SQL buffer is
   * not a file, so nothing in it is a change to anything. Marking it all as
   * changed, which is what an empty-string baseline does, would be a claim
   * about a file that does not exist.
   */
  baseline: string | null;
  /** Bumps on every edit. The plan pane compares against this. */
  revision: number;
  /** The workspace revision this buffer was last written at, or null. */
  syncedAt: number | null;
  meta: string;
  metaTone: "mute" | "amber";
  footerLeft: string;
  footerRight: string | null;
}

const TAB_LABELS: Record<EditorTabId, string> = { schema: "schema.sql", sql: "SQL", file: "file" };

export class Editor {
  private handlers: EditorHandlers;
  private buffers: Record<EditorTabId, Buffer>;
  private current: EditorTabId = "schema";

  private tabs: Record<EditorTabId, HTMLButtonElement>;
  private meta: HTMLElement;
  /** The run of numbers inside the gutter, not the gutter box: only the
   *  numbers are translated, so the gutter's border does not scroll away. */
  private gutter: HTMLElement;
  private overlay: HTMLElement;
  private input: HTMLTextAreaElement;
  private runRow: HTMLElement;
  private runButton: HTMLButtonElement;
  private stripLeft: HTMLElement;
  private stripRight: HTMLElement;
  private notice: HTMLElement;

  private repaintQueued = false;
  private lockedByHost = false;
  private lockReason = "";

  constructor(host: HTMLElement, handlers: EditorHandlers = {}) {
    // The root class carries every metric the overlay depends on, so the
    // component sets it rather than trusting the caller's markup.
    host.classList.add("pgc-editor");
    this.handlers = handlers;
    this.buffers = {
      schema: {
        id: "schema",
        label: TAB_LABELS.schema,
        text: "",
        baseline: null,
        revision: 0,
        syncedAt: null,
        meta: "",
        metaTone: "mute",
        footerLeft: "SQL · desired state",
        footerRight: null,
      },
      sql: {
        id: "sql",
        label: TAB_LABELS.sql,
        text: "",
        baseline: null,
        revision: 0,
        syncedAt: null,
        meta: "",
        metaTone: "mute",
        footerLeft: "SQL · executes in app.db",
        footerRight: null,
      },
      file: {
        id: "file",
        label: TAB_LABELS.file,
        text: "",
        baseline: null,
        revision: 0,
        syncedAt: null,
        meta: "",
        metaTone: "mute",
        footerLeft: "read-only",
        footerRight: null,
      },
    };

    // A literal skeleton: nothing here is interpolated, and no data ever
    // reaches the page this way.
    host.innerHTML = `
      <div class="pgc-tabbar">
        <div class="pgc-tablist" role="tablist" aria-label="Editor"></div>
        <span class="pgc-tabmeta"></span>
      </div>
      <div class="pgc-ed">
        <div class="pgc-ed-gutter" aria-hidden="true"><span class="pgc-ed-nums"></span></div>
        <div class="pgc-ed-code">
          <pre class="pgc-ed-overlay" aria-hidden="true"></pre>
          <textarea class="pgc-ed-input" spellcheck="false" autocapitalize="off"
                    autocorrect="off" wrap="off"
                    aria-describedby="pgc-ed-help"></textarea>
        </div>
      </div>
      <p id="pgc-ed-help" class="pgc-sr">Tab inserts two spaces. Press Escape then Tab to leave the editor.</p>
      <div class="pgc-ed-run" hidden>
        <button class="btn" type="button">Run</button>
        <span class="pgc-hint">⌘↵ · one submit is one unit of work; an open BEGIN is rolled back when it ends</span>
      </div>
      <p class="pgc-ed-notice" hidden></p>
      <div class="pgc-strip">
        <span class="pgc-strip-left"></span>
        <span class="pgc-strip-right"></span>
      </div>`;

    const tablist = host.querySelector<HTMLElement>(".pgc-tablist")!;
    this.tabs = {
      schema: this.makeTab(tablist, "schema"),
      sql: this.makeTab(tablist, "sql"),
      // Hidden until a file is opened into it, so the bar carries two tabs
      // until there is a third thing to show.
      file: this.makeTab(tablist, "file"),
    };
    this.tabs.file.hidden = true;
    this.meta = host.querySelector<HTMLElement>(".pgc-tabmeta")!;
    this.gutter = host.querySelector<HTMLElement>(".pgc-ed-nums")!;
    this.overlay = host.querySelector<HTMLElement>(".pgc-ed-overlay")!;
    this.input = host.querySelector<HTMLTextAreaElement>(".pgc-ed-input")!;
    this.runRow = host.querySelector<HTMLElement>(".pgc-ed-run")!;
    this.runButton = this.runRow.querySelector<HTMLButtonElement>("button")!;
    this.stripLeft = host.querySelector<HTMLElement>(".pgc-strip-left")!;
    this.stripRight = host.querySelector<HTMLElement>(".pgc-strip-right")!;
    this.notice = host.querySelector<HTMLElement>(".pgc-ed-notice")!;

    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("scroll", () => this.syncScroll());
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.runButton.addEventListener("click", () => {
      this.handlers.onSubmit?.(this.buffers.sql.text);
    });

    this.activate("schema");
  }

  private makeTab(list: HTMLElement, id: EditorTabId): HTMLButtonElement {
    const tab = el("button", "pgc-tab", TAB_LABELS[id]);
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.addEventListener("click", () => this.activate(id));
    list.appendChild(tab);
    return tab;
  }

  // ---- state -------------------------------------------------------------

  active(): EditorTabId {
    return this.current;
  }

  activate(id: EditorTabId): void {
    const changed = this.current !== id;
    this.current = id;
    for (const key of ["schema", "sql", "file"] as const) {
      const on = key === id;
      this.tabs[key].classList.toggle("is-active", on);
      this.tabs[key].setAttribute("aria-selected", on ? "true" : "false");
    }
    this.input.value = this.buffers[id].text;
    this.runRow.hidden = id !== "sql";
    this.applyReadOnly();
    this.repaint();
    if (changed) this.handlers.onTabChange?.(id);
  }

  text(id: EditorTabId = this.current): string {
    return this.buffers[id].text;
  }

  bufferRevision(id: EditorTabId = this.current): number {
    return this.buffers[id].revision;
  }

  /** True when the buffer holds edits that have not been written anywhere. */
  isDirty(id: EditorTabId = this.current): boolean {
    return this.buffers[id].syncedAt === null && this.buffers[id].revision > 0;
  }

  /**
   * Replaces a buffer.
   *
   * `baseline` is what the changed-line marks compare against; pass the text
   * as it exists on disk. Setting text this way does not fire onChange --
   * the caller already knows -- and does not bump the buffer revision unless
   * `edit` is set, so loading a file is not reported as an edit.
   */
  setText(
    id: EditorTabId,
    text: string,
    options: { baseline?: string | null; syncedAt?: number | null; edit?: boolean } = {},
  ): void {
    const buffer = this.buffers[id];
    buffer.text = text;
    if (options.baseline !== undefined) buffer.baseline = options.baseline;
    if (options.syncedAt !== undefined) buffer.syncedAt = options.syncedAt;
    if (options.edit) buffer.revision += 1;
    if (this.current === id) {
      this.input.value = text;
      this.repaint();
    }
  }

  /** The buffer now matches the workspace file at that revision. */
  markSynced(id: EditorTabId, revision: number): void {
    this.buffers[id].syncedAt = revision;
    if (this.current === id) this.repaint();
  }

  /**
   * Replaces a buffer the way typing would: a new revision, unsaved, and
   * onChange fired, so whatever follows an edit -- the save, the plan marked
   * stale -- follows this one too.
   */
  edit(id: EditorTabId, text: string): void {
    const buffer = this.buffers[id];
    buffer.text = text;
    buffer.revision += 1;
    buffer.syncedAt = null;
    if (this.current === id) {
      this.input.value = text;
      this.repaint();
    }
    this.handlers.onChange?.(id, text, buffer.revision);
  }

  /** Scrolls the textarea so that line (0-based) is on screen, if it is not. */
  reveal(line: number): void {
    const height = Number.parseFloat(getComputedStyle(this.input).lineHeight) || 21;
    const top = line * height;
    const view = this.input.clientHeight;
    if (top >= this.input.scrollTop && top + height <= this.input.scrollTop + view) return;
    this.input.scrollTop = Math.max(0, top - view / 3);
    this.syncScroll();
  }

  setBaseline(id: EditorTabId, text: string | null): void {
    this.buffers[id].baseline = text;
    if (this.current === id) this.repaint();
  }

  /** The right-hand note in the tab bar: "2 changes · not applied". */
  setMeta(id: EditorTabId, text: string, tone: "mute" | "amber" = "mute"): void {
    this.buffers[id].meta = text;
    this.buffers[id].metaTone = tone;
    if (this.current === id) this.paintChrome();
  }

  /** The footer strip. The right half defaults to the revision. */
  /**
   * Shows one workspace file, read-only, in its own tab.
   *
   * Read-only is enforced here rather than left to the caller: the text is a
   * copy of a file the playground does not write back, and an editable copy
   * would either lose what was typed or save it somewhere surprising.
   */
  showFile(name: string, text: string, note = "read-only"): void {
    const buffer = this.buffers.file;
    buffer.label = name;
    buffer.text = text;
    buffer.baseline = text;
    buffer.footerLeft = `${name} · ${note}`;
    buffer.footerRight = null;
    this.tabs.file.textContent = name;
    this.tabs.file.hidden = false;
    this.activate("file");
  }

  /** Puts the file tab away; the schema tab keeps its own text throughout. */
  closeFile(): void {
    this.tabs.file.hidden = true;
    this.buffers.file.text = "";
    this.buffers.file.label = TAB_LABELS.file;
    if (this.current === "file") this.activate("schema");
  }

  setFooter(id: EditorTabId, left: string, right?: string | null): void {
    this.buffers[id].footerLeft = left;
    if (right !== undefined) this.buffers[id].footerRight = right;
    if (this.current === id) this.paintChrome();
  }

  /**
   * Locks editing, with the reason on screen.
   *
   * Used while a command owns the workspace and while the runtime is being
   * restored, where an edit would be written into a file the command is
   * reading.
   */
  setReadOnly(on: boolean, reason = ""): void {
    this.lockedByHost = on;
    this.lockReason = reason;
    this.applyReadOnly();
  }

  /**
   * The file tab is always read-only, whatever the host asked for; the other
   * two follow the host. Applied on every activation, because otherwise
   * leaving the file tab would leave the textarea locked and entering it from
   * an unlocked tab would leave it writable.
   */
  private applyReadOnly(): void {
    const viewing = this.current === "file";
    const on = viewing || this.lockedByHost;
    const reason = viewing && !this.lockedByHost
      ? "A view of a workspace file. Ptah reads the file, so edit it where it lives, not here."
      : this.lockReason;
    this.input.readOnly = on;
    this.runButton.disabled = this.lockedByHost;
    this.notice.hidden = !on || reason === "";
    this.notice.textContent = reason;
  }

  focus(): void {
    this.input.focus();
  }

  // ---- input -------------------------------------------------------------

  private onInput(): void {
    const buffer = this.buffers[this.current];
    buffer.text = this.input.value;
    buffer.revision += 1;
    buffer.syncedAt = null;
    this.repaint();
    this.handlers.onChange?.(buffer.id, buffer.text, buffer.revision);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      if (this.current === "sql") {
        e.preventDefault();
        this.handlers.onSubmit?.(this.buffers.sql.text);
      }
      return;
    }
    if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // Tab indents, because this is a code editor. Escape then Tab leaves,
      // which is the escape hatch a keyboard user needs and the reason the
      // textarea carries an aria-describedby saying so.
      e.preventDefault();
      this.insertAtCursor("  ");
    }
  }

  private insertAtCursor(text: string): void {
    const start = this.input.selectionStart;
    const end = this.input.selectionEnd;
    // setRangeText keeps the browser's own undo stack, which a manual
    // value rewrite would throw away.
    this.input.setRangeText(text, start, end, "end");
    this.onInput();
  }

  // ---- painting ----------------------------------------------------------

  private repaint(): void {
    if (this.repaintQueued) return;
    this.repaintQueued = true;
    // One rebuild per frame: a fast typist otherwise re-tokenizes the buffer
    // several times between paints for no visible gain.
    const run = (): void => {
      this.repaintQueued = false;
      this.paintChrome();
      this.paintCode();
      this.syncScroll();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  }

  private paintChrome(): void {
    const buffer = this.buffers[this.current];
    this.meta.textContent = buffer.meta;
    this.meta.classList.toggle("is-amber", buffer.metaTone === "amber");
    this.stripLeft.textContent = buffer.footerLeft;
    this.stripRight.textContent = buffer.footerRight ?? this.defaultRevisionText(buffer);
  }

  private defaultRevisionText(buffer: Buffer): string {
    if (buffer.syncedAt !== null) return `revision r${buffer.syncedAt}`;
    if (buffer.revision === 0) return "";
    return "unsaved";
  }

  private paintCode(): void {
    const buffer = this.buffers[this.current];
    const lines = buffer.text.split("\n");

    // Lines as a version-control tool counts them, which drops the empty tail
    // after a final newline; the indexes line up with `lines` all the same.
    const marks =
      buffer.baseline === null || lines.length > HIGHLIGHT_LINE_LIMIT
        ? null
        : lineMarks(splitLines(buffer.baseline), splitLines(buffer.text));

    // One row per line, so a line can carry its mark in the gutter too.
    const numbers = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      const row = el("span", "pgc-ed-num", String(i + 1));
      const change = marks?.changed.get(i);
      if (change) row.classList.add(`is-${change}`);
      if (marks?.removedAbove.has(i)) row.classList.add("has-removed-above");
      numbers.appendChild(row);
    }
    // Lines removed from the very end sit below the last line there is.
    if (marks?.removedAbove.has(lines.length)) numbers.lastElementChild?.classList.add("has-removed-below");
    clear(this.gutter);
    this.gutter.appendChild(numbers);

    clear(this.overlay);
    if (lines.length > HIGHLIGHT_LINE_LIMIT) {
      // Plain text, and the strip says why. The buffer is unaffected.
      this.overlay.textContent = buffer.text;
      this.stripLeft.textContent = `${buffer.footerLeft} · highlighting off above ${HIGHLIGHT_LINE_LIMIT} lines`;
      return;
    }

    const tokens = tokenizeSQL(buffer.text);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      const row = el("span", "pgc-ed-line");
      const change = marks?.changed.get(i);
      if (change) row.classList.add(`is-${change}`);
      for (const token of tokens[i] ?? []) {
        if (token.kind === "plain") row.appendChild(document.createTextNode(token.text));
        else row.appendChild(el("span", `pgc-t-${token.kind}`, token.text));
      }
      // A zero-width space keeps an empty line's box, and its marker, alive.
      if (row.childNodes.length === 0) row.appendChild(document.createTextNode("​"));
      frag.appendChild(row);
    }
    fill(this.overlay, frag);
  }

  /** Keeps the overlay and the gutter under the textarea's own scrolling. */
  private syncScroll(): void {
    const x = this.input.scrollLeft;
    const y = this.input.scrollTop;
    this.overlay.style.transform = `translate(${-x}px, ${-y}px)`;
    this.gutter.style.transform = `translateY(${-y}px)`;
  }
}
