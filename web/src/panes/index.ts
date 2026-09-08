/**
 * The right-hand column: Data, Structure, Plan, and the tab strip over them.
 *
 * One thing for the page shell to construct and three panes it can reach.
 * The strip is here rather than in the shell because which pane is showing
 * is a property of this column, and because the panes need to be told when
 * they become visible -- a pane that was updated while hidden should not
 * have to guess whether it was seen.
 */

import { el } from "./dom.ts";
import { DataPane } from "./data.ts";
import { PlanPane } from "./plan.ts";
import { StructurePane } from "./structure.ts";

export * from "./catalog.ts";
export * from "./data.ts";
export * from "./plan.ts";
export * from "./rail.ts";
export * from "./structure.ts";
export { clear, el, fill, marker, renderStatus } from "./dom.ts";
export type { PaneStatus } from "./dom.ts";

export type ResultTab = "data" | "structure" | "plan";

const TAB_LABELS: Record<ResultTab, string> = {
  data: "Data",
  structure: "Structure",
  plan: "Plan",
};

export interface ResultPanesHandlers {
  onTabChange?(tab: ResultTab): void;
}

export class ResultPanes {
  readonly data: DataPane;
  readonly structure: StructurePane;
  readonly plan: PlanPane;

  private tabs: Record<ResultTab, HTMLButtonElement>;
  private bodies: Record<ResultTab, HTMLElement>;
  private source: HTMLElement;
  private handlers: ResultPanesHandlers;
  private current: ResultTab = "data";

  constructor(host: HTMLElement, handlers: ResultPanesHandlers = {}) {
    host.classList.add("pgc-panes");
    this.handlers = handlers;
    host.innerHTML = `
      <div class="pgc-tabbar">
        <div class="pgc-tablist" role="tablist" aria-label="Results"></div>
        <span class="pgc-tabmeta pgc-pane-source"></span>
      </div>
      <div class="pgc-pane" data-result-pane="data"></div>
      <div class="pgc-pane" data-result-pane="structure" hidden></div>
      <div class="pgc-pane" data-result-pane="plan" hidden></div>`;

    const list = host.querySelector<HTMLElement>(".pgc-tablist")!;
    this.source = host.querySelector<HTMLElement>(".pgc-pane-source")!;
    this.bodies = {
      data: host.querySelector<HTMLElement>('[data-result-pane="data"]')!,
      structure: host.querySelector<HTMLElement>('[data-result-pane="structure"]')!,
      plan: host.querySelector<HTMLElement>('[data-result-pane="plan"]')!,
    };
    this.tabs = {
      data: this.makeTab(list, "data"),
      structure: this.makeTab(list, "structure"),
      plan: this.makeTab(list, "plan"),
    };

    this.data = new DataPane(this.bodies.data);
    this.structure = new StructurePane(this.bodies.structure);
    this.plan = new PlanPane(this.bodies.plan);

    this.show("data");
  }

  private makeTab(list: HTMLElement, tab: ResultTab): HTMLButtonElement {
    const button = el("button", "pgc-tab", TAB_LABELS[tab]);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => this.show(tab));
    list.appendChild(button);
    return button;
  }

  /** The database this column is reading, e.g. `sqlite://app.db`. */
  setSource(text: string): void {
    this.source.textContent = text;
  }

  active(): ResultTab {
    return this.current;
  }

  show(tab: ResultTab): void {
    const changed = this.current !== tab;
    this.current = tab;
    for (const key of ["data", "structure", "plan"] as const) {
      const on = key === tab;
      this.tabs[key].classList.toggle("is-active", on);
      this.tabs[key].setAttribute("aria-selected", on ? "true" : "false");
      // `hidden` rather than display:none so the pane is out of the
      // accessibility tree as well as off the screen.
      this.bodies[key].hidden = !on;
    }
    if (changed) this.handlers.onTabChange?.(tab);
  }
}
