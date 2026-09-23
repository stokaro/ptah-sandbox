/**
 * The comparison behind the editor's change marks and the patch preview.
 *
 *   node --test src/linediff.test.mjs       (or: npm run test:unit)
 *
 * The marks are measured against the seeded file, so what they have to get
 * right is the kind of each line: new, changed, or the place where lines
 * went. The last test runs scenario A's own patch over its own fixture, which
 * is what a visitor sees after pressing Apply patch.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { hunks, lineMarks, revertHunk, splitLines } from "./linediff.ts";
import { applyPatch, scenarioById } from "./scenario.ts";

/** The marks as plain data, so a failing test prints what it saw. */
function marksOf(baseline, current) {
  const marks = lineMarks(baseline, current);
  return {
    changed: Object.fromEntries([...marks.changed].sort((a, b) => a[0] - b[0])),
    removedAbove: [...marks.removedAbove].sort((a, b) => a - b),
  };
}

test("a comma added to a line and a line inserted after it: one changed, one new", () => {
  const baseline = ["CREATE TABLE users (", "  id INTEGER,", "  name TEXT", ");"];
  const current = ["CREATE TABLE users (", "  id INTEGER,", "  name TEXT,", "  active INTEGER", ");"];
  assert.deepEqual(marksOf(baseline, current), { changed: { 2: "modified", 3: "added" }, removedAbove: [] });
});

test("a block added at the end is new, and nothing above it is marked", () => {
  const baseline = ["a", "b"];
  const current = ["a", "b", "", "CREATE INDEX i ON t (c);"];
  assert.deepEqual(marksOf(baseline, current), { changed: { 2: "added", 3: "added" }, removedAbove: [] });
});

test("an unchanged file has no marks", () => {
  assert.deepEqual(marksOf(["a", "b"], ["a", "b"]), { changed: {}, removedAbove: [] });
});

test("everything written into an empty file is new", () => {
  assert.deepEqual(marksOf(splitLines(""), ["a", "b"]), { changed: { 0: "added", 1: "added" }, removedAbove: [] });
});

test("a removed line is a place above the line that followed it", () => {
  assert.deepEqual(marksOf(["a", "b", "c"], ["a", "c"]), { changed: {}, removedAbove: [1] });
});

test("lines removed from the end are a place past the last line", () => {
  assert.deepEqual(marksOf(["a", "b", "c"], ["a"]), { changed: {}, removedAbove: [1] });
});

test("a final newline ends a line rather than starting one", () => {
  assert.deepEqual(splitLines("a\n"), ["a"]);
  assert.deepEqual(splitLines("a\n\n"), ["a", ""]);
  assert.deepEqual(splitLines("a"), ["a"]);
  assert.deepEqual(splitLines(""), []);
});

test("scenario A's patch, applied to its fixture, marks the email line changed and three lines new", () => {
  const seeded = readFileSync(new URL("../../fixtures/scenario-a/schema.sql", import.meta.url), "utf8");
  const patch = scenarioById("a").steps.find((s) => s.id === "edit").action.patch;
  const result = applyPatch(seeded, patch);
  assert.equal(result.state, "applies");
  const current = splitLines(result.text);
  const marks = marksOf(splitLines(seeded), current);
  assert.deepEqual(marks, { changed: { 8: "modified", 9: "added", 19: "added", 20: "added" }, removedAbove: [] });
  assert.equal(current[8], "  email TEXT NOT NULL,");
  assert.equal(current[9], "  active INTEGER NOT NULL DEFAULT 1");
  assert.equal(current[20], "CREATE INDEX idx_users_email ON users (email);");
});

// ---------------------------------------------------------------------------
// runs, which the gutter marks open and revert one at a time
// ---------------------------------------------------------------------------

const SEEDED = readFileSync(new URL("../../fixtures/scenario-a/schema.sql", import.meta.url), "utf8");
const PATCHED = applyPatch(SEEDED, scenarioById("a").steps.find((s) => s.id === "edit").action.patch).text;

test("scenario A's patch is two runs: the users body, and the index at the end", () => {
  assert.deepEqual(hunks(splitLines(SEEDED), splitLines(PATCHED)), [
    {
      start: 8,
      removed: ["  email TEXT NOT NULL"],
      added: ["  email TEXT NOT NULL,", "  active INTEGER NOT NULL DEFAULT 1"],
    },
    { start: 19, removed: [], added: ["", "CREATE INDEX idx_users_email ON users (email);"] },
  ]);
});

test("reverting one run puts back what the seeded file had there and leaves the other run", () => {
  const seeded = splitLines(SEEDED);
  const current = splitLines(PATCHED);
  const [users] = hunks(seeded, current);
  const reverted = revertHunk(current, users);
  assert.equal(reverted[8], "  email TEXT NOT NULL");
  assert.ok(!reverted.includes("  active INTEGER NOT NULL DEFAULT 1"));
  // The index run is still there, two lines higher now.
  assert.deepEqual(marksOf(seeded, reverted), { changed: { 18: "added", 19: "added" }, removedAbove: [] });
});

test("reverting every run, bottom first, is the seeded file again", () => {
  const seeded = splitLines(SEEDED);
  let current = splitLines(PATCHED);
  for (const run of hunks(seeded, current).reverse()) current = revertHunk(current, run);
  assert.deepEqual(current, seeded);
});

test("reverting a removal puts the removed lines back where they were", () => {
  const seeded = ["a", "b", "c", "d"];
  const current = ["a", "d"];
  const [run] = hunks(seeded, current);
  assert.deepEqual(run, { start: 1, removed: ["b", "c"], added: [] });
  assert.deepEqual(revertHunk(current, run), seeded);
});
