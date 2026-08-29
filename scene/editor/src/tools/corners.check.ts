/**
 * The vertex, edge and face tools, and the shared drag underneath them.
 *
 * Two rules carry the whole file. A handle is found by *where it is* rather than by its index, because
 * `brushHandles` deduplicates corners and the kernel renumbers vertices on every edit — so the checks below
 * grab handles by position and then assert the right corners moved. And a grabbed handle that is part of the
 * current selection drags the whole selection, which is the rule that lets a designer pick four corners of a
 * roof and then take hold of any one of them.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/corners.check.ts
 */
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { brushOf, brushVolume, faceCentre, faceNormal, type Brush } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { brushNode, layerNode, nodeById, type BrushNode, type NodeId, type World } from "../doc/document.ts";
import { newEditor, type Editor } from "../doc/editor.ts";
import { history, run, separate, type History } from "../doc/history.ts";
import { NOTHING, selectEdges, selectFaces, selectVertices } from "../doc/selection.ts";
import type { Handle } from "../render/handles.ts";
import { metresPerPixel, newView, type Size } from "../viewport/view.ts";
import { edgeTool, faceTool, vertexTool } from "./corners.ts";
import {
  cornersOf, cornersToDrag, dragCorners, edgeAt, handleDelta, selectedCorners, vertexAt,
} from "./handleDrag.ts";
import { newInput, type InputState } from "./input.ts";
import { ToolBox, type Outcome } from "./tool.ts";

const SIZE: Size = { width: 800, height: 400 };
/** 20 metres of reach over 400 pixels: one metre is exactly twenty pixels, so the sums below are exact */
const FRONT = { ...newView("front"), target: [1, 1, 1] as Vec3, reach: 20 };
const PIXELS = 1 / metresPerPixel(FRONT, SIZE);

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);

const at = (x: number, y: number, over: Partial<InputState> = {}): InputState =>
  newInput({ camera: FRONT, size: SIZE, at: { x, y }, button: 0, ...over });

/** two cubes side by side, nothing selected; the grid is a quarter of a metre */
function scene() {
  const one = brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [2, 2, 2] })));
  const two = brushNode(brushOf(cuboid({ min: [4, 0, 0], max: [6, 2, 2] })));
  const world: World = { layers: [layerNode("Main", [one, two])], broom: { grid: -2, scale: 1 } };
  const base = newEditor(world);
  return { one, two, world, editor: { ...base, layer: world.layers[0]!.id } satisfies Editor };
}

const brushIn = (world: World, id: NodeId): Brush => (nodeById(world, id) as BrushNode).brush;

/** the face of a solid pointing a given way — asked for by direction, because face order is the kernel's business */
function faceTowards(brush: Brush, n: Vec3): number {
  const found = brush.poly.faces.findIndex((_, i) => {
    const m = faceNormal(brush, i);
    return Math.abs(m[0] - n[0]) < 1e-6 && Math.abs(m[1] - n[1]) < 1e-6 && Math.abs(m[2] - n[2]) < 1e-6;
  });
  assert.ok(found >= 0, `no face pointing ${n.join(", ")}`);
  return found;
}

const handle = (kind: Handle["kind"], of: NodeId, at: Vec3, part = 0): Handle =>
  ({ kind, of, at: [at[0], at[1], at[2]], part, flags: 0 });

function apply(h: History, out: Outcome | undefined): History {
  if (!out) return h;
  let next = h;
  if (out.set) next = { ...next, editor: out.set(next.editor) };
  if (out.edit) next = run(next, out.edit);
  if (out.separate) next = separate(next);
  return next;
}

// ---------------------------------------------------------------- handles back to corners

test("a corner is found by where it is, whatever number the kernel gave it", () => {
  const { one } = scene();
  const found = vertexAt(one.brush, [2, 2, 2]);
  assert.notEqual(found, undefined);
  assert.deepEqual(one.brush.poly.vertices[found!], [2, 2, 2]);
  assert.equal(vertexAt(one.brush, [1, 1, 1]), undefined, "the middle of a cube is not a corner of it");
});

test("an edge is found by its midpoint, and both ends really are its ends", () => {
  const { one } = scene();
  const ends = edgeAt(one.brush, [0, 0, 1])!;
  assert.notEqual(ends, undefined);
  const [p, q] = [one.brush.poly.vertices[ends[0]]!, one.brush.poly.vertices[ends[1]]!];
  near((p[0] + q[0]) / 2, 0);
  near((p[1] + q[1]) / 2, 0);
  near((p[2] + q[2]) / 2, 1);
  assert.equal(edgeAt(one.brush, [0.3, 0, 1]), undefined);
});

test("a handle stands for one corner, two, or a whole loop", () => {
  const { one } = scene();
  const top = faceTowards(one.brush, [0, 1, 0]);
  assert.equal(cornersOf(one.brush, handle("vertex", one.id, [0, 0, 0]))!.length, 1);
  assert.equal(cornersOf(one.brush, handle("edge", one.id, [0, 0, 1]))!.length, 2);
  assert.equal(cornersOf(one.brush, handle("face", one.id, faceCentre(one.brush, top), top))!.length, 4);
  assert.equal(cornersOf(one.brush, handle("pivot", one.id, [0, 0, 0], -1)), undefined);
  assert.equal(cornersOf(one.brush, handle("vertex", one.id, [9, 9, 9])), undefined, "a stale handle names nothing");
});

// ---------------------------------------------------------------- what a drag takes with it

test("the corners of a selection are gathered per solid, and named once each", () => {
  const { one, two, editor } = scene();
  const picked: Editor = {
    ...editor,
    selection: selectVertices(
      selectVertices(NOTHING, [{ node: one.id, vertex: 0 }, { node: one.id, vertex: 1 }], "replace"),
      [{ node: two.id, vertex: 3 }],
      "add",
    ),
  };
  const gathered = selectedCorners(picked, "vertex");
  assert.deepEqual(gathered.get(one.id), [0, 1]);
  assert.deepEqual(gathered.get(two.id), [3]);

  const ends = edgeAt(one.brush, [0, 0, 1])!;
  const edged: Editor = { ...editor, selection: selectEdges(NOTHING, [{ node: one.id, a: ends[0], b: ends[1] }], "replace") };
  assert.deepEqual(selectedCorners(edged, "edge").get(one.id), [ends[0], ends[1]]);

  const top = faceTowards(one.brush, [0, 1, 0]);
  const faced: Editor = { ...editor, selection: selectFaces(editor.world, NOTHING, [{ node: one.id, face: top }], "replace") };
  assert.equal(selectedCorners(faced, "face").get(one.id)!.length, 4);
});

test("grabbing a handle that is in the selection drags the whole selection", () => {
  const { one, two, editor } = scene();
  const picked: Editor = {
    ...editor,
    selection: selectVertices(NOTHING, [{ node: one.id, vertex: 0 }, { node: two.id, vertex: 0 }], "replace"),
  };
  const grabbed = handle("vertex", one.id, one.brush.poly.vertices[0]!);
  const taken = cornersToDrag(picked, grabbed, [0]);
  assert.equal(taken.size, 2, "four corners picked and one of them grabbed means all four");
  assert.deepEqual(taken.get(two.id), [0]);
});

test("grabbing one that is not in the selection means they have changed their mind", () => {
  const { one, two, editor } = scene();
  const picked: Editor = { ...editor, selection: selectVertices(NOTHING, [{ node: two.id, vertex: 0 }], "replace") };
  const taken = cornersToDrag(picked, handle("vertex", one.id, one.brush.poly.vertices[1]!), [1]);
  assert.deepEqual([...taken.keys()], [one.id]);
  assert.deepEqual(taken.get(one.id), [1]);
});

// ---------------------------------------------------------------- the kernel call

test("a face's corners carried along tilt the walls around it", () => {
  const { one, world } = scene();
  const east = faceTowards(one.brush, [1, 0, 0]);
  const loop = one.brush.poly.faces[east]!.loop;
  const moved = dragCorners(world, new Map([[one.id, [...loop]]]), [1, 0, 0])!;
  const after = brushIn(moved, one.id);
  near(brushVolume(after), 12, 1e-9);
  assert.notEqual(vertexAt(after, [3, 0, 0]), undefined);
});

test("a corner dragged out stays a corner, and the one it left is gone", () => {
  const { one, world } = scene();
  const moved = dragCorners(world, new Map([[one.id, [vertexAt(one.brush, [0, 0, 0])!]]]), [-1, 0, 0])!;
  const after = brushIn(moved, one.id);
  assert.notEqual(vertexAt(after, [-1, 0, 0]), undefined);
  assert.equal(vertexAt(after, [0, 0, 0]), undefined);
  assert.ok(brushVolume(after) > 8, "pulling a corner outward makes the solid bigger, not smaller");
});

test("a drag that would flatten any solid moves none of them", () => {
  const { one, two, world } = scene();
  const east = faceTowards(two.brush, [1, 0, 0]);
  const flat = new Map([
    [one.id, [vertexAt(one.brush, [0, 0, 0])!]],
    [two.id, [...two.brush.poly.faces[east]!.loop]],
  ]);
  // the second solid's east wall pushed onto its west one: no volume left, so nothing happens anywhere
  assert.equal(dragCorners(world, flat, [-2, 0, 0]), undefined);
});

// ---------------------------------------------------------------- the snapping

test("the handle itself lands on the grid, not the box it belongs to", () => {
  const start = at(400, 200);
  const off: Vec3 = [0.1, 0, 0];
  const by = handleDelta(start, at(400 + 3 * PIXELS, 200), off, 0.25)!;
  near(by[0]!, 2.9, 1e-9);
  near(by[1]!, 0, 1e-9);
});

test("shift keeps a drag on one axis, and it is the axis it has gone furthest along", () => {
  const start = at(400, 200);
  const to = { x: 400 + PIXELS, y: 200 - 0.25 * PIXELS };
  const free = handleDelta(start, at(to.x, to.y), [2, 1, 1], 0.25)!;
  near(free[0]!, 1);
  near(free[1]!, 0.25);
  const held = handleDelta(start, at(to.x, to.y, { mods: { shift: true, ctrl: false, alt: false } }), [2, 1, 1], 0.25)!;
  near(held[0]!, 1);
  near(held[1]!, 0);
});

// ---------------------------------------------------------------- the gestures

const drag = (tools: ToolBox, h: History, from: InputState, dx: number): History => {
  let next = apply(h, tools.down(from, h.editor));
  next = apply(next, tools.move(at(from.at.x + 5, from.at.y, { hit: from.hit }), next.editor));
  next = apply(next, tools.move(at(from.at.x + dx, from.at.y, { hit: from.hit }), next.editor));
  return apply(next, tools.up(at(from.at.x + dx, from.at.y, { hit: from.hit }), next.editor));
};

test("dragging a face handle is one undo entry, and it moved the wall", () => {
  const { one, editor } = scene();
  const east = faceTowards(one.brush, [1, 0, 0]);
  const grabbed = handle("face", one.id, faceCentre(one.brush, east), east);
  const tools = new ToolBox([faceTool], "face");
  const h = drag(tools, history(editor), at(400, 200, { hit: { node: one.id, handle: grabbed } }), 2 * PIXELS);

  assert.equal(h.past.length, 1, "a drag is one entry however many frames it took");
  near(brushVolume(brushIn(h.editor.world, one.id)), 16, 1e-9);
});

test("dragging a corner handle takes that corner and leaves the rest", () => {
  const { one, editor } = scene();
  const grabbed = handle("vertex", one.id, [0, 0, 0]);
  const tools = new ToolBox([vertexTool], "vertex");
  const h = drag(tools, history(editor), at(400, 200, { hit: { node: one.id, handle: grabbed } }), -PIXELS);

  const after = brushIn(h.editor.world, one.id);
  assert.notEqual(vertexAt(after, [-1, 0, 0]), undefined);
  assert.notEqual(vertexAt(after, [2, 2, 2]), undefined, "the far corners stayed where they were");
});

test("dragging an edge handle takes both its ends", () => {
  const { one, editor } = scene();
  const ends = edgeAt(one.brush, [0, 0, 1])!;
  const tools = new ToolBox([edgeTool], "edge");
  const h = drag(tools, history(editor), at(400, 200, { hit: { node: one.id, handle: handle("edge", one.id, [0, 0, 1]) } }), -PIXELS);

  const after = brushIn(h.editor.world, one.id);
  for (const z of [0, 2]) assert.notEqual(vertexAt(after, [-1, 0, z]), undefined, "both ends came along");
  assert.equal(ends.length, 2);
});

test("a drag cancelled puts the solid back exactly", () => {
  const { one, editor } = scene();
  const grabbed = handle("vertex", one.id, [0, 0, 0]);
  const tools = new ToolBox([vertexTool], "vertex");
  let h = apply(history(editor), tools.down(at(400, 200, { hit: { node: one.id, handle: grabbed } }), editor));
  h = apply(h, tools.move(at(420, 200, { hit: { node: one.id, handle: grabbed } }), h.editor));
  h = apply(h, tools.cancel(h.editor));
  near(brushVolume(brushIn(h.editor.world, one.id)), 8, 1e-9);
});

test("a tool declines a handle of the wrong kind rather than dragging something else", () => {
  const { one, editor } = scene();
  const grabbed = handle("vertex", one.id, [0, 0, 0]);
  assert.equal(edgeTool.drag!(at(400, 200, { hit: { node: one.id, handle: grabbed } }), editor), undefined);
  assert.equal(faceTool.drag!(at(400, 200, { hit: { node: one.id, handle: grabbed } }), editor), undefined);
  assert.notEqual(vertexTool.drag!(at(400, 200, { hit: { node: one.id, handle: grabbed } }), editor), undefined);
});

// ---------------------------------------------------------------- picking

test("clicking a handle picks what it stands for, and shift adds to what is picked", () => {
  const { one, editor } = scene();
  const first = vertexTool.click!(at(400, 200, { hit: { handle: handle("vertex", one.id, [0, 0, 0]) } }), editor)!;
  const picked = first.set!(editor);
  assert.equal(picked.selection.vertices.length, 1);

  const shift = { shift: true, ctrl: false, alt: false };
  const second = vertexTool.click!(at(400, 200, { mods: shift, hit: { handle: handle("vertex", one.id, [2, 2, 2]) } }), picked)!;
  assert.equal(second.set!(picked).selection.vertices.length, 2);
});

test("the face tool takes a click on the wall itself, not only on the little square", () => {
  const { one, editor } = scene();
  const east = faceTowards(one.brush, [1, 0, 0]);
  const out = faceTool.click!(at(400, 200, { hit: { node: one.id, face: east } }), editor)!;
  const picked = out.set!(editor);
  assert.deepEqual(picked.selection.faces, [{ node: one.id, face: east }]);
});

test("clicking nothing at all is nothing, not a crash", () => {
  const { editor } = scene();
  assert.equal(vertexTool.click!(at(400, 200), editor), undefined);
  assert.equal(edgeTool.click!(at(400, 200), editor), undefined);
  assert.equal(faceTool.click!(at(400, 200), editor), undefined);
});

report("corners");
