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
import { diffView } from "./diffview.ts";
import { diffLines, splitLines } from "./linediff.ts";
import { anchorPopover } from "./popover.ts";
import {
  SCENARIOS,
  describeArgv,
  evaluateRoute,
  pad,
} from "./scenario.ts";
import type { PatchHunk, PatchResult, RouteState, Scenario, StateProbe, StepState } from "./scenario.ts";

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
  /** What applying a patch to schema.sql as the editor holds it would do. */
  patchState(patch: readonly PatchHunk[]): PatchResult["state"];
  /** Applies a patch to schema.sql in the editor, as an edit the visitor could undo by hand. */
  applyPatch(patch: readonly PatchHunk[]): void;
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
 * A done step keeps its number and gains a tick after its title. The number
 * is its place in the route, which does not change when it is done; the tick
 * is the part that says so. Screen readers get the word, not the glyph.
 *
 * A step that cannot be checked gets no mark at all: anything softer than a
 * tick would still read as a quieter kind of success.
 */
function doneMark(state: StepState): HTMLElement | null {
  if (state.status !== "done") return null;
  const mark = el("span", "pg-step-done");
  const tick = el("span", undefined, "✓");
  tick.setAttribute("aria-hidden", "true");
  return fill(mark, tick, el("span", "sr-only", "done"));
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
  /** The scenario selector, in the toolbar. */
  readonly bar: HTMLElement;
  /** The runtime's status pill and the storage note, in the status bar. */
  readonly state: HTMLElement;
  /** The five-column steps nav under the bar. */
  readonly steps: HTMLElement;
  /** The two-column strip that sits above the terminal. */
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

    this.bar = fill(
      el("div", "pg-bar"),
      fill(el("span", "pg-scenario"), el("span", "pg-scenario-label", "Scenario"), this.select),
    );
    this.state = fill(el("div", "pg-state"), this.status, this.storage);
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
        el("span", "pg-step-n", pad(index + 1)),
        el("span", "pg-step-of", `of ${pad(this.current.steps.length)}`),
        el("span", "pg-step-title", step.title),
        doneMark(state),
        el("span", "pg-step-hint", step.caption),
      );
      this.steps.appendChild(button);
    });
  }

  private renderNext(): void {
    clear(this.next);
    const route = this.route;
    const actions = el("div", "pg-next-run");

    if (!route) {
      fill(
        this.next,
        headlineWithHint("Reading the workspace.", {
          paragraphs: ["The steps above are checked against the real files and the real catalog, "
            + "so they stay blank until there is something to read."],
        }),
        actions,
      );
      return;
    }

    if (route.unavailable) {
      fill(
        this.next,
        headlineWithHint(this.current.title, {
          paragraphs: [this.current.description,
            `The route is not checked yet: ${route.unavailable}. Reading and editing work already.`],
        }),
        actions,
      );
      return;
    }

    const focused = this.focused();

    if (!focused) {
      const paragraphs = [this.current.finished.caption];
      if (this.current.note) paragraphs.push(this.current.note);
      fill(
        this.next,
        headlineWithHint(this.current.finished.headline, { paragraphs, offScript: route.offScript }),
        actions,
      );
      return;
    }

    const step = focused.step;
    this.appendActions(actions, focused);
    const patch = step.action?.kind === "edit" ? step.action.patch : undefined;
    const conflict = patch !== undefined && this.host.patchState(patch) === "conflict";
    fill(
      this.next,
      headlineWithHint(step.headline, {
        paragraphs: [focused.status === "done" ? step.done ?? step.instruction : step.instruction],
        patch,
        note: conflict
          ? "schema.sql has changed where this patch goes, so it is not applied. Type the change in "
            + "yourself, or Reset to start again from the seeded file."
          : undefined,
        check: detailLine(focused),
        offScript: route.offScript,
      }),
      actions,
    );
  }

  private appendActions(container: HTMLElement, state: StepState): void {
    const step = state.step;
    const action = step.action;
    const waiting = this.host.busy();

    // The primary action gets its own row for the same reason the secondary
    // ones do: .pg-next-run is a column of rows, and a box and its button
    // belong on one line inside a row rather than as siblings of it.
    const actions = el("div", "pg-next-row");
    if (action) container.appendChild(actions);

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
    } else if (action?.kind === "edit" && action.patch) {
      // The patch is applied to the editor's buffer and saved like typing, so
      // the lines it changed are marked there and the step ticks from the
      // file's content rather than from this click. Its label says what a
      // click would do now: apply, nothing left to apply, or cannot.
      const patch = action.patch;
      const state = this.host.patchState(patch);
      const label = state === "applies" ? "Apply patch" : state === "applied" ? "Patch applied" : "Patch does not apply";
      const button = el("button", "btn", label);
      button.type = "button";
      button.disabled = state !== "applies";
      button.addEventListener("click", () => this.host.applyPatch(patch));
      actions.appendChild(button);
    } else if (action?.kind === "edit") {
      const box = el("div", "cmd");
      box.appendChild(el("pre", undefined, action.snippet));
      const copy = el("button", "copy", "Copy");
      copy.type = "button";
      copy.addEventListener("click", () => { void navigator.clipboard?.writeText(action.snippet); });
      box.appendChild(copy);
      actions.appendChild(box);

      // Without a patch there is nothing the page could apply, so the button
      // opens the file and the edit is the visitor's to type.
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
      container.appendChild(row);
    }
  }
}

/** The primary button's words, which have to be honest about waiting. */
function buttonLabel(state: StepState, waiting: boolean): string {
  if (waiting) return "Waiting…";
  return state.status === "done" ? "Run again →" : "Run next →";
}

/**
 * A patch as a unified diff would print it: the lines it keeps, removes and
 * adds, hunk after hunk. It uses the comparison the editor's marks use, so
 * the lines shown here as added are the lines marked added once it applies.
 */
function patchPreview(patch: readonly PatchHunk[]): HTMLElement {
  return diffView(patch.map((hunk) => diffLines(splitLines(hunk.find), splitLines(hunk.replace))));
}

/** What the hint beside a headline opens. */
interface Hint {
  /** What the step asks for, or what it established once done. */
  paragraphs: readonly string[];
  /** A patch the step offers, shown as the lines it removes and adds. */
  patch?: readonly PatchHunk[] | undefined;
  /** Something to read before acting, in amber. */
  note?: string | undefined;
  /** What the route checked, in the check's own words. */
  check?: string;
  /** Set when the workspace has left the suggested route. */
  offScript?: string | null;
}

/**
 * The strip's headline, and a hint that opens the rest in a popover.
 *
 * The paragraphs used to sit under the headline. They are worth reading once,
 * and as a paragraph they held three lines of height that every pane below
 * gave up for as long as the step was shown. A note that the workspace has
 * left the route is the exception: the hint then says so on the strip, in
 * amber, because it is something to read before carrying on. It is not an
 * error treatment, since nothing has failed and nothing is blocked.
 */
function headlineWithHint(headline: string, hint: Hint): HTMLElement {
  const detail = el("div", "pg-next-detail");
  detail.id = "pg-next-detail";
  detail.popover = "auto";
  for (const text of hint.paragraphs) detail.appendChild(el("p", undefined, text));
  if (hint.patch) detail.appendChild(patchPreview(hint.patch));
  if (hint.note) detail.appendChild(el("p", "pg-next-note", `△ ${hint.note}`));
  if (hint.check) detail.appendChild(el("p", "pg-next-check", hint.check));
  if (hint.offScript) detail.appendChild(el("p", "pg-next-note", `△ ${hint.offScript}`));

  const button = el("button", "pg-next-info");
  button.type = "button";
  button.popoverTargetElement = detail;
  button.setAttribute("aria-expanded", "false");
  anchorPopover(detail, button);
  if (hint.offScript) {
    button.dataset["tone"] = "attention";
    fill(button, el("span", undefined, "△"), document.createTextNode(" Off the route"));
    button.firstElementChild?.setAttribute("aria-hidden", "true");
  } else {
    button.textContent = "i";
    button.setAttribute("aria-label", "About this step");
    button.title = "About this step";
  }

  return fill(el("div", "pg-next-copy"), el("strong", undefined, headline), button, detail);
}

/** The tooltip on a step in the nav. */
function detailLine(state: StepState): string {
  if (state.status === "unverifiable") return state.step.unverified ?? "nothing to check here";
  if (state.status === "unknown") return "not checked yet: the runtime has not answered";
  const lead = state.status === "done" ? "Done" : "Not yet";
  return `${lead}: ${state.detail}`;
}
