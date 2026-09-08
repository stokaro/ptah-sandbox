/**
 * The guided route: the scenario bar, the five steps, and the strip under the
 * terminal that says what to do next.
 *
 * It draws what `scenario.ts` decided. A step is ticked because its check
 * passed against the real workspace and the real catalog, so this file never
 * marks anything done on a click, and the next command is never run without
 * its full argv on screen first. Where the page cannot verify something it
 * says so in those words rather than showing a tick.
 *
 * The strip follows the current step by default and stays wherever the visitor
 * clicked otherwise, because a page that keeps yanking the reader somewhere
 * else is not helping.
 *
 * Markup only uses classes playground.css already defines, plus the small
 * "Guided route" section at the end of it. Nothing here sets a colour.
 */

import { clear, el, fill } from "./panes/dom.ts";
import {
  SCENARIOS,
  describeArgv,
  evaluateRoute,
  pad,
} from "./scenario.ts";
import type { RouteState, Scenario, StateProbe, Step, StepState } from "./scenario.ts";

/** What the guide needs from the rest of the page. */
export interface GuideHost {
  /** The real workspace and the real catalog. */
  probe: StateProbe;
  /** Starts a run in the terminal, exactly as the argv reads. */
  run(argv: readonly string[]): void;
  /** Puts SQL in the SQL pane. The visitor presses Run there. */
  offerSql(sql: string): void;
  /** Brings a file up in the editor. */
  focusFile(path: string): void;
  /** Seeds the workspace and the database for a scenario. */
  loadScenario(scenario: Scenario): Promise<void>;
  /** True while a command is in flight, so the strip can wait rather than queue. */
  busy(): boolean;
}

/** The pill on the right of the scenario bar. Its value is the host's. */
export interface StatusPill {
  glyph: string;
  text: string;
  tone: "normal" | "quiet" | "attention";
}

const IDLE: StatusPill = { glyph: "…", text: "starting", tone: "quiet" };

/**
 * A tick for a step whose check passed, the number otherwise.
 *
 * A step that cannot be checked keeps its number forever; there is no third
 * glyph that could be mistaken for a quieter kind of success.
 */
function glyphFor(state: StepState): string {
  return state.status === "done" ? "✓" : pad(state.index + 1);
}

function commandBox(argv: readonly string[]): HTMLElement {
  const box = el("div", "cmd");
  const pre = el("pre");
  pre.appendChild(el("span", "p", "$"));
  pre.appendChild(document.createTextNode(` ${describeArgv(argv)}`));
  const copy = el("button", "copy", "Copy");
  copy.type = "button";
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(describeArgv(argv)).then(
      () => { copy.textContent = "Copied"; },
      () => { copy.textContent = "Copy failed"; },
    ).finally(() => {
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    });
  });
  return fill(box, pre, copy);
}

export class Guide {
  /** The scenario bar: selector on the left, status pill on the right. */
  readonly bar: HTMLElement;
  /** The five-column steps nav under the bar. */
  readonly steps: HTMLElement;
  /** The two-column strip that sits below the terminal. */
  readonly next: HTMLElement;

  private readonly host: GuideHost;
  private readonly catalog: readonly Scenario[];
  private readonly select: HTMLSelectElement;
  private readonly status: HTMLElement;
  private readonly storage: HTMLElement;

  private current: Scenario;
  private route: RouteState | null = null;
  /** The step the strip is showing, or null to follow the route. */
  private pinned: number | null = null;
  /** Serializes refreshes so two overlapping passes cannot paint out of order. */
  private pass = 0;

  constructor(host: GuideHost, catalog: readonly Scenario[] = SCENARIOS) {
    if (catalog.length === 0) throw new Error("guide: no scenarios to show");
    this.host = host;
    this.catalog = catalog;
    this.current = catalog[0] as Scenario;

    this.select = el("select", "pg-select");
    this.select.setAttribute("aria-label", "Scenario");
    for (const scenario of catalog) {
      const option = el("option", undefined, `${scenario.id.toUpperCase()} · ${scenario.title}`);
      option.value = scenario.id;
      this.select.appendChild(option);
    }
    this.select.addEventListener("change", () => {
      void this.load(this.select.value);
    });

    this.status = el("span", "pg-status");
    this.status.setAttribute("role", "status");
    this.storage = el("span", "pg-storage", "memory-only");

    this.bar = el("div", "pg-bar");
    fill(
      this.bar,
      fill(el("span", "pg-scenario"), el("span", "pg-scenario-label", "Scenario"), this.select),
      fill(el("div", "pg-bar-right"), this.status, this.storage),
    );
    this.setStatus(IDLE);

    this.steps = el("nav", "pg-steps");
    this.steps.setAttribute("aria-label", "Guided steps");

    this.next = el("section", "pg-next");
    this.next.setAttribute("aria-label", "What to do next");

    this.render();
  }

  get scenario(): Scenario {
    return this.current;
  }

  /**
   * Switches scenario: seeds the workspace and the database, then re-scores.
   *
   * The route is emptied first, so nothing on screen claims to describe a
   * workspace that is being replaced underneath it.
   */
  async load(id: string): Promise<void> {
    const scenario = this.catalog.find((s) => s.id === id);
    if (!scenario) throw new Error(`guide: no scenario "${id}"`);
    this.current = scenario;
    this.select.value = id;
    this.pinned = null;
    this.route = null;
    this.render();
    await this.host.loadScenario(scenario);
    await this.refresh();
  }

  /** The value comes from the host; the guide only draws it. */
  setStatus(pill: StatusPill): void {
    clear(this.status);
    this.status.dataset["tone"] = pill.tone;
    const glyph = el("span", undefined, pill.glyph);
    glyph.setAttribute("aria-hidden", "true");
    fill(this.status, glyph, document.createTextNode(pill.text));
  }

  /** "memory-only", "saved locally r14", and so on. The host's words. */
  setStorage(text: string): void {
    this.storage.textContent = text;
  }

  /**
   * Re-scores every step against the real state and repaints.
   *
   * Call it after a run finishes, after the SQL pane executes something, and
   * after the workspace revision changes. It is cheap -- one pass asks the
   * catalog for its tables once -- and it is the only thing that moves a step.
   */
  async refresh(): Promise<void> {
    const pass = ++this.pass;
    const route = await evaluateRoute(this.current, this.host.probe);
    if (pass !== this.pass) return; // a newer pass already painted
    // Clicking a step pins the strip to it, but only until real state moves
    // the route on. Otherwise one click would leave the strip pointing at a
    // finished step for the rest of the session.
    if (this.route && this.route.currentIndex !== route.currentIndex) this.pinned = null;
    this.route = route;
    this.render();
  }

  /** Points the strip at one step. Clicking a step in the nav does this. */
  focusStep(index: number): void {
    this.pinned = index;
    this.render();
  }

  // -------------------------------------------------------------------------
  // painting
  // -------------------------------------------------------------------------

  /** The step the strip is showing: the pinned one, else the route's current. */
  private focused(): StepState | null {
    const route = this.route;
    if (!route) return null;
    if (this.pinned !== null) return route.steps[this.pinned] ?? null;
    return route.currentIndex === -1 ? null : route.steps[route.currentIndex] ?? null;
  }

  private render(): void {
    this.renderSteps();
    this.renderNext();
  }

  private renderSteps(): void {
    clear(this.steps);
    const route = this.route;
    const focused = this.focused();

    this.current.steps.forEach((step, index) => {
      const state: StepState = route?.steps[index]
        ?? { step, index, status: "unknown", detail: "not checked yet" };

      const button = el("button", "pg-step");
      button.type = "button";
      button.dataset["status"] = state.status;
      if (focused?.index === index) button.setAttribute("aria-current", "step");
      // The tooltip is the check's own words, so hovering a step says what was
      // looked at rather than repeating the caption.
      button.title = detailLine(state);
      button.addEventListener("click", () => this.focusStep(index));

      fill(
        button,
        el("span", "pg-step-n", glyphFor(state)),
        el("span", "pg-step-of", `of ${pad(this.current.steps.length)}`),
        el("span", "pg-step-title", step.title),
        el("span", "pg-step-hint", step.caption),
      );
      this.steps.appendChild(button);
    });
  }

  private renderNext(): void {
    clear(this.next);
    const route = this.route;
    const copy = el("div", "pg-next-copy");
    const actions = el("div", "pg-next-run");

    if (!route) {
      fill(
        copy,
        el("strong", undefined, "Reading the workspace."),
        el("span", "caption", "The steps below are scored against the real files and the real catalog, "
          + "so they stay blank until there is something to read."),
      );
      fill(this.next, copy, actions);
      return;
    }

    if (route.unavailable) {
      fill(
        copy,
        el("strong", undefined, this.current.title),
        el("span", "caption", `${this.current.description} The route is not scored yet: `
          + `${route.unavailable}. Reading and editing work already.`),
      );
      fill(this.next, copy, actions);
      return;
    }

    const focused = this.focused();

    if (!focused) {
      fill(
        copy,
        el("strong", undefined, this.current.finished.headline),
        el("span", "caption", this.current.finished.caption),
      );
      if (this.current.note) copy.appendChild(el("span", "caption", this.current.note));
      this.appendOffScript(copy, route);
      fill(this.next, copy, actions);
      return;
    }

    const step = focused.step;
    fill(copy, el("strong", undefined, step.headline));
    copy.appendChild(el("span", "caption", captionFor(focused)));
    this.appendOffScript(copy, route);

    this.appendActions(actions, focused);
    fill(this.next, copy, actions);
  }

  private appendOffScript(copy: HTMLElement, route: RouteState): void {
    if (!route.offScript) return;
    // Amber, because this is something to read before carrying on. It is not
    // an error: nothing has failed and nothing is blocked.
    const note = el("p", "pg-next-note", `△ ${route.offScript}`);
    copy.appendChild(note);
  }

  private appendActions(actions: HTMLElement, state: StepState): void {
    const step = state.step;
    const action = step.action;
    const waiting = this.host.busy();

    if (action?.kind === "run") {
      actions.appendChild(commandBox(action.argv));
      const button = el("button", "btn", buttonLabel(state, waiting));
      button.type = "button";
      button.disabled = waiting;
      button.addEventListener("click", () => {
        if (this.host.busy()) return;
        this.host.run(action.argv);
      });
      actions.appendChild(button);
    } else if (action?.kind === "sql") {
      const box = el("div", "cmd");
      const pre = el("pre", undefined, action.sql);
      const copy = el("button", "copy", "Copy");
      copy.type = "button";
      copy.addEventListener("click", () => { void navigator.clipboard?.writeText(action.sql); });
      actions.appendChild(fill(box, pre, copy));

      const button = el("button", "btn", "Put it in the SQL pane →");
      button.type = "button";
      button.addEventListener("click", () => this.host.offerSql(action.sql));
      actions.appendChild(button);
    } else if (action?.kind === "edit") {
      const box = el("div", "cmd");
      box.appendChild(el("pre", undefined, action.snippet));
      const copy = el("button", "copy", "Copy");
      copy.type = "button";
      copy.addEventListener("click", () => { void navigator.clipboard?.writeText(action.snippet); });
      box.appendChild(copy);
      actions.appendChild(box);

      // No button that edits the file: this step is the visitor's to make, and
      // a button here would be the page doing the one thing it is showing off.
      const button = el("button", "btn", `Open ${action.file} →`);
      button.type = "button";
      button.addEventListener("click", () => this.host.focusFile(action.file));
      actions.appendChild(button);
    }

    for (const argv of step.also ?? []) {
      const row = el("div", "pg-next-also");
      row.appendChild(commandBox(argv));
      const button = el("button", "btn btn-ghost", "Run");
      button.type = "button";
      button.disabled = waiting;
      button.addEventListener("click", () => {
        if (this.host.busy()) return;
        this.host.run(argv);
      });
      row.appendChild(button);
      actions.appendChild(row);
    }
  }
}

/** The primary button's words, which have to be honest about waiting. */
function buttonLabel(state: StepState, waiting: boolean): string {
  if (waiting) return "Waiting…";
  return state.status === "done" ? "Run again →" : "Run next →";
}

/** What the strip says under the headline for one step. */
function captionFor(state: StepState): string {
  const step: Step = state.step;
  if (state.status === "done") {
    return `${step.done ?? step.instruction} Checked against the workspace: ${state.detail}.`;
  }
  if (state.status === "unverifiable") {
    return `${step.instruction} ${step.unverified ?? ""}`.trim();
  }
  return step.instruction;
}

/** The tooltip on a step in the nav. */
function detailLine(state: StepState): string {
  if (state.status === "unverifiable") return state.step.unverified ?? "nothing to check here";
  if (state.status === "unknown") return "not checked yet: the runtime has not answered";
  const lead = state.status === "done" ? "Done" : "Not yet";
  return `${lead}: ${state.detail}`;
}
