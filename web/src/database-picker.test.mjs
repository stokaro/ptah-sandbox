import assert from "node:assert/strict";
import { test } from "node:test";
import { engineFromURL } from "./database-picker.ts";

test("targeted links select only a supported engine", () => {
  assert.equal(engineFromURL("https://play.ptah.run/?engine=postgres"), "postgres");
  assert.equal(engineFromURL("https://play.ptah.run/?engine=sqlite&source=docs"), "sqlite");
  assert.equal(engineFromURL("https://play.ptah.run/"), null);
  assert.equal(engineFromURL("https://play.ptah.run/?engine=other"), null);
  assert.equal(engineFromURL("https://play.ptah.run/?engine="), null);
});
