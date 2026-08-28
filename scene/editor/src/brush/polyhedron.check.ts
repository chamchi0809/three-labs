// The kernel every brush operation stands on. A solid that is subtly open, or wound inside out, or
// convex everywhere but at one vertex, looks perfectly fine on screen until the CSG three edits later.
// So every construction here is handed straight to `integrity`, which is the real assertion.
// Run with: node --experimental-strip-types src/brush/polyhedron.check.ts
import assert from "node:assert/strict";
import type { Plane, Vec3 } from "tscene";
import { report, test } from "../check.ts";
import {
  boxPolyhedron, clip, containsPoint, dedupePlanes, edges, facePoints, fromPlanes, hullPlanes,
  integrity, planeOfLoop, polyBounds, polyCentre, transform, vertexFaces, volume, weld,
} from "./polyhedron.ts";
import { cross, distance, dot, normalize, rotation, scaling, sub, translation } from "./vec.ts";

/** the six half-spaces of an axis-aligned box, in the order boxPolyhedron writes its faces */
const boxPlanes = (min: Vec3, max: Vec3): Plane[] => [
  { n: [1, 0, 0], d: max[0] },
  { n: [-1, 0, 0], d: -min[0] },
  { n: [0, 1, 0], d: max[1] },
  { n: [0, -1, 0], d: -min[1] },
  { n: [0, 0, 1], d: max[2] },
  { n: [0, 0, -1], d: -min[2] },
];

const unit = boxPolyhedron([0, 0, 0], [1, 1, 1]);
const ok = (poly: unknown, why: string) => {
  assert.ok(poly, `${why}: no solid was built`);
  assert.deepEqual(integrity(poly as never), [], why);
};

// ---------------------------------------------------------------- the starting box

test("a box is closed, convex and wound outward", () => {
  ok(unit, "the unit box");
  assert.equal(unit.vertices.length, 8);
  assert.equal(unit.faces.length, 6);
  assert.equal(edges(unit).length, 12);
  assert.equal(volume(unit), 1);
});

test("every face of a box is wound counter-clockwise seen from outside", () => {
  for (const face of unit.faces) {
    const derived = planeOfLoop(unit.vertices, face.loop)!;
    assert.ok(dot(derived.n, face.plane.n) > 0.999, `face ${face.plane.n} is wound inward`);
    assert.ok(Math.abs(derived.d - face.plane.d) < 1e-9);
  }
});

test("every edge borders exactly two faces, once in each direction", () => {
  for (const e of edges(unit)) assert.ok(e.faces[1] >= 0, `edge ${e.a}-${e.b} is open`);
  // a cube corner is three faces meeting
  for (const faces of vertexFaces(unit)) assert.equal(faces.length, 3);
});

test("a box knows where it is", () => {
  assert.deepEqual(polyBounds(unit), { min: [0, 0, 0], max: [1, 1, 1] });
  assert.deepEqual(polyCentre(unit), [0.5, 0.5, 0.5]);
  assert.ok(containsPoint(unit, [0.5, 0.5, 0.5]));
  assert.ok(containsPoint(unit, [1, 1, 1]), "a corner counts as inside");
  assert.ok(!containsPoint(unit, [1.001, 0.5, 0.5]));
});

// ---------------------------------------------------------------- clipping

test("a plane that misses the solid leaves it alone and says so", () => {
  const away = clip(unit, { n: [1, 0, 0], d: 5 }, 9);
  assert.equal(away.cut, false);
  assert.equal(away.poly, unit, "an untouched solid is not rebuilt");
});

test("a plane the solid is entirely behind leaves nothing", () => {
  assert.equal(clip(unit, { n: [1, 0, 0], d: -5 }, 9).poly, undefined);
});

test("a diagonal cut opens exactly one new face, and the solid stays closed", () => {
  const n = normalize([1, 1, 0])!;
  const cut = clip(unit, { n, d: dot(n, [1, 0.5, 0]) }, 9);
  ok(cut.poly, "the cut box");
  assert.equal(cut.cut, true);
  const opened = cut.poly!.faces.filter((f) => f.source === 9);
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.loop.length, 4, "the cut face is a quad");
  assert.ok(volume(cut.poly!) < 1 && volume(cut.poly!) > 0.8);
});

test("a cut through a corner removes that corner and nothing else", () => {
  const n = normalize([1, 1, 1])!;
  const cut = clip(unit, { n, d: dot(n, [1, 1, 0.7]) }, 9);
  ok(cut.poly, "the corner-cut box");
  assert.equal(cut.poly!.faces.length, 7);
  assert.equal(cut.poly!.faces.find((f) => f.source === 9)!.loop.length, 3);
  assert.ok(!containsPoint(cut.poly!, [1, 1, 1]), "the corner is gone");
});

test("the vertices a cut makes are shared by both faces that meet along the edge", () => {
  const n = normalize([1, 0.3, 0])!;
  const cut = clip(unit, { n, d: dot(n, [0.6, 0.5, 0]) }, 9).poly!;
  // if the two faces each made their own copy, the solid would have loose edges and integrity says so
  assert.deepEqual(integrity(cut), []);
  // and no two vertices sit on top of each other
  for (const [i, a] of cut.vertices.entries()) {
    for (const [j, b] of cut.vertices.entries()) {
      if (i < j) assert.ok(distance(a, b) > 1e-9, `vertices ${i} and ${j} coincide`);
    }
  }
});

test("cutting exactly along an existing face changes nothing", () => {
  const flush = clip(unit, { n: [1, 0, 0], d: 1 }, 9);
  assert.equal(flush.cut, false);
  assert.equal(flush.poly, unit);
});

// ---------------------------------------------------------------- fromPlanes

test("six half-spaces come back as the box they bound", () => {
  const { poly, problems } = fromPlanes(boxPlanes([-1, -2, -3], [4, 5, 6]));
  assert.deepEqual(problems, []);
  ok(poly, "the box from planes");
  assert.equal(poly!.faces.length, 6);
  assert.deepEqual(polyBounds(poly!), { min: [-1, -2, -3], max: [4, 5, 6] });
  assert.ok(Math.abs(volume(poly!) - 5 * 7 * 9) < 1e-6);
  // every face remembers which plane made it, which is how attributes survive a rebuild
  assert.deepEqual([...poly!.faces].map((f) => f.source).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
});

test("a face that bounds nothing is reported, not silently dropped", () => {
  const planes = [...boxPlanes([0, 0, 0], [1, 1, 1]), { n: normalize([1, 1, 1])!, d: 99 } as Plane];
  const { poly, problems } = fromPlanes(planes);
  ok(poly, "the box with a stray plane");
  assert.equal(poly!.faces.length, 6);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.kind, "redundant");
  assert.equal((problems[0] as { source: number }).source, 6);
});

test("planes that never close are reported as unbounded, not returned half-built", () => {
  const { poly, problems } = fromPlanes(boxPlanes([0, 0, 0], [1, 1, 1]).slice(0, 4));
  assert.equal(poly, undefined);
  assert.equal(problems[0]!.kind, "unbounded");
});

test("planes that bound no volume are reported as empty", () => {
  const planes = [...boxPlanes([0, 0, 0], [1, 1, 1]), { n: [-1, 0, 0], d: -2 } as Plane];
  const { poly, problems } = fromPlanes(planes);
  assert.equal(poly, undefined);
  assert.equal(problems.at(-1)!.kind, "empty");
});

test("a tetrahedron is four faces, four vertices and six edges", () => {
  const corners: Vec3[] = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]];
  const planes = hullPlanes(corners)!;
  assert.equal(planes.length, 4);
  const { poly } = fromPlanes(planes);
  ok(poly, "the tetrahedron");
  assert.equal(poly!.vertices.length, 4);
  assert.equal(poly!.faces.length, 4);
  assert.equal(edges(poly!).length, 6);
  assert.ok(Math.abs(volume(poly!) - 8 / 6) < 1e-9);
});

test("the three points a face is written as are spread around its loop", () => {
  const face = unit.faces[0]!;
  const [a, b, c] = facePoints(unit, face);
  const derived = normalize(cross(sub(b, a), sub(c, b)))!;
  assert.ok(dot(derived, face.plane.n) > 0.999, "the three points are wound outward");
  assert.ok(distance(a, b) > 0 && distance(b, c) > 0 && distance(a, c) > 0);
});

// ---------------------------------------------------------------- hull

test("the hull of a box's corners is six planes, not twelve triangles", () => {
  const corners = boxPolyhedron([0, 0, 0], [2, 3, 4]).vertices;
  const planes = hullPlanes(corners)!;
  assert.equal(planes.length, 6, `got ${planes.length} planes`);
  const { poly } = fromPlanes(planes);
  ok(poly, "the box rebuilt from its own corners");
  assert.equal(poly!.faces.length, 6);
  assert.deepEqual(polyBounds(poly!), { min: [0, 0, 0], max: [2, 3, 4] });
});

test("a point inside the hull does not add a face", () => {
  const corners = [...boxPolyhedron([0, 0, 0], [2, 2, 2]).vertices, [1, 1, 1] as Vec3];
  assert.equal(hullPlanes(corners)!.length, 6);
});

test("flat, collinear and too-few point sets have no hull at all", () => {
  assert.equal(hullPlanes([[0, 0, 0], [1, 0, 0], [0, 1, 0]]), undefined);
  assert.equal(hullPlanes([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [2, 2, 0]]), undefined, "coplanar");
  assert.equal(hullPlanes([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]), undefined, "collinear");
});

test("welding collapses coincident points and dedupe collapses repeated planes", () => {
  assert.equal(weld([[0, 0, 0], [0, 0, 1e-9], [1, 0, 0]]).length, 2);
  assert.equal(dedupePlanes([{ n: [1, 0, 0], d: 2 }, { n: [1, 0, 0], d: 2 }, { n: [0, 1, 0], d: 2 }]).length, 2);
});

test("a hull of many points on a sphere is convex and closed", () => {
  const points: Vec3[] = [];
  for (let i = 0; i < 40; i++) {
    // a deterministic spiral, so a failure is reproducible
    const y = 1 - (2 * i) / 39;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * 2.39996;
    points.push([r * Math.cos(a), y, r * Math.sin(a)]);
  }
  const planes = hullPlanes(points)!;
  const { poly } = fromPlanes(planes);
  ok(poly, "the sphere hull");
  for (const p of points) assert.ok(containsPoint(poly!, p, 1e-4), "a point is outside its own hull");
});

// ---------------------------------------------------------------- transforms

test("a transform moves the solid and keeps it closed", () => {
  const moved = transform(unit, translation([10, 0, -3]), false);
  ok(moved, "the moved box");
  assert.deepEqual(polyBounds(moved), { min: [10, 0, -3], max: [11, 1, -2] });
  const spun = transform(unit, rotation([0, 1, 0], Math.PI / 4, polyCentre(unit)), false);
  ok(spun, "the rotated box");
  assert.ok(Math.abs(volume(spun) - 1) < 1e-9, "rotation preserves volume");
  const big = transform(unit, scaling([2, 3, 4]), false);
  ok(big, "the scaled box");
  assert.ok(Math.abs(volume(big) - 24) < 1e-9);
});

test("a mirroring transform reverses every loop instead of turning the solid inside out", () => {
  const flipped = transform(unit, scaling([-1, 1, 1]), true);
  ok(flipped, "the mirrored box");
  assert.ok(volume(flipped) > 0, "volume is still positive");
  assert.deepEqual(polyBounds(flipped), { min: [-1, 0, 0], max: [0, 1, 1] });
});

report("polyhedron");
