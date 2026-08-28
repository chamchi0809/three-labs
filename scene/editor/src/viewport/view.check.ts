// node --experimental-strip-types --disable-warning=ExperimentalWarning src/viewport/view.check.ts
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import {
  MAX_REACH, MIN_REACH, basisOf, eyeOf, flyView, frameView, lookView, metresPerPixel, newView,
  orbitView, panView, pointOnPlane, rayThrough, zoomView, type View, type ViewKind,
} from "./view.ts";

const SIZE = { width: 800, height: 400 };
const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);
const nearVec = (a: Vec3, b: Vec3, eps = 1e-9) => {
  for (let i = 0; i < 3; i++) near(a[i]!, b[i]!, eps);
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const KINDS: ViewKind[] = ["3d", "top", "front", "side"];

// ---------------------------------------------------------------- the frame

test("every view's frame is orthonormal and right-handed", () => {
  for (const kind of KINDS) {
    const view = orbitView(newView(kind), 37, -12); // a 3D view that is not on an axis
    const { right, up, forward } = basisOf(view);
    near(dot(right, right), 1, 1e-12);
    near(dot(up, up), 1, 1e-12);
    near(dot(forward, forward), 1, 1e-12);
    near(dot(right, up), 0, 1e-12);
    near(dot(right, forward), 0, 1e-12);
    near(dot(up, forward), 0, 1e-12);
    // right × up points back at the viewer, which is what stops a view from mirroring the world
    nearVec(cross(right, up), [-forward[0], -forward[1], -forward[2]], 1e-12);
  }
});

test("the 3D view opens looking down −Z with Y up", () => {
  const view: View = { ...newView("3d"), yaw: 0, pitch: 0, reach: 10, target: [0, 0, 0] };
  const { right, up, forward } = basisOf(view);
  nearVec(forward, [0, 0, -1]);
  nearVec(right, [1, 0, 0]);
  nearVec(up, [0, 1, 0]);
  nearVec(eyeOf(view), [0, 0, 10]);
});

test("the top view looks down with −Z up the screen, which is where north goes", () => {
  const { right, up, forward } = basisOf(newView("top"));
  nearVec(forward, [0, -1, 0]);
  nearVec(right, [1, 0, 0]);
  nearVec(up, [0, 0, -1]);
});

test("an orthographic eye is pulled back along its own forward, not placed at the pivot", () => {
  const view = { ...newView("front"), target: [1, 2, 3] as Vec3 };
  const eye = eyeOf(view);
  near(eye[0], 1);
  near(eye[1], 2);
  assert.ok(eye[2] > 1000, `${eye[2]} is not far enough back to keep the map in front of the near plane`);
});

// ---------------------------------------------------------------- navigating

test("a pan drags the world with the cursor, in every kind of view", () => {
  const at = { x: 210, y: 300 };
  for (const kind of KINDS) {
    const view = orbitView(newView(kind), 21, 9);
    const was = pointOnPlane(view, at, SIZE);
    const panned = panView(view, 43, -17, SIZE);
    // the point that was under the cursor is under it again once the cursor has moved with the drag
    nearVec(pointOnPlane(panned, { x: at.x + 43, y: at.y - 17 }, SIZE), was, 1e-9);
  }
});

test("a 2D zoom about a point keeps that point still", () => {
  const at = { x: 140, y: 90 };
  const view = { ...newView("top"), target: [3, 0, -4] as Vec3 };
  const was = pointOnPlane(view, at, SIZE);
  const zoomed = zoomView(view, 3, SIZE, at);
  assert.ok(zoomed.reach < view.reach, "three notches up should have zoomed in");
  nearVec(pointOnPlane(zoomed, at, SIZE), was, 1e-9);
});

test("a zoom about nothing keeps the pivot, and zoom stops at both ends of the ladder", () => {
  const view = { ...newView("front"), target: [2, 2, 2] as Vec3 };
  nearVec(zoomView(view, 4, SIZE).target, view.target);
  assert.equal(zoomView(view, 500, SIZE).reach, MIN_REACH);
  assert.equal(zoomView(view, -500, SIZE).reach, MAX_REACH);
});

test("orbiting never quite reaches straight up or down", () => {
  const view = newView("3d");
  for (const pull of [10_000, -10_000]) {
    const turned = orbitView(view, 0, pull);
    assert.ok(Math.abs(turned.pitch) < Math.PI / 2, `pitch ${turned.pitch} passed the pole`);
    // still a usable frame at the limit: an up vector that has collapsed is what gimbal lock looks like
    near(dot(basisOf(turned).up, basisOf(turned).up), 1, 1e-12);
  }
});

test("orbit turns around the pivot; free look turns around the eye", () => {
  const view = { ...newView("3d"), target: [0, 0, 0] as Vec3, yaw: 0, pitch: 0, reach: 10 };
  const orbited = orbitView(view, 60, 0);
  nearVec(orbited.target, [0, 0, 0]);
  assert.notEqual(eyeOf(orbited)[0], eyeOf(view)[0]);

  const looked = lookView(view, 60, 0);
  nearVec(eyeOf(looked), eyeOf(view), 1e-9);
  assert.notEqual(looked.target[0], view.target[0]);
});

test("a 2D view has nothing to turn", () => {
  const view = newView("top");
  assert.equal(orbitView(view, 30, 30), view);
  assert.equal(lookView(view, 30, 30), view);
});

test("flying moves the eye and the pivot together", () => {
  const view = { ...newView("3d"), target: [0, 0, 0] as Vec3, yaw: 0, pitch: 0, reach: 10 };
  const flown = flyView(view, { forward: 4 });
  nearVec(flown.target, [0, 0, -4]);
  nearVec(eyeOf(flown), [0, 0, 6]);
  nearVec(flyView(view, { right: 2, up: 3 }).target, [2, 3, 0]);
});

// ---------------------------------------------------------------- framing

test("framing centres on the box and does not turn the view", () => {
  const box = { min: [2, 0, -6] as Vec3, max: [10, 4, 2] as Vec3 };
  for (const kind of KINDS) {
    const view = orbitView(newView(kind), 33, 7);
    const framed = frameView(view, box, SIZE);
    nearVec(framed.target, [6, 2, -2]);
    assert.equal(framed.yaw, view.yaw);
    assert.equal(framed.pitch, view.pitch);
  }
});

test("a framed 2D view holds the whole box with room to spare", () => {
  const box = { min: [-4, -1, -3] as Vec3, max: [4, 5, 3] as Vec3 };
  // front shows x across and y down: 8 wide, 6 tall, in a 2:1 pane, so height decides
  const framed = frameView(newView("front"), box, SIZE);
  near(framed.reach, 6 * 1.25);
  // a tall pane makes width decide instead
  const tall = frameView(newView("front"), box, { width: 200, height: 800 });
  near(tall.reach, (8 / 0.25) * 1.25);
});

test("a framed 3D view keeps the box inside the narrower of the two half-angles", () => {
  const box = { min: [-2, -2, -2] as Vec3, max: [2, 2, 2] as Vec3 };
  const radius = Math.hypot(2, 2, 2);
  const wide = frameView(newView("3d"), box, { width: 800, height: 400 });
  const narrow = frameView(newView("3d"), box, { width: 400, height: 800 });
  // a pane narrower than it is tall has to stand further back to fit the same box
  assert.ok(narrow.reach > wide.reach, `${narrow.reach} should be further than ${wide.reach}`);
  for (const framed of [wide, narrow]) {
    const half = (framed.fov * Math.PI) / 180 / 2;
    assert.ok(Math.asin(radius / framed.reach) < half, "the box does not fit in the vertical field");
  }
});

test("framing nothing changes nothing", () => {
  const view = newView("3d");
  assert.equal(frameView(view, undefined, SIZE), view);
  assert.equal(frameView(view, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, SIZE), view);
});

// ---------------------------------------------------------------- screen and world

test("an orthographic pane shows exactly its reach from top to bottom", () => {
  const view = { ...newView("side"), reach: 40 };
  near(metresPerPixel(view, SIZE), 40 / 400);
  const top = pointOnPlane(view, { x: 400, y: 0 }, SIZE);
  const bottom = pointOnPlane(view, { x: 400, y: 400 }, SIZE);
  near(top[1] - bottom[1], 40);
});

test("the middle of the screen is the pivot, and the ray through it is the line of sight", () => {
  for (const kind of KINDS) {
    const view = orbitView(newView(kind), 12, -20);
    const middle = { x: SIZE.width / 2, y: SIZE.height / 2 };
    nearVec(pointOnPlane(view, middle, SIZE), view.target, 1e-9);
    const ray = rayThrough(view, middle, SIZE);
    nearVec(ray.direction, basisOf(view).forward, 1e-9);
  }
});

test("a 2D ray starts behind the map and a 3D ray starts at the eye", () => {
  const flat = rayThrough(newView("top"), { x: 10, y: 10 }, SIZE);
  assert.ok(flat.origin[1] > 1000, "an orthographic ray must start outside anything it could hit");

  const view = newView("3d");
  nearVec(rayThrough(view, { x: 10, y: 10 }, SIZE).origin, eyeOf(view), 1e-9);
});

report("view");
