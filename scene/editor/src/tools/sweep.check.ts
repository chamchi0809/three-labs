/**
 * The sweep tool: a face pulled off a solid, leaving new solids behind it.
 *
 * The thing that makes this tool and not extrude is that the source is left exactly as it was — so the
 * checks below always assert the source's volume as well as what came out of it. The other half is the
 * segment count: eight is a staircase, and a staircase whose steps are not all the same height is not one.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/sweep.check.ts
 */
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { brushBounds, brushOf, brushVolume, faceNormal, type Brush } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { withFace } from "../brush/uv.ts";
import { brushNode, layerNode, nodeById, type BrushNode, type NodeId, type World } from "../doc/document.ts";
import { newEditor, type Editor } from "../doc/editor.ts";
import { history, run, separate, type History } from "../doc/history.ts";
import { metresPerPixel, newView, type Size } from "../viewport/view.ts";
import { newInput, type InputState } from "./input.ts";
import {
  MAX_SEGMENTS, setSegments, sweepSlab, sweepState, sweepTool, sweepWorld,
} from "./sweep.ts";
import { ToolBox, type Outcome } from "./tool.ts";

const SIZE: Size = { width: 800, height: 400 };
const FRONT = { ...newView("front"), target: [1, 1, 1] as Vec3, reach: 20 };
const PIXELS = 1 / metresPerPixel(FRONT, SIZE);

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);

/** the face of a solid pointing a given way — face order is the kernel's business, not the check's */
function faceTowards(brush: Brush, n: Vec3): number {
  const found = brush.poly.faces.findIndex((_, i) => {
    const m = faceNormal(brush, i);
    return Math.abs(m[0] - n[0]) < 1e-6 && Math.abs(m[1] - n[1]) < 1e-6 && Math.abs(m[2] - n[2]) < 1e-6;
  });
  assert.ok(found >= 0, `no face pointing ${n.join(", ")}`);
  return found;
}

/** one cube, its east wall brick and the rest of it stone, so a material can be followed across the sweep */
function scene() {
  const plain = brushOf(cuboid({ min: [0, 0, 0], max: [2, 2, 2] }));
  const east = faceTowards(plain, [1, 0, 0]);
  let painted = plain;
  for (let i = 0; i < painted.poly.faces.length; i++) {
    painted = withFace(painted, i, { material: i === east ? "brick" : "stone" });
  }
  const solid = brushNode(painted);
  const world: World = { layers: [layerNode("Main", [solid])], broom: { grid: -2, scale: 1 } };
  const base = newEditor(world);
  const editor: Editor = { ...base, layer: world.layers[0]!.id };
  return { solid, east, world, editor };
}

const at = (x: number, y: number, over: Partial<InputState> = {}): InputState =>
  newInput({ camera: FRONT, size: SIZE, at: { x, y }, button: 0, ...over });

const brushIn = (world: World, id: NodeId): Brush => (nodeById(world, id) as BrushNode).brush;
const madeIn = (world: World, made: NodeId[]): Brush[] => made.map((id) => brushIn(world, id));

function apply(h: History, out: Outcome | undefined): History {
  if (!out) return h;
  let next = h;
  if (out.set) next = { ...next, editor: out.set(next.editor) };
  if (out.edit) next = run(next, out.edit);
  if (out.separate) next = separate(next);
  return next;
}

// ---------------------------------------------------------------- one slab

test("a face swept forward leaves the volume it passed through, and keeps its outline", () => {
  const { solid, east } = scene();
  const slab = sweepSlab(solid.brush, east, 0, 1)!;
  assert.ok(slab);
  near(brushVolume(slab), 4);
  const box = brushBounds(slab)!;
  near(box.min[0]!, 2);
  near(box.max[0]!, 3);
  near(box.min[1]!, 0);
  near(box.max[1]!, 2);
});

test("a sweep can go backwards, which is how a recess gets something to subtract", () => {
  const { solid, east } = scene();
  const slab = sweepSlab(solid.brush, east, 0, -1)!;
  const box = brushBounds(slab)!;
  near(box.min[0]!, 1);
  near(box.max[0]!, 2);
  near(brushVolume(slab), 4);
});

test("a sweep of no distance is nothing at all, not a solid of no volume", () => {
  const { solid, east } = scene();
  assert.equal(sweepSlab(solid.brush, east, 1, 1), undefined);
  assert.equal(sweepSlab(solid.brush, 99, 0, 1), undefined, "a face that is not there sweeps nothing");
});

test("the swept solid comes off already matching the wall it came from", () => {
  const { solid, east } = scene();
  const slab = sweepSlab(solid.brush, east, 0, 1)!;
  const cap = faceTowards(slab, [1, 0, 0]);
  assert.equal(slab.faces[cap]!.material, "brick", "the far cap is the face that was swept");
  assert.equal(slab.faces[faceTowards(slab, [0, 1, 0])]!.material, "stone", "the sides are the walls it slid along");
});

// ---------------------------------------------------------------- a whole sweep

test("the source solid is left exactly where it was, which is the whole difference from extrude", () => {
  const { solid, east, world } = scene();
  const swept = sweepWorld(world, [{ node: solid.id, face: east }], 2, 1)!;
  near(brushVolume(brushIn(swept.world, solid.id)), 8);
  assert.equal(swept.made.length, 1);
  near(brushVolume(brushIn(swept.world, swept.made[0]!)), 8);
  assert.equal(swept.world.layers[0]!.children.length, 2);
});

test("eight segments is eight solids, each the same size, laid end to end", () => {
  const { solid, east, world } = scene();
  const swept = sweepWorld(world, [{ node: solid.id, face: east }], 2, 8)!;
  assert.equal(swept.made.length, 8);
  const slabs = madeIn(swept.world, swept.made);
  for (const [i, slab] of slabs.entries()) {
    near(brushVolume(slab), 1, 1e-9);
    near(brushBounds(slab)!.min[0]!, 2 + i * 0.25, 1e-9);
    near(brushBounds(slab)!.max[0]!, 2 + (i + 1) * 0.25, 1e-9);
  }
});

test("a sweep that cannot be built builds none of it", () => {
  const { solid, east, world } = scene();
  const half = sweepWorld(world, [{ node: solid.id, face: east }, { node: solid.id, face: 99 }], 1, 1);
  assert.equal(half, undefined, "half a staircase is worse than none, because it has to be found first");
  assert.equal(sweepWorld(world, [{ node: solid.id, face: east }], 0, 1), undefined);
  assert.equal(sweepWorld(world, [{ node: solid.id, face: east }], 1, 0), undefined);
  assert.equal(sweepWorld(world, [{ node: "nope" as NodeId, face: 0 }], 1, 1), undefined);
});

// ---------------------------------------------------------------- the count

test("the count is clamped to something a designer can actually use", () => {
  const was = sweepState.segments;
  assert.equal(setSegments(0), 1, "zero segments is no gesture at all");
  assert.equal(setSegments(-5), 1);
  assert.equal(setSegments(1000), MAX_SEGMENTS);
  assert.equal(setSegments(8.4), 8);
  setSegments(was);
});

test("comma and full stop step it, and say what it is now", () => {
  setSegments(1);
  assert.match(sweepTool.press!(".", undefined, scene().editor)!.note!, /2 segments/);
  assert.equal(sweepState.segments, 2);
  sweepTool.press!(",", undefined, scene().editor);
  assert.equal(sweepState.segments, 1);
  sweepTool.press!(",", undefined, scene().editor);
  assert.equal(sweepState.segments, 1, "it stops at one rather than going to nothing");
  assert.equal(sweepTool.press!("q", undefined, scene().editor), undefined, "keys it does not want are left alone");
});

// ---------------------------------------------------------------- the gesture

test("dragging a face is one entry, and what it leaves behind is what gets selected", () => {
  setSegments(1);
  const { solid, east, editor } = scene();
  const hit = { node: solid.id, face: east };
  const tools = new ToolBox([sweepTool], "sweep");

  let h = history(editor);
  h = apply(h, tools.down(at(400, 200, { hit }), h.editor));
  h = apply(h, tools.move(at(405, 200, { hit }), h.editor));
  h = apply(h, tools.move(at(400 + PIXELS, 200, { hit }), h.editor));
  h = apply(h, tools.up(at(400 + PIXELS, 200, { hit }), h.editor));

  assert.equal(h.past.length, 1);
  const layer = h.editor.world.layers[0]!.children as BrushNode[];
  assert.equal(layer.length, 2);
  near(brushVolume(brushIn(h.editor.world, solid.id)), 8);

  const made = layer.find((n) => n.id !== solid.id)!;
  near(brushBounds(made.brush)!.max[0]!, 3);
  assert.deepEqual(h.editor.selection.nodes, [made.id], "the new solids are what the designer will move next");
  assert.deepEqual(h.editor.selection.faces, [], "the face it named belonged to the solid it came off");
});

test("the count answers while the button is still down", () => {
  setSegments(1);
  const { solid, east, editor } = scene();
  const hit = { node: solid.id, face: east };
  const tracker = sweepTool.drag!(at(400, 200, { hit }), editor)!;

  const one = tracker.move(at(400 + PIXELS, 200, { hit }), editor)!;
  assert.equal(one.edit!.name, "sweep face");
  setSegments(4);
  const four = tracker.move(at(400 + PIXELS, 200, { hit }), editor)!;
  assert.equal(four.edit!.name, "sweep 4 segments");
  assert.equal((four.edit!.apply(editor).world.layers[0]!.children as BrushNode[]).length, 5);
  setSegments(1);
});

test("a sweep of nothing is refused, and a cancelled one puts the world back", () => {
  setSegments(1);
  const { solid, east, editor } = scene();
  assert.equal(sweepTool.drag!(at(400, 200), editor), undefined, "no face under the pointer, no sweep");

  const hit = { node: solid.id, face: east };
  const tracker = sweepTool.drag!(at(400, 200, { hit }), editor)!;
  const out = tracker.move(at(400 + PIXELS, 200, { hit }), editor)!;
  const after = out.edit!.apply(editor);
  assert.equal(after.world.layers[0]!.children.length, 2);
  const undone = tracker.cancel(after)!.edit!.apply(after);
  assert.equal(undone.world.layers[0]!.children.length, 1);
});

test("clicking picks the face rather than sweeping it", () => {
  const { solid, east, editor } = scene();
  const out = sweepTool.click!(at(400, 200, { hit: { node: solid.id, face: east } }), editor)!;
  assert.equal(out.edit, undefined);
  assert.deepEqual(out.set!(editor).selection.faces, [{ node: solid.id, face: east }]);
});

report("sweep");
