/**
 * The first-visit tour: what each region of the page is, in reading order.
 *
 * This is orientation, not instruction. `guide.ts` already answers "what do I
 * do" -- five steps with a real argv and a real state check behind each. What
 * it does not answer is "what am I looking at", and a visitor who has never
 * seen this page lands on a rail, two panes, a terminal and a step nav at the
 * same moment. The tour names those regions once and then gets out of the way;
 * its last card hands over to the route rather than competing with it.
 *
 * Three properties worth knowing before changing anything here.
 *
 * **The steps are derived from what is on screen, not from this list.** Below
 * 720px the three panes are tabs and only one of them is in the layout, so a
 * fixed script would point a card at a `display: none` element and draw a ring
 * around nothing. Every step names its candidate targets, the first *visible*
 * one wins, and a step with no visible target is dropped. That is also why the
 * card counts "2 of 5" from the derived list rather than from the declaration.
 *
 * **Nothing here changes the page.** The tour reads geometry and draws on top.
 * It never switches a tab, scrolls a pane or runs a command, because a tour
 * that rearranges the thing it is describing leaves the visitor somewhere they
 * did not put themselves.
 *
 * **It is re-openable.** A one-shot overlay that can never be summoned again is
 * a worse deal than no overlay: the one visitor who dismisses it by reflex has
 * no way back. The header carries a Tour button for that, and it is the same
 * entry point the first visit uses.
 *
 * Markup uses classes tour.css defines and nothing else; no colour is set here.
 */

import { el, fill } from "./panes/dom.ts";

/** How the card is placed relative to the ring, in preference order. */
type Side = "below" | "above" | "right" | "left";

interface StepSpec {
  /** Candidate targets, best first. The first visible one is used. */
  targets: readonly string[];
  title: string;
  body: string;
  /** Preferred sides, tried in order before falling back to a clamp. */
  prefer: readonly Side[];
}

/**
 * The regions, in the order the page's own story runs: the state you want, the
 * state you have, the difference between them, the thing that applies it, the
 * route, and where to start.
 *
 * The three pane steps and the tabs step are mutually exclusive in practice --
 * the panes are separate elements on a wide screen and one tab strip on a
 * phone -- and the visibility rule above is what picks between them.
 */
const STEPS: readonly StepSpec[] = [
  {
    targets: ["#pg-editor"],
    title: "The schema you want",
    body:
      "A plain SQL file. Ptah reads it as the state the database should end up in. " +
      "You edit this; you never write the migration yourself.",
    prefer: ["right", "below", "above"],
  },
  {
    targets: ["#pg-rail"],
    title: "What the database actually has",
    body:
      "The workspace files, and below them the tables read back out of SQLite " +
      "after each command. This side is measured, not assumed.",
    prefer: ["right", "below"],
  },
  {
    targets: ["#pg-db"],
    title: "The difference, and the rows",
    body:
      "Data is what is in a table now. Structure marks what the schema file does " +
      "not account for. Plan is the SQL Ptah would run — readable before it runs.",
    prefer: ["left", "below", "above"],
  },
  {
    targets: [".pg-panetabs"],
    title: "Three panes, one at a time",
    body:
      "At this width the editor, the console and the database share the screen. " +
      "These tabs switch between them; nothing is lost when one is hidden.",
    prefer: ["below", "above"],
  },
  {
    targets: ["#pg-terminal"],
    title: "A real command line",
    body:
      "Real argv, real stdout and stderr, real exit codes. ↑ walks the history and " +
      "Tab completes. It is not a shell: no pipes, no redirects.",
    prefer: ["above", "below"],
  },
  {
    targets: ["#pg-steps"],
    title: "Five steps, if you want them",
    body:
      "A step ticks when the state actually changed — the column is in the catalog — " +
      "never because you pressed something. Going off the route is fine.",
    prefer: ["below", "above"],
  },
  {
    targets: ["#pg-next", "#pg-run-next"],
    title: "Start here",
    body:
      "The next command, written out in full. Press Run next, or type it into the " +
      "prompt yourself. Nothing is installed and nothing leaves this tab.",
    prefer: ["above", "below"],
  },
];

/** The storage key. Absence means the tour has not been shown. */
const SEEN_KEY = "ptah-play-tour";

/** Margin between the ring and the card, and between the card and the viewport. */
export const GAP = 12;
export const EDGE = 12;

/** The part of a rectangle the placement needs. `DOMRect` satisfies it. */
export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Placement {
  side: Side;
  top: number;
  left: number;
}

/**
 * Where the card goes, given the ring, the card's measured size and the
 * viewport.
 *
 * Pure, and exported, because this is where the failures live: a card off the
 * bottom of a short window, or a card laid over the very region it is
 * describing. The class below only feeds it rectangles it has measured.
 * src/tour.test.mjs pins the two properties that matter -- the card stays on
 * screen, and it does not cover the ring when any side had room.
 *
 * The clamp is last and unconditional, so the fallback side cannot put the
 * card outside the viewport. That means a card CAN overlap the ring when no
 * side fits at all -- on a viewport shorter than the card plus the region,
 * something has to give, and a readable card that overlaps beats a correct
 * one nobody can see.
 */
export function choosePlacement(
  ring: Box,
  card: Box,
  view: { width: number; height: number },
  prefer: readonly Side[],
): Placement {
  const right = ring.left + ring.width;
  const bottom = ring.top + ring.height;
  const fits: Record<Side, boolean> = {
    below: bottom + GAP + card.height <= view.height - EDGE,
    above: ring.top - GAP - card.height >= EDGE,
    right: right + GAP + card.width <= view.width - EDGE,
    left: ring.left - GAP - card.width >= EDGE,
  };
  const side = prefer.find((option) => fits[option]) ?? "below";

  let top: number;
  let left: number;
  if (side === "below" || side === "above") {
    top = side === "below" ? bottom + GAP : ring.top - GAP - card.height;
    left = ring.left + ring.width / 2 - card.width / 2;
  } else {
    left = side === "right" ? right + GAP : ring.left - GAP - card.width;
    top = ring.top + ring.height / 2 - card.height / 2;
  }

  return {
    side,
    left: Math.min(Math.max(EDGE, left), Math.max(EDGE, view.width - card.width - EDGE)),
    top: Math.min(Math.max(EDGE, top), Math.max(EDGE, view.height - card.height - EDGE)),
  };
}

/**
 * The smallest box worth drawing a ring around, per side.
 *
 * Not `> 0`. Below 720px `.pg-step:not([aria-current="step"])` is hidden, so
 * the step nav collapses to its own border whenever no step is current --
 * measured at 428x1 on a phone. A ring around that is a stray line across the
 * page and a card pointing at nothing, and `> 0` accepts it. A region a
 * sentence can describe has area.
 */
const MIN_SIDE = 24;

/**
 * Whether an element is laid out at a size worth describing.
 *
 * This is the whole of the derivation rule: the step list in `STEPS` is a
 * superset, and what a given screen actually shows decides the tour.
 */
function visible(node: Element | null): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false;
  const rect = node.getBoundingClientRect();
  return rect.width >= MIN_SIDE && rect.height >= MIN_SIDE;
}

/** Reading a rejected storage is not a reason to fail; it means "not seen". */
function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode: the tour opens again next time, which is the safe way to be wrong */
  }
}

/** The elements the card's focus trap cycles through. */
function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("button:not([disabled])"));
}

export class Tour {
  private readonly root: HTMLElement;
  private readonly scrim: readonly HTMLElement[];
  private readonly ring: HTMLElement;
  private readonly card: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly count: HTMLElement;
  private readonly back: HTMLButtonElement;
  private readonly forward: HTMLButtonElement;

  /** The steps this screen actually has, decided when the tour opens. */
  private live: { spec: StepSpec; target: HTMLElement }[] = [];
  private at = 0;
  private open = false;
  private restore: HTMLElement | null = null;

  private readonly onKey = (event: KeyboardEvent): void => this.key(event);
  private readonly onLayout = (): void => {
    if (this.open) this.place();
  };

  /**
   * Re-places the overlay when the page moves under it.
   *
   * Scroll and resize are not enough. The boot strip appears, reports phases
   * and goes away while the tour is open, and each of those is a layout shift
   * with no event of its own: the ring stayed 30px above the editor for the
   * whole of the first step, drawn across the step nav. Watching the body and
   * every target covers that, font swaps, and a pane that grows when its
   * content arrives. The body alone is not enough above 1100px, where the
   * panes fill a window-high frame: the strip leaving moved the editor 91px
   * and left the body exactly as tall as before, so only the panes resized.
   */
  private readonly resizes = new ResizeObserver(() => {
    if (this.open) this.place();
  });

  constructor() {
    // Four rectangles rather than one big `box-shadow` spread: the design has
    // no shadows in it, and four rects also leave the cut-out genuinely
    // transparent instead of tinted.
    this.scrim = ["t", "r", "b", "l"].map((edge) => el("div", `pg-tour-scrim pg-tour-scrim-${edge}`));
    this.ring = el("div", "pg-tour-ring");
    this.title = el("h2", "pg-tour-title");
    this.body = el("p", "pg-tour-body");
    this.count = el("span", "pg-tour-count");

    this.back = el("button", "btn btn-ghost pg-tour-back", "Back");
    this.back.type = "button";
    this.back.addEventListener("click", () => this.go(this.at - 1));

    this.forward = el("button", "btn pg-tour-next", "Next");
    this.forward.type = "button";
    this.forward.addEventListener("click", () => this.go(this.at + 1));

    const skip = el("button", "pg-tour-skip", "Skip");
    skip.type = "button";
    skip.addEventListener("click", () => this.close());

    const foot = fill(el("div", "pg-tour-foot"), this.count, fill(el("div", "pg-tour-buttons"), skip, this.back, this.forward));

    this.card = fill(el("div", "pg-tour-card"), this.title, this.body, foot);
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-modal", "true");
    this.card.setAttribute("aria-label", "A tour of this page");
    this.card.tabIndex = -1;

    this.root = fill(el("div", "pg-tour"), ...this.scrim, this.ring, this.card);
    this.root.hidden = true;
    // The scrim is the forgiving exit: a click anywhere outside the card ends
    // the tour rather than trapping someone who has seen enough.
    for (const part of this.scrim) part.addEventListener("click", () => this.close());
  }

  /** Attaches the overlay. Call once, after the page markup exists. */
  mount(host: HTMLElement = document.body): void {
    host.appendChild(this.root);
  }

  /** Opens the tour if this browser has not been shown it before. */
  offerFirstVisit(): void {
    if (seen()) return;
    this.start();
  }

  /** Opens the tour unconditionally. The Tour button calls this. */
  start(): void {
    this.live = STEPS.flatMap((spec) => {
      const target = spec.targets.map((s) => document.querySelector(s)).find(visible);
      return target ? [{ spec, target }] : [];
    });
    // Nothing on screen to point at -- a collapsed or still-empty page. Saying
    // nothing is better than drawing a ring around the viewport corner.
    if (this.live.length === 0) return;

    markSeen();
    this.restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.open = true;
    this.root.hidden = false;
    document.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onLayout);
    window.addEventListener("scroll", this.onLayout, true);
    this.resizes.observe(document.body);
    for (const { target } of this.live) this.resizes.observe(target);
    this.go(0);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.hidden = true;
    document.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onLayout);
    window.removeEventListener("scroll", this.onLayout, true);
    this.resizes.disconnect();
    this.restore?.focus();
    this.restore = null;
  }

  private go(to: number): void {
    if (to < 0) return;
    if (to >= this.live.length) {
      this.close();
      return;
    }
    this.at = to;
    const { spec } = this.live[to];
    this.title.textContent = spec.title;
    this.body.textContent = spec.body;
    this.count.textContent = `${to + 1} of ${this.live.length}`;
    this.back.disabled = to === 0;
    this.forward.textContent = to === this.live.length - 1 ? "Done" : "Next";

    // Scrolling and measuring are separate passes on purpose. `scrollIntoView`
    // does not finish before the next statement -- a rectangle read straight
    // after it was 30px stale on the first step, which put the cut-out across
    // the step nav -- so the placement waits a frame for the scroll to land.
    // Doing both in one pass and letting the scroll listener correct it also
    // works, and is worse: the card visibly moves twice.
    this.live[to].target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    requestAnimationFrame(() => {
      if (this.open) this.place();
    });
    this.card.focus();
  }

  /**
   * Puts the ring on the target and the card beside it.
   *
   * Pure measurement: it reads the page and moves three things on top of it.
   * It never scrolls, which is what lets the scroll listener call it without
   * the two triggering each other. `go` does the scrolling, once per step.
   */
  private place(): void {
    const { spec, target } = this.live[this.at];
    const rect = target.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    this.ring.style.top = `${rect.top}px`;
    this.ring.style.left = `${rect.left}px`;
    this.ring.style.width = `${rect.width}px`;
    this.ring.style.height = `${rect.height}px`;

    const [t, r, b, l] = this.scrim;
    const box = (node: HTMLElement, top: number, left: number, width: number, height: number): void => {
      node.style.top = `${top}px`;
      node.style.left = `${left}px`;
      node.style.width = `${Math.max(0, width)}px`;
      node.style.height = `${Math.max(0, height)}px`;
    };
    box(t, 0, 0, vw, rect.top);
    box(b, rect.bottom, 0, vw, vh - rect.bottom);
    box(l, rect.top, 0, rect.left, rect.height);
    box(r, rect.top, rect.right, vw - rect.right, rect.height);

    // The card is measured rather than assumed: its height depends on how the
    // body wrapped at this width, and a guessed height puts it off-screen on
    // the one viewport nobody tested.
    const card = this.card.getBoundingClientRect();
    const spot = choosePlacement(rect, card, { width: vw, height: vh }, spec.prefer);

    this.card.style.left = `${spot.left}px`;
    this.card.style.top = `${spot.top}px`;
    this.card.dataset.side = spot.side;
  }

  private key(event: KeyboardEvent): void {
    if (!this.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      this.go(this.at + 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      this.go(this.at - 1);
      return;
    }
    if (event.key !== "Tab") return;

    // The overlay covers the page, so Tab must stay inside the card; without
    // this the focus ring walks off into controls the scrim is hiding.
    const stops = focusable(this.card);
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === this.card)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
