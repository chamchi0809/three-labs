// Handles: that a cuboid offers eight corners rather than twenty-four, and that the buffers a handle is
// drawn from say what the handle said.
// Run with: node --experimental-strip-types src/render/handles.check.ts
import assert from "node:assert/strict";
import { boxFaces, buildBrush, type Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { HOVERED, SELECTED } from "./batch.ts";
import { brushHandles, clearHandles, newHandles, setHandleFlags, setHandles } from "./handles.ts";

const polygonsOf = (min: Vec3, max: Vec3) => {
  const { mesh, problems } = buildBrush(boxFaces(min, max).map((points) => ({ points })));
  assert.deepEqual(problems, []);
  return mesh!.polygons;
};

const CUBE = polygonsOf([0, 0, 0], [2, 2, 2]);

test("a cuboid has eight corner handles, not one per face per corner", () => {
  const handles = brushHandles("a", CUBE);
  assert.equal(handles.length, 8, "a corner belongs to three faces and is still one place to grab");
  const at = new Set(handles.map((h) => h.at.join(",")));
  assert.equal(at.size, 8);
  assert.ok(at.has("0,0,0") && at.has("2,2,2"));
  assert.deepEqual([...new Set(handles.map((h) => h.part))].length, 8, "and each is numbered apart");
});

test("edges are twelve midpoints and faces are six centres", () => {
  const edges = brushHandles("a", CUBE, { edges: true });
  assert.equal(edges.length, 12);
  assert.ok(edges.every((h) => h.kind === "edge"));

  const faces = brushHandles("a", CUBE, { faces: true });
  assert.equal(faces.length, 6);
  assert.ok(faces.every((h) => h.at.filter((v) => v === 1).length === 2), "a cube's face centre is on its middle");
});

test("all three kinds at once come out as one list that knows which is which", () => {
  const all = brushHandles("a", CUBE, { vertices: true, edges: true, faces: true });
  assert.equal(all.length, 8 + 12 + 6);
  assert.equal(all.filter((h) => h.kind === "vertex").length, 8);
  assert.equal(all.filter((h) => h.kind === "edge").length, 12);
  assert.equal(all.filter((h) => h.kind === "face").length, 6);
});

test("the arrays are filled from the handles", () => {
  const set = newHandles();
  setHandles(set, brushHandles("a", CUBE));
  assert.equal(set.count, 8);
  assert.deepEqual([...set.position.slice(0, 3)], set.handles[0]!.at);
  assert.deepEqual([...set.kind.slice(0, 8)], Array(8).fill(0), "all vertices");
});

test("a set replaced by a smaller one keeps the buffer but not the old handles", () => {
  const set = newHandles();
  setHandles(set, brushHandles("a", CUBE, { vertices: true, edges: true, faces: true }));
  const buffer = set.position;
  setHandles(set, brushHandles("b", CUBE));
  assert.equal(set.count, 8);
  assert.equal(set.position, buffer, "twenty-six's room fits eight");
  assert.equal(set.handles.length, 8, "and the leftovers are not reachable");
  assert.ok(set.handles.every((h) => h.of === "b"));
});

test("hovering one handle writes one float and leaves the rest alone", () => {
  const set = newHandles();
  setHandles(set, brushHandles("a", CUBE, { vertices: true }));
  setHandles(set, set.handles.map((h) => ({ ...h, flags: SELECTED })));

  assert.equal(setHandleFlags(set, 3, HOVERED), true);
  assert.equal(set.flag[3], HOVERED);
  assert.equal(set.flag[2], SELECTED, "its neighbour is untouched");
  assert.equal(setHandleFlags(set, 3, HOVERED), false, "and saying it twice is free");
  assert.equal(setHandleFlags(set, 99, HOVERED), false, "as is a handle that is not there");
});

test("clearing leaves nothing pickable", () => {
  const set = newHandles();
  setHandles(set, brushHandles("a", CUBE));
  clearHandles(set);
  assert.equal(set.count, 0);
  assert.deepEqual(set.handles, []);
});

test("a face that bounded nothing offers no handles of its own", () => {
  const holed = [...CUBE];
  holed[0] = undefined;
  assert.equal(brushHandles("a", holed, { faces: true }).length, 5);
  assert.equal(brushHandles("a", holed).length, 8, "its corners are its neighbours' too");
});

report("handles");
