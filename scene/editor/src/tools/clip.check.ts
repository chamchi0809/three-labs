/**
 * The clip tool: a plane placed by hand, and solids cut along it.
 *
 * The two things worth checking hardest are the ones a designer would notice within a minute of using it.
 * A plane drawn with two points in an orthographic pane has to mean the wall standing straight up out of
 * that line, or every clip in the top view comes out lying flat. And a solid the plane misses has to be
 * left exactly alone rather than quietly counted as an edit, or the undo stack fills with entries that
 * changed nothing.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/clip.check.ts
 */
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { brushBounds, brushOf, brushVolume } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { brushNode, layerNode, nodeById, type BrushNode, type World } from "../doc/document.ts";
import { newEditor, type Editor } from "../doc/editor.ts";
import { history, run, separate, type History } from "../doc/history.ts";
import { NOTHING, selectNodes } from "../doc/selection.ts";
import { newView, type Size } from "../viewport/view.ts";
import { clipPlane, clipState, clipDecor, clipTool, clipWorld, resetClip, KEEPS } from "./clip.ts";
import { newInput, type InputState } from "./input.ts";
import { ToolBox, type Outcome } from "./tool.ts";

const SIZE: Size = { width: 800, height: 400 };
const TOP = { ...newView("top"), target: [0, 0, 0] as Vec3, reach: 20 };
const SPACE = { ...newView("3d"), target: [0, 0, 0] as Vec3, reach: 20 };

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);

const at = (x: number, y: number, over: Partial<InputState> = {}): InputState =>
  newInput({ camera: TOP, size: SIZE, at: { x, y }, button: 0, ...over });

/** one cube from the origin to (2,2,2), selected */
function scene() {
  const solid = brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [2, 2, 2] })));
  const world: World = { layers: [layerNode("Main", [solid])], broom: { grid: -2, scale: 1 } };
  const base = newEditor(world);
  const editor: Editor = {
    ...base,
    layer: world.layers[0]!.id,
    selection: selectNodes(world, NOTHING, [solid.id], "replace", undefined),
  };
  return { solid, world, editor };
}

function apply(h: History, out: Outcome | undefined): History {
  if (!out) return h;
  let next = h;
  if (out.set) next = { ...next, editor: out.set(next.editor) };
  if (out.edit) next = run(next, out.edit);
  if (out.separate) next = separate(next);
  return next;
}

// ---------------------------------------------------------------- the plane

test("two points in an orthographic pane mean the wall standing up out of that line", () => {
  const plane = clipPlane([[0, 0, 0], [2, 0, 0]], TOP)!;
  assert.ok(plane, "a line in the top view is a plane, because the pane supplies the third direction");
  near(Math.abs(plane.n[2]!), 1, 1e-9);
  near(plane.n[1]!, 0, 1e-9);
  near(plane.d, 0, 1e-9);
});

test("two points in the 3D pane mean nothing, because there is no one direction to lean on", () => {
  assert.equal(clipPlane([[0, 0, 0], [2, 0, 0]], SPACE), undefined);
  assert.equal(clipPlane([[0, 0, 0]], TOP), undefined);
  assert.equal(clipPlane([], TOP), undefined);
});

test("three points make a plane anywhere, and three points on a line make none", () => {
  const plane = clipPlane([[0, 0, 0], [2, 0, 0], [0, 0, 2]], SPACE)!;
  near(Math.abs(plane.n[1]!), 1, 1e-9);
  assert.equal(clipPlane([[0, 0, 0], [1, 0, 0], [2, 0, 0]], SPACE), undefined, "a line is every plane, so no plane");
});

// ---------------------------------------------------------------- the cut

test("keeping the front keeps the positive side, and keeping the back keeps the other", () => {
  const { world, solid } = scene();
  const plane = { n: [1, 0, 0] as Vec3, d: 1 };

  const front = clipWorld(world, [solid.id], plane, "front")!;
  const kept = (nodeById(front.world, solid.id) as BrushNode).brush;
  near(brushBounds(kept)!.min[0]!, 1);
  near(brushVolume(kept), 4);
  assert.deepEqual(front.made, [], "one half means one solid");

  const back = clipWorld(world, [solid.id], plane, "back")!;
  near(brushBounds((nodeById(back.world, solid.id) as BrushNode).brush)!.max[0]!, 1);
});

test("keeping both leaves two solids, and both of them are picked", () => {
  const { world, solid } = scene();
  const plane = { n: [1, 0, 0] as Vec3, d: 1 };
  const both = clipWorld(world, [solid.id], plane, "both")!;
  assert.equal(both.made.length, 1);
  const layer = both.world.layers[0]!.children as BrushNode[];
  assert.equal(layer.length, 2);
  near(layer.reduce((sum, n) => sum + brushVolume(n.brush), 0), 8, 1e-9);
});

test("a solid wholly on the kept side is left exactly as it was, and nothing is an edit", () => {
  const { world, solid } = scene();
  const missed = clipWorld(world, [solid.id], { n: [1, 0, 0], d: 10 }, "back");
  assert.equal(missed, undefined, "an undo entry that changed nothing is worse than no entry");
});

test("a solid wholly on the discarded side goes away, which is what keeping the front means", () => {
  const { world, solid } = scene();
  const gone = clipWorld(world, [solid.id], { n: [1, 0, 0], d: 10 }, "front")!;
  assert.equal(nodeById(gone.world, solid.id), undefined);
  assert.equal(gone.world.layers[0]!.children.length, 0);
});

test("the materials of a cut solid follow it, and the new face takes the nearest wall's", () => {
  const { solid } = scene();
  const painted = { ...solid, brush: { ...solid.brush, faces: solid.brush.faces.map((f) => ({ ...f, material: "brick" })) } };
  const one: World = { layers: [layerNode("Main", [painted])], broom: { grid: -2, scale: 1 } };
  const cut = clipWorld(one, [painted.id], { n: [1, 0, 0], d: 1 }, "front")!;
  const kept = (nodeById(cut.world, painted.id) as BrushNode).brush;
  for (const face of kept.faces) assert.equal(face.material, "brick");
});

// ---------------------------------------------------------------- the gesture

test("points are placed by clicking, and a fourth click starts a new plane", () => {
  resetClip();
  const { editor } = scene();
  clipTool.click!(at(0, 0, { hit: { point: [0, 0, 0] } }), editor);
  clipTool.click!(at(0, 0, { hit: { point: [2, 0, 0] } }), editor);
  assert.equal(clipState.points.length, 2);
  clipTool.click!(at(0, 0, { hit: { point: [0, 0, 2] } }), editor);
  assert.equal(clipState.points.length, 3);
  clipTool.click!(at(0, 0, { hit: { point: [1, 1, 1] } }), editor);
  assert.equal(clipState.points.length, 1, "a tool that stops answering reads as broken");
  resetClip();
});

test("clicking in a different pane starts the plane again, because the old one meant that pane", () => {
  resetClip();
  const { editor } = scene();
  clipTool.click!(at(0, 0, { hit: { point: [0, 0, 0] } }), editor);
  const elsewhere = newInput({ camera: SPACE, size: SIZE, at: { x: 0, y: 0 }, hit: { point: [2, 0, 0] } });
  clipTool.click!(elsewhere, editor);
  assert.equal(clipState.points.length, 1);
  resetClip();
});

test("backspace takes a point back and escape puts the whole thing away", () => {
  resetClip();
  const { editor } = scene();
  clipTool.click!(at(0, 0, { hit: { point: [0, 0, 0] } }), editor);
  clipTool.click!(at(0, 0, { hit: { point: [2, 0, 0] } }), editor);
  clipTool.press!("backspace", at(0, 0), editor);
  assert.equal(clipState.points.length, 1);
  clipTool.press!("escape", at(0, 0), editor);
  assert.equal(clipState.points.length, 0);
  assert.equal(clipState.camera, undefined);
});

test("tab walks the halves round", () => {
  resetClip();
  const { editor } = scene();
  const was = clipState.keep;
  for (let i = 1; i <= KEEPS.length; i++) {
    clipTool.press!("tab", at(0, 0), editor);
    assert.equal(clipState.keep, KEEPS[(KEEPS.indexOf(was) + i) % KEEPS.length]);
  }
  assert.equal(clipState.keep, was, "round the loop and back where it started");
});

test("enter cuts what is selected, as one entry, and clears the points", () => {
  resetClip();
  clipState.keep = "front";
  const { solid, editor } = scene();
  const tools = new ToolBox([clipTool]);
  let h = history(editor);
  h = apply(h, tools.press("enter", at(0, 0), h.editor)); // nothing placed yet
  assert.equal(h.past.length, 0);

  h = apply(h, clipTool.click!(at(0, 0, { hit: { point: [1, 0, 0] } }), h.editor));
  h = apply(h, clipTool.click!(at(0, 0, { hit: { point: [1, 0, 2] } }), h.editor));
  h = apply(h, tools.press("enter", at(0, 0), h.editor));

  assert.equal(h.past.length, 1, "one clip is one entry, however many points it took to aim");
  assert.equal(clipState.points.length, 0);
  near(brushVolume((nodeById(h.editor.world, solid.id) as BrushNode).brush), 4, 1e-9);
});

test("a clip that misses everything refuses rather than putting an entry on the stack", () => {
  resetClip();
  clipState.keep = "back";
  const { editor } = scene();
  const tools = new ToolBox([clipTool]);
  let h = history(editor);
  h = apply(h, clipTool.click!(at(0, 0, { hit: { point: [50, 0, 0] } }), h.editor));
  h = apply(h, clipTool.click!(at(0, 0, { hit: { point: [50, 0, 2] } }), h.editor));
  const out = tools.press("enter", at(0, 0), h.editor)!;
  assert.equal(out.edit, undefined);
  assert.match(out.note!, /misses/);
  resetClip();
  clipState.keep = "front";
});

test("nothing selected is refused too, and says so", () => {
  resetClip();
  const { editor } = scene();
  const empty = { ...editor, selection: NOTHING };
  clipTool.click!(at(0, 0, { hit: { point: [1, 0, 0] } }), empty);
  clipTool.click!(at(0, 0, { hit: { point: [1, 0, 2] } }), empty);
  const out = clipTool.press!("enter", at(0, 0), empty)!;
  assert.equal(out.edit, undefined);
  assert.match(out.note!, /nothing selected/);
  resetClip();
});

// ---------------------------------------------------------------- what it draws

test("the preview is the cross-section the cut would leave, not an infinite grey plane", () => {
  resetClip();
  const { editor } = scene();
  clipTool.click!(at(0, 0, { hit: { point: [1, 0, 0] } }), editor);
  clipTool.click!(at(0, 0, { hit: { point: [1, 0, 2] } }), editor);
  const decor = clipDecor(editor);
  const cut = decor["clip:cut"]!;
  assert.equal(cut.length, 4 * 6, "a plane through a cube leaves a quadrilateral");
  for (let i = 0; i < cut.length; i += 3) near(cut[i]!, 1, 1e-9);

  const marks = decor["clip:points"]!;
  assert.equal(marks.length, 2 * 3 * 6 + 6, "a cross on each point, and one line joining them");
  resetClip();
});

test("leaving the tool puts the preview away", () => {
  resetClip();
  const { editor } = scene();
  clipTool.click!(at(0, 0, { hit: { point: [1, 0, 0] } }), editor);
  const out = clipTool.leave!(editor)!;
  assert.equal(out.decor!["clip:points"], undefined);
  assert.equal(out.decor!["clip:cut"], undefined);
  assert.equal(clipState.points.length, 0);
});

report("clip");
