// The arithmetic every dragging tool is built out of. No document, no renderer, no canvas.
// node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/drag.check.ts
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { basisOf, metresPerPixel, newView, orbitView, projectPoint, rayThrough } from "../viewport/view.ts";
import {
  axisDelta, axisDistance, majorAxis, meetPlane, movePlane, onlyAxis, planeDelta, planeThrough,
  pointOnDragPlane, snapExtrude, snapMove, snapPoint,
} from "./drag.ts";

const SIZE = { width: 800, height: 400 };
const GROUND = planeThrough([0, 0, 0], [0, 1, 0]);

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);
const nearVec = (a: Vec3, b: Vec3, eps = 1e-9) => {
  for (let i = 0; i < 3; i++) near(a[i]!, b[i]!, eps);
};

// ---------------------------------------------------------------- choosing a plane

test("an orthographic drag runs in the pane's own plane, so nothing moves out of sight", () => {
  for (const kind of ["top", "front", "side"] as const) {
    const view = newView(kind);
    const plane = movePlane(view, [1, 2, 3]);
    const { forward } = basisOf(view);
    nearVec(plane.normal, [-forward[0], -forward[1], -forward[2]]);
    nearVec(plane.origin, [1, 2, 3]);
  }
});

test("a 3D drag is on the ground until alt stands it up, and then it faces the camera", () => {
  const view = newView("3d");
  nearVec(movePlane(view, [0, 0, 0]).normal, [0, 1, 0]);

  const up = movePlane(view, [0, 0, 0], true);
  near(up.normal[1]!, 0, 1e-12);
  // facing the camera: the plane's normal points back along the view's forward, horizontally
  const { forward } = basisOf(view);
  const flat = Math.hypot(forward[0], forward[2]);
  near(up.normal[0]!, -forward[0]! / flat, 1e-12);
  near(up.normal[2]!, -forward[2]! / flat, 1e-12);
});

test("looking straight down there is still a vertical plane to drag on", () => {
  const down = { ...newView("3d"), pitch: Math.PI / 2 - 1e-9 };
  const plane = movePlane(down, [0, 0, 0], true);
  near(Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]), 1, 1e-9);
  near(plane.normal[1]!, 0);
});

// ---------------------------------------------------------------- meeting a plane

test("a ray meets a plane where the plane says it does", () => {
  const hit = meetPlane({ origin: [3, 10, -4], direction: [0, -1, 0] }, GROUND);
  nearVec(hit!, [3, 0, -4]);
});

test("a ray running along a plane has no answer at all, rather than a very large one", () => {
  assert.equal(meetPlane({ origin: [0, 5, 0], direction: [1, 0, 0] }, GROUND), undefined);
});

test("a screen point lands on the ground under it", () => {
  const view = newView("top");
  const on = pointOnDragPlane(view, { x: 400, y: 200 }, SIZE, GROUND);
  // the middle of a top pane is the pivot, straight down onto the ground
  nearVec(on!, [view.target[0], 0, view.target[2]]);
});

// ---------------------------------------------------------------- dragging on a plane

test("dragging in a top pane moves the world by exactly the pixels it was dragged", () => {
  const view = newView("top");
  const metres = metresPerPixel(view, SIZE);
  const by = planeDelta(view, SIZE, { x: 100, y: 200 }, { x: 300, y: 250 }, GROUND);
  // top has +x to the right and −z up the screen, so dragging down the screen is +z
  nearVec(by!, [200 * metres, 0, 50 * metres], 1e-9);
});

test("a drag with no plane under either end gives nothing, so the caller can hold its last delta", () => {
  // a front pane looks along −z, so a plane whose normal is +x is seen exactly edge-on from it
  const wall = planeThrough([0, 0, 0], [1, 0, 0]);
  assert.equal(planeDelta(newView("front"), SIZE, { x: 0, y: 0 }, { x: 10, y: 10 }, wall), undefined);
});

// ---------------------------------------------------------------- dragging along a line

test("a ray that crosses the axis reports where it crossed", () => {
  // the textbook case, by hand: the answer is the signed distance from the origin along the axis
  assert.equal(axisDistance({ origin: [10, 5, 0], direction: [-1, 0, 0] }, [0, 0, 0], [0, 1, 0]), 5);
  assert.equal(axisDistance({ origin: [10, -2, 0], direction: [-1, 0, 0] }, [0, 0, 0], [0, 1, 0]), -2);
});

test("the answer is in metres along the axis even when the axis was not given as a unit vector", () => {
  const long = axisDistance({ origin: [10, 5, 0], direction: [-1, 0, 0] }, [0, 0, 0], [0, 7, 0]);
  near(long!, 5, 1e-12);
});

test("a point put on screen and picked back off it is the point it started as", () => {
  // not the top pane: it looks straight down the axis being measured, which is the one case with no answer
  for (const kind of ["3d", "front", "side"] as const) {
    const view = orbitView(newView(kind), 21, -9);
    const axis: Vec3 = [0, 1, 0];
    const origin: Vec3 = [1, 0, -2];
    const point: Vec3 = [origin[0], origin[1] + 3, origin[2]];
    const at = projectPoint(view, point, SIZE);
    assert.ok(at, `${kind} could not put the point on screen`);
    near(axisDistance(rayThrough(view, at, SIZE), origin, axis)!, 3, 1e-6);
  }
});

test("an axis pointing straight at the designer says nothing, because a mouse cannot", () => {
  const along = { origin: [0, 0, 10] as Vec3, direction: [0, 0, -1] as Vec3 };
  assert.equal(axisDistance(along, [0, 0, 0], [0, 0, 1]), undefined);
});

test("dragging up a front pane pulls a face up by the pixels it was dragged", () => {
  const view = newView("front");
  const metres = metresPerPixel(view, SIZE);
  const by = axisDelta(view, SIZE, { x: 400, y: 300 }, { x: 400, y: 200 }, [0, 0, 0], [0, 1, 0]);
  near(by!, 100 * metres, 1e-9);
});

// ---------------------------------------------------------------- putting it on the grid

test("a move snaps the thing being moved onto the grid, not the distance it moved", () => {
  // a corner sitting at 0.1 dragged a little: it lands on a grid line and forgets the 0.1
  nearVec(snapMove([0.1, 0, 0], [0.2, 0, 0], 0.25), [0.15, 0, 0], 1e-12);
  // and a corner already on the grid moves by whole cells
  nearVec(snapMove([0.5, 0, 0], [0.26, 0, 0], 0.25), [0.25, 0, 0], 1e-12);
});

test("a move too small to reach the next line is no move at all", () => {
  nearVec(snapMove([0, 0, 0], [0.01, 0.01, 0.01], 0.25), [0, 0, 0]);
});

test("a point snaps on every axis at once", () => {
  nearVec(snapPoint([0.3, -0.3, 1.1], 0.25), [0.25, -0.25, 1], 1e-12);
});

test("the first pixel of a pull moves the face, which is why the snap is outwards", () => {
  assert.ok(snapExtrude(0, 0.001, 0.25) > 0, "a nudge out must leave the wall");
  assert.ok(snapExtrude(0, -0.001, 0.25) < 0, "and a nudge in must go in");
  // and it lands the face on a line rather than making the distance a round number
  near(snapExtrude(0.1, 0.01, 0.25), 0.15, 1e-12);
  near(snapExtrude(0.1, -0.01, 0.25), -0.1, 1e-12);
});

// ---------------------------------------------------------------- holding an axis

test("holding shift keeps the axis the drag is most along, not the one the camera likes", () => {
  assert.equal(majorAxis([0.4, 0.9, 0.2]), 1);
  assert.equal(majorAxis([-3, 0.9, 0.2]), 0);
  assert.equal(majorAxis([0, 0, -0.001]), 2);
  assert.equal(majorAxis([0, 0, 0]), 0, "a drag that has not moved has to answer something");
  nearVec(onlyAxis([1, 2, 3], 1), [0, 2, 0]);
});

report("drag");
