/*
 * The draggable lines between the panes of the full-window layout.
 *
 * Above 1100px the playground lays its panes out like an editor (see "Full
 * window" in playground.css): the file list, the editor and the database
 * across the top, the terminal across the bottom. Three lines between them can
 * be moved: the file list's right edge, the database pane's left edge, and the
 * top of the terminal's block. Each writes one custom property on the grid --
 * --pg-rail, --pg-db, --pg-term -- and the grid's template reads it. A size
 * nobody has set is left to the stylesheet's default.
 *
 * Each line is a real control: a focusable separator with its value, moved by
 * the arrow keys as well as the pointer, and a double click puts it back. The
 * sizes a reader chose are kept in this browser, and a storage that refuses
 * only means they last for the page.
 */

type Name = "rail" | "db" | "term";

type Sizes = Partial<Record<Name, number>>;

const STORAGE_KEY = "ptah-playground-panes";
const WIDE = "(min-width: 1101px)";
const STEP = 16;

/* The room each pane keeps however the others are dragged. */
const MIN = { rail: 160, db: 280, term: 120, editor: 280, panes: 160 };
const MAX_RAIL = 440;

const LABEL: Record<Name, string> = {
  rail: "Resize the file list",
  db: "Resize the database pane",
  term: "Resize the terminal",
};

function load(): Sizes {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    const sizes: Sizes = {};
    if (parsed !== null && typeof parsed === "object") {
      for (const name of ["rail", "db", "term"] as const) {
        const value = (parsed as Record<string, unknown>)[name];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) sizes[name] = value;
      }
    }
    return sizes;
  } catch {
    return {};
  }
}

function save(sizes: Sizes): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
  } catch {
    // Storage refused; the sizes last for this page only.
  }
}

/* The panes are looked up on each use: the components that own them may
 * replace the static markup in place, and a size read off a detached node is
 * zero. */
export interface SplitterPanes {
  grid: HTMLElement;
  rail: () => HTMLElement | null;
  db: () => HTMLElement | null;
  next: () => HTMLElement | null;
  terminal: () => HTMLElement | null;
}

export function installSplitters(panes: SplitterPanes): void {
  const { grid } = panes;
  const width = (pane: HTMLElement | null): number => pane?.offsetWidth ?? 0;
  const height = (pane: HTMLElement | null): number => pane?.offsetHeight ?? 0;
  const wide = window.matchMedia(WIDE);
  const sizes = load();

  const measured = (name: Name): number =>
    name === "rail" ? width(panes.rail()) : name === "db" ? width(panes.db()) : height(panes.terminal());

  const bounds = (name: Name): [number, number] => {
    const gridWidth = grid.clientWidth;
    const gridHeight = grid.clientHeight;
    const nextHeight = height(panes.next());
    if (name === "rail") {
      const others = sizes.db ?? width(panes.db());
      return [MIN.rail, Math.max(MIN.rail, Math.min(MAX_RAIL, gridWidth - others - MIN.editor))];
    }
    if (name === "db") {
      const others = sizes.rail ?? width(panes.rail());
      return [MIN.db, Math.max(MIN.db, gridWidth - others - MIN.editor)];
    }
    return [MIN.term, Math.max(MIN.term, gridHeight - nextHeight - MIN.panes)];
  };

  const clamp = (name: Name, value: number): number => {
    const [low, high] = bounds(name);
    return Math.round(Math.min(high, Math.max(low, value)));
  };

  const handles = new Map<Name, HTMLElement>();

  const describe = (name: Name): void => {
    const handle = handles.get(name);
    if (handle === undefined) return;
    const [low, high] = bounds(name);
    handle.setAttribute("aria-valuemin", String(Math.round(low)));
    handle.setAttribute("aria-valuemax", String(Math.round(high)));
    handle.setAttribute("aria-valuenow", String(Math.round(sizes[name] ?? measured(name))));
  };

  // Writes every chosen size, clamped to the window as it is now, so a size
  // saved on a larger screen cannot push a pane off this one.
  const apply = (): void => {
    for (const name of ["rail", "db", "term"] as const) {
      const value = sizes[name];
      if (value === undefined) grid.style.removeProperty(`--pg-${name}`);
      else grid.style.setProperty(`--pg-${name}`, `${clamp(name, value)}px`);
    }
    for (const name of handles.keys()) describe(name);
  };

  const set = (name: Name, value: number): void => {
    sizes[name] = clamp(name, value);
    apply();
  };

  const reset = (name: Name): void => {
    delete sizes[name];
    apply();
    save(sizes);
  };

  const make = (name: Name, orientation: "vertical" | "horizontal"): void => {
    const handle = document.createElement("div");
    handle.className = "pg-split";
    handle.dataset.split = name;
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", orientation);
    handle.setAttribute("aria-label", LABEL[name]);
    handle.title = `${LABEL[name]}. Double-click to reset.`;

    // The value each line holds is a pane's size, so the pointer's position is
    // turned into that size from the edge the pane sits against.
    const sizeAt = (event: PointerEvent): number => {
      const box = grid.getBoundingClientRect();
      if (name === "rail") return event.clientX - box.left;
      if (name === "db") return box.right - event.clientX;
      return box.bottom - event.clientY - height(panes.next());
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !wide.matches) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("is-dragging");
      grid.closest(".pg-app")?.classList.add("is-resizing");
      const move = (moved: PointerEvent): void => set(name, sizeAt(moved));
      const done = (): void => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", done);
        handle.removeEventListener("pointercancel", done);
        handle.classList.remove("is-dragging");
        grid.closest(".pg-app")?.classList.remove("is-resizing");
        save(sizes);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", done);
      handle.addEventListener("pointercancel", done);
    });

    // An arrow moves the line the way it points: right widens the file list
    // and narrows the database pane, up raises the terminal.
    handle.addEventListener("keydown", (event) => {
      const current = sizes[name] ?? measured(name);
      let delta = 0;
      if (orientation === "vertical") {
        if (event.key === "ArrowRight") delta = name === "rail" ? STEP : -STEP;
        else if (event.key === "ArrowLeft") delta = name === "rail" ? -STEP : STEP;
      } else if (event.key === "ArrowUp") delta = STEP;
      else if (event.key === "ArrowDown") delta = -STEP;
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const [low, high] = bounds(name);
        set(name, event.key === "Home" ? low : high);
        save(sizes);
        return;
      }
      if (delta === 0) return;
      event.preventDefault();
      set(name, current + delta);
      save(sizes);
    });

    handle.addEventListener("dblclick", () => reset(name));

    handles.set(name, handle);
    grid.appendChild(handle);
  };

  make("rail", "vertical");
  make("db", "vertical");
  make("term", "horizontal");

  apply();
  // The limits depend on the grid's own size, which changes without the window
  // changing: the boot strip above it leaves once the runtime answers, and a
  // size clamped while it was there would stay clamped after it went.
  new ResizeObserver(apply).observe(grid);
  wide.addEventListener("change", apply);
}
