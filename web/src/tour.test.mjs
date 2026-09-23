/**
 * Contract tests for where the tour card lands.
 *
 * The rest of the tour is DOM and is checked by looking at it; this is the
 * part that decides a number, so it is pinned here where it is cheap. Both
 * defects these tests describe were real and were found by measuring the
 * built page, not by reading the code: a card placed off the bottom of a
 * short window, and a card laid across the region it was describing.
 *
 * Run:  node --test src/tour.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { EDGE, GAP, POINTER_INSET, choosePlacement, pointerAt } from "./tour.ts";

/** A card the size the real one measures at its widest wrap. */
const CARD = { top: 0, left: 0, width: 368, height: 160 };
const DESKTOP = { width: 1440, height: 950 };

/** Whether two boxes share any area. */
function overlaps(a, b) {
  return !(
    a.left + a.width <= b.left ||
    b.left + b.width <= a.left ||
    a.top + a.height <= b.top ||
    b.top + b.height <= a.top
  );
}

function placed(spot, card) {
  return { top: spot.top, left: spot.left, width: card.width, height: card.height };
}

test("the first preferred side with room is the one used", () => {
  // A pane in the middle of a wide window: every side has room, so the
  // preference decides and nothing else does.
  const ring = { top: 300, left: 500, width: 400, height: 300 };
  assert.equal(choosePlacement(ring, CARD, DESKTOP, ["right", "below"]).side, "right");
  assert.equal(choosePlacement(ring, CARD, DESKTOP, ["below", "right"]).side, "below");
  assert.equal(choosePlacement(ring, CARD, DESKTOP, ["left", "above"]).side, "left");
  assert.equal(choosePlacement(ring, CARD, DESKTOP, ["above", "left"]).side, "above");
});

test("a preferred side with no room is skipped for the next one", () => {
  // The terminal: full width, hard against the bottom of the window. "below"
  // is asked for first and cannot be honoured.
  const ring = { top: 640, left: 129, width: 1182, height: 290 };
  const spot = choosePlacement(ring, CARD, DESKTOP, ["below", "above"]);
  assert.equal(spot.side, "above");
  assert.ok(!overlaps(placed(spot, CARD), ring), "the card must stay off the region it describes");
});

test("the card stays on screen on every viewport it is asked about", () => {
  // Corners and edges, on a window small enough that most sides do not fit.
  const view = { width: 420, height: 520 };
  const rings = [
    { top: 0, left: 0, width: 420, height: 60 },
    { top: 460, left: 0, width: 420, height: 60 },
    { top: 0, left: 360, width: 60, height: 520 },
    { top: 200, left: 180, width: 60, height: 60 },
    { top: 0, left: 0, width: 420, height: 520 },
  ];
  const sides = [
    ["below", "above"],
    ["above", "below"],
    ["right", "left"],
    ["left", "right"],
  ];
  for (const ring of rings) {
    for (const prefer of sides) {
      const spot = choosePlacement(ring, CARD, view, prefer);
      const box = placed(spot, CARD);
      const where = `ring ${JSON.stringify(ring)} prefer ${prefer.join(",")}`;
      assert.ok(box.left >= EDGE - 0.5, `left edge, ${where}`);
      assert.ok(box.top >= EDGE - 0.5, `top edge, ${where}`);
      assert.ok(box.left + box.width <= view.width - EDGE + 0.5, `right edge, ${where}`);
      assert.ok(box.top + box.height <= view.height - EDGE + 0.5, `bottom edge, ${where}`);
    }
  }
});

test("a side that fits keeps the card clear of the region", () => {
  // The property the preference list exists to produce. Only asserted where a
  // side actually had room: on a window too small for both, the clamp wins and
  // an overlap is the documented outcome.
  const view = { width: 1280, height: 800 };
  const ring = { top: 300, left: 400, width: 300, height: 200 };
  for (const prefer of [["below"], ["above"], ["right"], ["left"]]) {
    const spot = choosePlacement(ring, CARD, view, prefer);
    assert.equal(spot.side, prefer[0], `${prefer[0]} had room and should have been used`);
    assert.ok(!overlaps(placed(spot, CARD), ring), `${prefer[0]} overlapped the region`);
  }
});

test("the gap between the card and the region is the declared one", () => {
  const ring = { top: 300, left: 500, width: 400, height: 300 };
  const below = choosePlacement(ring, CARD, DESKTOP, ["below"]);
  assert.equal(below.top, ring.top + ring.height + GAP);
  const right = choosePlacement(ring, CARD, DESKTOP, ["right"]);
  assert.equal(right.left, ring.left + ring.width + GAP);
  const above = choosePlacement(ring, CARD, DESKTOP, ["above"]);
  assert.equal(above.top + CARD.height + GAP, ring.top);
  const left = choosePlacement(ring, CARD, DESKTOP, ["left"]);
  assert.equal(left.left + CARD.width + GAP, ring.left);
});

test("a viewport smaller than the card still yields a placement inside it", () => {
  // Nothing fits. The clamp has to produce a number rather than a negative
  // coordinate that would hide the card off the top left.
  const view = { width: 300, height: 140 };
  const spot = choosePlacement({ top: 0, left: 0, width: 300, height: 140 }, CARD, view, ["below"]);
  assert.ok(spot.top >= EDGE - 0.5 && spot.left >= EDGE - 0.5);
  assert.ok(Number.isFinite(spot.top) && Number.isFinite(spot.left));
});

test("the pointer sits opposite the middle of the ring", () => {
  const ring = { top: 800, left: 0, width: 390, height: 45 };
  const card = { top: 630, left: 12, width: 366, height: 157 };
  assert.equal(pointerAt(ring, card, "above"), 183);
});

test("a card pushed aside by the window still points at its ring, off its corners", () => {
  const card = { top: 100, left: 12, width: 366, height: 157 };
  // A ring at the far left of the screen: the pointer stops short of the corner.
  assert.equal(pointerAt({ top: 40, left: 0, width: 20, height: 28 }, card, "below"), POINTER_INSET);
  // A ring at the far right: the same at the other end.
  assert.equal(pointerAt({ top: 40, left: 380, width: 10, height: 28 }, card, "below"), 366 - POINTER_INSET);
  // Beside the card, the pointer is measured down its side.
  assert.equal(pointerAt({ top: 150, left: 400, width: 100, height: 40 }, card, "left"), 70);
});
