// The dimension overlay, which is arithmetic and therefore checkable: that a box is measured along the axes
// it actually has, that the numbers land on the box's outer edges rather than across its face, and that a
// selection you have flown past is not measured at all.
// Run with: node --experimental-strip-types src/viewport/measure.check.ts
import assert from "node:assert/strict";
import { report, test } from "../check.ts";
import type { Bounds } from "../brush/builder.ts";
import { boundsGuides, formatSpan } from "./measure.ts";
import { newView, screenOf, type Size, type View } from "./view.ts";

const SIZE: Size = { width: 400, height: 300 };

const box = (min: [number, number, number], max: [number, number, number]): Bounds => ({ min, max });

/** a 2D view centred on the origin, showing twelve metres top to bottom, so a metre is exactly 25 pixels */
const flat = (kind: "top" | "front" | "side"): View => ({
  ...newView(kind), target: [0, 0, 0], reach: 12,
});

const byAxis = (guides: ReturnType<typeof boundsGuides>) =>
  Object.fromEntries(guides.map((g) => [g.axis, g.label]));

// ---------------------------------------------------------------- which axes get measured

test("a 2D pane measures the two axes it can see and not the one pointing at you", () => {
  const guides = boundsGuides(box([-2, -1, -3], [2, 1, 3]), flat("front"), SIZE);
  assert.deepEqual(byAxis(guides), { 0: "4 m", 1: "2 m" }, "front is xy, so z is end-on");

  assert.deepEqual(byAxis(boundsGuides(box([-2, -1, -3], [2, 1, 3]), flat("top"), SIZE)), {
    0: "4 m", 2: "6 m",
  }, "top is xz");
  assert.deepEqual(byAxis(boundsGuides(box([-2, -1, -3], [2, 1, 3]), flat("side"), SIZE)), {
    1: "2 m", 2: "6 m",
  }, "side is zy");
});

test("a 3D pane measures all three", () => {
  const view: View = { ...newView("3d"), target: [0, 0, 0], reach: 20 };
  assert.deepEqual(byAxis(boundsGuides(box([-2, -1, -3], [2, 1, 3]), view, SIZE)), {
    0: "4 m", 1: "2 m", 2: "6 m",
  });
});

test("an axis with no thickness is not measured, and a flat selection still says the rest", () => {
  assert.deepEqual(byAxis(boundsGuides(box([-2, 0, -3], [2, 0, 3]), flat("top"), SIZE)), {
    0: "4 m", 2: "6 m",
  }, "a floor has no height and does not claim one");
  assert.deepEqual(boundsGuides(box([0, 0, 0], [0, 0, 0]), flat("top"), SIZE), [], "a point is not a size");
});

test("an axis too short to write on is left alone rather than crowded", () => {
  // eight millimetres across twenty-five pixels to the metre is a fifth of a pixel
  assert.deepEqual(byAxis(boundsGuides(box([0, 0, 0], [0.008, 2, 2]), flat("front"), SIZE)), { 1: "2 m" });
});

// ---------------------------------------------------------------- where the numbers land

test("a guide runs along the edge it is measuring, at the length that edge really is", () => {
  const guides = boundsGuides(box([-2, -1, 0], [2, 1, 0]), flat("front"), SIZE);
  const x = guides.find((g) => g.axis === 0)!;
  assert.equal(Math.round(Math.hypot(x.to.x - x.from.x, x.to.y - x.from.y)), 100, "four metres at 25 px/m");
  assert.equal(Math.round(x.from.y), Math.round(x.to.y), "and it is horizontal, because the x axis is");
});

test("the number sits off its edge, on the side away from the box", () => {
  const guides = boundsGuides(box([-2, -1, 0], [2, 1, 0]), flat("front"), SIZE);
  const centre = { x: SIZE.width / 2, y: SIZE.height / 2 };
  for (const g of guides) {
    const mid = { x: (g.from.x + g.to.x) / 2, y: (g.from.y + g.to.y) / 2 };
    assert.ok(
      Math.hypot(g.at.x - centre.x, g.at.y - centre.y) > Math.hypot(mid.x - centre.x, mid.y - centre.y),
      `axis ${g.axis} is pushed outward, not inward`,
    );
    assert.ok(Math.abs(Math.hypot(g.at.x - mid.x, g.at.y - mid.y) - 13) < 1e-6, "by the offset, exactly");
  }
});

test("a number is held inside the pane, so a half-off-screen box still says how big it is", () => {
  // a box whose left edge is a long way off the left of the pane
  const guides = boundsGuides(box([-40, -1, 0], [-6, 1, 0]), flat("front"), SIZE);
  for (const g of guides) {
    assert.ok(g.at.x >= 4 && g.at.x <= SIZE.width - 4, `axis ${g.axis} stayed in the pane horizontally`);
    assert.ok(g.at.y >= 4 && g.at.y <= SIZE.height - 4, `axis ${g.axis} stayed in it vertically`);
  }
});

test("in 3D the labelled edge is one on the outside of the silhouette", () => {
  const view: View = { ...newView("3d"), target: [0, 0, 0], reach: 20, yaw: 0.6, pitch: 0.5 };
  const b = box([-2, -1, -3], [2, 1, 3]);
  const middle = screenOf(view, [0, 0, 0], SIZE)!;
  for (const g of boundsGuides(b, view, SIZE)) {
    const mid = { x: (g.from.x + g.to.x) / 2, y: (g.from.y + g.to.y) / 2 };
    assert.ok(
      Math.hypot(mid.x - middle.x, mid.y - middle.y) > 10,
      `axis ${g.axis} is measured on an outer edge, not one through the middle of the box`,
    );
  }
});

// ---------------------------------------------------------------- what is not drawn

test("a box behind the eye is not measured", () => {
  const view: View = { ...newView("3d"), target: [0, 0, 0], reach: 8 };
  assert.deepEqual(boundsGuides(box([100, 100, 100], [104, 102, 106]), view, SIZE), [], "far behind");
  assert.deepEqual(
    boundsGuides(box([-40, -40, -40], [40, 40, 40]), view, SIZE), [],
    "and a box the camera is inside, which is half in front and half behind",
  );
});

test("a pane with no size is not measured, so a collapsed pane costs nothing", () => {
  assert.deepEqual(boundsGuides(box([0, 0, 0], [1, 1, 1]), flat("top"), { width: 0, height: 300 }), []);
});

// ---------------------------------------------------------------- the numbers themselves

test("a length is written the way a designer reads it", () => {
  assert.equal(formatSpan(4), "4 m");
  assert.equal(formatSpan(2.5), "2.5 m");
  assert.equal(formatSpan(0.25), "250 mm");
  assert.equal(formatSpan(0.015625), "15.6 mm");
});

test("and it is rounded, because a dragged box is a subtraction and not a round number", () => {
  assert.equal(formatSpan(3.9999999999999996), "4 m");
  assert.equal(formatSpan(0.30000000000000004), "300 mm");
});

report("measure");
