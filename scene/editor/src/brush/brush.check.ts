// The brush model, and the one thing it exists to get right: an edit changes the topology, and the
// materials have to end up on the faces a designer would say they belong to. Also the round trip, which
// has to be exact or a sheet drifts every time it is opened and saved.
// Run with: node --experimental-strip-types src/brush/brush.check.ts
import assert from "node:assert/strict";
import type { BrushFace, Vec3 } from "tscene";
import { report, test } from "../check.ts";
import {
  addVertex, brushArea, brushBounds, brushCentre, brushFromFaces, brushOf, brushProblems, brushToFaces,
  brushToMesh, brushVolume, expandBrush, faceArea, faceCentre, faceNormal, facePolygon, faceAttributes,
  gridError, isOnGrid, moveEdge, moveFace, moveVertices, removeVertex, setFacePlane, settle, snapBrush,
  transformBrush, type Brush,
} from "./brush.ts";
import { cuboid, cylinder } from "./builder.ts";
import { subtract } from "./csg.ts";
import { integrity } from "./polyhedron.ts";
import { rotation, scaling, translation } from "./vec.ts";

const box = (min: Vec3, max: Vec3) => brushOf(cuboid({ min, max }));
const sound = (edit: { brush?: Brush; problems: string[] }, why: string): Brush => {
  assert.deepEqual(edit.problems, [], why);
  assert.ok(edit.brush, `${why}: no brush`);
  assert.deepEqual(brushProblems(edit.brush!), [], why);
  assert.equal(edit.brush!.faces.length, edit.brush!.poly.faces.length, `${why}: faces and attributes disagree`);
  return edit.brush!;
};

/** a brush whose faces are told apart by their material, so an edit can be followed by name */
function named(min: Vec3, max: Vec3): Brush {
  const b = box(min, max);
  const names = ["--east", "--west", "--ceiling", "--floor", "--north", "--south"];
  return { ...b, faces: b.faces.map((f, i) => ({ ...f, material: names[i] })) };
}
const materialOf = (b: Brush, normal: Vec3) =>
  b.faces[b.poly.faces.findIndex((f) => f.plane.n.every((x, k) => Math.abs(x - normal[k]!) < 1e-9))]?.material;

/** the corners within a pick radius of a place — how a viewport selects, and immune to the last bit */
const corners = (b: Brush, at: (v: Vec3) => boolean): number[] =>
  b.poly.vertices.map((v, i) => (at(v) ? i : -1)).filter((i) => i >= 0);
const about = (v: number, x: number) => Math.abs(v - x) < 1e-6;

// ---------------------------------------------------------------- the model

test("a fresh brush has one description per face, all the same", () => {
  const b = box([0, 0, 0], [2, 2, 2]);
  assert.equal(b.faces.length, 6);
  assert.deepEqual(brushProblems(b), []);
  assert.deepEqual(b.faces[0], faceAttributes());
  // the descriptions are not shared, so setting one does not set all six
  b.faces[0]!.offset[0] = 5;
  assert.equal(b.faces[1]!.offset[0], 0);
});

test("a brush knows its size, its middle and its surfaces", () => {
  const b = box([0, 0, 0], [2, 3, 4]);
  assert.deepEqual(brushBounds(b), { min: [0, 0, 0], max: [2, 3, 4] });
  assert.deepEqual(brushCentre(b), [1, 1.5, 2]);
  assert.equal(brushVolume(b), 24);
  assert.equal(brushArea(b), 2 * (2 * 3 + 3 * 4 + 2 * 4));
  assert.equal(faceArea(b, 0), 3 * 4); // +x
  assert.deepEqual(faceNormal(b, 0), [1, 0, 0]);
  assert.deepEqual(faceCentre(b, 0), [2, 1.5, 2]);
  assert.equal(facePolygon(b, 0).length, 4);
});

test("a scale of zero is reported rather than rendered", () => {
  const b = box([0, 0, 0], [1, 1, 1]);
  b.faces[2]!.scale = [0, 1];
  assert.match(brushProblems(b)[0]!, /scale of zero/);
});

// ---------------------------------------------------------------- the sheet, both ways

test("a brush written to a sheet and read back is the same brush", () => {
  const before = named([0, 0, 0], [2, 3, 4]);
  before.faces[2]!.scale = [0.5, 0.25];
  before.faces[2]!.rotation = Math.PI / 6;
  before.faces[4]!.uv = { kind: "parallel" };
  before.faces[4]!.offset = [1.5, -2];
  const after = sound(brushFromFaces(brushToFaces(before)), "the round trip");
  assert.deepEqual(brushBounds(after), brushBounds(before));
  assert.deepEqual(after.poly.faces.map((f) => f.plane), before.poly.faces.map((f) => f.plane));
  // the attributes survive, on the right faces
  assert.deepEqual(after.faces.map((f) => f.scale), before.faces.map((f) => f.scale));
  assert.deepEqual(after.faces.map((f) => f.rotation), before.faces.map((f) => f.rotation));
  assert.deepEqual(after.faces.map((f) => f.uv), before.faces.map((f) => f.uv));
  assert.deepEqual(after.faces.map((f) => f.offset), before.faces.map((f) => f.offset));
});

test("a face that has never been touched writes three points and nothing else", () => {
  const written = brushToFaces(box([0, 0, 0], [1, 1, 1]));
  assert.deepEqual(Object.keys(written[0]!), ["points"]);
  assert.equal(written.length, 6);
  // and the points are wound so the plane comes back pointing the same way
  const back = brushFromFaces(written).brush!;
  assert.deepEqual(back.poly.faces.map((f) => f.plane.n), [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ]);
});

test("a sheet with a face that bounds nothing still opens, and says which face", () => {
  const faces = brushToFaces(box([0, 0, 0], [2, 2, 2]));
  const stray: BrushFace = { points: [[9, 9, 0], [9, 9, 1], [10, 9, 1]] };
  const { brush, problems } = brushFromFaces([...faces, stray]);
  assert.ok(brush);
  assert.equal(brush!.poly.faces.length, 6);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /^face 6: /);
});

test("a sheet with too few faces, or three points in a line, is refused with a reason", () => {
  const short = brushToFaces(box([0, 0, 0], [1, 1, 1])).slice(0, 3);
  assert.match(brushFromFaces(short).problems.at(-1)!, /at least 4 faces/);
  const flat = brushToFaces(box([0, 0, 0], [1, 1, 1]));
  flat[0] = { points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] };
  assert.match(brushFromFaces(flat).problems[0]!, /in a line/);
});

test("a brush becomes the mesh the runtime would build", () => {
  const { mesh, problems } = brushToMesh(box([0, 0, 0], [2, 2, 2]));
  assert.deepEqual(problems, []);
  assert.equal(mesh!.groups.length, 6);
  assert.equal(mesh!.positions.length / 3, 36);
  assert.equal(mesh!.polygons.filter(Boolean).length, 6);
});

// ---------------------------------------------------------------- attributes across an edit

test("a face slid along its normal keeps every material where it was", () => {
  const before = named([0, 0, 0], [2, 2, 2]);
  const after = sound(moveFace(before, 0, 3), "sliding the east wall out");
  assert.deepEqual(brushBounds(after), { min: [0, 0, 0], max: [5, 2, 2] });
  for (const [n, name] of [
    [[1, 0, 0], "--east"], [[-1, 0, 0], "--west"], [[0, 1, 0], "--ceiling"],
    [[0, -1, 0], "--floor"], [[0, 0, 1], "--north"], [[0, 0, -1], "--south"],
  ] as [Vec3, string][]) {
    assert.equal(materialOf(after, n), name, `${name} moved`);
  }
});

test("a face pushed through the brush is refused, not collapsed", () => {
  const b = box([0, 0, 0], [2, 2, 2]);
  const edit = moveFace(b, 0, -3);
  assert.equal(edit.brush, undefined);
  assert.match(edit.problems[0]!, /moving the face/);
});

test("a corner cut off inherits the material of the face it is closest to", () => {
  const before = named([0, 0, 0], [2, 2, 2]);
  // pull the +x+y+z corner in along x only: the new face faces mostly +x, so it is the east wall's
  const after = sound(moveVertices(before, [7], [-1, 0, 0]), "cutting the corner");
  assert.equal(after.poly.faces.length, 7);
  const invented = after.poly.faces.findIndex((f) => f.plane.n[0]! > 0.1 && f.plane.n[1]! > 0.1);
  assert.ok(invented >= 0, "the bevel is there");
  assert.equal(after.faces[invented]!.material, "--east");
  assert.equal(materialOf(after, [0, 1, 0]), "--ceiling", "the ceiling is untouched");
});

test("a corner dragged flat merges its faces and keeps one of the materials", () => {
  const before = named([0, 0, 0], [2, 2, 2]);
  const cut = sound(moveVertices(before, [7], [-1, 0, 0]), "cutting the corner");
  const back = sound(moveVertices(cut, corners(cut, (v) => about(v[0], 1)), [1, 0, 0]), "putting it back");
  assert.equal(back.poly.faces.length, 6, "the bevel merged away");
  assert.equal(materialOf(back, [1, 0, 0]), "--east");
});

test("a corner removed cuts the brush flat across, and the new face takes a neighbour", () => {
  const before = named([0, 0, 0], [2, 2, 2]);
  const after = sound(removeVertex(before, 7), "removing a corner");
  assert.equal(after.poly.faces.length, 7);
  assert.ok(brushVolume(after) < 8);
  assert.ok(after.faces.every((f) => typeof f.material === "string"), "a face came out blank");
});

test("a corner added grows the brush and the new faces are not blank", () => {
  const before = named([0, 0, 0], [2, 2, 2]);
  const after = sound(addVertex(before, [1, 4, 1]), "adding a corner");
  assert.ok(brushVolume(after) > 8);
  assert.ok(after.faces.every((f) => typeof f.material === "string"));
});

test("an edge dragged moves both its ends", () => {
  const before = box([0, 0, 0], [2, 2, 2]);
  const top = corners(before, (v) => about(v[1], 2) && about(v[0], 2));
  assert.equal(top.length, 2);
  const after = sound(moveEdge(before, top[0]!, top[1]!, [1, 0, 0]), "dragging the top edge out");
  assert.deepEqual(brushBounds(after).max, [3, 2, 2]);
  assert.equal(after.poly.faces.length, 6, "a box sheared is still six faces");
});

test("a face put on a plane outright lands exactly there", () => {
  const after = sound(setFacePlane(box([0, 0, 0], [2, 2, 2]), 2, { n: [0, 1, 0], d: 5 }), "raising the ceiling");
  assert.deepEqual(brushBounds(after).max, [2, 5, 2]);
});

// ---------------------------------------------------------------- transforms

test("a brush moved, spun and scaled stays a brush, and keeps its materials", () => {
  const before = named([0, 0, 0], [2, 2, 2]);
  const moved = sound(transformBrush(before, translation([10, 0, 0])), "moving");
  assert.deepEqual(brushBounds(moved), { min: [10, 0, 0], max: [12, 2, 2] });
  assert.equal(materialOf(moved, [1, 0, 0]), "--east");
  const spun = sound(transformBrush(before, rotation([0, 1, 0], Math.PI / 2, [1, 1, 1])), "spinning");
  assert.ok(Math.abs(brushVolume(spun) - 8) < 1e-9);
  const big = sound(transformBrush(before, scaling([2, 1, 1], [0, 0, 0])), "scaling");
  assert.deepEqual(brushBounds(big), { min: [0, 0, 0], max: [4, 2, 2] });
});

test("a mirrored brush is not inside out", () => {
  const flipped = sound(transformBrush(named([0, 0, 0], [2, 2, 2]), scaling([-1, 1, 1])), "mirroring");
  assert.ok(brushVolume(flipped) > 0);
  assert.deepEqual(brushBounds(flipped), { min: [-2, 0, 0], max: [0, 2, 2] });
  // the wall that faced east now faces west, and takes its material with it
  assert.equal(materialOf(flipped, [-1, 0, 0]), "--east");
});

test("a brush pushed out keeps its wall thickness, unlike a scale", () => {
  const after = sound(expandBrush(box([0, 0, 0], [2, 2, 2]), 0.5), "growing");
  assert.deepEqual(brushBounds(after), { min: [-0.5, -0.5, -0.5], max: [2.5, 2.5, 2.5] });
  assert.equal(expandBrush(box([0, 0, 0], [2, 2, 2]), -2).brush, undefined);
});

// ---------------------------------------------------------------- the grid

test("a brush off the grid is snapped onto it", () => {
  const before = box([0.03, -0.11, 0.9], [2.07, 1.98, 3.02]);
  assert.ok(!isOnGrid(before, 0.25));
  assert.ok(gridError(before, 0.25) > 0);
  const after = sound(snapBrush(before, 0.25), "snapping");
  assert.ok(isOnGrid(after, 0.25));
  assert.deepEqual(brushBounds(after), { min: [0, 0, 1], max: [2, 2, 3] });
  assert.equal(gridError(after, 0.25), 0);
});

test("a brush already on the grid is unchanged by snapping", () => {
  const before = box([0, 0, 0], [2, 2, 2]);
  assert.ok(isOnGrid(before, 0.25));
  assert.deepEqual(brushBounds(sound(snapBrush(before, 0.25), "snapping")), brushBounds(before));
});

test("a brush thinner than a grid cell is refused rather than flattened", () => {
  const sliver = box([0, 0, 0], [2, 0.01, 2]);
  const edit = snapBrush(sliver, 0.25);
  assert.equal(edit.brush, undefined);
  assert.match(edit.problems[0]!, /snapping to the grid/);
});

// ---------------------------------------------------------------- the kernel underneath

test("a carved brush keeps its materials on both sides of the cut", () => {
  const room = named([0, 0, 0], [4, 4, 4]);
  const cutter = brushOf(cuboid({ min: [1, 1, -1], max: [2, 2, 5] }), { material: "--doorway" });
  const parts = subtract(room.poly, { ...cutter.poly, faces: cutter.poly.faces.map((f) => ({ ...f, source: f.source + 100 })) });
  assert.ok(parts.length > 0);
  for (const part of parts) {
    assert.deepEqual(integrity(part), []);
    // settle needs a brush to inherit from, and the cutter's numbering is past the end of the room's
    const carved = settle({ ...room, faces: [...room.faces, ...Array(94).fill(room.faces[0]), ...cutter.faces] }, part);
    assert.deepEqual(brushProblems(carved), []);
    assert.ok(carved.faces.every((f) => typeof f.material === "string"));
  }
});

test("a primitive is a brush like any other", () => {
  const b = brushOf(cylinder({ min: [0, 0, 0], max: [2, 4, 2] }, 8)!, { material: "--pillar" });
  assert.deepEqual(brushProblems(b), []);
  assert.equal(b.faces.length, 10);
  assert.deepEqual(brushToMesh(b).problems, []);
  const back = sound(brushFromFaces(brushToFaces(b)), "a cylinder round trip");
  assert.equal(back.poly.faces.length, 10);
  assert.ok(Math.abs(brushVolume(back) - brushVolume(b)) < 1e-6);
});

report("brush");
