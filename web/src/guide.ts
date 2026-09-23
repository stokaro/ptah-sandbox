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
import type {
  Action,
  PatchHunk,
  PatchResult,
  RouteState,
  Scenario,
  StateProbe,
  Step,
  StepState,
} from "./scenario.ts";

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
  /** Puts focus on the terminal's prompt, where a running command reads its answer. */
  focusPrompt(): void;
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
  return state.status === "done" ? doneTick() : null;
}

/** The green tick, with the word for screen readers. */
function doneTick(): HTMLElement {
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
  // The full-window strip keeps a command to one line; the whole of it is
  // here, as well as in what Copy takes and what the terminal echoes.
  pre.title = describeArgv(argv);
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
  /** Opens the scenario picker; it names the scenario that is loaded. */
  private readonly pick: HTMLButtonElement;
  /** The picker: every scenario by its title and what it is about. */
  private readonly picker: HTMLDialogElement;
  private readonly status: HTMLElement;
  private readonly storage: HTMLElement;

  private current: Scenario;
  private route: RouteState | null = null;
  /** What a run the strip started is asking on stdin; null when it is not. */
  private question: string | null = null;
  /** SQL the strip put in the SQL pane that nobody has run since; null when none. */
  private offered: string | null = null;
  /** Per step, the part the strip shows, for a step of more than one. */
  private partAt = new Map<number, number>();
  /** Per step, the parts this page has seen done. */
  private partsDone = new Map<number, Set<number>>();
  /** The strip's move from one height to another, while it runs. */
  private heightMove: Animation | null = null;
  /** The step the strip is showing, or null to follow the route. */
  private pinned: number | null = null;
  /** Serializes refreshes so two overlapping passes cannot paint out of order. */
  private pass = 0;

  constructor(host: GuideHost, catalog: readonly Scenario[] = SCENARIOS) {
    if (catalog.length === 0) throw new Error("guide: no scenarios to show");
    this.host = host;
    this.catalog = catalog;
    this.current = catalog[0] as Scenario;

    // A dialog rather than a select: a scenario is chosen by what it is
    // about, which takes a sentence, and the list is meant to grow.
    this.pick = el("button", "pg-scenario-btn");
    this.pick.type = "button";
    this.pick.setAttribute("aria-haspopup", "dialog");
    this.picker = this.buildPicker();
    this.pick.addEventListener("click", () => this.openPicker());

    this.status = el("span", "pg-status");
    this.status.setAttribute("role", "status");
    this.storage = el("span", "pg-storage", "memory-only");

    this.bar = fill(
      el("div", "pg-bar"),
      fill(el("span", "pg-scenario"), el("span", "pg-scenario-label", "Scenario"), this.pick),
      this.picker,
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
    this.pinned = null;
    this.route = null;
    this.forgetParts();
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
  /**
   * The scenario picker. One row per scenario in catalog order, each its
   * title, its description and how many steps it has, so a scenario added to
   * the catalog is in the list with nothing else to change.
   */
  private buildPicker(): HTMLDialogElement {
    const dialog = el("dialog", "pg-picker");
    dialog.setAttribute("aria-labelledby", "pg-picker-title");
    const close = el("button", "btn btn-ghost pg-picker-close", "Close");
    close.type = "button";
    close.addEventListener("click", () => dialog.close());
    const title = el("h2", "pg-picker-title", "Choose a scenario");
    title.id = "pg-picker-title";

    const list = el("ul", "pg-picker-list");
    for (const scenario of this.catalog) {
      const option = el("button", "pg-picker-option");
      option.type = "button";
      option.dataset["scenario"] = scenario.id;
      const count = scenario.steps.length;
      fill(
        option,
        el("span", "pg-picker-name", scenario.title),
        el("span", "pg-picker-meta", count === 0 ? "no steps" : count === 1 ? "1 step" : `${count} steps`),
        el("span", "pg-picker-desc", scenario.description),
      );
      option.addEventListener("click", () => {
        dialog.close();
        if (scenario.id !== this.current.id) void this.load(scenario.id);
      });
      list.appendChild(fill(el("li"), option));
    }
    // Up and down move between the rows, as they would in a list box.
    list.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const options = [...list.querySelectorAll<HTMLButtonElement>(".pg-picker-option")];
      const at = options.indexOf(document.activeElement as HTMLButtonElement);
      const next = options[at + (event.key === "ArrowDown" ? 1 : -1)];
      if (next === undefined) return;
      event.preventDefault();
      next.focus();
    });
    // A click on the backdrop is a click on the dialog itself.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });

    fill(
      dialog,
      fill(el("div", "pg-picker-head"), title, close),
      el(
        "p",
        "pg-picker-note",
        "Each scenario seeds its own workspace. Choosing one replaces the files and the database in "
          + "this tab, so Export first if you want to keep them.",
      ),
      list,
    );
    return dialog;
  }

  /** Opens the picker on the scenario that is loaded. */
  private openPicker(): void {
    for (const option of this.picker.querySelectorAll<HTMLButtonElement>(".pg-picker-option")) {
      const here = option.dataset["scenario"] === this.current.id;
      if (here) option.setAttribute("aria-current", "true");
      else option.removeAttribute("aria-current");
    }
    this.picker.showModal();
    this.picker.querySelector<HTMLButtonElement>('.pg-picker-option[aria-current="true"]')?.focus();
  }

  /**
   * A run the strip started is asking a question on stdin, or has its answer
   * (null). While it asks, the strip says so and quotes the question: the
   * button that started it is at the top of the window and the prompt that
   * wants the answer is at the bottom, and a confirmation nobody notices is
   * a run that looks stuck.
   */
  asking(question: string | null): void {
    this.question = question;
    this.renderNext();
  }

  /**
   * Something ran from the SQL pane. Whatever the strip put there has done
   * its job, so the strip stops pointing at Run, and the step's SQL part is
   * done if this was its query -- or any query, when the strip had just put
   * its own there and the visitor edited it before running.
   */
  sqlRan(sql: string): void {
    const offered = this.offered;
    this.offered = null;
    this.markParts((part) => part.kind === "sql" && (part.sql === offered || sameSql(part.sql, sql)));
    this.renderNext();
  }

  /**
   * A command finished in the terminal, typed there or started from the
   * strip. A part of the step on screen that is that command is done.
   */
  ran(argv: readonly string[]): void {
    this.markParts((part) => part.kind === "run" && sameArgv(part.argv, argv));
  }

  /** A new workspace: nothing in it has been done yet. */
  forgetParts(): void {
    this.partAt.clear();
    this.partsDone.clear();
    this.offered = null;
  }

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
    this.pick.textContent = this.current.title;
    this.pick.title = "Choose another scenario";
    this.renderSteps();
    this.renderNext();
  }

  /**
   * The step row. Its buttons are built once per scenario and then only
   * updated: a change of step is then a change of attributes on the same
   * elements, which CSS can animate. A row rebuilt on every render had no
   * earlier state to move from, so the selection jumped.
   */
  private renderSteps(): void {
    const route = this.route;
    const focused = this.focused();
    const steps = this.current.steps;

    if (this.steps.dataset["scenario"] !== this.current.id) {
      clear(this.steps);
      this.steps.dataset["scenario"] = this.current.id;
      // A scenario with no steps keeps the row, saying so, so switching to it
      // does not pull everything under the row up by its height.
      this.steps.classList.toggle("is-empty", steps.length === 0);
      if (steps.length === 0) {
        this.steps.appendChild(el("p", "pg-steps-empty", "No steps in this scenario: nothing is suggested and nothing is checked."));
      }
      steps.forEach((step, index) => {
        const button = el("button", "pg-step");
        button.type = "button";
        button.addEventListener("click", () => this.focusStep(index));
        fill(
          button,
          el("span", "pg-step-n", pad(index + 1)),
          el("span", "pg-step-of", `of ${pad(steps.length)}`),
          el("span", "pg-step-title", step.title),
          el("span", "pg-step-mark"),
          el("span", "pg-step-hint", step.caption),
        );
        this.steps.appendChild(button);
      });
    }

    this.steps.querySelectorAll<HTMLButtonElement>(".pg-step").forEach((button, index) => {
      const step = steps[index] as Step;
      const state: StepState = route?.steps[index]
        ?? { step, index, status: "unknown", detail: "not checked yet" };
      button.dataset["status"] = state.status;
      if (focused?.index === index) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
      // The tooltip is the check's own words, so hovering a step says what was
      // looked at rather than repeating the caption.
      button.title = detailLine(state);
      const mark = button.querySelector(".pg-step-mark") as HTMLElement;
      clear(mark);
      const tick = doneMark(state);
      if (tick) mark.appendChild(tick);
    });
  }

  /**
   * Paints the strip. Where its height changed -- on a phone the strip is as
   * tall as what the step says, and moving to another step or part changes
   * it -- the strip moves from the old height to the new one instead of
   * jumping, and what is under it moves with it. The full-window strip holds
   * one height and never moves.
   */
  private renderNext(): void {
    const before = this.next.getBoundingClientRect().height;
    // Cancelled before the new height is read, or the reading is the old
    // animation's rather than the strip's own.
    this.heightMove?.cancel();
    this.paintNext();
    const after = this.next.getBoundingClientRect().height;
    if (before === 0 || Math.abs(after - before) < 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    this.next.style.overflow = "hidden";
    this.heightMove = this.next.animate([{ height: `${before}px` }, { height: `${after}px` }], {
      duration: 220,
      easing: "ease",
    });
    const settle = (): void => {
      this.next.style.overflow = "";
    };
    this.heightMove.finished.then(settle, settle);
  }

  private paintNext(): void {
    clear(this.next);
    const route = this.route;
    const actions = el("div", "pg-next-run");
    delete this.next.dataset["state"];

    if (this.question !== null) {
      const focused = this.focused();
      this.next.dataset["state"] = "asking";
      const answer = el("button", "btn", "Answer in the terminal");
      answer.type = "button";
      answer.addEventListener("click", () => this.host.focusPrompt());
      const ask = fill(
        el("div", "pg-next-ask"),
        el("span", "pg-next-ask-sigil", "?"),
        el("span", "pg-next-ask-text", this.question === "" ? "The command is waiting for input." : this.question),
      );
      actions.appendChild(fill(el("div", "pg-next-row"), ask, answer));
      fill(
        this.next,
        headlineWithHint("Ptah is waiting for your answer in the terminal.", {
          paragraphs: [
            focused?.step.instruction
              ?? "Type the answer at the prompt and press Enter. Ctrl+C cancels the command.",
          ],
        }),
        actions,
      );
      return;
    }

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
    const parts = actionsOf(step);
    const at = this.partShown(focused.index, parts.length);
    const action = parts[at];
    // The strip put this step's SQL in the pane and nobody has run it yet:
    // the headline says where the next press is. The guide never presses it.
    const offered = action?.kind === "sql" && this.offered === action.sql;
    if (offered) this.next.dataset["state"] = "offered";
    this.appendActions(actions, focused, parts, at);
    const patch = action?.kind === "edit" ? action.patch : undefined;
    const conflict = patch !== undefined && this.host.patchState(patch) === "conflict";
    fill(
      this.next,
      headlineWithHint(offered ? "The query is in the SQL pane. Press Run there to read the rows back." : step.headline, {
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

  /**
   * The part of the step the strip shows, and, for a step of more than one,
   * the switch between its parts. .pg-next-run is a column of rows, and a
   * box and its button belong on one line inside a row rather than as
   * siblings of it.
   */
  private appendActions(
    container: HTMLElement,
    state: StepState,
    parts: readonly Action[],
    at: number,
  ): void {
    const action = parts[at];
    const waiting = this.host.busy();
    const done = this.partsDone.get(state.index) ?? new Set<number>();

    const actions = el("div", "pg-next-row");
    if (action) container.appendChild(actions);
    if (parts.length > 1) actions.appendChild(this.partSwitch(state.index, parts, at, done));

    if (action?.kind === "run") {
      actions.appendChild(commandBox(action.argv));
      // Again, once this part has been seen done -- or the whole step has,
      // and this is its last part.
      const again = done.has(at) || (state.status === "done" && at === parts.length - 1);
      const button = el("button", "btn", runLabel(again, waiting));
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
      pre.title = action.sql;
      const copy = el("button", "copy", "Copy");
      copy.type = "button";
      copy.addEventListener("click", () => { void navigator.clipboard?.writeText(action.sql); });
      actions.appendChild(fill(box, pre, copy));

      if (this.offered === action.sql) {
        // Put there already: in place of a button that would put it there
        // again, where the one that runs it is.
        actions.appendChild(el("span", "pg-next-offer", "Run is under the query · ⌘↵ or Ctrl+↵"));
      } else {
        const button = el("button", "btn", "Put it in the SQL pane →");
        button.type = "button";
        button.addEventListener("click", () => {
          this.host.offerSql(action.sql);
          this.offered = action.sql;
          this.renderNext();
        });
        actions.appendChild(button);
      }
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

  }

  /**
   * One numbered button per part, the part on screen marked current and a
   * part seen done carrying the step's tick. Any of them can be chosen; a
   * part seen done moves the strip on to the next by itself.
   */
  private partSwitch(step: number, parts: readonly Action[], at: number, done: ReadonlySet<number>): HTMLElement {
    const group = el("div", "pg-next-parts");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Parts of this step");
    parts.forEach((part, index) => {
      const button = el("button", "pg-next-part");
      button.type = "button";
      const finished = done.has(index);
      fill(button, el("span", undefined, String(index + 1)), finished ? doneTick() : null);
      button.title = `${index + 1} of ${parts.length}: ${partLabel(part)}${finished ? ", done" : ""}`;
      button.setAttribute("aria-label", button.title);
      if (index === at) button.setAttribute("aria-current", "step");
      button.addEventListener("click", () => {
        this.partAt.set(step, index);
        this.renderNext();
      });
      group.appendChild(button);
    });
    return group;
  }

  /** Which part of a step the strip shows. */
  private partShown(step: number, count: number): number {
    return Math.min(this.partAt.get(step) ?? 0, Math.max(0, count - 1));
  }

  /**
   * Records that parts of the step on screen were done, and when the part
   * shown is one of them, moves on to the next part not done yet. Only the
   * step on screen is credited: a part is guidance about where the visitor
   * is, and the route's own checks decide whether a step is done.
   */
  private markParts(matches: (part: Action) => boolean): void {
    const focused = this.focused();
    if (focused === null) return;
    const parts = actionsOf(focused.step);
    const done = this.partsDone.get(focused.index) ?? new Set<number>();
    const before = done.size;
    parts.forEach((part, index) => {
      if (matches(part)) done.add(index);
    });
    if (done.size === before) return;
    this.partsDone.set(focused.index, done);
    const at = this.partShown(focused.index, parts.length);
    if (done.has(at)) {
      const next = parts.findIndex((_, index) => index > at && !done.has(index));
      if (next !== -1) this.partAt.set(focused.index, next);
    }
    this.renderNext();
  }
}

/** The run button's words, which have to be honest about waiting. */
function runLabel(again: boolean, waiting: boolean): string {
  if (waiting) return "Waiting…";
  return again ? "Run again →" : "Run next →";
}

/**
 * A step's actions in the order they are meant to be done: its action, then
 * each of its further commands. The strip shows one at a time.
 */
function actionsOf(step: Step): Action[] {
  const parts: Action[] = step.action ? [step.action] : [];
  for (const argv of step.also ?? []) parts.push({ kind: "run", argv });
  return parts;
}

/** What a part is, for the switch's labels. */
function partLabel(part: Action): string {
  if (part.kind === "run") return `ptah ${part.argv.filter((token) => !token.startsWith("-")).slice(0, 2).join(" ")}`;
  if (part.kind === "sql") return "the query in the SQL pane";
  return `the edit to ${part.file}`;
}

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

/** Whitespace and a final semicolon do not make two queries different. */
function sameSql(a: string, b: string): boolean {
  const norm = (sql: string): string => sql.replace(/\s+/g, " ").trim().replace(/;$/, "").trim();
  return norm(a) === norm(b);
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
