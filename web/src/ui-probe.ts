/**
 * The regression test for the playground page, run in a real browser.
 *
 * It drives `index.html` itself, in an iframe, through the controls a visitor
 * uses: it types into the terminal's input and presses Enter, types into the
 * editor's textarea, clicks the SQL tab's Run button. It never imports a module
 * from the page and never reaches for an internal object -- every assertion is
 * a question about the DOM the page produced.
 *
 * That is the point. `probe.ts` proves the runtime; the component suites prove
 * the pieces in Node against fake DOMs. Neither can tell you that the plan pane
 * fills after a dry run, because that only happens when the pieces are wired
 * to each other. This can, and it fails when the wiring breaks.
 *
 * The result is published on `window.__probe` for a CDP driver to read; the
 * page also prints it, so opening ui-probe.html in a browser is a valid way to
 * run it.
 */

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface ProbeResult {
  ok: boolean;
  passed: number;
  failed: number;
  durationMs: number;
  checks: Check[];
  /** Everything the page said, so a failure can be read rather than guessed at. */
  transcript: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  const line = document.createElement("div");
  line.className = ok ? "ok" : "bad";
  line.textContent = `${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`;
  document.getElementById("out")?.append(line);
}

/* ---------- Waiting ---------- */

const DEADLINE_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls until a predicate answers, or gives up with what it last saw.
 *
 * Polling rather than observing: the page has no events to subscribe to from
 * outside, and inventing one would be a hook that exists only for the test.
 */
async function until<T>(
  what: string,
  probe: () => T | null,
  timeout = DEADLINE_MS,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() - started > timeout) {
      throw new Error(`timed out after ${Math.round((Date.now() - started) / 1000)} s waiting for ${what}`);
    }
    await sleep(100);
  }
}

/* ---------- The page under test ---------- */

/**
 * The frame's own event constructors.
 *
 * An event has to be built with the constructor from the document it is
 * dispatched into: one built here is an instance of this window's Event and
 * the page's own `instanceof` checks would not recognise it. `Window` as the
 * DOM lib types it does not carry the global constructors, so the two that are
 * used are named.
 */
interface FrameGlobals {
  Event: typeof Event;
  KeyboardEvent: typeof KeyboardEvent;
}

let doc!: Document;
let win!: FrameGlobals;

function q<T extends Element>(selector: string): T | null {
  return doc.querySelector<T>(selector);
}

function need<T extends Element>(selector: string): T {
  const node = q<T>(selector);
  if (node === null) throw new Error(`ui-probe: ${selector} is not on the page`);
  return node;
}

function textOf(selector: string): string {
  return q(selector)?.textContent ?? "";
}

/** Types a line into the terminal and presses Enter, as a person would. */
function typeCommand(line: string): void {
  const field = need<HTMLInputElement>(".term-field-input");
  field.focus();
  field.value = line;
  field.dispatchEvent(new win.Event("input", { bubbles: true }));
  field.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
}

/** Replaces the editor's text through its own input path. */
function typeSchema(value: string): void {
  const input = need<HTMLTextAreaElement>(".pgc-ed-input");
  input.focus();
  input.value = value;
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
}

/** The status the route put on each step: done / current / todo / unknown. */
function stepStates(): string[] {
  return [...doc.querySelectorAll<HTMLElement>(".pg-step")].map(
    (b) => b.dataset["status"] ?? "?",
  );
}

/** True when a result pane's text contains a string. */
function paneHas(pane: string, value: string): boolean {
  return textOf(`[data-result-pane="${pane}"]`).includes(value);
}

function terminalText(): string {
  return textOf(".term-screen");
}

/** The state attribute the terminal keeps on its root: idle while nothing runs. */
function terminalIdle(): boolean {
  return need<HTMLElement>("#pg-terminal").dataset["state"] === "idle";
}

async function runCommand(line: string): Promise<{ exit: string; output: string }> {
  const before = terminalText().length;
  typeCommand(line);
  await until(`${line} to start`, () => !terminalIdle() || terminalText().length > before, 20_000);
  await until(`${line} to finish`, () => terminalIdle());
  return { exit: textOf(".term-exit").trim(), output: terminalText().slice(before) };
}

/* ---------- The scenario ---------- */

const DRIFT = "ptah schema drift --schema-file schema.sql --db-url sqlite://app.db";
const DRY_RUN =
  "ptah schema apply --schema-file schema.sql --db-url sqlite://app.db --dry-run";
const APPLY = "ptah schema apply --schema-file schema.sql --db-url sqlite://app.db";

const EDITED_SCHEMA = `-- The schema you want the database to have.

CREATE TABLE users (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  email  TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tasks (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title   TEXT NOT NULL,
  done    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_users_email ON users (email);
`;

/** A value that is markup. It must reach the page as characters. */
const HOSTILE = "<script>alert(1)</script>";

async function run(): Promise<void> {
  const started = Date.now();

  // `need` looks inside the page under test; the frame itself belongs to this
  // document.
  const frame = document.querySelector<HTMLIFrameElement>("#page");
  if (frame === null) throw new Error("ui-probe: the harness has no iframe");
  await new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
    frame.src = "index.html";
  });
  const contentWindow = frame.contentWindow;
  const contentDocument = frame.contentDocument;
  if (contentWindow === null || contentDocument === null) {
    throw new Error("ui-probe: the page did not open");
  }
  win = contentWindow as unknown as FrameGlobals;
  doc = contentDocument;

  // What the page threw on its own. An assertion suite can pass every check
  // while the page is logging uncaught errors behind it, and the two crashes
  // this list exists for -- a superseded refresh reading torn module state --
  // were both invisible to the checks that ran around them.
  const thrown: string[] = [];
  contentWindow.addEventListener("error", (event) => {
    thrown.push(String((event as ErrorEvent).message));
  });
  contentWindow.addEventListener("unhandledrejection", (event) => {
    thrown.push(String((event as PromiseRejectionEvent).reason));
  });

  /* ---- 1. The page is useful before the runtime is ---- */

  // Read on the first turn after load, while the wasm is still being fetched.
  // A textarea's text is its `value`; `textContent` is the markup default and
  // would be empty however much the editor is holding.
  const earlySchema = q<HTMLTextAreaElement>("#pg-editor .pgc-ed-input")?.value ?? "";
  const earlyRail = textOf("#pg-rail");
  const earlyStatus = textOf(".pg-status");
  const bootVisible = need<HTMLElement>("#pg-boot-strip").hidden === false;

  check(
    "the schema is readable before the runtime is ready",
    earlySchema.includes("CREATE TABLE users") && earlySchema.includes("FOREIGN KEY"),
    `boot strip visible: ${bootVisible}, status "${earlyStatus.trim()}", ` +
      `editor holds ${earlySchema.length} characters`,
  );
  check(
    "the seeded table list is on screen before the runtime is ready",
    earlyRail.includes("users") && earlyRail.includes("tasks") && earlyRail.includes("schema.sql"),
    `rail says: ${earlyRail.replace(/\s+/g, " ").trim().slice(0, 160)}`,
  );

  // The tour is opened now, while the boot strip is still above the panes, and
  // its ring is read again once the strip has gone; see the check after ready.
  need<HTMLElement>("#pg-tour-open").click();

  /* ---- 2. The loader counts real bytes and reaches ready ---- */

  let sawBytes = "";
  const bytePattern = /([\d.]+)\s*(MiB|MB|KiB|kB)/;
  const watcher = window.setInterval(() => {
    const boot = textOf("#pg-boot");
    if (sawBytes === "" && bytePattern.test(boot) && !/0\.0\s*\/\s*0\.0/.test(boot)) {
      sawBytes = boot.replace(/\s+/g, " ").trim();
    }
  }, 50);

  await until("the runtime to report ready", () => textOf(".pg-status").includes("ready"));
  window.clearInterval(watcher);

  check(
    "the boot indicator showed real transferred bytes",
    bytePattern.test(sawBytes),
    sawBytes === "" ? "no byte count was ever rendered" : sawBytes,
  );
  check(
    "the boot strip goes away when the runtime is ready",
    need<HTMLElement>("#pg-boot-strip").hidden,
    `status pill: "${textOf(".pg-status").trim()}"`,
  );

  // The frame is 1440px wide, so the panes fill a window-high frame, and the
  // strip leaving moves them without changing the body's height. A tour that
  // re-placed itself only when the body resized kept its ring 91px below the
  // editor. Two frames is time enough for a resize observer to have answered.
  await sleep(250);
  const ring = need<HTMLElement>(".pg-tour-ring").getBoundingClientRect();
  const editor = need<HTMLElement>("#pg-editor").getBoundingClientRect();
  const off = Math.max(
    Math.abs(ring.top - editor.top),
    Math.abs(ring.left - editor.left),
    Math.abs(ring.height - editor.height),
  );
  check(
    "a tour opened during boot keeps its ring on the editor after the strip goes",
    bootVisible && off < 2,
    `opened with the strip visible: ${bootVisible}; ring top ${Math.round(ring.top)}, ` +
      `editor top ${Math.round(editor.top)}, heights ${Math.round(ring.height)}/${Math.round(editor.height)}`,
  );
  need<HTMLElement>(".pg-tour-skip").click();

  const buildLine = textOf("#pg-running");
  check(
    "About states the build that is actually running",
    /commands registered/.test(buildLine) && /SQLite/.test(buildLine),
    buildLine.replace(/\s+/g, " ").trim().slice(0, 180),
  );

  await until("the rail to show the catalog it read", () => textOf("#pg-rail").includes("3 rows"));

  /* ---- The full-window layout ---- */

  // The frame is 1440 by 1100, so this is the layout above 1100px: the header
  // and the application fill the window and there is no page under them.
  const page = doc.documentElement;
  check(
    "the full-window layout fits the window, with no page to scroll",
    page.scrollHeight <= page.clientHeight,
    `document ${page.scrollHeight}px tall in a ${page.clientHeight}px window`,
  );

  // What used to sit under the application is in About now, so About has to
  // open, show it, and close again.
  const about = need<HTMLDialogElement>("#pg-about");
  need<HTMLButtonElement>("#pg-about-open").click();
  const aboutShown = about.open && need<HTMLElement>("#pg-running").getBoundingClientRect().height > 0;
  need<HTMLButtonElement>("#pg-about-close").click();
  check(
    "About opens from the status bar, shows what is running, and closes",
    aboutShown && !about.open,
    `open with the Running line on screen: ${aboutShown}; open after Close: ${about.open}`,
  );

  // Between the side panes is the default; the toolbar pair moves the
  // terminal across the width and back. Read straight after each click,
  // because a layout read is synchronous. It ends on the default.
  const dockTo = (dock: string): { term: DOMRect; editor: DOMRect; grid: DOMRect } => {
    need<HTMLButtonElement>(`#pg-dock [data-dock="${dock}"]`).click();
    return {
      term: need<HTMLElement>("#pg-terminal").getBoundingClientRect(),
      editor: need<HTMLElement>("#pg-editor").getBoundingClientRect(),
      grid: need<HTMLElement>(".pg-grid").getBoundingClientRect(),
    };
  };
  const across = dockTo("full");
  const between = dockTo("between");
  check(
    "the terminal sits under the editor between the side panes, or across the width when asked",
    Math.abs(between.term.left - between.editor.left) < 2
      && Math.abs(between.term.width - between.editor.width) < 2
      && Math.abs(across.term.width - across.grid.width) < 2,
    `between: terminal at ${Math.round(between.term.left)}, ${Math.round(between.term.width)}px wide, ` +
      `editor at ${Math.round(between.editor.left)}, ${Math.round(between.editor.width)}px; ` +
      `across: terminal ${Math.round(across.term.width)}px of a ${Math.round(across.grid.width)}px grid`,
  );

  // The site header folds into the toolbar above 1100px: the Ptah mark opens
  // the header's links, the header's own list being the source, and the
  // toolbar's theme toggle does what the header's did.
  const siteHeader = need<HTMLElement>(".site-header");
  const headerLinks = siteHeader.querySelectorAll(".nav-links a").length;
  need<HTMLButtonElement>("#pg-sitemenu-btn").click();
  const menu = need<HTMLElement>("#pg-sitemenu");
  const menuOpen = menu.matches(":popover-open");
  const menuLinks = menu.querySelectorAll("a").length;
  const menuHere = menu.querySelector('a[aria-current="page"]')?.textContent ?? "";
  menu.hidePopover();
  check(
    "the site header folds into the toolbar, and the Ptah mark opens its links",
    siteHeader.getBoundingClientRect().height === 0 && menuOpen && headerLinks > 0
      && menuLinks === headerLinks + 1 && menuHere === "Playground",
    `header ${Math.round(siteHeader.getBoundingClientRect().height)}px tall; menu open ${menuOpen}, ` +
      `${menuLinks} links for the header's ${headerLinks} and home, current "${menuHere}"`,
  );

  const theme = (): string => doc.documentElement.getAttribute("data-theme") ?? "";
  const themeBefore = theme();
  need<HTMLButtonElement>(".pg-toolbar-theme").click();
  const themeFlipped = theme();
  need<HTMLButtonElement>(".pg-toolbar-theme").click();
  check(
    "the toolbar's theme toggle switches the theme and back",
    themeFlipped !== themeBefore && theme() === themeBefore,
    `${themeBefore} → ${themeFlipped} → ${theme()}`,
  );

  // The step's strip is one line; what the step means is behind the hint.
  const strip = need<HTMLElement>("#pg-next");
  const stripHeight = Math.round(strip.getBoundingClientRect().height);
  const hint = need<HTMLButtonElement>("#pg-next .pg-next-info");
  hint.click();
  const popover = need<HTMLElement>("#pg-next-detail");
  const popoverOpen = popover.matches(":popover-open");
  const gap = Math.round(popover.getBoundingClientRect().top - hint.getBoundingClientRect().bottom);
  const popoverText = (popover.textContent ?? "").trim();
  popover.hidePopover();
  check(
    "the step's strip is one line, and its hint opens what the step means under it",
    stripHeight <= 64 && popoverOpen && gap >= 0 && gap < 20 && popoverText.length > 40,
    `strip ${stripHeight}px tall; popover open ${popoverOpen}, ${gap}px under the hint, ` +
      `says "${popoverText.slice(0, 80)}"`,
  );

  /* ---- 3. Drift, through the terminal ---- */

  const drift = await runCommand(DRIFT);
  check(
    "typing the drift command gives exit 0 and the real message",
    drift.exit.includes("exit 0") && drift.output.includes("No schema drift detected"),
    `bar said "${drift.exit}", output: ${drift.output.replace(/\s+/g, " ").trim().slice(0, 140)}`,
  );

  // The route is scored against the catalog and the workspace, never against a
  // click: the step ticks because a `schema drift` really exited 0.
  await until("step 01 to be ticked", () => stepStates()[0] === "done", 15_000).catch(
    () => undefined,
  );
  check(
    "running the command ticks its step, off the run's real exit code",
    stepStates()[0] === "done",
    `steps: ${stepStates().join(", ")}`,
  );

  /* ---- 4. Edit, then the dry run fills the Plan pane ---- */

  // Step 02 carries a patch. Apply patch puts it in the editor like typing
  // would, the editor marks the lines against the seeded file, and the step
  // ticks because schema.sql now declares the column and the index -- not
  // because a button was pressed.
  const applyButton = [...doc.querySelectorAll<HTMLButtonElement>("#pg-next .pg-next-run .btn")].find(
    (b) => b.textContent === "Apply patch",
  );
  applyButton?.click();
  await until("step 02 to tick after the patch", () => stepStates()[1] === "done", 20_000).catch(
    () => undefined,
  );
  const markedAs = (kind: string): number[] =>
    [...doc.querySelectorAll<HTMLElement>("#pg-editor .pgc-ed-num")]
      .map((row, index) => (row.classList.contains(`is-${kind}`) ? index + 1 : 0))
      .filter((line) => line > 0);
  const added = markedAs("added");
  const modified = markedAs("modified");
  const tintedLines = doc.querySelectorAll("#pg-editor .pgc-ed-line.is-added, #pg-editor .pgc-ed-line.is-modified").length;
  check(
    "Apply patch writes step 02's edit into schema.sql, marked line by line against the seeded file",
    applyButton !== undefined && stepStates()[1] === "done"
      && added.join(",") === "10,20,21" && modified.join(",") === "9" && tintedLines === 4,
    `button ${applyButton === undefined ? "missing" : "pressed"}; steps: ${stepStates().join(", ")}; ` +
      `added lines ${added.join(",") || "none"}, changed ${modified.join(",") || "none"}, ${tintedLines} tinted`,
  );

  // A mark opens what the seeded file had there, and reverts that run alone:
  // the users body goes back, the index stays, and step 02 is not done any
  // more because schema.sql no longer declares the column.
  doc.querySelector<HTMLButtonElement>('#pg-editor .pgc-ed-num[data-change="0"]')?.click();
  const peek = q<HTMLElement>("#pg-editor .pgc-ed-peek");
  const peekOpen = peek?.matches(":popover-open") ?? false;
  const peekText = peek?.textContent ?? "";
  [...(peek?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .find((b) => b.textContent === "Revert this change")
    ?.click();
  await until("step 02 to be undone by the revert", () => stepStates()[1] !== "done", 20_000).catch(
    () => undefined,
  );
  const reverted = q<HTMLTextAreaElement>("#pg-editor .pgc-ed-input")?.value ?? "";
  check(
    "a gutter mark shows the seeded lines, and Revert puts back that run and no other",
    peekOpen && peekText.includes("-   email TEXT NOT NULL") && peekText.includes("+   active INTEGER")
      && !reverted.includes("active INTEGER") && reverted.includes("CREATE INDEX idx_users_email")
      && markedAs("added").join(",") === "19,20" && markedAs("modified").length === 0
      && stepStates()[1] !== "done",
    `peek open ${peekOpen}, says "${peekText.replace(/\s+/g, " ").slice(0, 90)}"; after revert added ` +
      `${markedAs("added").join(",") || "none"}, changed ${markedAs("modified").join(",") || "none"}; ` +
      `steps: ${stepStates().join(", ")}`,
  );

  // The revert went through the browser's own editing, so the textarea's
  // undo -- what Cmd+Z and Ctrl+Z run -- takes it back, marks and all. A
  // revert that assigned the value would have left nothing to undo.
  const editorInput = need<HTMLTextAreaElement>("#pg-editor .pgc-ed-input");
  editorInput.focus();
  const undoRan = doc.execCommand("undo");
  await until("the undo to reach the marks", () => markedAs("added").includes(10) || null, 5_000).catch(
    () => undefined,
  );
  check(
    "undo in the editor takes a revert back",
    undoRan && editorInput.value.includes("  active INTEGER NOT NULL DEFAULT 1")
      && markedAs("modified").join(",") === "9" && markedAs("added").join(",") === "10,20,21",
    `undo ran ${undoRan}; active is ${editorInput.value.includes("active INTEGER") ? "back" : "still gone"}; ` +
      `added ${markedAs("added").join(",") || "none"}, changed ${markedAs("modified").join(",") || "none"}`,
  );

  typeSchema(EDITED_SCHEMA);
  await until(
    "schema.sql to be written back to the workspace",
    () => textOf("#pg-editor .pgc-strip-right").includes("revision r"),
    20_000,
  );

  const dry = await runCommand(DRY_RUN);
  check(
    "the dry run exits 0 without touching the database",
    dry.exit.includes("exit 0"),
    `bar said "${dry.exit}"`,
  );

  const planTab = [...doc.querySelectorAll<HTMLButtonElement>(".pgc-tab")].find(
    (b) => b.textContent === "Plan",
  );
  planTab?.click();
  const planText = textOf('[data-result-pane="plan"]');
  check(
    "the Plan pane holds the two statements the planner produced",
    /ALTER TABLE .*users.* ADD COLUMN .*active/.test(planText) &&
      /CREATE INDEX .*idx_users_email/.test(planText),
    planText.replace(/\s+/g, " ").trim().slice(0, 220),
  );

  /* ---- 5. Editing again marks the shown plan stale ---- */

  typeSchema(`${EDITED_SCHEMA}\n-- one more line, so the plan is about an older file\n`);
  // The pane says it twice: "stale" in the header line, and the reason in the
  // note under the statements. Both are asserted, because the header alone
  // could be a label with nothing behind it.
  const stale = await until(
    "the plan to be marked stale",
    () => {
      const head = textOf('[data-result-pane="plan"] .pgc-pane-status-line');
      const body = textOf('[data-result-pane="plan"] .pgc-pane-note');
      return head.includes("stale") && body.includes("out of date") ? `${head} — ${body}` : null;
    },
    20_000,
  ).catch((err: unknown) => String(err));
  check(
    "editing the schema marks the shown plan stale",
    stale.includes("stale") && stale.includes("out of date"),
    stale.replace(/\s+/g, " ").trim().slice(0, 200),
  );

  // Put the file back to exactly what the plan describes before applying it.
  typeSchema(EDITED_SCHEMA);
  await sleep(1000);

  /* ---- 6. Apply, confirmed with YES through the terminal ---- */

  const usersBefore = textOf("#pg-rail");
  const asks = (): number => (terminalText().match(/Type 'YES' to confirm/g) ?? []).length;
  const stripAsking = (): boolean => q<HTMLElement>("#pg-next")?.dataset["state"] === "asking";
  const rowAsking = (): boolean => q<HTMLElement>(".pg-term")?.hasAttribute("data-asking") ?? false;

  // Typed at the prompt, the apply asks there and nowhere else: whoever typed
  // it is looking at the row already. Declined, so the database is unchanged.
  const asksBeforeTyped = asks();
  typeCommand(APPLY);
  await until("the typed apply to ask for confirmation", () => asks() > asksBeforeTyped || null, 30_000);
  check(
    "apply stops and asks, rather than being auto-approved",
    !terminalIdle() && textOf(".pg-status").includes("waiting for confirmation"),
    `status pill: "${textOf(".pg-status").trim()}"`,
  );
  check(
    "a typed command that asks leaves the strip and the prompt row alone",
    !stripAsking() && !rowAsking(),
    `strip asking ${stripAsking()}, prompt row lit ${rowAsking()}`,
  );
  typeCommand("no");
  await until("the declined apply to end", () => terminalIdle(), 30_000);
  const marksAfterDeclined = markedAs("added").length + markedAs("modified").length;

  // Started from the strip, the same question is raised where the button
  // was: the strip quotes it, the prompt row is lit, and focus is waiting
  // in the prompt for the answer.
  const applyRow = [...doc.querySelectorAll<HTMLElement>("#pg-next .pg-next-row")].find(
    (row) => (row.textContent ?? "").includes(APPLY) && !(row.textContent ?? "").includes("--dry-run"),
  );
  const asksBeforeGuided = asks();
  applyRow?.querySelector<HTMLButtonElement>("button.btn")?.click();
  await until("the guided apply to ask for confirmation", () => asks() > asksBeforeGuided || null, 30_000).catch(
    () => undefined,
  );
  await until("the strip to take the question", () => stripAsking() || null, 5_000).catch(() => undefined);
  const promptFocused = doc.activeElement?.classList.contains("term-field-input") ?? false;
  check(
    "a command started from the strip that asks is raised in the strip and at the prompt",
    applyRow !== undefined && stripAsking() && rowAsking() && promptFocused
      && textOf("#pg-next").includes("Type 'YES' to confirm"),
    `strip row ${applyRow === undefined ? "missing" : "found"}; strip asking ${stripAsking()}, ` +
      `prompt row lit ${rowAsking()}, prompt focused ${promptFocused}; ` +
      `strip says "${textOf("#pg-next").replace(/\s+/g, " ").trim().slice(0, 100)}"`,
  );

  typeCommand("YES");
  await until("the apply to finish", () => terminalIdle(), 60_000);
  const applyExit = textOf(".term-exit").trim();
  // Applied, schema.sql is what the database has, so the editor stops marking
  // it -- the way a commit clears a gutter. Declined, it had kept its marks.
  await sleep(100);
  const marksAfterApplied = markedAs("added").length + markedAs("modified").length;
  check(
    "a successful apply clears the editor's change marks, and a declined one kept them",
    marksAfterDeclined > 0 && marksAfterApplied === 0,
    `marked lines after the declined apply ${marksAfterDeclined}, after the applied one ${marksAfterApplied}`,
  );
  check(
    "YES typed at the prompt completes the apply, and the strip and the row stop asking",
    applyExit.includes("exit 0") && !stripAsking() && !rowAsking(),
    `bar said "${applyExit}"; before the apply the rail read ` +
      `${usersBefore.replace(/\s+/g, " ").trim().slice(0, 60)}`,
  );

  /* ---- 7. The data pane shows the surviving rows ---- */

  const dataTab = [...doc.querySelectorAll<HTMLButtonElement>(".pgc-tab")].find(
    (b) => b.textContent === "Data",
  );
  dataTab?.click();
  const usersRow = [...doc.querySelectorAll<HTMLElement>(".pgc-rail-row")].find(
    (r) => r.dataset["table"] === "users",
  );
  usersRow?.click();
  await until(
    "the data pane to read users back",
    () => textOf('[data-result-pane="data"] .pgc-pane-title') === "users",
    20_000,
  );

  const dataPane = need<HTMLElement>('[data-result-pane="data"]');
  const header = [...dataPane.querySelectorAll("th")].map((th) => th.textContent ?? "");
  const rows = [...dataPane.querySelectorAll("tbody tr, tr")]
    .map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""))
    .filter((cells) => cells.length > 0);
  const activeIndex = header.findIndex((h) => h.startsWith("active"));
  const names = rows.map((cells) => cells[1] ?? "");
  const actives = rows.map((cells) => (activeIndex === -1 ? "" : cells[activeIndex] ?? ""));

  check(
    "the original three rows survived the apply with active = 1",
    rows.length === 3 &&
      names.join(",") === "Ada,Grace,Alan" &&
      actives.every((value) => value === "1"),
    `columns ${header.join(" | ")}; rows ${rows.map((r) => r.join("/")).join("  ")}`,
  );
  check(
    "the new column is marked new, off two catalog reads",
    header.some((h) => h.includes("active") && h.includes("new")),
    `header cells: ${header.join(" | ")}`,
  );

  /* ---- 7b. Step 05 puts its query in the SQL pane and points at Run ---- */

  // The strip never presses Run; after "Put it in the SQL pane" it says Run
  // is the next press, Run is lit, and focus is in the query so Cmd+Enter
  // works. The first run from the pane puts all of that out.
  const partsNow = (): string =>
    [...doc.querySelectorAll<HTMLElement>("#pg-next .pg-next-part")]
      .map((part) => `${part.hasAttribute("aria-current") ? ">" : ""}${(part.textContent ?? "").replace("done", "")}`)
      .join(" ");
  const shownCommand = (): string => textOf("#pg-next .pg-next-row .cmd pre").replace(/\s+/g, " ").trim();
  const partsBeforeRun = partsNow();
  const commandBeforeRun = shownCommand();
  const putButton = [...doc.querySelectorAll<HTMLButtonElement>("#pg-next .pg-next-run .btn")].find(
    (b) => b.textContent === "Put it in the SQL pane →",
  );
  putButton?.click();
  await sleep(100);
  const stripOffered = q<HTMLElement>("#pg-next")?.dataset["state"] === "offered";
  const runLit = q(".pgc-ed-run .btn")?.classList.contains("is-offered") ?? false;
  const queryFocused = doc.activeElement?.classList.contains("pgc-ed-input") ?? false;
  const offeredQuery = q<HTMLTextAreaElement>(".pgc-ed-input")?.value ?? "";
  need<HTMLButtonElement>(".pgc-ed-run button").click();
  await until("the offered query to answer", () => paneHas("data", "query result") || null, 30_000).catch(
    () => undefined,
  );
  const stillOffered =
    q<HTMLElement>("#pg-next")?.dataset["state"] === "offered"
    || (q(".pgc-ed-run .btn")?.classList.contains("is-offered") ?? false);
  // Its two parts are done in order: the query first and nothing else on
  // show, then, once the query has run, drift in its place and part 1 ticked.
  const partsAfterRun = partsNow();
  const commandAfterRun = shownCommand();
  check(
    "step 05 shows its query alone, and running it moves the strip on to drift",
    partsBeforeRun === ">1 2" && commandBeforeRun.startsWith("SELECT")
      && partsAfterRun === "1✓ >2" && commandAfterRun.startsWith("$ ptah schema drift"),
    `parts before "${partsBeforeRun}", showing "${commandBeforeRun.slice(0, 40)}"; ` +
      `after "${partsAfterRun}", showing "${commandAfterRun.slice(0, 40)}"`,
  );
  check(
    "step 05's query goes into the SQL pane with Run lit, and running it puts the pointer out",
    putButton !== undefined && stripOffered && runLit && queryFocused
      && offeredQuery.includes("SELECT id, name, active FROM users") && !stillOffered,
    `put button ${putButton === undefined ? "missing" : "pressed"}; strip offered ${stripOffered}, ` +
      `Run lit ${runLit}, query focused ${queryFocused}; after Run still pointing ${stillOffered}`,
  );

  /* ---- 8. Drift is clean again ---- */

  const after = await runCommand(DRIFT);
  check(
    "drift is clean again after the apply",
    after.exit.includes("exit 0") && after.output.includes("No schema drift detected"),
    `bar said "${after.exit}"`,
  );

  await until("the route to finish", () => stepStates().every((x) => x === "done"), 15_000).catch(
    () => undefined,
  );
  check(
    "every step is done, each one verified against real state",
    stepStates().every((state) => state === "done"),
    `steps: ${stepStates().join(", ")}`,
  );

  /* ---- 9. The exit code on screen is the process's own ---- */

  const bad = await runCommand("ptah schema drift --schema-file nope.sql --db-url sqlite://app.db");
  check(
    "a failing command shows its real exit code and stays on screen",
    /exit [12]/.test(bad.exit) && bad.output.trim().length > 0,
    `bar said "${bad.exit}", stderr: ${bad.output.replace(/\s+/g, " ").trim().slice(0, 140)}`,
  );

  /* ---- 10. A value that is markup renders as text ---- */

  const sqlTab = [...doc.querySelectorAll<HTMLButtonElement>("#pg-editor .pgc-tab")].find(
    (b) => b.textContent === "SQL",
  );
  sqlTab?.click();
  const sqlInput = need<HTMLTextAreaElement>(".pgc-ed-input");
  sqlInput.focus();
  sqlInput.value = `UPDATE users SET name = '${HOSTILE}' WHERE id = 3;`;
  sqlInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  need<HTMLButtonElement>(".pgc-ed-run button").click();

  await until(
    "the hostile value to come back out of the database",
    () => textOf('[data-result-pane="data"]').includes("alert(1)"),
    30_000,
  );
  const pane = need<HTMLElement>('[data-result-pane="data"]');
  check(
    "a table value containing markup renders as text",
    pane.querySelector("script") === null && textOf('[data-result-pane="data"]').includes(HOSTILE),
    `the pane contains ${pane.querySelectorAll("script").length} script elements and the ` +
      `characters ${HOSTILE}`,
  );

  /* ---- 11. Another scenario seeds and scores ---- */

  const selector = need<HTMLSelectElement>("#pg-bar select");
  selector.value = "c";
  selector.dispatchEvent(new win.Event("change", { bubbles: true }));
  await until(
    "scenario C to be seeded and scored",
    () => {
      const states = stepStates();
      return states.length > 0 && states.every((x) => x !== "unknown") && states[0] !== "done";
    },
    60_000,
  ).catch(() => undefined);
  const railAfterSwitch = textOf("#pg-rail");
  check(
    "switching scenario re-seeds the workspace and scores the new route",
    stepStates().every((state) => state !== "unknown") &&
      railAfterSwitch.includes("No tables yet"),
    `steps: ${stepStates().join(", ")}; rail: ` +
      `${railAfterSwitch.replace(/\s+/g, " ").trim().slice(0, 120)}`,
  );

  /* ---- 11b. Generated files show, and do not outlive their scenario ---- */

  // Scenario C's whole subject is the pair of files `migrations generate`
  // writes. `listFiles` answers about one directory, so a rail that showed
  // only the top level would name none of them.
  const generated = await runCommand(
    "ptah migrations generate --schema-file schema.sql --db-url sqlite://app.db " +
      "--migrations-dir migrations --name init",
  );
  await until("the generated files", () => textOf("#pg-rail").includes("migrations/"), 30_000).catch(
    () => undefined,
  );
  const railWithMigrations = textOf("#pg-rail");
  check(
    "the files a command generated are named in the workspace list",
    /migrations\/\S+\.up\.sql/.test(railWithMigrations) &&
      /migrations\/\S+\.down\.sql/.test(railWithMigrations),
    `exit ${generated.exit}; rail: ${railWithMigrations.replace(/\s+/g, " ").trim().slice(0, 200)}`,
  );

  /* ---- 12. A SQL-pane answer stays on screen ---- */

  // Every refresh repaints the data pane from the selected table. A SELECT run
  // here used to be replaced by the users table within a tick, which reads as
  // the query having done nothing at all.
  const sqlTab2 = [...doc.querySelectorAll<HTMLButtonElement>("#pg-editor .pgc-tab")].find(
    (b) => b.textContent === "SQL",
  );
  sqlTab2?.click();
  const queryInput = need<HTMLTextAreaElement>(".pgc-ed-input");
  queryInput.focus();
  queryInput.value = "SELECT 42 AS the_answer;";
  queryInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  need<HTMLButtonElement>(".pgc-ed-run button").click();
  await until("the query result", () => paneHas("data", "the_answer"), 30_000).catch(
    () => undefined,
  );
  await sleep(2000); // long enough for a refresh to have overwritten it
  check(
    "a SELECT run from the SQL pane keeps its answer on screen",
    paneHas("data", "the_answer") && paneHas("data", "42"),
    textOf('[data-result-pane="data"]').replace(/\s+/g, " ").trim().slice(0, 160),
  );

  /* ---- 13. Two seedings asked for at once do not tear the page ---- */

  // A visitor who picks a scenario and then presses Reset asks twice. The two
  // seedings used to interleave: `serialize` between the drop and the seed
  // rejected, and a catalog read that started before the drop landed after it,
  // leaving the rail claiming an empty database over a freshly seeded one.
  const before = thrown.length;
  selector.value = "a";
  selector.dispatchEvent(new win.Event("change", { bubbles: true }));
  selector.value = "c";
  selector.dispatchEvent(new win.Event("change", { bubbles: true }));
  selector.value = "a";
  selector.dispatchEvent(new win.Event("change", { bubbles: true }));
  need<HTMLButtonElement>("#pg-reset").click();
  await until(
    "both seedings to settle",
    () => textOf("#pg-rail").includes("3 rows") && terminalIdle(),
    90_000,
  ).catch(() => undefined);
  await sleep(2000);
  check(
    "asking for two seedings at once leaves one consistent page",
    thrown.length === before &&
      textOf("#pg-rail").includes("3 rows") &&
      // Seeding removes directories too: the previous scenario's migrations
      // must not be sitting in this one's workspace, where the route would
      // score them and Reset would be claiming a seed it did not restore.
      !textOf("#pg-rail").includes("migrations/"),
    `page threw ${thrown.length - before} time(s)` +
      `${thrown.length > before ? `: ${thrown.slice(before).join(" | ").slice(0, 160)}` : ""}; ` +
      `rail: ${textOf("#pg-rail").replace(/\s+/g, " ").trim().slice(0, 100)}`,
  );

  /* ---- Clicking a file does not cost you the schema ---- */

  // Opening another workspace file used to reuse the schema buffer: the schema
  // tab then showed that file, clicking schema.sql did nothing visible, and
  // the "read-only view" was editable, so typing in it saved the wrong text
  // over schema.sql. Each of those is checked here.
  {
    const clickFile = (name: string): boolean => {
      const row = [...doc.querySelectorAll<HTMLElement>("#pg-rail .pgc-rail-row")]
        .find((r) => (r.textContent ?? "").includes(name));
      row?.click();
      return row !== undefined;
    };
    const area = () => doc.querySelector<HTMLTextAreaElement>(".pgc-editor textarea");
    const schemaHead = "-- The schema you want";

    const opened = clickFile("README.md");
    await sleep(400);
    const viewing = area();
    check(
      "opening another file gives it its own read-only tab",
      opened && viewing !== null && viewing.readOnly && !viewing.value.startsWith(schemaHead),
      `readOnly ${viewing?.readOnly}, showing "${(viewing?.value ?? "").slice(0, 30)}"`,
    );

    clickFile("schema.sql");
    await sleep(400);
    const back = area();
    check(
      "and going back to schema.sql returns the schema, editable",
      back !== null && back.value.startsWith(schemaHead) && !back.readOnly,
      `readOnly ${back?.readOnly}, showing "${(back?.value ?? "").slice(0, 30)}"`,
    );

    clickFile("app.db");
    await sleep(600);
    const afterDb = area();
    check(
      "clicking the database shows its structure instead of its bytes",
      afterDb !== null && afterDb.value.startsWith(schemaHead)
        && textOf("#pg-db .pgc-tab.is-active").includes("Structure"),
      `editor "${(afterDb?.value ?? "").slice(0, 24)}", right pane "${textOf("#pg-db .pgc-tab.is-active")}"`,
    );

    clickFile("schema.sql");
    await sleep(300);
  }

  // The file on disk is what Ptah reads, so ask Ptah rather than the DOM.
  {
    const drift = await runCommand(DRIFT);
    check(
      "and schema.sql on disk was never written over",
      drift.exit.includes("exit 0"),
      `after opening other files, drift said "${drift.exit}"`,
    );
  }

  /* ---- The explain strip keeps its prose column ---- */

  // A grid `auto` track is sized from max-content, and max-content is measured
  // as if nothing wrapped. When a step carried a second command the actions
  // column was therefore measured as both rows side by side, took the whole
  // width, and left the prose beside it at zero -- one word per line. A step
  // of more than one part now shows one part at a time with a switch before
  // it, so the real shape is measured: the first step with parts, pinned.
  {
    let found = false;
    for (const stepButton of doc.querySelectorAll<HTMLButtonElement>(".pg-step")) {
      stepButton.click();
      found = q("#pg-next .pg-next-parts") !== null;
      if (found) break;
    }
    const strip = need<HTMLElement>("#pg-next");
    const run = strip.querySelector<HTMLElement>(".pg-next-run");
    const row = strip.querySelector<HTMLElement>(".pg-next-row");
    const title = strip.querySelector<HTMLElement>(".pg-next-copy strong");
    const copyWidth = Math.round(strip.querySelector<HTMLElement>(".pg-next-copy")?.getBoundingClientRect().width ?? 0);
    const titleHeight = Math.round(title?.getBoundingClientRect().height ?? 0);
    const rowHeight = Math.round(row?.getBoundingClientRect().height ?? 0);
    check(
      "a step of two parts shows one, with its switch, and still leaves the prose a column",
      found && run?.children.length === 1 && rowHeight < 50 && copyWidth > 240 && titleHeight < 60,
      `step with parts ${found ? "found" : "missing"}; ${run?.children.length ?? 0} row(s), ${rowHeight}px tall; ` +
        `prose column ${copyWidth}px, headline ${titleHeight}px tall`,
    );
  }

  /* ---- Done ---- */

  check(
    "the page threw nothing of its own along the way",
    thrown.length === 0,
    thrown.length === 0 ? "no uncaught error or rejection" : thrown.join(" | ").slice(0, 300),
  );

  const failed = checks.filter((c) => !c.ok).length;
  const result: ProbeResult = {
    ok: failed === 0,
    passed: checks.length - failed,
    failed,
    durationMs: Date.now() - started,
    checks,
    transcript: terminalText(),
  };
  (window as unknown as { __probe: ProbeResult }).__probe = result;
}

run().catch((err: unknown) => {
  check("the probe ran to the end", false, String(err));
  const failed = checks.filter((c) => !c.ok).length;
  (window as unknown as { __probe: ProbeResult }).__probe = {
    ok: false,
    passed: checks.length - failed,
    failed,
    durationMs: 0,
    checks,
    transcript: doc === undefined ? "" : terminalText(),
  };
});
