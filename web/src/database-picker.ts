import type { DatabaseEngine } from "./protocol.ts";
import { el, fill } from "./panes/dom.ts";
import { createOverlay } from "./panes/overlay.ts";
import { PGLITE_VERSION, POSTGRES_VERSION } from "./runtime/engine-versions.ts";
import sqlite from "../vendor/sqlite/sqlite-capabilities.json" with { type: "json" };

export function engineFromURL(url: string): DatabaseEngine | null {
  const engine = new URL(url).searchParams.get("engine");
  return engine === "postgres" || engine === "sqlite" ? engine : null;
}

export class DatabasePicker {
  readonly button = el("button", "pg-engine-button", "SQLite ▾");
  readonly element = el("div", "pg-engine");
  private readonly overlay = createOverlay("Choose a database", "pg-engine-overlay");
  private readonly choices = new Map<DatabaseEngine, { button: HTMLButtonElement; status: HTMLElement }>();
  private required = false;

  constructor(select: (engine: DatabaseEngine) => void) {
    this.button.type = "button";
    this.button.id = "pg-engine";
    this.button.value = "sqlite";
    this.button.setAttribute("aria-label", "Choose database engine");
    this.button.setAttribute("aria-haspopup", "dialog");
    this.button.addEventListener("click", () => this.overlay.open());
    this.overlay.dialog.addEventListener("cancel", event => { if (this.required) event.preventDefault(); });
    fill(this.element, el("span", undefined, "Database"), this.button);
    this.overlay.body.appendChild(el("p", "pg-engine-note", "Switching databases resets this scenario's files and data. Export first to keep your work. Everything runs in this tab and stays in memory."));
    const options = [
      { engine: "sqlite" as const, title: `SQLite ${sqlite.version}`, tool: "Official SQLite WebAssembly build", note: "Loaded when the playground starts. Supports SQLite file imports and versioned migrations." },
      { engine: "postgres" as const, title: `PostgreSQL ${POSTGRES_VERSION}`, tool: `PGlite ${PGLITE_VERSION}`, note: "Downloads the PostgreSQL runtime when first selected. Supports JSONB, arrays, UUIDs, and GIN indexes. SQLite file imports are unavailable." },
    ];
    for (const option of options) {
      const choice = el("button", "pg-engine-option");
      choice.type = "button";
      choice.dataset["engine"] = option.engine;
      const status = el("span", "pg-engine-choice-status");
      fill(choice, el("strong", undefined, option.title), el("span", "pg-engine-tool", option.tool), el("span", "pg-engine-description", option.note), status);
      choice.addEventListener("click", () => {
        this.required = false;
        this.overlay.close.hidden = false;
        this.overlay.dialog.close();
        select(option.engine);
      });
      this.choices.set(option.engine, { button: choice, status });
      this.overlay.body.appendChild(choice);
    }
    this.update("sqlite", ["sqlite", "postgres"]);
  }

  requireChoice(): void {
    this.required = true;
    this.overlay.close.hidden = true;
    this.overlay.open();
    this.choices.get(this.button.value as DatabaseEngine)?.button.focus();
  }

  update(engine: DatabaseEngine, supported: readonly DatabaseEngine[]): void {
    this.button.value = engine;
    this.button.textContent = `${engine === "postgres" ? "PostgreSQL" : "SQLite"} ▾`;
    for (const [value, choice] of this.choices) {
      choice.button.disabled = !supported.includes(value);
      choice.button.setAttribute("aria-pressed", String(value === engine));
      choice.status.textContent = choice.button.disabled ? "Unavailable in this scenario" : value === engine ? "Selected" : "Select database";
    }
  }
}
