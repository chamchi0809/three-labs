// Arithmetic that everything above it trusts silently. A basis that is left-handed, or a rotation that
// is a degree out, shows up as a brush that is subtly wrong three modules away.
// Run with: node --experimental-strip-types src/brush/vec.check.ts
import assert from "node:assert/strict";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import {
  IDENTITY, add, bounds, centroid, clean, cross, determinant, distance, dot, flip, intersectPlanes,
  length, mul, multiply, neg, normalize, planeBasis, planeDistance, rotation, scaling, shear, sub,
  transformDirection, transformPoint, translation,
} from "./vec.ts";

const near = (a: number, b: number, why: string) => assert.ok(Math.abs(a - b) < 1e-9, `${why}: ${a} is not ${b}`);
const nearV = (a: Vec3, b: Vec3, why: string) => assert.ok(distance(a, b) < 1e-9, `${why}: ${a} is not ${b}`);

test("the basics are the basics", () => {
  assert.deepEqual(add([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
  assert.deepEqual(sub([1, 2, 3], [4, 5, 6]), [-3, -3, -3]);
  assert.deepEqual(mul([1, 2, 3], 2), [2, 4, 6]);
  assert.deepEqual(neg([1, -2, 3]), [-1, 2, -3]);
  assert.equal(dot([1, 2, 3], [4, 5, 6]), 32);
  assert.deepEqual(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  assert.equal(length([3, 4, 0]), 5);
  assert.equal(distance([1, 0, 0], [4, 4, 0]), 5);
  assert.deepEqual(centroid([[0, 0, 0], [2, 4, 6]]), [1, 2, 3]);
  assert.deepEqual(bounds([[1, 5, 3], [-1, 2, 9]]), { min: [-1, 2, 3], max: [1, 5, 9] });
  assert.equal(bounds([]), undefined);
});

test("a direction that is not one comes back as nothing, not as zero", () => {
  assert.equal(normalize([0, 0, 0]), undefined);
  assert.equal(normalize([1e-15, 0, 0]), undefined);
  nearV(normalize([0, 7, 0])!, [0, 1, 0], "a unit vector");
});

test("negative zero never reaches a coordinate", () => {
  assert.ok(Object.is(clean([-0, 0, -0])[0], 0));
  assert.deepEqual(clean([-0, -0, -0]), [0, 0, 0]);
});

test("a plane's distance is positive outside the solid, and flipping swaps the sides", () => {
  const p = { n: [0, 1, 0] as Vec3, d: 2 };
  near(planeDistance(p, [0, 3, 0]), 1, "above");
  near(planeDistance(p, [0, 1, 0]), -1, "below");
  const f = flip(p);
  assert.deepEqual(f, { n: [0, -1, 0], d: -2 });
  near(planeDistance(f, [0, 3, 0]), -1, "above the flipped plane is inside it");
});

test("three planes meet where they should, and parallel ones nowhere", () => {
  const at = intersectPlanes({ n: [1, 0, 0], d: 2 }, { n: [0, 1, 0], d: 3 }, { n: [0, 0, 1], d: 4 });
  assert.deepEqual(at, [2, 3, 4]);
  assert.equal(intersectPlanes({ n: [1, 0, 0], d: 2 }, { n: [1, 0, 0], d: 3 }, { n: [0, 0, 1], d: 4 }), undefined);
});

test("a plane basis is right-handed for every direction", () => {
  const dirs: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];
  for (let i = 0; i < 24; i++) dirs.push(normalize([Math.cos(i), Math.sin(i * 1.7), Math.cos(i * 0.3) - 0.5])!);
  for (const n of dirs) {
    const { u, v } = planeBasis(n);
    near(length(u), 1, `u for ${n}`);
    near(length(v), 1, `v for ${n}`);
    near(dot(u, n), 0, `u lies in the plane of ${n}`);
    near(dot(v, n), 0, `v lies in the plane of ${n}`);
    nearV(cross(u, v), n, `the basis for ${n} is right-handed`);
  }
});

// ---------------------------------------------------------------- transforms

test("the identity does nothing, and translation only moves", () => {
  nearV(transformPoint(IDENTITY, [1, 2, 3]), [1, 2, 3], "identity");
  nearV(transformPoint(translation([1, 2, 3]), [10, 0, 0]), [11, 2, 3], "translation");
  nearV(transformDirection(translation([1, 2, 3]), [10, 0, 0]), [10, 0, 0], "a direction ignores translation");
  assert.equal(determinant(IDENTITY), 1);
});

test("scaling about a point leaves that point where it is", () => {
  const m = scaling([2, 2, 2], [1, 1, 1]);
  nearV(transformPoint(m, [1, 1, 1]), [1, 1, 1], "the centre");
  nearV(transformPoint(m, [2, 1, 1]), [3, 1, 1], "twice as far out");
  assert.equal(determinant(scaling([2, 3, 4])), 24);
});

test("a mirror has a negative determinant, which is how the winding knows to flip", () => {
  assert.ok(determinant(scaling([-1, 1, 1])) < 0);
  assert.ok(determinant(scaling([-1, -1, 1])) > 0, "two mirrors are a rotation");
});

test("rotation is right-handed and about the point it is given", () => {
  nearV(transformPoint(rotation([0, 1, 0], Math.PI / 2), [1, 0, 0]), [0, 0, -1], "a quarter turn about +y");
  nearV(transformPoint(rotation([0, 0, 1], Math.PI / 2), [1, 0, 0]), [0, 1, 0], "a quarter turn about +z");
  const about = rotation([0, 1, 0], Math.PI, [5, 0, 5]);
  nearV(transformPoint(about, [5, 0, 5]), [5, 0, 5], "the pivot does not move");
  nearV(transformPoint(about, [6, 0, 5]), [4, 0, 5], "the rest turns around it");
  near(determinant(rotation([1, 2, 3], 0.7)), 1, "a rotation preserves volume");
});

test("four quarter turns are the identity, whatever the axis", () => {
  const axis: Vec3 = normalize([1, 2, -3])!;
  let m = IDENTITY;
  for (let i = 0; i < 4; i++) m = multiply(rotation(axis, Math.PI / 2), m);
  nearV(transformPoint(m, [3, -1, 2]), [3, -1, 2], "back where it started");
});

test("multiply applies the right-hand matrix first", () => {
  const m = multiply(translation([10, 0, 0]), scaling([2, 2, 2]));
  nearV(transformPoint(m, [1, 0, 0]), [12, 0, 0], "scaled, then moved");
});

test("a shear slides one axis along another and pins the plane it is measured from", () => {
  // the top of a box pushed along +x as y rises, with the bottom held
  const m = shear([1, 0, 0], 1, [0, 0, 0]);
  nearV(transformPoint(m, [0, 0, 0]), [0, 0, 0], "the origin is pinned");
  nearV(transformPoint(m, [0, 2, 0]), [2, 2, 0], "two up is two across");
  nearV(transformPoint(m, [5, 0, 0]), [5, 0, 0], "nothing moves at y = 0");
  near(determinant(m), 1, "a shear preserves volume");
});

report("vec");
