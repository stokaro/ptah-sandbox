/**
 * The left rail: the workspace above, the database below.
 *
 * The two halves come from two different places on purpose. The file list is
 * `Workspace.list()`. The table list is the SQLite catalog, read with
 * PRAGMA. `app.db` appears in the file half because MemFS has a file of that
 * name; its tables appear in the database half because the bridge was asked.
 * Neither half is derived from the editor buffer, so the rail cannot claim a
 * column exists because somebody typed it.
 *
 * This is also where drift is told structurally rather than in prose: a
 * column the database has and the schema file does not is marked, in amber,
 * next to the column. A visitor who never reads the terminal still sees it.
 */

import type { Catalog, ColumnMark, SchemaDiff, TableInfo } from "./catalog.ts";
import { explicitIndexes, foreignKeyFor, foreignKeyLabel } from "./catalog.ts";
import { clear, el, marker, renderStatus } from "./dom.ts";

export interface RailFile {
  name: string;
  size: number;
  isDir: boolean;
  /** True when the buffer differs from what the workspace holds. */
  modified?: boolean;
}

export interface RailHandlers {
  onSelectFile?(name: string): void;
  onSelectTable?(name: string): void;
}

/** Sizes as a person reads them, not as bytes. Matches the mock's `28 KiB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${Math.round(kib)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

/** `3 rows`, `1 row`, and `counting…` while COUNT(*) has not run. */
export function formatRowCount(count: number | null): string {
  if (count === null) return "counting…";
  return count === 1 ? "1 row" : `${count.toLocaleString("en-US")} rows`;
}

/**
 * The trailing note on a column line.
 *
 * Amber only for `only-in-database`, which is the drift case and the one
 * thing here a visitor may have to act on. A column that is in the file but
 * not yet in the database is the ordinary state between an edit and an
 * apply, so it stays quiet.
 */
export function columnNote(
  mark: ColumnMark | undefined,
  isNew: boolean,
): { text: string; tone: "mute" | "amber" } | null {
  if (mark === "only-in-database") return { text: "not in schema.sql", tone: "amber" };
  if (mark === "only-in-schema") return { text: "not applied yet", tone: "mute" };
  if (isNew) return { text: "added", tone: "mute" };
  return null;
}

export class Rail {
  private root: HTMLElement;
  private filesHost: HTMLElement;
  private dbHost: HTMLElement;
  private dbLabel: HTMLElement;
  private handlers: RailHandlers;

  private selectedFile: string | null = null;
  private selectedTable: string | null = null;

  constructor(host: HTMLElement, handlers: RailHandlers = {}) {
    host.classList.add("pgc-rail");
    this.handlers = handlers;
    host.innerHTML = `
      <div class="pgc-rail-group">
        <div class="pgc-rail-head"><div class="label">Workspace</div></div>
        <div class="pgc-rail-files"></div>
      </div>
      <div class="pgc-rail-group">
        <div class="pgc-rail-head"><div class="label pgc-rail-dblabel">Database</div></div>
        <div class="pgc-rail-db"></div>
      </div>`;
    this.root = host;
    this.filesHost = host.querySelector<HTMLElement>(".pgc-rail-files")!;
    this.dbHost = host.querySelector<HTMLElement>(".pgc-rail-db")!;
    this.dbLabel = host.querySelector<HTMLElement>(".pgc-rail-dblabel")!;
  }

  /** Highlights a file row. Purely a selection; it reads nothing. */
  selectFile(name: string | null): void {
    this.selectedFile = name;
    for (const row of this.filesHost.querySelectorAll<HTMLElement>(".pgc-rail-row")) {
      row.classList.toggle("is-current", row.dataset.name === name);
    }
  }

  selectTable(name: string | null): void {
    this.selectedTable = name;
    for (const row of this.dbHost.querySelectorAll<HTMLElement>(".pgc-rail-row[data-table]")) {
      row.classList.toggle("is-current", row.dataset.table === name);
    }
  }

  setFiles(files: RailFile[]): void {
    clear(this.filesHost);
    if (files.length === 0) {
      this.filesHost.appendChild(el("p", "pgc-rail-empty", "The workspace is empty."));
      return;
    }
    for (const file of files) {
      const row = el("button", "pgc-rail-row");
      row.type = "button";
      row.dataset.name = file.name;
      row.appendChild(el("span", "pgc-rail-glyph", file.isDir ? "▸" : glyphFor(file.name)));
      row.appendChild(el("span", "pgc-rail-name", file.name));
      if (file.modified) row.appendChild(marker("modified", "amber"));
      else if (!file.isDir) row.appendChild(marker(formatSize(file.size)));
      row.classList.toggle("is-current", file.name === this.selectedFile);
      row.addEventListener("click", () => this.handlers.onSelectFile?.(file.name));
      this.filesHost.appendChild(row);
    }
  }

  /** The workspace could not be listed. Says so where the files would be. */
  setFilesError(message: string): void {
    renderStatus(this.filesHost, { kind: "error", message });
  }

  setDatabaseLoading(note: string): void {
    renderStatus(this.dbHost, { kind: "loading", note });
  }

  setDatabaseError(message: string): void {
    renderStatus(this.dbHost, { kind: "error", message });
  }

  /**
   * Draws the database half.
   *
   * `diff` carries the desired-versus-actual marks and may be absent, which
   * means the schema file could not be read into the scratch database. In
   * that case nothing is marked -- an unavailable comparison is not evidence
   * that the two agree, and it is not evidence that they differ either.
   */
  setCatalog(
    catalog: Catalog,
    options: { diff?: SchemaDiff | null; addedColumns?: Set<string> } = {},
  ): void {
    this.dbLabel.textContent = `Database · ${catalog.path}`;
    clear(this.dbHost);

    if (catalog.tables.length === 0) {
      this.dbHost.appendChild(
        el("p", "pgc-rail-empty", "No tables yet. The database is a real file with nothing in it."),
      );
      return;
    }

    const diff = options.diff ?? null;
    const added = options.addedColumns ?? new Set<string>();

    for (const table of catalog.tables) {
      this.dbHost.appendChild(this.tableRow(table));
      this.dbHost.appendChild(this.columnList(catalog, table, diff, added));
    }

    for (const table of catalog.tables) {
      for (const index of explicitIndexes(table)) {
        const row = el("div", "pgc-rail-row is-static");
        row.appendChild(el("span", "pgc-rail-glyph", "⌗"));
        row.appendChild(el("span", "pgc-rail-name", index.name));
        row.appendChild(marker(index.unique ? "unique index" : "index"));
        this.dbHost.appendChild(row);
      }
    }
  }

  private tableRow(table: TableInfo): HTMLElement {
    const row = el("button", "pgc-rail-row");
    row.type = "button";
    row.dataset.table = table.name;
    row.appendChild(el("span", "pgc-rail-glyph", "▦"));
    row.appendChild(el("span", "pgc-rail-name", table.name));
    row.appendChild(marker(formatRowCount(table.rowCount)));
    row.classList.toggle("is-current", table.name === this.selectedTable);
    row.addEventListener("click", () => this.handlers.onSelectTable?.(table.name));
    return row;
  }

  private columnList(
    catalog: Catalog,
    table: TableInfo,
    diff: SchemaDiff | null,
    added: Set<string>,
  ): HTMLElement {
    const list = el("div", "pgc-rail-cols");
    const names = new Set(table.columns.map((c) => c.name));

    for (const column of table.columns) {
      list.appendChild(
        this.columnLine(catalog, table, column.name, diff, added, {
          pk: column.pk > 0,
        }),
      );
    }

    // A column the schema file has and the database does not is still worth
    // listing: it is what the next apply will create. It is drawn from the
    // desired catalog, and labelled as not applied, so it is never mistaken
    // for something the database already has.
    if (diff) {
      for (const [name, mark] of diff.columns) {
        if (mark !== "only-in-schema") continue;
        const bare = name.startsWith(`${table.name}.`) ? name.slice(table.name.length + 1) : name;
        if (names.has(bare) || bare.includes(".")) continue;
        list.appendChild(this.columnLine(catalog, table, bare, diff, added, { pk: false }));
      }
    }

    return list;
  }

  private columnLine(
    catalog: Catalog,
    table: TableInfo,
    name: string,
    diff: SchemaDiff | null,
    added: Set<string>,
    flags: { pk: boolean },
  ): HTMLElement {
    const line = el("span", "pgc-rail-col");
    line.appendChild(el("span", "pgc-rail-colname", name));

    if (flags.pk) line.appendChild(marker("PK"));
    const fk = foreignKeyFor(table, name);
    if (fk) line.appendChild(marker(foreignKeyLabel(catalog, fk)));

    const key = `${table.name}.${name}`;
    const note = columnNote(diff?.columns.get(key), added.has(key));
    if (note) line.appendChild(marker(note.text, note.tone));
    return line;
  }

  /** The whole rail, for a caller that wants to reveal or hide it. */
  element(): HTMLElement {
    return this.root;
  }
}

/** The glyph in front of a file name. Cosmetic; it asserts nothing. */
function glyphFor(name: string): string {
  return /\.(db|sqlite|sqlite3)$/i.test(name) ? "▣" : "≡";
}
