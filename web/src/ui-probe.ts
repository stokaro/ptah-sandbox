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

  const buildLine = textOf("#pg-running");
  check(
    "the footer states the build that is actually running",
    /commands registered/.test(buildLine) && /SQLite/.test(buildLine),
    buildLine.replace(/\s+/g, " ").trim().slice(0, 180),
  );

  await until("the rail to show the catalog it read", () => textOf("#pg-rail").includes("3 rows"));

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
  typeCommand(APPLY);
  await until(
    "the apply to ask for confirmation",
    () => terminalText().includes("Type 'YES' to confirm"),
    30_000,
  );
  check(
    "apply stops and asks, rather than being auto-approved",
    !terminalIdle() && textOf(".pg-status").includes("waiting for confirmation"),
    `status pill: "${textOf(".pg-status").trim()}"`,
  );

  typeCommand("YES");
  await until("the apply to finish", () => terminalIdle(), 60_000);
  const applyExit = textOf(".term-exit").trim();
  check(
    "YES typed at the prompt completes the apply",
    applyExit.includes("exit 0"),
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
  // width, and left the prose beside it at zero -- one word per line. Measured,
  // because it is a layout bug no assertion about the DOM tree would catch.
  {
    const strip = need<HTMLElement>("#pg-next");
    const run = strip.querySelector<HTMLElement>(".pg-next-run");
    const title = strip.querySelector<HTMLElement>(".pg-next-copy strong");
    let copyWidth = 0;
    let titleHeight = 0;
    let rows = 0;
    if (run && title) {
      // Synthesise the second row exactly as the guide builds it, so the check
      // does not depend on which step happens to be focused.
      const row = doc.createElement("div");
      row.className = "pg-next-also";
      const box = doc.createElement("div");
      box.className = "cmd";
      const pre = doc.createElement("pre");
      pre.textContent = "$ ptah schema drift --schema-file schema.sql --db-url sqlite://app.db";
      box.appendChild(pre);
      row.appendChild(box);
      const button = doc.createElement("button");
      button.className = "btn btn-ghost";
      button.textContent = "Run";
      row.appendChild(button);
      run.appendChild(row);

      rows = run.children.length;
      copyWidth = Math.round(
        (strip.querySelector<HTMLElement>(".pg-next-copy") as HTMLElement).getBoundingClientRect().width,
      );
      titleHeight = Math.round(title.getBoundingClientRect().height);
      row.remove();
    }
    check(
      "a step with two commands still leaves the prose a column to sit in",
      rows === 2 && copyWidth > 240 && titleHeight < 60,
      `rows ${rows}, prose column ${copyWidth}px, headline ${titleHeight}px tall`,
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
