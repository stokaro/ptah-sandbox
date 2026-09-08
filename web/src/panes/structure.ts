/**
 * The structure pane: the schema SQLite actually has, for one table.
 *
 * Every row here came out of `PRAGMA table_info`, `PRAGMA index_list` and
 * `PRAGMA foreign_key_list` against the real file. The schema file is not
 * read to build this, which is the point -- when the two disagree, this pane
 * is the side that is true, and the disagreement is what the visitor came to
 * see.
 *
 * Marking is conservative. A column is called out in amber only when the
 * desired catalog was successfully built from the schema file and does not
 * contain it. If the file could not be parsed there is no comparison, and
 * the pane says so rather than implying the two sides agree.
 */

import type { Catalog, SchemaDiff, TableInfo } from "./catalog.ts";
import { columnConstraint, explicitIndexes, referencedBy } from "./catalog.ts";
import { clear, el, marker, renderStatus, td, th } from "./dom.ts";

export interface StructureView {
  catalog: Catalog;
  table: string;
  /** The desired-versus-actual comparison, or null when it is unavailable. */
  diff: SchemaDiff | null;
  /**
   * Why the comparison is unavailable, when it is. Printed as the reason
   * nothing is marked, so an unmarked pane is never read as "no drift".
   */
  diffUnavailable?: string;
}

/**
 * The wording for a column's comparison mark.
 *
 * Only `only-in-database` is amber: it is the state a person has to resolve,
 * by editing the file or by reverting the column. Everything else is either
 * ordinary or already visible in the plan.
 */
export function structureMark(
  mark: string | undefined,
): { text: string; tone: "mute" | "amber" } | null {
  if (mark === "only-in-database") return { text: "△ not in schema.sql", tone: "amber" };
  if (mark === "only-in-schema") return { text: "in schema.sql, not applied yet", tone: "mute" };
  return null;
}

export class StructurePane {
  private title: HTMLElement;
  private status: HTMLElement;
  private body: HTMLElement;

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
    this.setEmpty("Pick a table in the rail to read its actual schema out of SQLite.");
  }

  setLoading(note = "reading the catalog…"): void {
    this.status.classList.remove("is-amber");
    this.status.textContent = note;
    renderStatus(this.body, { kind: "loading", note });
  }

  setEmpty(note: string): void {
    this.title.textContent = "Structure";
    this.status.classList.remove("is-amber");
    this.status.textContent = "";
    renderStatus(this.body, { kind: "empty", note });
  }

  setError(message: string, note?: string): void {
    this.status.textContent = "read failed";
    this.status.classList.add("is-amber");
    renderStatus(this.body, { kind: "error", message, note });
  }

  show(view: StructureView): void {
    const table = view.catalog.tables.find((t) => t.name === view.table);
    if (!table) {
      this.title.textContent = view.table;
      this.status.textContent = "not in the database";
      renderStatus(this.body, {
        kind: "empty",
        note: `The catalog read at ${new Date(view.catalog.readAt).toLocaleTimeString("en-US")} has no table called ${view.table}.`,
      });
      return;
    }

    this.status.classList.remove("is-amber");
    this.title.textContent = table.name;
    this.status.textContent = "actual schema · read from SQLite";
    clear(this.body);

    this.body.appendChild(this.columnsTable(table, view.diff));
    this.body.appendChild(this.relations(view.catalog, table));

    const footer = this.footer(view, table);
    if (footer) this.body.appendChild(footer);
  }

  private columnsTable(table: TableInfo, diff: SchemaDiff | null): HTMLElement {
    const grid = el("table", "pgc-table");
    const head = el("tr");
    head.appendChild(th("Column"));
    head.appendChild(th("Type"));
    head.appendChild(th("Constraint"));
    grid.appendChild(el("thead")).appendChild(head);

    const body = el("tbody");
    for (const column of table.columns) {
      const tr = el("tr");
      tr.appendChild(td(column.name));
      // SQLite allows a column with no declared type; an empty cell would
      // read as a rendering bug, so the absence is named.
      tr.appendChild(td(column.type === "" ? "(no type)" : column.type));

      const constraint = td(columnConstraint(table, column));
      const mark = structureMark(diff?.columns.get(`${table.name}.${column.name}`));
      if (mark) {
        if (constraint.textContent !== "") constraint.appendChild(document.createTextNode(" "));
        constraint.appendChild(marker(mark.text, mark.tone));
      }
      tr.appendChild(constraint);
      body.appendChild(tr);
    }

    // Columns the file asks for that the database does not have yet. Listed
    // last and labelled, so the table stays a description of the database.
    if (diff) {
      const present = new Set(table.columns.map((c) => c.name));
      for (const [key, value] of diff.columns) {
        if (value !== "only-in-schema") continue;
        if (!key.startsWith(`${table.name}.`)) continue;
        const name = key.slice(table.name.length + 1);
        if (present.has(name) || name.includes(".")) continue;
        const tr = el("tr", "is-pending");
        tr.appendChild(td(name));
        tr.appendChild(td("—"));
        const cell = td("");
        cell.appendChild(marker("in schema.sql, not applied yet"));
        tr.appendChild(cell);
        body.appendChild(tr);
      }
    }

    grid.appendChild(body);
    const scroller = el("div", "pgc-table-wrap");
    scroller.appendChild(grid);
    return scroller;
  }

  private relations(catalog: Catalog, table: TableInfo): HTMLElement {
    const list = el("dl", "flags pgc-flags");

    const indexes = explicitIndexes(table);
    list.appendChild(el("dt", "", "Indexes"));
    list.appendChild(
      el(
        "dd",
        "",
        indexes.length === 0
          ? "none"
          : indexes
              .map((i) => `${i.name} (${i.columns.join(", ")})${i.unique ? " unique" : ""}`)
              .join(" · "),
      ),
    );

    const inbound = referencedBy(catalog, table.name);
    list.appendChild(el("dt", "", "Referenced by"));
    list.appendChild(
      el(
        "dd",
        "",
        inbound.length === 0 ? "nothing" : inbound.map((r) => `${r.from} → ${r.to}`).join(" · "),
      ),
    );

    const outbound = table.foreignKeys;
    if (outbound.length > 0) {
      list.appendChild(el("dt", "", "References"));
      list.appendChild(
        el(
          "dd",
          "",
          outbound
            .map((f) => `${f.column} → ${f.table}${f.toColumn ? `.${f.toColumn}` : ""}`)
            .join(" · "),
        ),
      );
    }

    return list;
  }

  private footer(view: StructureView, table: TableInfo): HTMLElement | null {
    if (view.diffUnavailable) {
      return el(
        "p",
        "pgc-pane-note",
        `Nothing is marked: the desired schema could not be read, so there is nothing to compare against. ${view.diffUnavailable}`,
      );
    }
    if (!view.diff) return null;

    const drifted = table.columns.filter(
      (c) => view.diff!.columns.get(`${table.name}.${c.name}`) === "only-in-database",
    );
    if (drifted.length > 0) {
      return el(
        "p",
        "pgc-pane-note is-amber",
        "△ Desired and actual schema differ. The terminal has the drift report; " +
          "reconcile by editing schema.sql or by reverting the column in SQL.",
      );
    }
    return el(
      "p",
      "pgc-pane-note",
      `Every column here is also in schema.sql, as SQLite parsed it at ${new Date(view.catalog.readAt).toLocaleTimeString("en-US")}.`,
    );
  }
}
