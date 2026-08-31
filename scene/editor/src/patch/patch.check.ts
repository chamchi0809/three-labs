// The patch model: the operations the tools drive it with, and the one thing that makes a closed patch
// editable at all — dragging a seam point drags its twin. The maths itself is tscene's and checked there;
// what is checked here is the editing on top of it, and that the editor's matrices arrive the right way up.
// Run with: node --experimental-strip-types src/patch/patch.check.ts
import assert from "node:assert/strict";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { rotation, translation } from "../brush/vec.ts";
import {
  addColumn, addRow, columnsOf, dropColumn, dropRow, flip, gridError, gridFromRows, isOnGrid, movePatch,
  movePoints, patchBounds, patchCentre, patchHull, patchOf, patchPoints, patchProblems, patchShape,
  patchToMesh, patchUv, rowsOf, snapPatch, spansOf, transformPatch, type Patch, type PatchMesh,
} from "./patch.ts";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b} to within ${eps}`);

const nearVec = (a: Vec3, b: Vec3, eps = 1e-9) => {
  for (const i of [0, 1, 2]) near(a[i]!, b[i]!, eps);
};

/** a flat 3x3 in the xz plane, the smallest thing that is a patch at all */
const flat = (): Patch =>
  patchOf([
    [[0, 0, 0], [2, 0, 0], [4, 0, 0]],
    [[0, 0, 2], [2, 0, 2], [4, 0, 2]],
    [[0, 0, 4], [2, 0, 4], [4, 0, 4]],
  ]);

const built = (patch: Patch): PatchMesh => {
  assert.deepEqual(patchProblems(patch), []);
  const { mesh, problems } = patchToMesh(patch);
  assert.deepEqual(problems, []);
  assert.ok(mesh);
  return mesh!;
};

const sound = (patch: Patch, why: string) => {
  assert.deepEqual(patchProblems(patch), [], why);
  assert.ok(patchToMesh(patch).mesh, `${why}: no mesh`);
};

/** the box the tessellated surface actually fills — smaller than the hull, and where the curve really goes */
function meshBounds(mesh: PatchMesh): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (const a of [0, 1, 2]) {
      min[a] = Math.min(min[a]!, mesh.positions[i + a]!);
      max[a] = Math.max(max[a]!, mesh.positions[i + a]!);
    }
  }
  return { min, max };
}

/** the vertex in the middle of a tessellated patch, which is where a span's bow is at its biggest */
const middleOf = (mesh: PatchMesh): Vec3 => {
  const at = (((mesh.rows - 1) / 2) * mesh.columns + (mesh.columns - 1) / 2) * 3;
  return [mesh.positions[at]!, mesh.positions[at + 1]!, mesh.positions[at + 2]!];
};

// ---------------------------------------------------------------- the model

test("a patch starts at one metre per tile, unturned and unoffset, the way a face does", () => {
  const p = flat();
  assert.deepEqual(p.uv.scale, [1, 1]);
  assert.deepEqual(p.uv.offset, [0, 0]);
  assert.equal(p.uv.rotation, 0);
  assert.equal(p.material, undefined);
  // left out on purpose: the curvature is what should pick, and a number written here would freeze it
  assert.equal(p.subdivisions, undefined);
});

test("the default layout is copied, not shared", () => {
  patchUv().scale[0] = 7;
  assert.deepEqual(patchUv().scale, [1, 1], "one patch's texture scale changed every other patch's");
});

test("a grid's shape is its rows, its columns, and the spans they make", () => {
  const p = patchShape("cylinder", [0, 0, 0], [2, 2, 2]);
  assert.equal(rowsOf(p.grid), 3);
  assert.equal(columnsOf(p.grid), 9);
  assert.deepEqual(spansOf(p.grid), { down: 1, across: 4 }, "nine points round is four quarter-turns");
});

test("every primitive the shape tool offers is a patch the builder accepts", () => {
  for (const shape of ["plane", "cylinder", "cone", "dome", "bevel"] as const) {
    sound(patchShape(shape, [0, 0, 0], [2, 2, 2]), shape);
  }
});

test("the hull joins every neighbour once, each way", () => {
  // a 3x3 grid is 3 rows of 2 segments across, and 3 columns of 2 segments down
  assert.equal(patchHull(flat().grid).length, 12);
});

test("the control points come back addressed by where they are", () => {
  const points = patchPoints(flat().grid);
  assert.equal(points.length, 9);
  nearVec(points.find((p) => p.row === 2 && p.column === 2)!.at, [4, 0, 4]);
  nearVec(points.find((p) => p.row === 0 && p.column === 2)!.at, [4, 0, 0], 1e-12);
});

test("the centre is the hull's, which is where a gizmo sits", () => {
  nearVec(patchCentre(flat().grid), [2, 0, 2]);
});

// ---------------------------------------------------------------- the handle is not on the surface

test("a span reaches half way to its middle handle, and no further", () => {
  const raised = movePoints(flat(), [0, 1, 2].map((column) => ({ row: 1, column })), [0, 4, 0]);
  // the whole middle row lifted by four, so every span across is flat at four and the one span down bows
  near(middleOf(built({ ...raised, subdivisions: 2 }))[1]!, 2);
  // and the hull says four, which is exactly the gap the control net is drawn to explain
  near(patchBounds(raised.grid).max[1]!, 4);
});

test("the bounds of a patch are its hull's, so they do not move when the tessellation does", () => {
  const dome = patchShape("dome", [-1, 0, -1], [1, 2, 1]);
  const coarse = patchBounds({ ...dome, subdivisions: 1 }.grid);
  const fine = patchBounds({ ...dome, subdivisions: 16 }.grid);
  nearVec(coarse.max, fine.max, 0);
  assert.ok(
    coarse.max[1]! >= meshBounds(built({ ...dome, subdivisions: 16 })).max[1]!,
    "the hull has to contain the surface, or a frame-selection would clip it",
  );
});

// ---------------------------------------------------------------- editing

test("moving a control point moves that one, and leaves the patch that went in alone", () => {
  const before = flat();
  const after = movePoints(before, [{ row: 1, column: 1 }], [0, 3, 0]);
  nearVec(after.grid[1]![1]!, [2, 3, 2]);
  nearVec(after.grid[0]![0]!, [0, 0, 0]);
  assert.notEqual(after.grid, before.grid, "the grid should be a new value");
  nearVec(before.grid[1]![1]!, [2, 0, 2], 0);
});

test("dragging a seam point drags its twin, so a cylinder stays closed", () => {
  const before = patchShape("cylinder", [-1, 0, -1], [1, 2, 1]);
  const last = columnsOf(before.grid) - 1;
  const after = movePoints(before, [{ row: 0, column: 0 }], [0, 0, 5]);
  nearVec(after.grid[0]![last]!, after.grid[0]![0]!, 0);
  // and only the seam: the point a quarter of the way round is where it was
  nearVec(after.grid[0]![2]!, before.grid[0]![2]!, 0);
  // the row above is not welded to it either — the twin is a coincident point, not a whole column
  nearVec(after.grid[1]![0]!, before.grid[1]![0]!, 0);
});

test("a cone's tip moves as one point, because that is what it is", () => {
  const before = patchShape("cone", [-1, 0, -1], [1, 2, 1]);
  const tip = rowsOf(before.grid) - 1;
  const after = movePoints(before, [{ row: tip, column: 0 }], [0, 1, 0]);
  for (const p of after.grid[tip]!) nearVec(p, after.grid[tip]![0]!, 0);
  near(after.grid[tip]![0]![1]!, 3);
  sound(after, "the cone came apart");
});

test("weld off moves exactly what was named, and tears the seam", () => {
  const before = patchShape("cylinder", [-1, 0, -1], [1, 2, 1]);
  const last = columnsOf(before.grid) - 1;
  const after = movePoints(before, [{ row: 0, column: 0 }], [0, 0, 5], false);
  nearVec(after.grid[0]![last]!, before.grid[0]![last]!, 0);
  assert.notDeepEqual(after.grid[0]![last], after.grid[0]![0], "the seam should be open");
});

test("moving the whole patch moves every point once, seam and tip included", () => {
  const before = patchShape("cone", [-1, 0, -1], [1, 2, 1]);
  const [a, b] = [patchBounds(before.grid), patchBounds(movePatch(before, [10, 0, 0]).grid)];
  near(b.min[0]! - a.min[0]!, 10);
  near(b.max[0]! - a.max[0]!, 10);
});

test("a transform goes through the handles, and a quadratic follows exactly", () => {
  const before = flat();
  nearVec(transformPatch(before, translation([1, 2, 3])).grid[0]![0]!, [1, 2, 3]);
  // a quarter turn about y, right-handed: the far corner of a 4x4 plate goes (4, 0, 4) → (4, 0, -4)
  const turned = transformPatch(before, rotation([0, 1, 0], Math.PI / 2));
  nearVec(turned.grid[2]![2]!, [4, 0, -4], 1e-9);
  nearVec(turned.grid[0]![0]!, [0, 0, 0], 1e-9);
  sound(turned, "a rotated patch");
});

test("an identity-shaped edit hands back the same grid rather than a copy of it", () => {
  const p = flat();
  // one span each way, so there is nothing to remove and the grid should come back untouched
  assert.equal(dropRow(p, 0).grid, p.grid);
  assert.equal(dropColumn(p, 0).grid, p.grid);
});

test("splitting a span adds two handles and leaves the surface where it was", () => {
  const before = patchShape("dome", [-1, 0, -1], [1, 2, 1]);
  const after = addColumn(before, 0);
  assert.equal(columnsOf(after.grid), columnsOf(before.grid) + 2, "a span is two more control points");
  assert.equal(rowsOf(after.grid), rowsOf(before.grid), "and the other direction is untouched");
  sound(after, "the split grid");
  // de Casteljau's split, so the same surface described with more handles — the box it fills is the same
  const a = meshBounds(built({ ...before, subdivisions: 8 }));
  const b = meshBounds(built({ ...after, subdivisions: 8 }));
  nearVec(a.min, b.min, 1e-9);
  nearVec(a.max, b.max, 1e-9);
});

test("a span can be inserted and taken back out", () => {
  const before = patchShape("cylinder", [-1, 0, -1], [1, 2, 1]);
  const more = addRow(before, 0);
  assert.equal(rowsOf(more.grid), 5);
  assert.equal(rowsOf(dropRow(more, 1).grid), 3);
  assert.equal(columnsOf(dropColumn(before, 0).grid), 7);
  sound(dropColumn(before, 0), "a cylinder with a quarter taken out");
});

test("flipping turns the surface inside out and leaves the shape alone", () => {
  const before = patchShape("cylinder", [-1, 0, -1], [1, 2, 1]);
  const after = flip(before);
  nearVec(patchBounds(after.grid).min, patchBounds(before.grid).min, 0);
  nearVec(patchBounds(after.grid).max, patchBounds(before.grid).max, 0);
  // reversing the rows reverses v, so the normal at a point is the one it had, negated: a tunnel
  const a = built({ ...before, subdivisions: 2 });
  const b = built({ ...after, subdivisions: 2 });
  const last = (b.rows - 1) * b.columns * 3;
  for (const i of [0, 1, 2]) near(a.normals[i]!, -b.normals[last + i]!, 1e-6);
});

test("snapping puts every handle on the grid, and says so beforehand", () => {
  const off = movePoints(flat(), [{ row: 0, column: 0 }], [0.31, 0, 0.19]);
  assert.ok(!isOnGrid(off, 0.25));
  near(gridError(off, 0.25), 0.06, 1e-9);
  const on = snapPatch(off, 0.25);
  assert.ok(isOnGrid(on, 0.25));
  near(gridError(on, 0.25), 0);
  nearVec(on.grid[0]![0]!, [0.25, 0, 0.25], 1e-12);
});

// ---------------------------------------------------------------- reading a grid back

test("a row with an expression in it is not a grid", () => {
  assert.equal(gridFromRows([[[0, 0, 0], undefined, [4, 0, 0]]]), undefined);
});

test("a grid the runtime would refuse is refused here rather than repaired", () => {
  const even: (Vec3 | undefined)[][] = [
    [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
    [[0, 0, 1], [1, 0, 1], [2, 0, 1]],
  ];
  assert.equal(gridFromRows(even), undefined, "two rows is not an odd number of them");
  const ragged: (Vec3 | undefined)[][] = [
    [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
    [[0, 0, 1], [1, 0, 1], [2, 0, 1], [3, 0, 1], [4, 0, 1]],
    [[0, 0, 2], [1, 0, 2], [2, 0, 2]],
  ];
  assert.equal(gridFromRows(ragged), undefined, "the rows are different lengths");
});

test("a grid that is a grid comes back as itself", () => {
  const rows: (Vec3 | undefined)[][] = flat().grid;
  assert.deepEqual(gridFromRows(rows), flat().grid);
});

test("the problems are the checker's own words, so the editor and a build agree", () => {
  const bad = patchOf([
    [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
    [[0, 0, 1], [1, 0, 1], [2, 0, 1]],
  ]);
  assert.deepEqual(patchProblems(bad), ["a patch needs at least three rows of control points"]);
  assert.equal(patchToMesh(bad).mesh, undefined, "and there is no mesh to draw");
});

report("patch");
