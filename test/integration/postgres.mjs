/** Real PGlite + real Ptah wasm. No catalog responses are stubbed. */
import assert from "node:assert/strict";
import process from "node:process";
import {readFileSync} from "node:fs";
import { boot } from "./harness.mjs";
import { createPostgresBridge } from "../../web/src/runtime/postgres-bridge.ts";
import { PGLITE_VERSION, POSTGRES_VERSION } from "../../web/src/runtime/engine-versions.ts";
import { SCENARIOS, scenarioForEngine, applyPatch, evaluateRoute } from "../../web/src/scenario.ts";
import { readPostgresCatalog } from "../../web/src/panes/postgres-catalog.ts";

const postgres = await createPostgresBridge();
globalThis.__postgres = postgres;
const session = await boot();
let assertions = 0;
async function run(argv, code = 0, answers = []) {
 const result = await session.run(argv, { answers });
 assert.equal(result.code, code, `${argv.join(" ")}\n${result.stdout}\n${result.stderr}`);
 assert.deepEqual(result.panics, []);
 assertions++;
 return result;
}
try {
 const manifest = JSON.parse(readFileSync(new URL("../../web/vendor/ptah/manifest.json", import.meta.url), "utf8"));
 assert.equal(session.ready.version, manifest.ptahVersion);
 assert.equal(session.ready.commit, manifest.ptahCommit);
 const info = await postgres.info();
 assert.equal(info.version.split(" ")[1], POSTGRES_VERSION, "the picker must describe the PostgreSQL build that ships");
 assert.equal(info.packageVersion, PGLITE_VERSION);
 const url = "postgres://pglite/app";
 for (const preset of SCENARIOS.filter(s => s.capabilities.engines.includes("postgres"))) {
  const scenario = scenarioForEngine(preset, "postgres");
  for (const file of session.workspace.list("/workspace")) session.workspace.remove(file.name);
  await postgres.drop("app");
  for (const [file,text] of Object.entries(scenario.files)) session.workspace.writeFile(file,text);
  await postgres.exec("app",scenario.seed);
  const flags = ["--schema-file","schema.sql","--db-url",url];
  console.log(`PostgreSQL scenario ${scenario.id}`);
  {
   await run(["schema","drift",...flags]);
   if (scenario.id === "a" || scenario.id === "postgres-only") {
    const edit = scenario.steps.find(step => step.action?.kind === "edit").action;
    const patch = applyPatch(scenario.files["schema.sql"],edit.patch);
    assert.equal(patch.state,"applies");
    session.workspace.writeFile("schema.sql",patch.text);
    const plan = await run(["schema","apply",...flags,"--dry-run"]);
    if (scenario.id === "postgres-only") {
      const capture = readFileSync(new URL("ground-truth/54_postgres_gin_plan.txt", import.meta.url),"utf8");
      const native = capture.split("--- stdout ---\n")[1].split("--- stderr ---")[0];
      assert.equal(plan.stdout,native,"browser PostgreSQL plan must match the native capture byte for byte");
    }
    await run(["schema","apply",...flags],0,[[/Type 'YES'/,"YES\n"]]);
    await run(["schema","drift",...flags]);
    const catalog = await readPostgresCatalog("app",(path,sql)=>postgres.sql(path,sql));
    assert.equal(catalog.tables.find(t => t.name === (scenario.id === "a" ? "users" : "events")).rowCount,scenario.id === "a" ? 3 : 2);
    if (scenario.id === "postgres-only") {
      assert.ok(catalog.tables[0].indexes.some(i => i.name === "events_payload_idx"));
      const answer = await postgres.sql("app",scenario.steps[1].action.sql);
      assert.equal(answer.rows.length,1);
      assert.equal(answer.rows[0][1],"deploy");
    }
   } else if (scenario.id === "b") {
    await postgres.exec("app","ALTER TABLE users ADD COLUMN nickname TEXT");
    await run(["schema","drift",...flags],1);
    await run(["schema","drift",...flags,"--format","json"],1);
    await postgres.exec("app","ALTER TABLE users DROP COLUMN nickname");
    await run(["schema","drift",...flags]);
   }
  }
  const route = await evaluateRoute(scenario,{
   engine:()=>"postgres",query:sql=>postgres.sql("app",sql),
   readFile:async path=>{try{return session.workspace.readText(path)}catch{return null}},
   listFiles:async path=>{try{return session.workspace.list(path).map(f=>f.name)}catch{return []}},
   runs:()=>[],
   sqlRuns:()=>[],
  });
  assert.equal(route.unavailable,null);
 }
 // PostgreSQL migrations require multiple physical sessions. The preset must
 // refuse that engine rather than pretend those sessions are independent.
 assert.throws(() => scenarioForEngine(SCENARIOS.find(s => s.id === "c"), "postgres"), /requires sqlite/);
 await run(["db","capabilities","--db-url",url]);
 await run(["schema","inspect","--db-url",url]);
 // An external-looking URL must fail rather than silently use this local DB.
 await run(["db","capabilities","--db-url","postgres://example.com/app"],2);
 assert.deepEqual(session.stray,{stdout:"",stderr:""});
 console.log(`${assertions} PostgreSQL commands passed; values and catalog assertions passed.`);
} catch (error) { console.error(error); process.exitCode=1; }
finally { clearInterval(session.keepAlive); process.exit(process.exitCode ?? 0); }
