// Runs web/ui-probe.html in headless Chrome and prints what it found.
//
// The probe drives the real page in an iframe; this only starts a browser,
// waits for `window.__probe`, and reports. It also takes the three renders the
// design has to be checked against, because a page that passes every assertion
// can still be laid out wrong and only a picture shows that.
//
//   node scripts/ui-probe-run.mjs [--base http://127.0.0.1:8788/] [--shots DIR]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";

const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT ?? 9444);

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const base = arg("base", "http://127.0.0.1:8788/");
const shots = arg("shots", null);

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--window-size=1560,1200",
    `--user-data-dir=/tmp/ui-probe-profile-${PORT}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const getJSON = (path) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: PORT, path }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const targets = await getJSON("/json/list");
      const page = targets.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      // Chrome has not opened the port yet.
    }
    await sleep(250);
  }
  throw new Error("Chrome never answered on the DevTools port");
}

async function main() {
  const target = await connect();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    });

  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { resolve, reject } = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) reject(new Error(`${d.error.message} (${JSON.stringify(d.error.data ?? "")})`));
      else resolve(d.result);
      return;
    }
    if (d.method === "Runtime.consoleAPICalled") {
      logs.push(
        `[${d.params.type}] ` +
          d.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "),
      );
    }
    if (d.method === "Runtime.exceptionThrown") {
      logs.push(
        `[exception] ${d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text}`,
      );
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  await send("Runtime.enable");
  await send("Page.enable");

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result?.value;
  };

  // Nothing from the browser's cache. The profile persists between runs and
  // `make serve` sends no caching headers, so Chrome would reuse a bundle it
  // fetched minutes ago by heuristic and the probe would pass or fail code
  // that is no longer on disk -- which it did, reporting an old check by its
  // old name after the file had changed.
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });

  await send("Page.navigate", { url: `${base}ui-probe.html` });

  let result = null;
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    result = await evaluate("window.__probe ? JSON.stringify(window.__probe) : null");
    if (result) break;
    await sleep(1000);
  }

  if (!result) {
    console.error("TIMEOUT: the probe never published a result.");
    console.error(await evaluate('document.getElementById("out").textContent'));
    if (logs.length) console.error(`--- console ---\n${logs.join("\n")}`);
    chrome.kill();
    process.exit(1);
  }

  const probe = JSON.parse(result);
  for (const c of probe.checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
    console.log(`      ${c.detail}`);
  }
  console.log(
    `\n${probe.passed} passed, ${probe.failed} failed, ${(probe.durationMs / 1000).toFixed(1)} s`,
  );
  if (probe.failed > 0) {
    console.log("\n--- terminal transcript ---");
    console.log(probe.transcript);
  }
  if (logs.length) console.error(`\n--- console ---\n${logs.join("\n")}`);

  /* ---------- The renders ---------- */

  if (shots) {
    mkdirSync(shots, { recursive: true });
    const capture = async (name, width, height, theme) => {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 700,
      });
      await send("Page.navigate", { url: `${base}index.html` });
      await sleep(500);
      if (theme) {
        await evaluate(
          `try{localStorage.setItem("ptah-theme",${JSON.stringify(theme)})}catch(e){};` +
            `document.documentElement.setAttribute("data-theme",${JSON.stringify(theme)})`,
        );
      }
      // Wait for the runtime, so the shot is of the working page rather than
      // of a boot strip.
      const until = Date.now() + 120_000;
      for (;;) {
        const ready = await evaluate(
          'document.querySelector(".pg-status")?.textContent?.includes("ready") ?? false',
        );
        if (ready || Date.now() > until) break;
        await sleep(500);
      }
      await sleep(1200);
      const metrics = await send("Page.getLayoutMetrics");
      const full = Math.min(Math.ceil(metrics.cssContentSize.height), 12000);
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: full,
        deviceScaleFactor: 1,
        mobile: width < 700,
      });
      await sleep(400);
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      const file = join(shots, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log(`wrote ${file} (${width}x${full})`);
    };

    await capture("ui-light.png", 1440, 1000, "light");
    await capture("ui-dark.png", 1440, 1000, "dark");
    await capture("ui-mobile.png", 390, 844, "light");
  }

  chrome.kill();
  process.exit(probe.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  chrome.kill();
  process.exit(1);
});
