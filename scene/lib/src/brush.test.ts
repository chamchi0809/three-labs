// node --experimental-strip-types src/brush.test.ts
import assert from "node:assert/strict";
import { boxFaces, brushBounds, buildBrush, planeFromPoints, uvAt, uvBasis, type BrushFace, type Vec3 } from "./brush.ts";
import { loadScene } from "./runtime.ts";
import { threeRegistry } from "./three.ts";

const tests: [string, () => unknown][] = [];
const test = (name: string, fn: () => unknown) => tests.push([name, fn]);

const box = (min: Vec3, max: Vec3): BrushFace[] => boxFaces(min, max).map((points) => ({ points }));
const unit = () => box([-1, -1, -1], [1, 1, 1]);

/** every distinct vertex of the built mesh, rounded past the clipper's noise */
function vertices(positions: Float32Array): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < positions.length; i += 3) {
    out.add([0, 1, 2].map((k) => (Math.round(positions[i + k]! * 1e4) / 1e4).toFixed(4)).join(" "));
  }
  return out;
}

test("three points wound counter-clockwise from outside give an outward normal", () => {
  const top = boxFaces([-1, -1, -1], [1, 1, 1])[0]!;
  const plane = planeFromPoints(top)!;
  assert.deepEqual(plane.n.map(Math.round), [0, 1, 0]);
  assert.equal(plane.d, 1);
});

test("collinear points define no plane", () => {
  assert.equal(planeFromPoints([[0, 0, 0], [1, 0, 0], [2, 0, 0]]), undefined);
});

test("a box brush is six quads, eight vertices and twelve triangles", () => {
  const { mesh, problems } = buildBrush(unit());
  assert.deepEqual(problems, []);
  assert.ok(mesh);
  assert.equal(mesh.groups.length, 6);
  assert.equal(mesh.positions.length / 3, 36); // 6 faces x 2 triangles x 3
  assert.equal(vertices(mesh.positions).size, 8);
  // every face keeps its own slot, in the order the sheet wrote them
  assert.deepEqual(mesh.groups.map((g) => g.face), [0, 1, 2, 3, 4, 5]);
});

test("the normal of every triangle points away from the centre", () => {
  const { mesh } = buildBrush(unit());
  for (let i = 0; i < mesh!.positions.length; i += 3) {
    const p = [0, 1, 2].map((k) => mesh!.positions[i + k]!);
    const n = [0, 1, 2].map((k) => mesh!.normals[i + k]!);
    assert.ok(p[0]! * n[0]! + p[1]! * n[1]! + p[2]! * n[2]! > 0, "a normal points into the solid");
  }
});

test("a seventh plane that cuts a corner off is a face like any other", () => {
  const faces = box([0, 0, 0], [2, 2, 2]);
  // x + y <= 3, which clips the edge where x and y are both 2
  faces.push({ points: [[3, 0, 0], [1, 2, 2], [3, 0, 2]] });
  const { mesh, problems } = buildBrush(faces);
  assert.deepEqual(problems, []);
  assert.ok(mesh);
  assert.equal(mesh.groups.length, 7);
});

test("a face the others already close is reported, and the rest still builds", () => {
  const faces = unit();
  // x <= 10: outside the box, so the six box planes clip it away entirely
  faces.push({ points: [[10, 0, 0], [10, 1, 0], [10, 1, 1]] });
  const { mesh, problems } = buildBrush(faces);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.face, 6);
  assert.match(problems[0]!.message, /bounds nothing/);
  assert.equal(mesh!.groups.length, 6);
});

test("fewer than four faces is not a solid", () => {
  const faces = unit().slice(0, 3);
  const { mesh, problems } = buildBrush(faces);
  assert.equal(mesh, undefined);
  assert.match(problems[0]!.message, /at least 4 faces/);
});

test("half-spaces that bound an infinite volume are rejected", () => {
  // the four side walls of a box, with no top and no bottom
  const faces = unit().filter((_, i) => i > 1);
  const { mesh, problems } = buildBrush(faces);
  assert.equal(mesh, undefined);
  assert.ok(problems.some((p) => /do not close a solid/.test(p.message)));
});

test("two faces on the same plane are reported once, naming the earlier one", () => {
  const faces = unit();
  faces.push({ points: boxFaces([-1, -1, -1], [1, 1, 1])[0]! });
  const { problems } = buildBrush(faces);
  assert.equal(problems.filter((p) => /same plane/.test(p.message)).length, 1);
  assert.equal(problems.find((p) => /same plane/.test(p.message))!.face, 6);
});

test("paraxial uv puts a floor in the world's xz plane and a wall the right way up", () => {
  const floor = uvBasis({ points: [[0, 0, 0], [0, 0, 1], [1, 0, 0]] }, [0, 1, 0]);
  assert.deepEqual(floor.u, [1, 0, 0]);
  assert.deepEqual(floor.v, [0, 0, -1]);
  const wall = uvBasis({ points: [[0, 0, 0], [0, 0, 1], [1, 0, 0]] }, [0, 0, 1]);
  assert.deepEqual(wall.u, [1, 0, 0]);
  assert.deepEqual(wall.v, [0, 1, 0]);
});

test("scale is metres of world per tile, so a bigger scale means fewer tiles", () => {
  const face: BrushFace = { points: [[0, 0, 0], [0, 0, 1], [1, 0, 0]], scale: [4, 4] };
  const basis = uvBasis(face, [0, 0, 1]);
  assert.deepEqual(uvAt([8, 0, 0], basis, face), [2, 0]);
  assert.deepEqual(uvAt([0, 2, 0], basis, face), [0, 0.5]);
});

test("offset is metres along the face's own axes", () => {
  const face: BrushFace = { points: [[0, 0, 0], [0, 0, 1], [1, 0, 0]], scale: [2, 2], offset: [1, 0] };
  const basis = uvBasis(face, [0, 0, 1]);
  assert.deepEqual(uvAt([1, 0, 0], basis, face), [1, 0]);
});

test("rotation turns the axes inside their own plane", () => {
  const face: BrushFace = { points: [[0, 0, 0], [0, 0, 1], [1, 0, 0]], rotation: Math.PI / 2 };
  const { u } = uvBasis(face, [0, 0, 1]);
  // +x rotated a quarter turn about +z is +y, and the basis stays in the face's plane
  assert.ok(Math.abs(u[0]!) < 1e-9 && Math.abs(u[1]! - 1) < 1e-9 && Math.abs(u[2]!) < 1e-9, `got ${u.join(", ")}`);
});

test("parallel uv keeps its axes in a face that no world axis is close to", () => {
  const n: Vec3 = [0.577, 0.577, 0.577];
  const { u, v } = uvBasis({ points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], uv: { kind: "parallel" } }, n);
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  assert.ok(Math.abs(dot(u, n)) < 1e-6 && Math.abs(dot(v, n)) < 1e-6, "an axis left the plane");
  assert.ok(Math.abs(dot(u, v)) < 1e-6, "the axes are not perpendicular");
});

test("bounds are the box the face points span", () => {
  assert.deepEqual(brushBounds(box([-1, 0, 2], [3, 4, 5])), { min: [-1, 0, 2], max: [3, 4, 5] });
});

// ---------------------------------------------------------------- the sheet a designer writes

/** the six faces of a box, as a sheet writes them — the same winding boxFaces() returns */
const sheetFaces = (extra = "") =>
  boxFaces([0, 0, 0], [2, 2, 2])
    .map((p) => `  face(${p.map((v) => `[${v.join(", ")}]`).join(", ")}) {${extra}}`)
    .join("\n");

test("a brush sheet builds one Mesh with a material per face", async () => {
  const src = `--stone: meshStandardMaterial { color: color(#808080); };\nbrush #pillar {\n  castShadow: true;\n${sheetFaces(" material: var(--stone);")}\n}\n`;
  const group = await loadScene(src, { registry: threeRegistry });
  const mesh = group.children[0] as any;
  assert.equal(mesh.name, "pillar");
  assert.equal(mesh.type, "Mesh");
  assert.equal(mesh.castShadow, true, "a property beside the faces still lands on the Mesh");
  assert.equal(mesh.geometry.groups.length, 6);
  assert.equal(mesh.geometry.getAttribute("position").count, 36);
  assert.equal(mesh.geometry.getAttribute("uv").itemSize, 2);
  assert.equal(mesh.material.length, 6);
  // one `--stone` declaration is one material, shared by every face that names it
  assert.equal(new Set(mesh.material).size, 1);
  assert.ok(mesh.geometry.boundingSphere, "the geometry knows its own bounds");
});

test("a face with no material of its own falls back to one plain material, not six", async () => {
  const group = await loadScene(`brush {\n${sheetFaces()}\n}\n`, { registry: threeRegistry });
  const mesh = group.children[0] as any;
  assert.equal(mesh.material.length, 6);
  assert.equal(new Set(mesh.material).size, 1);
  assert.equal(mesh.material[0].type, "MeshStandardMaterial");
});

test("a brush the faces do not close fails the build, naming the reason", async () => {
  const open = boxFaces([0, 0, 0], [2, 2, 2]).slice(0, 4).map((p) => `  face(${p.map((v) => `[${v.join(", ")}]`).join(", ")}) {}`).join("\n");
  await assert.rejects(() => loadScene(`brush {\n${open}\n}\n`, { registry: threeRegistry }), /do not close a solid/);
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
