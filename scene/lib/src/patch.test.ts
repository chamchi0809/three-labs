// node --experimental-strip-types src/patch.test.ts
import assert from "node:assert/strict";
import {
  buildPatch,
  bevelPatch,
  conePatch,
  cylinderPatch,
  domePatch,
  flipPatch,
  gridProblems,
  insertColumn,
  insertRow,
  patchBounds,
  patchOfShape,
  planePatch,
  pointOn,
  normalOn,
  removeColumn,
  removeRow,
  spansIn,
  subdivisionsFor,
  transformPatch,
  type PatchGrid,
  type Vec3,
} from "./patch.ts";
import { loadScene } from "./runtime.ts";
import { threeRegistry } from "./three.ts";

const tests: [string, () => unknown][] = [];
const test = (name: string, fn: () => unknown) => tests.push([name, fn]);

const near = (a: number, b: number, tol = 1e-9, what = "") => assert.ok(Math.abs(a - b) < tol, `${what} ${a} != ${b}`);
const nearVec = (a: Vec3, b: Vec3, tol = 1e-9, what = "") => a.forEach((v, i) => near(v, b[i]!, tol, `${what}[${i}]`));

/** the flat unit square, 3 x 3, in the xz plane at y = 0 */
const flat = (): PatchGrid => planePatch([0, 0, 0], [2, 0, 2]);

/** one span bent a metre upwards in the middle of its middle row */
const bent = (): PatchGrid => {
  const g = flat();
  g[1]![1] = [1, 1, 1];
  return g;
};

// ---------------------------------------------------------------- the curve

test("a span is three control points, and a row of five is two spans", () => {
  assert.equal(spansIn(3), 1);
  assert.equal(spansIn(5), 2);
  assert.equal(spansIn(9), 4);
});

test("the surface passes through its corners and misses its middle handle by half", () => {
  const g = bent();
  nearVec(pointOn(g, 0, 0), [0, 0, 0]);
  nearVec(pointOn(g, 1, 1), [2, 0, 2], 1e-9, "far corner");
  // the middle of a quadratic reaches half way to its handle, which is the one thing about patches that
  // catches people out: the handle is not on the surface
  nearVec(pointOn(g, 0.5, 0.5), [1, 0.25, 1], 1e-9, "centre");
});

test("a flat patch is flat, however finely it is cut", () => {
  const { mesh } = buildPatch({ grid: flat(), subdivisions: 8 });
  assert.ok(mesh);
  for (let i = 1; i < mesh.positions.length; i += 3) near(mesh.positions[i]!, 0, 1e-6, "y");
});

test("a floor's normal points up, and a floor turned over points down", () => {
  nearVec(normalOn(flat(), 0.5, 0.5), [0, 1, 0], 1e-9, "up");
  nearVec(normalOn(flipPatch(flat()), 0.5, 0.5), [0, -1, 0], 1e-9, "down");
});

test("the tip of a cone has a normal rather than a zero vector", () => {
  const n = normalOn(conePatch([-1, 0, -1], [1, 2, 1]), 0.5, 1);
  assert.ok(Number.isFinite(n[0]! + n[1]! + n[2]!), `${n}`);
  near(Math.hypot(...n), 1, 1e-6, "unit length");
  assert.ok(n[1]! > 0, `the tip faces up rather than ${n[1]}`);
});

// ---------------------------------------------------------------- tessellation

test("the tessellated grid is the spans times the subdivisions, plus the shared edge", () => {
  const { mesh } = buildPatch({ grid: insertColumn(flat(), 0), subdivisions: 3 });
  assert.equal(mesh!.rows, 4, "one span of rows, cut three ways");
  assert.equal(mesh!.columns, 7, "two spans of columns, cut three ways");
  assert.equal(mesh!.indices.length, 3 * 6 * 6, "eighteen quads");
});

test("every triangle is wound so its normal agrees with the surface's", () => {
  const { mesh } = buildPatch({ grid: bent(), subdivisions: 4 });
  const p = (i: number): Vec3 => [mesh!.positions[i * 3]!, mesh!.positions[i * 3 + 1]!, mesh!.positions[i * 3 + 2]!];
  for (let t = 0; t < mesh!.indices.length; t += 3) {
    const [a, b, c] = [p(mesh!.indices[t]!), p(mesh!.indices[t + 1]!), p(mesh!.indices[t + 2]!)];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const s = [mesh!.normals[mesh!.indices[t]! * 3]!, mesh!.normals[mesh!.indices[t]! * 3 + 1]!, mesh!.normals[mesh!.indices[t]! * 3 + 2]!];
    assert.ok(n[0]! * s[0]! + n[1]! * s[1]! + n[2]! * s[2]! > 0, `triangle ${t / 3} is wound the wrong way`);
  }
});

test("uv is measured along the surface, so a bent patch is not squashed at the bend", () => {
  const { mesh } = buildPatch({ grid: bent(), subdivisions: 8 });
  // the far corner's u is the arc length across, which on a bent patch is longer than the two metres
  // the flat one covers — a texture laid out by parameter would have them equal and would visibly stretch
  const last = mesh!.rows * mesh!.columns - 1;
  const flatU = buildPatch({ grid: flat(), subdivisions: 8 }).mesh!.uvs[last * 2]!;
  near(flatU, 2, 1e-6, "the flat one is two metres across");
  assert.ok(mesh!.uvs[last * 2]! > flatU, `the bent one should be longer than ${flatU}`);
});

test("scale is metres per tile and offset is metres, both along the surface", () => {
  const { mesh } = buildPatch({ grid: flat(), subdivisions: 1, scale: [0.5, 0.5], offset: [1, 0] });
  near(mesh!.uvs[0]!, 2, 1e-6, "offset of one metre at half a metre per tile is two tiles");
  const last = mesh!.rows * mesh!.columns - 1;
  near(mesh!.uvs[last * 2 + 1]!, 4, 1e-6, "two metres down at half a metre per tile");
});

// ---------------------------------------------------------------- how finely

test("a flat patch needs one segment a span and a bent one needs more", () => {
  assert.equal(subdivisionsFor({ grid: flat() }), 1);
  assert.ok(subdivisionsFor({ grid: bent() }) > 4, "a metre of bow wants a good many");
  assert.equal(subdivisionsFor({ grid: bent(), subdivisions: 2 }), 2, "unless the patch says otherwise");
});

test("the subdivision count is clamped rather than trusted", () => {
  assert.equal(subdivisionsFor({ grid: flat(), subdivisions: 0 }), 1);
  assert.equal(subdivisionsFor({ grid: flat(), subdivisions: 999 }), 16);
});

// ---------------------------------------------------------------- what is wrong with a grid

test("an even or a short grid is named rather than rendered", () => {
  assert.deepEqual(gridProblems(flat()), []);
  assert.match(gridProblems([flat()[0]!, flat()[1]!])[0]!.message, /at least three rows/);
  assert.match(gridProblems([...flat(), flat()[0]!])[0]!.message, /odd number of rows, and this one has 4/);
  assert.match(gridProblems(flat().map((r) => r.slice(0, 2)))[0]!.message, /at least three control points/);
});

test("a ragged grid names the row that is ragged", () => {
  const g = flat();
  g[2] = [...g[2]!, [0, 0, 0]];
  const [problem] = gridProblems(g);
  assert.equal(problem!.row, 2);
  assert.match(problem!.message, /same length/);
});

test("a grid the checker rejects builds nothing, and says so instead of throwing", () => {
  const { mesh, problems } = buildPatch({ grid: [flat()[0]!, flat()[1]!] });
  assert.equal(mesh, undefined);
  assert.equal(problems.length, 1);
});

// ---------------------------------------------------------------- editing

test("splitting a span adds control points without moving the surface", () => {
  const before = bent();
  const after = insertColumn(before, 0);
  assert.equal(after[0]!.length, 5);
  assert.equal(after.length, 3, "the other direction is untouched");
  for (const [u, v] of [[0, 0], [0.25, 0.4], [0.5, 0.5], [0.9, 1]]) {
    // the same place on the surface, which after the split is at twice the parameter across
    nearVec(pointOn(after, u! * 2, v!), pointOn(before, u!, v!), 1e-9, `(${u}, ${v})`);
  }
});

test("splitting rows works the same way down", () => {
  const before = bent();
  const after = insertRow(before, 0);
  assert.equal(after.length, 5);
  assert.equal(after[0]!.length, 3);
  nearVec(pointOn(after, 0.5, 1), pointOn(before, 0.5, 0.5), 1e-9, "the middle");
});

test("dropping a span leaves an odd grid, and the last span will not be dropped", () => {
  const two = insertColumn(flat(), 0);
  assert.equal(removeColumn(two, 1)[0]!.length, 3);
  assert.equal(removeColumn(flat(), 0)[0]!.length, 3, "one span is the minimum");
  assert.equal(removeRow(insertRow(flat(), 0), 0).length, 3);
  assert.equal(removeRow(flat(), 0).length, 3);
});

test("a patch moves through a matrix a control point at a time", () => {
  const moved = transformPatch(flat(), [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1]);
  nearVec(moved[0]![0]!, [1, 2, 3]);
  nearVec(moved[2]![2]!, [5, 2, 7]);
});

// ---------------------------------------------------------------- primitives

test("every primitive fills the box it was given and builds a mesh", () => {
  for (const shape of ["plane", "cylinder", "cone", "dome", "bevel"] as const) {
    const grid = patchOfShape(shape, [-1, 0, -1], [1, 2, 1]);
    assert.deepEqual(gridProblems(grid), [], shape);
    const { mesh } = buildPatch({ grid });
    assert.ok(mesh && mesh.positions.length > 0, shape);
    const { min, max } = patchBounds(grid);
    for (let i = 0; i < 3; i++) assert.ok(max[i]! >= min[i]!, `${shape} axis ${i}`);
  }
});

test("a cylinder is a closed ring of the box's radius, and its seam meets", () => {
  const grid = cylinderPatch([-1, 0, -1], [1, 3, 1]);
  assert.equal(grid.length, 3);
  assert.equal(grid[0]!.length, 9);
  nearVec(grid[0]![0]!, grid[0]![8]!, 1e-9, "the seam");
  for (let c = 0; c < 9; c += 2) near(Math.hypot(grid[0]![c]![0]!, grid[0]![c]![2]!), 1, 1e-9, `column ${c}`);
  near(grid[0]![0]![1]!, 0, 1e-9, "the bottom ring");
  near(grid[2]![0]![1]!, 3, 1e-9, "the top ring");
});

test("a cone closes to one point and a dome closes to one point", () => {
  const cone = conePatch([-1, 0, -1], [1, 2, 1]);
  for (const p of cone[2]!) nearVec(p, [0, 2, 0], 1e-9, "the tip");
  const dome = domePatch([-2, 0, -2], [2, 2, 2]);
  for (const p of dome[2]!) nearVec(p, [0, 2, 0], 1e-9, "the pole");
  near(Math.hypot(dome[0]![0]![0]!, dome[0]![0]![2]!), 2, 1e-9, "the equator");
});

test("a bevel turns the corner of its box", () => {
  const grid = bevelPatch([0, 0, 0], [2, 1, 2]);
  nearVec(grid[0]![0]!, [2, 0, 0], 1e-9, "one end");
  nearVec(grid[0]![2]!, [0, 0, 2], 1e-9, "the other");
  // the surface bows out towards the corner it is cutting, not in towards the middle of the box
  const m = pointOn(grid, 0.5, 0);
  assert.ok(Math.hypot(m[0]!, m[2]!) > Math.SQRT2, `${m} should be outside the straight chord`);
});

test("the bounds are the control points, which is a box the surface is inside", () => {
  const { min, max } = patchBounds(bent());
  assert.deepEqual(min, [0, 0, 0]);
  assert.deepEqual(max, [2, 1, 2]);
  const { mesh } = buildPatch({ grid: bent(), subdivisions: 8 });
  for (let i = 0; i < mesh!.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      assert.ok(mesh!.positions[i + k]! >= min[k]! - 1e-6 && mesh!.positions[i + k]! <= max[k]! + 1e-6);
    }
  }
});

// ---------------------------------------------------------------- in a sheet

test("a sheet's patch becomes one Mesh with the material it named", async () => {
  const scene = await loadScene(
    `--wall: meshStandardMaterial { color: color(#8899aa); }\n` +
      `patch {\n` +
      `  material: var(--wall);\n` +
      `  subdivisions: 2;\n` +
      `  row(vec3(0, 0, 0), vec3(1, 0, 0), vec3(2, 0, 0));\n` +
      `  row(vec3(0, 0, 1), vec3(1, 1, 1), vec3(2, 0, 1));\n` +
      `  row(vec3(0, 0, 2), vec3(1, 0, 2), vec3(2, 0, 2));\n` +
      `}\n`,
    { registry: threeRegistry },
  );
  const mesh = scene.children[0] as any;
  assert.equal(mesh.type, "Mesh");
  assert.equal(mesh.material.type, "MeshStandardMaterial");
  assert.equal(mesh.geometry.getIndex().count, 2 * 2 * 6);
  assert.equal(mesh.geometry.getAttribute("position").count, 9);
  assert.ok(mesh.geometry.getAttribute("normal"), "smooth shading needs normals");
  assert.ok(mesh.geometry.getAttribute("uv"), "and a material needs uvs");
});

test("a patch with an even row is rejected at load, naming what is wrong with it", async () => {
  const four = (z: number) => `  row(vec3(0,0,${z}), vec3(1,0,${z}), vec3(2,0,${z}), vec3(3,0,${z}));`;
  await assert.rejects(
    () => loadScene(`patch {\n${[0, 1, 2].map(four).join("\n")}\n}\n`, { registry: threeRegistry }),
    /odd number of control points/,
  );
  await assert.rejects(
    () => loadScene(`patch {\n  row(vec3(0,0,0), vec3(1,0,0));\n}\n`, { registry: threeRegistry }),
    /at least three control points/,
  );
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
