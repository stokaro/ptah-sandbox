/**
 * The plan pane: the SQL the real planner produced, and nothing else.
 *
 * This pane never executes anything. It has no query function, no exec
 * function, and no way to reach the bridge -- deliberately, so that "apply"
 * cannot quietly become "run what is on screen". When the visitor applies,
 * the real command runs again and plans again against the file and the
 * catalog as they are at that moment. What is drawn here is a record of a
 * plan that was produced at a stated revision, not a queued instruction.
 *
 * Because of that, the plan is marked stale the instant either input moves:
 * the schema buffer is edited, or the catalog is re-read after something
 * changed it. A stale plan stays on screen, with the reason, because it is
 * still the last true answer -- it is just no longer an answer about now.
 *
 * Two sources feed it. `ptah schema plan --dry-run` emits JSON with one
 * object per statement, carrying the planner's own severity and reason;
 * that path involves no parsing of prose. `ptah schema apply --dry-run`
 * emits the statements as text, and `parsePlanOutput` splits them for
 * display only, keeping the raw output and falling back to it whenever the
 * split is not clean.
 */

import { clear, el, marker, renderStatus } from "./dom.ts";

export interface PlanStatement {
  sql: string;
  /** Comment lines the planner wrote above the statement, verbatim. */
  note: string;
  /** From the JSON plan: "safe", "destructive", and so on. */
  severity?: string;
  /** From the JSON plan: why the planner gave it that severity. */
  reason?: string;
}

export interface PlanText {
  statements: PlanStatement[];
  /** The output exactly as it arrived. Shown whenever splitting is unsure. */
  raw: string;
  /**
   * False when the text did not split into whole statements. The pane then
   * prints `raw` rather than a set of fragments that look authoritative.
   */
  confident: boolean;
}

/** Where a plan came from, and therefore when it stops being current. */
export interface PlanOrigin {
  /** The schema buffer revision the plan was produced from. */
  revision: number;
  /** The catalog vintage it was produced against, as `Catalog.readAt`. */
  catalogAt: number;
}

// --------------------------------------------------------------------------
// Reading a plan
// --------------------------------------------------------------------------

/**
 * Splits `schema apply --dry-run` output into statements, for display.
 *
 * The rules are the shape of the real output: a header line ending in a
 * colon, then statements that may span lines, each ending in a semicolon,
 * with the planner's own `--` comments above the statement they explain.
 *
 * A semicolon inside a string literal would split in the wrong place. That
 * is why `confident` exists and why `raw` is always kept: when anything is
 * left over at the end, the pane prints the original text instead. The JSON
 * path below has no such problem and is preferred where it is available.
 */
export function parsePlanOutput(stdout: string): PlanText {
  const raw = stdout;
  const statements: PlanStatement[] = [];
  const lines = stdout.split("\n");

  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i += 1;
  // The header ("Planned schema changes:") is a label, not a statement.
  if (i < lines.length) {
    const first = lines[i]!.trim();
    if (first.endsWith(":") && !first.includes(";")) i += 1;
  }

  let notes: string[] = [];
  let buffer: string[] = [];
  let sawContent = false;

  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "") {
      if (buffer.length === 0) notes = [];
      continue;
    }
    sawContent = true;
    if (buffer.length === 0 && trimmed.startsWith("--")) {
      notes.push(trimmed.replace(/^--\s?/, ""));
      continue;
    }
    buffer.push(line);
    if (trimmed.endsWith(";")) {
      statements.push({ sql: buffer.join("\n").trim(), note: notes.join(" ") });
      buffer = [];
      notes = [];
    }
  }

  const confident = buffer.length === 0 && (statements.length > 0 || !sawContent);
  return { statements, raw, confident };
}

/**
 * Reads `ptah schema plan --dry-run` JSON.
 *
 * Throws when the text is not the document this understands, because a plan
 * pane that silently shows nothing is worse than one that shows why it could
 * not read the plan.
 */
export function parsePlanJSON(text: string): PlanText {
  const doc: unknown = JSON.parse(text);
  if (typeof doc !== "object" || doc === null) throw new Error("plan JSON is not an object");
  const list = (doc as { statements?: unknown }).statements;
  if (!Array.isArray(list)) throw new Error("plan JSON has no statements array");
  const statements: PlanStatement[] = list.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`plan statement ${index + 1} is not an object`);
    }
    const row = item as { sql?: unknown; severity?: unknown; reason?: unknown };
    if (typeof row.sql !== "string") throw new Error(`plan statement ${index + 1} has no sql`);
    return {
      // The JSON omits the terminating semicolon; the pane shows statements
      // the way they would be typed, so it is put back.
      sql: row.sql.trimEnd().endsWith(";") ? row.sql : `${row.sql};`,
      note: "",
      severity: typeof row.severity === "string" ? row.severity : undefined,
      reason: typeof row.reason === "string" ? row.reason : undefined,
    };
  });
  return { statements, raw: text, confident: true };
}

/**
 * Why a plan is no longer about the current state, or null when it still is.
 *
 * Either input moving is enough. The message names which one, because "your
 * plan is stale" without a reason invites the visitor to assume it is a bug.
 */
export function planStaleReason(origin: PlanOrigin, current: PlanOrigin): string | null {
  const schemaMoved = origin.revision !== current.revision;
  const catalogMoved = origin.catalogAt !== current.catalogAt;
  if (!schemaMoved && !catalogMoved) return null;
  if (schemaMoved && catalogMoved) {
    return "schema.sql and the database have both changed since this plan was produced";
  }
  if (schemaMoved) return "schema.sql has changed since this plan was produced";
  return "the database has changed since this plan was produced";
}

// --------------------------------------------------------------------------
// The pane
// --------------------------------------------------------------------------

export interface PlanView {
  plan: PlanText;
  origin: PlanOrigin;
  /** How the plan was obtained, shown in the header: "dry run", "saved plan". */
  kind: string;
}

export class PlanPane {
  private title: HTMLElement;
  private status: HTMLElement;
  private body: HTMLElement;

  private view: PlanView | null = null;
  private staleReason: string | null = null;

  constructor(host: HTMLElement) {
    host.innerHTML = `
      <div class="pgc-pane-head">
        <strong class="pgc-pane-title">Schema plan</strong>
        <span class="pgc-pane-status-line"></span>
      </div>
      <div class="pgc-pane-body"></div>`;
    this.title = host.querySelector<HTMLElement>(".pgc-pane-title")!;
    this.status = host.querySelector<HTMLElement>(".pgc-pane-status-line")!;
    this.body = host.querySelector<HTMLElement>(".pgc-pane-body")!;
    this.setEmpty(
      "No plan yet. Run schema apply with --dry-run to see the exact SQL before anything runs.",
    );
  }

  setLoading(note = "planning…"): void {
    this.status.classList.remove("is-amber");
    this.status.textContent = note;
    renderStatus(this.body, { kind: "loading", note });
  }

  setEmpty(note: string): void {
    this.view = null;
    this.staleReason = null;
    this.title.textContent = "Schema plan";
    this.status.textContent = "";
    this.status.classList.remove("is-amber");
    renderStatus(this.body, { kind: "empty", note });
  }

  /**
   * The planner failed. Its message stays on screen; a plan pane that goes
   * blank after a failed plan reads as "no changes needed", which is the
   * most expensive misreading available on this page.
   */
  setError(message: string, note?: string): void {
    this.view = null;
    this.staleReason = null;
    this.status.textContent = "planning failed";
    this.status.classList.add("is-amber");
    renderStatus(this.body, {
      kind: "error",
      message,
      note: note ?? "Nothing was applied. The database is as it was.",
    });
  }

  show(view: PlanView): void {
    this.view = view;
    this.staleReason = null;
    this.paint();
  }

  /**
   * Marks the shown plan stale. Called the moment the buffer is edited or a
   * fresh catalog read lands, without waiting for anything to be re-run.
   */
  markStale(reason: string): void {
    if (!this.view) return;
    this.staleReason = reason;
    this.paint();
  }

  /** Convenience: marks stale only when one of the two inputs actually moved. */
  reconcile(current: PlanOrigin): void {
    if (!this.view) return;
    const reason = planStaleReason(this.view.origin, current);
    if (reason) this.markStale(reason);
  }

  isStale(): boolean {
    return this.staleReason !== null;
  }

  private paint(): void {
    const view = this.view;
    if (!view) return;

    const count = view.plan.statements.length;
    const counted = view.plan.confident
      ? `${count} ${count === 1 ? "statement" : "statements"}`
      : "unsplit output";
    this.status.textContent = this.staleReason
      ? `${counted} · stale · r${view.origin.revision}`
      : `${counted} · ${view.kind} · r${view.origin.revision}`;
    this.status.classList.toggle("is-amber", this.staleReason !== null);

    clear(this.body);

    if (view.plan.confident && count === 0) {
      this.body.appendChild(
        el("p", "pgc-pane-note", "The planner produced no statements. Nothing needs to change."),
      );
      this.body.appendChild(this.provenance(view));
      return;
    }

    if (!view.plan.confident) {
      // The split was not clean, so the output is shown exactly as it came
      // rather than as fragments that would look like separate statements.
      this.body.appendChild(el("pre", "code pgc-plan-raw", view.plan.raw.trim()));
      this.body.appendChild(
        el(
          "p",
          "pgc-pane-note",
          "Shown as the command printed it: the output did not split into whole statements, " +
            "so it is not broken up here.",
        ),
      );
      this.body.appendChild(this.provenance(view));
      return;
    }

    const list = el("ol", "pgc-plan");
    for (const statement of view.plan.statements) {
      const item = el("li", "pgc-plan-item");
      if (statement.note) item.appendChild(el("p", "pgc-plan-note", statement.note));
      item.appendChild(el("pre", "code pgc-plan-sql", statement.sql));
      if (statement.severity || statement.reason) {
        const foot = el("p", "pgc-plan-meta");
        if (statement.severity) {
          // Severity is the planner's word. Only "destructive" earns amber;
          // the colour tracks what the planner said, not a guess from the SQL.
          foot.appendChild(
            marker(statement.severity, statement.severity === "safe" ? "mute" : "amber"),
          );
        }
        if (statement.reason) foot.appendChild(document.createTextNode(` ${statement.reason}`));
        item.appendChild(foot);
      }
      list.appendChild(item);
    }
    this.body.appendChild(list);
    this.body.appendChild(this.provenance(view));
  }

  private provenance(view: PlanView): HTMLElement {
    if (this.staleReason) {
      return el(
        "p",
        "pgc-pane-note is-amber",
        `△ This plan is out of date: ${this.staleReason}. It is still what the planner said at ` +
          `revision r${view.origin.revision}. Applying re-runs the real command, which plans ` +
          "again against the file and the catalog as they are then.",
      );
    }
    return el(
      "p",
      "pgc-pane-note",
      `Produced by the real planner from revision r${view.origin.revision}. Editing schema.sql ` +
        "marks this plan stale; apply re-plans against the current file and catalog.",
    );
  }
}
