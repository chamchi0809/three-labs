/**
 * Rotate, scale and shear.
 *
 * The three properties worth pinning down are the ones that decide whether a level stays buildable. The
 * axes have to be *world* axes, so a turn in a pane leaves faces on axis and corners on the grid. What snaps
 * has to be where the geometry lands — the moving edge, the sliding corner — rather than the factor, because
 * a tidy 1.25 that leaves a wall a third of a cell off the floor is worse than an untidy number that does
 * not. And a rotation has to accumulate, or a drag round the pivot folds back on itself halfway.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/gizmo.check.ts
 */
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { brushBounds, brushOf, type Brush } from "../brush/brush.ts";
import { cuboid, type Bounds } from "../brush/builder.ts";
import { brushNode, layerNode, nodeById, type BrushNode, type NodeId, type World } from "../doc/document.ts";
import { newEditor, type Editor } from "../doc/editor.ts";
import { NOTHING, selectNodes } from "../doc/selection.ts";
import { metresPerPixel, newView, projectPoint, type Point, type Size } from "../viewport/view.ts";
import { gizmoOf, paneAxes, rotateTool, scaleTool, shearTool } from "./gizmo.ts";
import { newInput, type InputState } from "./input.ts";
import type { Outcome, Tool } from "./tool.ts";

const SIZE: Size = { width: 800, height: 400 };
const TOP = { ...newView("top"), target: [2, 1, 1] as Vec3, reach: 20 };
const FRONT = { ...newView("front"), target: [1, 1, 1] as Vec3, reach: 20 };
/** twenty pixels to the metre in both panes, so every drag below is an exact distance */
const PIXELS = 1 / metresPerPixel(FRONT, SIZE);

const near = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);

const ALT = { shift: false, ctrl: false, alt: true };
const SHIFT = { shift: true, ctrl: false, alt: false };

/** one box, selected, on a quarter-metre grid */
function scene(max: Vec3, camera = FRONT) {
  const solid = brushNode(brushOf(cuboid({ min: [0, 0, 0], max })));
  const world: World = { layers: [layerNode("Main", [solid])], broom: { grid: -2, scale: 1 } };
  const base = newEditor(world);
  const editor: Editor = {
    ...base,
    layer: world.layers[0]!.id,
    selection: selectNodes(world, NOTHING, [solid.id], "replace", undefined),
  };
  return { solid, world, editor, camera };
}

const at = (camera: typeof FRONT, x: number, y: number, over: Partial<InputState> = {}): InputState =>
  newInput({ camera, size: SIZE, at: { x, y }, button: 0, ...over });

const brushIn = (world: World, id: NodeId): Brush => (nodeById(world, id) as BrushNode).brush;
const boxOf = (world: World, id: NodeId): Bounds => brushBounds(brushIn(world, id))!;

/** a whole drag: press, some frames, release — each frame applied as the tool asks for it */
function gesture(tool: Tool, editor: Editor, from: InputState, frames: InputState[]) {
  const tracker = tool.drag!(from, editor);
  assert.ok(tracker, "the tool declined the drag");
  let e = editor;
  let out: Outcome | undefined;
  for (const frame of frames) {
    out = tracker.move(frame, e);
    if (out?.edit) e = out.edit.apply(e);
  }
  return { editor: e, note: out?.note, tracker };
}

// ---------------------------------------------------------------- the axes

test("an orthographic pane reads as three different world axes, exactly", () => {
  assert.deepEqual(paneAxes(TOP), { across: 0, up: 2, along: 1 }, "looking down: x across, z up the screen");
  assert.deepEqual(paneAxes(FRONT), { across: 0, up: 1, along: 2 });
});

test("a camera looking down a diagonal still names three different axes", () => {
  for (const yaw of [0, 30, 45, 60, 90, 135, 180, 225, 315]) {
    for (const pitch of [-89, -45, -20, 0, 20, 45, 89]) {
      const view = { ...newView("3d"), target: [0, 0, 0] as Vec3, reach: 20, yaw, pitch };
      const { across, up, along } = paneAxes(view);
      assert.equal(new Set([across, up, along]).size, 3, `yaw ${yaw} pitch ${pitch} collapsed two axes into one`);
    }
  }
});

test("nothing selected is no gizmo, rather than a gizmo about the origin", () => {
  const { editor } = scene([2, 2, 2]);
  assert.equal(gizmoOf(at(FRONT, 400, 200), { ...editor, selection: NOTHING }), undefined);
  const g = gizmoOf(at(FRONT, 400, 200), editor)!;
  assert.deepEqual(g.centre, [1, 1, 1]);
  assert.equal(g.spin, 1, "the front pane is looked at along -z, so screen-counter-clockwise is +z");
});

// ---------------------------------------------------------------- rotate

/** a pixel on a circle round the pivot, at an angle measured the way the screen measures it */
const round = (pivot: Point, degrees: number, radius = 100): Point => ({
  x: pivot.x + radius * Math.cos((degrees * Math.PI) / 180),
  y: pivot.y - radius * Math.sin((degrees * Math.PI) / 180),
});

test("a quarter turn on screen is a quarter turn about the pane's own world axis", () => {
  const { solid, editor } = scene([4, 2, 2], TOP);
  const pivot = projectPoint(TOP, [2, 1, 1], SIZE)!;
  const from = at(TOP, round(pivot, 0).x, round(pivot, 0).y);
  const { editor: after, note } = gesture(rotateTool, editor, from, [
    at(TOP, round(pivot, 90).x, round(pivot, 90).y),
  ]);

  assert.match(note!, /90° about y/, "the top pane turns things about y, whatever the camera is doing");
  const box = boxOf(after.world, solid.id);
  near(box.min[0]!, 1);
  near(box.max[0]!, 3);
  near(box.min[2]!, -1);
  near(box.max[2]!, 3, 1e-6);
});

test("a turn lands on fifteen degrees, and alt lets it land anywhere", () => {
  const { editor } = scene([4, 2, 2], TOP);
  const pivot = projectPoint(TOP, [2, 1, 1], SIZE)!;
  const from = at(TOP, round(pivot, 0).x, round(pivot, 0).y);

  const small = gesture(rotateTool, editor, from, [at(TOP, round(pivot, 5).x, round(pivot, 5).y)]);
  assert.match(small.note!, /0°/, "five degrees rounds to nothing rather than to a wall off the grid");

  const step = gesture(rotateTool, editor, from, [at(TOP, round(pivot, 10).x, round(pivot, 10).y)]);
  assert.match(step.note!, /15°/);

  const fine = gesture(rotateTool, editor, { ...from, mods: ALT }, [
    at(TOP, round(pivot, 10).x, round(pivot, 10).y, { mods: ALT }),
  ]);
  assert.match(fine.note!, /10°/);
});

test("a drag that goes most of the way round keeps counting instead of folding back", () => {
  const { editor } = scene([4, 2, 2], TOP);
  const pivot = projectPoint(TOP, [2, 1, 1], SIZE)!;
  const from = at(TOP, round(pivot, 0).x, round(pivot, 0).y);
  const frames = [120, 240, 270].map((d) => at(TOP, round(pivot, d).x, round(pivot, d).y));
  const { note } = gesture(rotateTool, editor, from, frames);
  assert.match(note!, /270°/, "three quarters of a turn is not a quarter turn the other way");
});

// ---------------------------------------------------------------- scale

/** the pixel a world point on the drag plane sits at, so a drag can be aimed at a corner of the box */
const pixelAt = (camera: typeof FRONT, p: Vec3): Point => projectPoint(camera, p, SIZE)!;

test("the far corner stays put and the moving edge lands on the grid", () => {
  const { solid, editor } = scene([2, 2, 2]);
  const corner = pixelAt(FRONT, [2, 2, 1]);
  const from = at(FRONT, corner.x, corner.y);
  const { editor: after, note } = gesture(scaleTool, editor, from, [at(FRONT, corner.x + PIXELS, corner.y)]);

  assert.match(note!, /1\.5/);
  const box = boxOf(after.world, solid.id);
  near(box.min[0]!, 0, 1e-9);
  near(box.max[0]!, 3, 1e-9);
  near(box.max[1]!, 2, 1e-9);
});

test("a factor is derived from where the edge lands, not the other way round", () => {
  const { solid, editor } = scene([2, 2, 2]);
  const corner = pixelAt(FRONT, [2, 2, 1]);
  const from = at(FRONT, corner.x, corner.y);
  // a tenth of a metre is less than half a cell, so the edge stays where it is and the solid does not move
  const { editor: after } = gesture(scaleTool, editor, from, [at(FRONT, corner.x + 0.1 * PIXELS, corner.y)]);
  near(boxOf(after.world, solid.id).max[0]!, 2, 1e-9);
});

test("shift scales by the axis pushed hardest, in every direction including the unseen one", () => {
  const { solid, editor } = scene([2, 2, 2]);
  const corner = pixelAt(FRONT, [2, 2, 1]);
  const from = at(FRONT, corner.x, corner.y, { mods: SHIFT });
  const { editor: after } = gesture(scaleTool, editor, from, [
    at(FRONT, corner.x + PIXELS, corner.y - 0.25 * PIXELS, { mods: SHIFT }),
  ]);
  const box = boxOf(after.world, solid.id);
  for (const k of [0, 1]) {
    near(box.min[k]!, 0, 1e-9);
    near(box.max[k]!, 3, 1e-9);
  }
  // the axis into the screen has no near side and no far side, so it grows about the middle
  near(box.min[2]!, -0.5, 1e-9);
  near(box.max[2]!, 2.5, 1e-9);
});

test("alt scales about the middle, which is the one time both sides move", () => {
  const { solid, editor } = scene([2, 2, 2]);
  const corner = pixelAt(FRONT, [2, 2, 1]);
  const from = at(FRONT, corner.x, corner.y, { mods: ALT });
  const { editor: after } = gesture(scaleTool, editor, from, [
    at(FRONT, corner.x + PIXELS, corner.y, { mods: ALT }),
  ]);
  const box = boxOf(after.world, solid.id);
  near(box.min[0]!, -1, 1e-9);
  near(box.max[0]!, 3, 1e-9);
});

// ---------------------------------------------------------------- shear

test("grabbing the top leans the top over and leaves the bottom exactly where it was", () => {
  const { solid, editor } = scene([2, 2, 2]);
  const corner = pixelAt(FRONT, [2, 2, 1]);
  const from = at(FRONT, corner.x, corner.y);
  const { editor: after, note } = gesture(shearTool, editor, from, [at(FRONT, corner.x + PIXELS, corner.y)]);

  assert.match(note!, /1 m over 2 m/);
  const brush = brushIn(after.world, solid.id);
  const box = brushBounds(brush)!;
  near(box.min[0]!, 0, 1e-9);
  near(box.max[0]!, 3, 1e-9);
  const floor = brush.poly.vertices.filter((v) => Math.abs(v[1]) < 1e-9);
  assert.equal(floor.length, 4);
  for (const v of floor) assert.ok(v[0] > -1e-9 && v[0] < 2 + 1e-9, "the floor did not move");
});

test("grabbing the bottom leans the bottom and leaves the top", () => {
  const { solid, editor } = scene([2, 2, 2]);
  const corner = pixelAt(FRONT, [2, 0, 1]);
  const from = at(FRONT, corner.x, corner.y);
  const { editor: after } = gesture(shearTool, editor, from, [at(FRONT, corner.x + PIXELS, corner.y)]);
  const brush = brushIn(after.world, solid.id);
  const ceiling = brush.poly.vertices.filter((v) => Math.abs(v[1] - 2) < 1e-9);
  for (const v of ceiling) assert.ok(v[0] > -1e-9 && v[0] < 2 + 1e-9, "the ceiling did not move");
  near(brushBounds(brush)!.max[0]!, 3, 1e-9);
});

// ---------------------------------------------------------------- refusals

test("all three decline when there is nothing to work on", () => {
  const { editor } = scene([2, 2, 2]);
  const empty = { ...editor, selection: NOTHING };
  for (const tool of [rotateTool, scaleTool, shearTool]) {
    assert.equal(tool.drag!(at(FRONT, 400, 200), empty), undefined, `${tool.id} made a gizmo out of nothing`);
  }
});

test("a cancelled gesture puts the world back exactly as it was", () => {
  const { solid, editor } = scene([2, 2, 2]);
  const corner = pixelAt(FRONT, [2, 2, 1]);
  const from = at(FRONT, corner.x, corner.y);
  const { editor: after, tracker } = gesture(scaleTool, editor, from, [at(FRONT, corner.x + PIXELS, corner.y)]);
  near(boxOf(after.world, solid.id).max[0]!, 3, 1e-9);
  const undone = tracker!.cancel(after)!.edit!.apply(after);
  near(boxOf(undone.world, solid.id).max[0]!, 2, 1e-9);
});

report("gizmo");
