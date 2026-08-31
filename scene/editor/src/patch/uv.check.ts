/**
 * A material on a curved surface, and the corner it is measured from.
 *
 * The claim these tests are here to hold is the one the module is built on: because a patch's uv origin is
 * a place on the surface rather than the world origin, scaling and turning need no anchor to be solved for.
 * So each operation is checked twice — once for what it writes, and once for what it leaves where it was.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/patch/uv.check.ts
 */
import { strict as assert } from "node:assert";
import { report, test } from "../check.ts";
import { patchShape, type Patch } from "./patch.ts";
import {
  flipPatchUv, nudgePatchUv, resetPatchUv, rotatePatchUv, scalePatchUv, setPatchUvScale, withPatchMaterial,
  withPatchUv,
} from "./uv.ts";

const sheet = (over: Partial<Patch> = {}): Patch => patchShape("plane", [0, 0, 0], [4, 0, 4], over);

/** where the material lands at a point on the surface, by the runtime's own rule */
const uvAt = (patch: Patch, s: number, t: number): [number, number] => {
  const { offset, scale, rotation } = patch.uv;
  const u = (s + offset[0]) / (scale[0] || 1);
  const v = (t + offset[1]) / (scale[1] || 1);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return [u * cos - v * sin, u * sin + v * cos];
};

const near = (a: number, b: number, why: string) =>
  assert.ok(Math.abs(a - b) < 1e-9, `${why}: ${a} is not ${b}`);

// ---------------------------------------------------------------- the grid is never touched

test("every operation leaves the geometry alone, because none of them is about the geometry", () => {
  const patch = sheet({ material: "wall" });
  const each = [
    nudgePatchUv(patch, [1, 2]),
    rotatePatchUv(patch, 0.5),
    scalePatchUv(patch, [2, 2]),
    setPatchUvScale(patch, [0.5, 0.5]),
    flipPatchUv(patch, "u"),
    resetPatchUv(patch),
    withPatchMaterial(patch, "water"),
  ];
  for (const out of each) assert.equal(out.grid, patch.grid, "the control points came back as the same array");
});

// ---------------------------------------------------------------- the material name

test("a material is written, and taking it off leaves the key absent rather than undefined", () => {
  const named = withPatchMaterial(sheet(), "water");
  assert.equal(named.material, "water");

  const bare = withPatchMaterial(named, undefined);
  assert.equal("material" in bare, false, "an absent material is absent, so the emitter writes no line");
  assert.deepEqual(bare.uv, named.uv, "the material and the numbers are separate knobs");
});

// ---------------------------------------------------------------- offset

test("a nudge adds metres of surface, and adds to what was already there", () => {
  const once = nudgePatchUv(sheet(), [0.5, -0.25]);
  assert.deepEqual(once.uv.offset, [0.5, -0.25]);
  assert.deepEqual(nudgePatchUv(once, [0.5, 0.25]).uv.offset, [1, 0]);
});

test("a nudge moves the material by the metres asked for, at the scale it is drawn at", () => {
  const half = sheet({ uv: { offset: [0, 0], scale: [2, 2], rotation: 0 } });
  const before = uvAt(half, 1, 1);
  const after = uvAt(nudgePatchUv(half, [2, 0]), 1, 1);
  // two metres of surface at two metres per tile is one whole tile along u, and nothing along v
  near(after[0] - before[0], 1, "a full tile along u");
  near(after[1] - before[1], 0, "nothing along v");
});

// ---------------------------------------------------------------- scale

test("scaling multiplies, and setting replaces", () => {
  const patch = sheet({ uv: { offset: [0, 0], scale: [2, 4], rotation: 0 } });
  assert.deepEqual(scalePatchUv(patch, [2, 0.5]).uv.scale, [4, 2]);
  assert.deepEqual(setPatchUvScale(patch, [1, 1]).uv.scale, [1, 1]);
});

test("a zero is refused by both, because a material divided by nothing is nowhere", () => {
  const patch = sheet();
  assert.deepEqual(scalePatchUv(patch, [0, 0]).uv.scale, [1, 1], "scaling by nothing scales by one");
  assert.deepEqual(setPatchUvScale(patch, [0, 3]).uv.scale, [1, 3]);
});

test("scaling keeps the corner where it was, which is the whole reason there is no anchor to pass", () => {
  const patch = sheet({ uv: { offset: [1, 2], scale: [2, 2], rotation: 0 } });
  const bigger = scalePatchUv(patch, [2, 2]);
  // the corner is s = 0, t = 0 — the offset is what it lands at, and it moves with the scale by design
  assert.deepEqual(uvAt(patch, 0, 0), [0.5, 1]);
  assert.deepEqual(uvAt(bigger, 0, 0), [0.25, 0.5], "the corner tracks the scale rather than drifting");
  assert.deepEqual(bigger.uv.offset, patch.uv.offset, "and the offset never had to be re-solved");
});

// ---------------------------------------------------------------- rotation

test("turning adds radians, and turns the material about the surface's own corner", () => {
  const patch = sheet({ uv: { offset: [0, 0], scale: [1, 1], rotation: 0 } });
  const turned = rotatePatchUv(patch, Math.PI / 2);
  near(turned.uv.rotation, Math.PI / 2, "a quarter turn");

  const corner = uvAt(turned, 0, 0);
  near(corner[0], 0, "the corner did not move along u");
  near(corner[1], 0, "the corner did not move along v");

  const along = uvAt(turned, 1, 0);
  near(along[0], 0, "a metre along the surface now runs down the material");
  near(along[1], 1, "a metre along the surface now runs down the material");

  near(rotatePatchUv(turned, Math.PI / 2).uv.rotation, Math.PI, "and turning again adds to it");
});

// ---------------------------------------------------------------- flipping and resetting

test("a flip negates one axis and leaves the other, on either axis", () => {
  const patch = sheet({ uv: { offset: [0, 0], scale: [2, 3], rotation: 0 } });
  assert.deepEqual(flipPatchUv(patch, "u").uv.scale, [-2, 3]);
  assert.deepEqual(flipPatchUv(patch, "v").uv.scale, [2, -3]);
  assert.deepEqual(flipPatchUv(flipPatchUv(patch, "u"), "u").uv.scale, [2, 3], "twice is where it started");
});

test("reset puts the numbers back where a fresh patch has them, and keeps the material", () => {
  const messy = sheet({ material: "water", uv: { offset: [3, -1], scale: [4, 0.5], rotation: 1.2 } });
  const clean = resetPatchUv(messy);
  assert.deepEqual(clean.uv, { offset: [0, 0], scale: [1, 1], rotation: 0 });
  assert.equal(clean.material, "water", "reset is about the layout, not about what the surface is made of");
});

test("a partial write touches only what it names", () => {
  const patch = sheet({ uv: { offset: [1, 2], scale: [3, 4], rotation: 5 } });
  const out = withPatchUv(patch, { rotation: 0 });
  assert.deepEqual(out.uv, { offset: [1, 2], scale: [3, 4], rotation: 0 });
});

report("patch-uv");
