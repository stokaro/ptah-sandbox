/*
 * Where the terminal sits in the full-window layout.
 *
 * Between the file list and the database pane by default, under the editor,
 * the way an editor docks its panel under the document; across the whole
 * width when a reader wants the room for long output. The choice is one data
 * attribute on the grid, which playground.css lays out, and the toolbar pair
 * that sets it reports it with aria-pressed. It is kept in this browser, and a
 * storage that refuses only means the choice lasts for the page.
 */

type Dock = "between" | "full";

const STORAGE_KEY = "ptah-playground-dock";

function load(): Dock {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "full" ? "full" : "between";
  } catch {
    return "between";
  }
}

function save(dock: Dock): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, dock);
  } catch {
    // Storage refused; the choice lasts for this page only.
  }
}

export function installDock(grid: HTMLElement, group: HTMLElement): void {
  const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>("button[data-dock]"));

  const apply = (dock: Dock): void => {
    grid.dataset["dock"] = dock;
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset["dock"] === dock));
    }
  };

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const dock: Dock = button.dataset["dock"] === "full" ? "full" : "between";
      apply(dock);
      save(dock);
    });
  }

  apply(load());
}
