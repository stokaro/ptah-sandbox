/**
 * The data pane: rows read back out of SQLite after a command finished.
 *
 * This is where the product's one claim gets checked. Ptah says it can add a
 * column without losing data; this pane goes and looks. The rows are read by
 * a SELECT issued after the process exited, against the same file the command
 * wrote, and they are drawn as text. Nothing is carried over from before the
 * command, and nothing is predicted.
 *
 * A column marked `new` is marked because it was absent from a catalog read
 * taken before the command and present in one taken after, which is a fact
 * about two things the database said about itself. The "still N rows" line is
 * only printed when the count before the command was actually captured.
 */

import type { Catalog } from "./catalog.ts";
import { columnsAddedBetween, isWithoutRowid, quoteIdent } from "./catalog.ts";
import { clear, el, marker, renderStatus, td, th } from "./dom.ts";

/** How many rows the pane will draw. Past this it says it is truncating. */
export const ROW_LIMIT = 50;

/** How much of one value is drawn before it is cut. */
export const CELL_LIMIT = 160;

export type CellKind = "null" | "text" | "number" | "blob";

export interface Cell {
  text: string;
  kind: CellKind;
  /** True when control characters were replaced with escapes to fit one line. */
  escaped: boolean;
  /** True when the value was cut at CELL_LIMIT. `full` holds the whole thing. */
  truncated: boolean;
  full: string;
}

const CONTROL = /[\u0000-\u001F\u007F]/g;

function escapeControls(text: string): { text: string; escaped: boolean } {
  let escaped = false;
  const out = text.replace(CONTROL, (ch) => {
    escaped = true;
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    return `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`;
  });
  return { text: out, escaped };
}

/**
 * One value as it will appear on screen.
 *
 * NULL prints as the word NULL in the muted colour; an empty TEXT prints as
 * nothing at all. That keeps the two distinguishable without inventing
 * quotation marks that are not in the data.
 *
 * A BLOB prints its length rather than its bytes. Rendering arbitrary bytes
 * as characters in a table cell is how a data grid lies about what is stored.
 *
 * The bridge hands back an integer that does not fit a double as a decimal
 * string, so a large integer arrives here indistinguishable from TEXT. Both
 * are drawn the same way, which is the honest outcome: the pane does not
 * claim a type the protocol did not carry.
 */
export function formatCell(value: unknown): Cell {
  if (value === null || value === undefined) {
    return { text: "NULL", kind: "null", escaped: false, truncated: false, full: "NULL" };
  }
  if (typeof value === "number") {
    const text = Object.is(value, -0) ? "-0" : String(value);
    return { text, kind: "number", escaped: false, truncated: false, full: text };
  }
  if (value instanceof Uint8Array) {
    const text = `BLOB · ${value.length} ${value.length === 1 ? "byte" : "bytes"}`;
    return { text, kind: "blob", escaped: false, truncated: false, full: text };
  }
  const raw = typeof value === "string" ? value : String(value);
  const { text, escaped } = escapeControls(raw);
  const truncated = text.length > CELL_LIMIT;
  return {
    text: truncated ? `${text.slice(0, CELL_LIMIT)}…` : text,
    kind: "text",
    escaped,
    truncated,
    full: raw,
  };
}

export interface Capped<T> {
  rows: T[];
  shown: number;
  truncated: boolean;
}

/** Cuts a row set to the pane's limit and reports that it did. */
export function capRows<T>(rows: T[], limit = ROW_LIMIT): Capped<T> {
  if (rows.length <= limit) return { rows, shown: rows.length, truncated: false };
  return { rows: rows.slice(0, limit), shown: limit, truncated: true };
}

/**
 * The read the pane issues.
 *
 * `ORDER BY rowid` for an ordinary table, because a SELECT with no ORDER BY
 * has no defined order and a pane that says "3 rows" should show the same
 * three in the same places twice running. A WITHOUT ROWID table has no rowid
 * to order by, so the query omits it and the pane says the order is the
 * database's.
 *
 * One row past the limit is fetched so the pane can tell "exactly 50" from
 * "more than 50" without a second query.
 */
export function rowQuery(
  table: string,
  options: { limit?: number; withoutRowid?: boolean } = {},
): { sql: string; order: string } {
  const limit = options.limit ?? ROW_LIMIT;
  const name = quoteIdent(table);
  if (options.withoutRowid) {
    return {
      sql: `SELECT * FROM ${name} LIMIT ${limit + 1}`,
      order: "database order · this table has no rowid to sort by",
    };
  }
  return {
    sql: `SELECT * FROM ${name} ORDER BY rowid LIMIT ${limit + 1}`,
    order: "ordered by rowid",
  };
}

/** Convenience over `rowQuery` for a table that is already in the catalog. */
export function rowQueryFor(
  catalog: Catalog,
  table: string,
  limit = ROW_LIMIT,
): { sql: string; order: string } {
  const info = catalog.tables.find((t) => t.name === table);
  return rowQuery(table, { limit, withoutRowid: info ? isWithoutRowid(info) : false });
}

// --------------------------------------------------------------------------
// Sorting
// --------------------------------------------------------------------------

const KIND_ORDER: Record<CellKind, number> = { null: 0, number: 1, text: 2, blob: 3 };

/**
 * SQLite's own ordering between storage classes: NULL, then numbers, then
 * text, then blobs. Within text it is a plain code-unit comparison rather
 * than a locale collation, because the database did not sort these -- the
 * browser did -- and pretending otherwise would misstate where the order
 * came from.
 */
export function compareCells(a: unknown, b: unknown): number {
  const ka = KIND_ORDER[formatCell(a).kind];
  const kb = KIND_ORDER[formatCell(b).kind];
  if (ka !== kb) return ka - kb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = formatCell(a).full;
  const sb = formatCell(b).full;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * A stable sort by one column.
 *
 * Array.prototype.sort has been required to be stable since ES2019, so rows
 * that tie keep the order the database returned them in. The pane states
 * both facts on screen.
 */
export function sortRows(
  rows: unknown[][],
  column: number,
  direction: "asc" | "desc",
): unknown[][] {
  const sign = direction === "asc" ? 1 : -1;
  return rows.slice().sort((x, y) => sign * compareCells(x[column], y[column]));
}

// --------------------------------------------------------------------------
// The pane
// --------------------------------------------------------------------------

export interface DataView {
  table: string;
  columns: string[];
  /** Rows exactly as the bridge returned them, before capping. */
  rows: unknown[][];
  /** COUNT(*) for the table, when it is known. */
  total: number | null;
  /** How the rows were read. Printed under the table. */
  order: string;
  /** Columns a comparison of two catalog reads showed to be new. */
  newColumns?: string[];
  /** The row count before the command, when it was captured. */
  rowsBefore?: number | null;
  /** A sentence for the top-right of the pane, e.g. "read after apply". */
  status?: string;
  /** A sentence under the table. Replaces the default note when set. */
  note?: string;
}

export class DataPane {
  private title: HTMLElement;
  private status: HTMLElement;
  private body: HTMLElement;

  private view: DataView | null = null;
  private sort: { column: number; direction: "asc" | "desc" } | null = null;

  constructor(host: HTMLElement) {
    host.innerHTML = `
      <div class="pgc-pane-head">
        <strong class="pgc-pane-title"></strong>
        <span class="pgc-pane-status-line"></span>
      </div>
      <div class="pgc-pane-body"></div>`;
    this.title = host.querySelector<HTMLElement>(".pgc-pane-title")!;
    this.status = host.querySelector<HTMLElement>(".pgc-pane-status-line")!;
    this.body = host.querySelector<HTMLElement>(".pgc-pane-body")!;
    this.setEmpty("Run a command or pick a table to read rows out of the database.");
  }

  setLoading(table: string, note = "reading…"): void {
    this.title.textContent = table;
    this.status.classList.remove("is-amber");
    this.status.textContent = note;
    renderStatus(this.body, { kind: "loading", note });
  }

  setEmpty(note: string): void {
    this.view = null;
    this.title.textContent = "Data";
    this.status.classList.remove("is-amber");
    this.status.textContent = "";
    renderStatus(this.body, { kind: "empty", note });
  }

  /** The read failed. The message stays on screen until a read succeeds. */
  setError(message: string, note?: string): void {
    this.view = null;
    this.status.textContent = "read failed";
    this.status.classList.add("is-amber");
    renderStatus(this.body, { kind: "error", message, note });
  }

  show(view: DataView): void {
    this.view = view;
    this.sort = null;
    this.paint();
  }

  /**
   * Convenience for the common call: the catalog before and after a command,
   * plus the rows read after it. Works out which columns are new rather than
   * being told, so it cannot mark one the command did not create.
   */
  showAfterCommand(
    view: Omit<DataView, "newColumns">,
    before: Catalog | null,
    after: Catalog | null,
  ): void {
    this.show({ ...view, newColumns: columnsAddedBetween(before, after, view.table) });
  }

  private paint(): void {
    const view = this.view;
    if (!view) return;

    this.status.classList.remove("is-amber");
    this.title.textContent = view.table;

    const capped = capRows(view.rows);
    const rows = this.sort
      ? sortRows(capped.rows, this.sort.column, this.sort.direction)
      : capped.rows;

    const counted =
      view.total !== null
        ? `${view.total.toLocaleString("en-US")} ${view.total === 1 ? "row" : "rows"}`
        : `${capped.shown} shown`;
    this.status.textContent = view.status ? `${counted} · ${view.status}` : counted;

    clear(this.body);

    if (view.columns.length === 0) {
      renderStatus(this.body, { kind: "empty", note: "This table has no columns." });
      return;
    }

    const table = el("table", "pgc-table");
    const head = el("tr");
    const isNew = new Set(view.newColumns ?? []);
    view.columns.forEach((name, index) => {
      const cell = th(name);
      if (isNew.has(name)) {
        cell.classList.add("is-new");
        cell.appendChild(marker("new"));
      }
      const button = el("button", "pgc-sort");
      button.type = "button";
      button.setAttribute("aria-label", `Sort by ${name}`);
      button.classList.toggle("is-sorted", this.sort?.column === index);
      button.textContent = this.sortGlyph(index);
      button.addEventListener("click", () => this.toggleSort(index));
      cell.appendChild(button);
      head.appendChild(cell);
    });
    table.appendChild(el("thead")).appendChild(head);

    const body = el("tbody");
    let anyEscaped = false;
    let anyTruncated = false;
    for (const row of rows) {
      const tr = el("tr");
      for (let c = 0; c < view.columns.length; c++) {
        const cell = formatCell(row[c]);
        if (cell.escaped) anyEscaped = true;
        if (cell.truncated) anyTruncated = true;
        const node = td(cell.text, cell.kind === "null" ? "is-null" : "");
        // The tooltip carries the whole value; the cell carries what fits.
        if (cell.truncated) node.title = cell.full;
        tr.appendChild(node);
      }
      body.appendChild(tr);
    }
    table.appendChild(body);

    const scroller = el("div", "pgc-table-wrap");
    scroller.appendChild(table);
    this.body.appendChild(scroller);

    if (rows.length === 0) {
      this.body.appendChild(
        el("p", "pgc-pane-note", "The table has no rows. Its columns are above."),
      );
    }

    for (const line of this.notes(view, capped, anyEscaped, anyTruncated)) {
      this.body.appendChild(el("p", line.tone === "amber" ? "pgc-pane-note is-amber" : "pgc-pane-note", line.text));
    }
  }

  /**
   * Everything the pane has to say about how the rows got here.
   *
   * The survival sentence is the payoff of the whole page, so it is stated
   * plainly and once -- and only when the before count was actually taken.
   */
  private notes(
    view: DataView,
    capped: Capped<unknown[]>,
    escaped: boolean,
    truncated: boolean,
  ): { text: string; tone: "mute" | "amber" }[] {
    const out: { text: string; tone: "mute" | "amber" }[] = [];

    const added = view.newColumns ?? [];
    if (added.length > 0 && view.rowsBefore != null && view.total != null) {
      const names = added.join(", ");
      const kept = view.rowsBefore === view.total;
      out.push({
        text: kept
          ? `${names} ${added.length === 1 ? "was" : "were"} added, and the table still has ` +
            `${view.total.toLocaleString("en-US")} ${view.total === 1 ? "row" : "rows"}. ` +
            "These are the rows as they are now, read back after the command finished."
          : `${names} ${added.length === 1 ? "was" : "were"} added. The row count went from ` +
            `${view.rowsBefore.toLocaleString("en-US")} to ${view.total.toLocaleString("en-US")}.`,
        tone: kept ? "mute" : "amber",
      });
    } else if (added.length > 0) {
      out.push({
        text: `${added.join(", ")} ${added.length === 1 ? "is" : "are"} new since the previous catalog read.`,
        tone: "mute",
      });
    }

    if (view.note) out.push({ text: view.note, tone: "mute" });

    const details: string[] = [view.order];
    if (capped.truncated) {
      const total = view.total !== null ? ` of ${view.total.toLocaleString("en-US")}` : "";
      details.push(`showing the first ${capped.shown}${total}`);
    }
    if (this.sort) {
      const name = view.columns[this.sort.column] ?? "";
      details.push(
        `then sorted in the browser by ${name}, ${this.sort.direction === "asc" ? "ascending" : "descending"}, ` +
          `over the ${capped.shown} rows shown; ties keep the database's order`,
      );
    }
    if (escaped) details.push("control characters are shown escaped");
    if (truncated) details.push(`long values are cut at ${CELL_LIMIT} characters`);
    out.push({ text: `${details.join(" · ")}.`, tone: "mute" });

    return out;
  }

  private sortGlyph(index: number): string {
    if (!this.sort || this.sort.column !== index) return "↕";
    return this.sort.direction === "asc" ? "↑" : "↓";
  }

  private toggleSort(index: number): void {
    if (!this.sort || this.sort.column !== index) this.sort = { column: index, direction: "asc" };
    else if (this.sort.direction === "asc") this.sort = { column: index, direction: "desc" };
    else this.sort = null;
    this.paint();
  }
}
