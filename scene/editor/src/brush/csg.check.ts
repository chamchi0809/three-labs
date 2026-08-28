// CSG is where a kernel bug stops being theoretical: a subtraction that leaves a sliver, or a fragment
// wound inside out, turns into a level that leaks. Every solid any operation here produces is handed to
// `integrity`, and the volumes are made to add up.
// Run with: node --experimental-strip-types src/brush/csg.check.ts
import assert from "node:assert/strict";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { cone, cube, cuboid, cylinder, icoSphere, uvSphere, wedge } from "./builder.ts";
import {
  build, contains, fromPoints, hollow, intersect, keepSolid, merge, offsetFaces, overlaps, sourced,
  split, subtract, unionBounds,
} from "./csg.ts";
import { containsPoint, edges, integrity, polyBounds, volume, type Polyhedron } from "./polyhedron.ts";
import { normalize } from "./vec.ts";

const box = (min: Vec3, max: Vec3) => cuboid({ min, max });
const ok = (poly: Polyhedron | undefined, why: string) => {
  assert.ok(poly, `${why}: no solid`);
  assert.deepEqual(integrity(poly), [], why);
};
const near = (a: number, b: number, why: string, slack = 1e-6) =>
  assert.ok(Math.abs(a - b) < slack, `${why}: ${a} is not ${b}`);
const total = (polys: Polyhedron[]) => polys.reduce((s, p) => s + volume(p), 0);

// ---------------------------------------------------------------- overlap

test("overlap is decided by the operands' own faces", () => {
  assert.ok(overlaps(box([0, 0, 0], [2, 2, 2]), box([1, 1, 1], [3, 3, 3])));
  assert.ok(!overlaps(box([0, 0, 0], [2, 2, 2]), box([3, 0, 0], [4, 2, 2])));
  // touching is not overlapping: two brushes flush against each other must not carve one another
  assert.ok(!overlaps(box([0, 0, 0], [2, 2, 2]), box([2, 0, 0], [4, 2, 2])));
  assert.ok(contains(box([0, 0, 0], [4, 4, 4]), box([1, 1, 1], [2, 2, 2])));
  assert.ok(!contains(box([0, 0, 0], [4, 4, 4]), box([1, 1, 1], [9, 2, 2])));
});

// ---------------------------------------------------------------- subtract

test("a hole through the middle of a box leaves six sound fragments", () => {
  const outer = box([0, 0, 0], [3, 3, 3]);
  const inner = box([1, 1, 1], [2, 2, 2]);
  const parts = subtract(outer, inner);
  assert.equal(parts.length, 6, `got ${parts.length} fragments`);
  for (const [i, p] of parts.entries()) ok(p, `fragment ${i}`);
  near(total(parts), 27 - 1, "the fragments account for the whole brush minus the hole");
  // and nothing of the hole survived
  for (const p of parts) assert.ok(!containsPoint(p, [1.5, 1.5, 1.5]), "a fragment reaches into the hole");
});

test("fragments do not overlap each other", () => {
  const parts = subtract(box([0, 0, 0], [3, 3, 3]), box([1, 1, 1], [2, 2, 2]));
  for (const [i, a] of parts.entries()) {
    for (const [j, b] of parts.entries()) if (i < j) assert.ok(!overlaps(a, b), `fragments ${i} and ${j} overlap`);
  }
});

test("the inside of a hole is textured from the brush that made it", () => {
  const outer = box([0, 0, 0], [3, 3, 3]); // faces sourced 0..5
  const inner = { ...box([1, 1, 1], [2, 2, 2]) };
  inner.faces = inner.faces.map((f) => ({ ...f, source: f.source + 100 }));
  const parts = subtract(outer, inner);
  const fromInner = parts.flatMap((p) => p.faces.filter((f) => f.source >= 100));
  assert.ok(fromInner.length >= 6, `only ${fromInner.length} faces came from the cutting brush`);
  // ...and the walls of the room still belong to the room
  assert.ok(parts.flatMap((p) => p.faces.filter((f) => f.source < 6 && f.source >= 0)).length >= 6);
});

test("a subtraction that misses gives the brush back untouched", () => {
  const a = box([0, 0, 0], [2, 2, 2]);
  assert.deepEqual(subtract(a, box([5, 5, 5], [6, 6, 6])), [a]);
  assert.deepEqual(subtract(a, box([2, 0, 0], [4, 2, 2])), [a], "a flush neighbour cuts nothing");
});

test("a subtraction that swallows the brush leaves nothing at all", () => {
  assert.deepEqual(subtract(box([1, 1, 1], [2, 2, 2]), box([0, 0, 0], [3, 3, 3])), []);
});

test("a corner bite leaves fragments, not a concave brush", () => {
  const parts = subtract(box([0, 0, 0], [2, 2, 2]), box([1, 1, 1], [3, 3, 3]));
  for (const [i, p] of parts.entries()) ok(p, `fragment ${i}`);
  near(total(parts), 8 - 1, "the bite is one cubic metre");
});

test("an angled cutter still leaves closed fragments", () => {
  const n = normalize([1, 1, 0.3])!;
  const cutter = build([
    ...sourced(box([-1, -1, -1], [4, 4, 4]), 100),
    { plane: { n, d: 2 }, source: 200 },
  ]).poly!;
  const parts = subtract(box([0, 0, 0], [3, 3, 3]), cutter);
  for (const [i, p] of parts.entries()) ok(p, `fragment ${i}`);
  assert.ok(total(parts) > 0 && total(parts) < 27);
});

// ---------------------------------------------------------------- intersect

test("the intersection of two boxes is the box they share", () => {
  const both = intersect(box([0, 0, 0], [3, 3, 3]), box([2, 1, -1], [5, 2, 9]));
  ok(both, "the shared box");
  assert.deepEqual(polyBounds(both!), { min: [2, 1, 0], max: [3, 2, 3] });
  near(volume(both!), 1 * 1 * 3, "the shared volume");
});

test("boxes that miss each other share nothing", () => {
  assert.equal(intersect(box([0, 0, 0], [1, 1, 1]), box([2, 2, 2], [3, 3, 3])), undefined);
  assert.equal(intersect(box([0, 0, 0], [1, 1, 1]), box([1, 0, 0], [2, 1, 1])), undefined, "flush is not shared");
});

// ---------------------------------------------------------------- merge

test("two boxes that meet along a face merge into one, exactly", () => {
  const { poly, exact } = merge([box([0, 0, 0], [1, 2, 2]), box([1, 0, 0], [3, 2, 2])]);
  ok(poly, "the merged box");
  assert.equal(exact, true);
  assert.equal(poly!.faces.length, 6, "the shared face is gone, not left inside");
  assert.deepEqual(polyBounds(poly!), { min: [0, 0, 0], max: [3, 2, 2] });
});

test("a merge that fills in a corner says so instead of adding solid quietly", () => {
  const { poly, exact } = merge([box([0, 0, 0], [1, 1, 1]), box([2, 2, 2], [3, 3, 3])]);
  ok(poly, "the hull of two separate boxes");
  assert.equal(exact, false);
});

test("a merged face keeps the material of the face it came from", () => {
  const left = box([0, 0, 0], [1, 2, 2]);
  const { poly } = merge([left, box([1, 0, 0], [3, 2, 2])]);
  // the -x face of the result is the -x face of the left box, source 1 in cuboid's order
  const minusX = poly!.faces.find((f) => f.plane.n[0] === -1)!;
  assert.equal(minusX.source, 1);
});

// ---------------------------------------------------------------- offset and hollow

test("pushing every face out grows the brush without changing its shape", () => {
  const bigger = offsetFaces(box([0, 0, 0], [2, 2, 2]), 0.5);
  ok(bigger, "the grown box");
  assert.deepEqual(polyBounds(bigger!), { min: [-0.5, -0.5, -0.5], max: [2.5, 2.5, 2.5] });
  assert.equal(offsetFaces(box([0, 0, 0], [2, 2, 2]), -2), undefined, "shrunk past nothing is nothing");
});

test("a hollowed box is a shell of the thickness asked for", () => {
  const parts = hollow(box([0, 0, 0], [4, 4, 4]), 0.5);
  assert.equal(parts.length, 6);
  for (const [i, p] of parts.entries()) ok(p, `wall ${i}`);
  near(total(parts), 4 ** 3 - 3 ** 3, "the shell is the box minus its cavity");
  assert.deepEqual(unionBounds(parts), { min: [0, 0, 0], max: [4, 4, 4] });
});

test("a brush too small to hollow comes back whole", () => {
  const small = box([0, 0, 0], [1, 1, 1]);
  assert.deepEqual(hollow(small, 1), [small]);
  assert.deepEqual(hollow(small, 0), [small]);
});

// ---------------------------------------------------------------- clip

test("the clip tool's two halves add back up to the brush", () => {
  const whole = box([0, 0, 0], [2, 2, 2]);
  const n = normalize([1, 1, 0])!;
  const { front, back } = split(whole, { n, d: 2 }, 77);
  ok(front, "the front half");
  ok(back, "the back half");
  near(volume(front!) + volume(back!), 8, "the halves are the whole");
  // both halves carry the cut face, and it is the one the caller named
  assert.ok(front!.faces.some((f) => f.source === 77));
  assert.ok(back!.faces.some((f) => f.source === 77));
});

test("a clip that misses leaves one half empty rather than a sliver", () => {
  const { front, back } = split(box([0, 0, 0], [2, 2, 2]), { n: [1, 0, 0], d: 9 });
  assert.ok(back, "everything is behind the plane");
  assert.equal(front, undefined);
});

// ---------------------------------------------------------------- vertex editing

test("a dragged corner rebuilds the brush and keeps the faces it only tilted", () => {
  const start = box([0, 0, 0], [2, 2, 2]);
  const moved = start.vertices.map((v): Vec3 => (v[0] === 2 && v[1] === 2 && v[2] === 2 ? [3, 3, 3] : v));
  const dragged = fromPoints(moved, sourced(start));
  ok(dragged, "the dragged brush");
  assert.ok(volume(dragged!) > 8, "pulling a corner out adds volume");
  // the three faces the drag did not touch are still exactly where they were, with their materials
  for (const source of [1, 3, 5]) {
    assert.ok(dragged!.faces.some((f) => f.source === source), `face ${source} lost its material`);
  }
});

test("a corner dragged flat against its neighbours merges the faces instead of creasing", () => {
  // an eight-corner box with one corner pushed onto the plane of the face beside it stays six faces
  const start = box([0, 0, 0], [2, 2, 2]);
  const flat = start.vertices.map((v): Vec3 => (v[0] === 2 && v[1] === 2 && v[2] === 2 ? [2, 2, 2] : v));
  assert.equal(fromPoints(flat, sourced(start))!.faces.length, 6);
});

test("points that are not a solid do not become one", () => {
  assert.equal(fromPoints([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]]), undefined);
});

// ---------------------------------------------------------------- primitives

test("a cuboid's faces are in the order the inspector names them", () => {
  const b = cuboid({ min: [0, 0, 0], max: [1, 2, 3] });
  ok(b, "the cuboid");
  assert.deepEqual(b.faces.map((f) => f.plane.n), [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ]);
  assert.deepEqual(b.faces.map((f) => f.source), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(polyBounds(cube(2, [1, 1, 1])), { min: [0, 0, 0], max: [2, 2, 2] });
});

test("a cylinder has one face per side plus two caps", () => {
  for (const sides of [3, 4, 8, 16]) {
    const c = cylinder({ min: [0, 0, 0], max: [2, 4, 2] }, sides);
    ok(c, `a ${sides}-sided cylinder`);
    assert.equal(c!.faces.length, sides + 2, `a ${sides}-sided cylinder`);
    assert.equal(c!.vertices.length, sides * 2);
    assert.equal(edges(c!).length, sides * 3);
    assert.ok(volume(c!) < 2 * 4 * 2 && volume(c!) > 0);
  }
});

test("a cylinder fills the box it was dragged in", () => {
  const c = cylinder({ min: [-1, 0, -2], max: [1, 4, 2] }, 16)!;
  const b = polyBounds(c);
  // an even-sided prism has flat sides facing the axes, so it touches the box at the middle of each side
  near(b.min[1]!, 0, "the bottom");
  near(b.max[1]!, 4, "the top");
  assert.ok(b.max[0]! <= 1 + 1e-9 && b.max[2]! <= 2 + 1e-9, "it stays inside the drag");
});

test("a cone has one face per side plus a base, and one tip", () => {
  const c = cone({ min: [0, 0, 0], max: [2, 3, 2] }, 6);
  ok(c, "the cone");
  assert.equal(c!.faces.length, 7);
  assert.equal(c!.vertices.length, 7);
  assert.ok(containsPoint(c!, [1, 0.1, 1]), "the middle of the base is inside");
  assert.ok(!containsPoint(c!, [0.05, 2.9, 0.05]), "the corner at the top is not");
});

test("a wedge is a box with one edge collapsed", () => {
  const w = wedge({ min: [0, 0, 0], max: [2, 2, 2] });
  ok(w, "the wedge");
  assert.equal(w!.vertices.length, 6);
  assert.equal(w!.faces.length, 5);
  near(volume(w!), 4, "half the box");
});

test("both spheres are closed solids inside the box they were dragged in", () => {
  const b = { min: [0, 0, 0] as Vec3, max: [2, 2, 2] as Vec3 };
  const uv = uvSphere(b, 8, 4);
  ok(uv, "the uv sphere");
  const ico = icoSphere(b, 1);
  ok(ico, "the icosphere");
  assert.equal(icoSphere(b, 0)!.faces.length, 20, "no subdivision is the icosahedron itself");
  for (const s of [uv!, ico!]) {
    const bb = polyBounds(s);
    for (let k = 0; k < 3; k++) {
      assert.ok(bb.min[k]! >= -1e-9 && bb.max[k]! <= 2 + 1e-9, "a sphere escaped its box");
    }
    assert.ok(containsPoint(s, [1, 1, 1]), "the centre is inside");
    assert.ok(volume(s) > 0.5 * (4 / 3) * Math.PI, "it is at least half a sphere's worth of volume");
  }
});

test("a primitive can be carved like any other brush", () => {
  const parts = subtract(cylinder({ min: [0, 0, 0], max: [4, 4, 4] }, 8)!, cube(1, [2, 2, 2]));
  const { kept, dropped } = keepSolid(parts);
  assert.deepEqual(dropped, []);
  assert.equal(kept.length, parts.length);
  assert.ok(kept.length >= 6);
});

report("csg");
