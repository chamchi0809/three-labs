/**
 * Pulling a face along its own normal — the gesture a level is actually shaped with.
 *
 * Two things here are worth more than the rest. The face must leave the wall on the *first* pixel, which
 * is what the outward snap buys and what rounding-to-nearest silently costs. And a pull that would destroy
 * a solid must move nothing at all, rather than leaving half a room raised.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/extrude.check.ts
 */
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { brushBounds, brushOf, faceCentre, faceNormal } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { brushNode, layerNode, nodeById, type BrushNode, type World } from "../doc/document.ts";
import { newEditor, type Editor } from "../doc/editor.ts";
import { history, run, separate, undo, type History } from "../doc/history.ts";
import { NOTHING, selectFaces } from "../doc/selection.ts";
import { metresPerPixel, newView, type Size } from "../viewport/view.ts";
import { extrudeTool, facesToPull, pullAxis, pullFaces, pullWorld } from "./extrude.ts";
import { newInput, type InputState } from "./input.ts";
import { ToolBox, type Outcome } from "./tool.ts";

const SIZE: Size = { width: 800, height: 400 };
const VIEW = { ...newView("front"), target: [0, 0, 0] as Vec3, reach: 20 };
const METRES = metresPerPixel(VIEW, SIZE);

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);
const nearVec = (a: Vec3, b: Vec3, eps = 1e-9) => {
  for (let i = 0; i < 3; i++) near(a[i]!, b[i]!, eps);
};

const at = (x: number, y: number, over: Partial<InputState> = {}): InputState =>
  newInput({ camera: VIEW, size: SIZE, at: { x, y }, button: 0, ...over });

/** one cube, and the index of the face pointing straight up */
function scene() {
  const solid = brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [2, 2, 2] })));
  const top = solid.brush.poly.faces.findIndex((_, i) => faceNormal(solid.brush, i)[1]! > 0.999);
  const world: World = { layers: [layerNode("Main", [solid])], broom: { grid: -2, scale: 1 } };
  return { solid, top, editor: { ...newEditor(world), layer: world.layers[0]!.id } as Editor };
}

const boundsOf = (e: Editor, id: string) => brushBounds((nodeById(e.world, id) as BrushNode).brush)!;

function apply(h: History, out: Outcome | undefined): History {
  if (!out) return h;
  let next = h;
  if (out.set) next = { ...next, editor: out.set(next.editor) };
  if (out.edit) next = run(next, out.edit);
  if (out.separate) next = separate(next);
  return next;
}

// ---------------------------------------------------------------- which faces go

test("the face under the pointer goes, unless it is one of a selection, in which case they all do", () => {
  const { solid, top, editor } = scene();
  const hit = { node: solid.id, face: top };
  assert.deepEqual(facesToPull(editor, hit), [hit]);

  const many = { ...editor, selection: selectFaces(editor.world, NOTHING, [hit, { node: solid.id, face: 0 }]) };
  assert.equal(facesToPull(many, hit).length, 2, "four walls of a room raise together");
  // pressing a face outside the selection means the designer changed their mind about which one they meant
  const other = { node: solid.id, face: (top + 1) % 6 };
  assert.deepEqual(facesToPull({ ...many, selection: selectFaces(many.world, NOTHING, [hit]) }, other), [other]);
});

// ---------------------------------------------------------------- the axis and the pull

test("a pull runs along the face's own normal, through its middle", () => {
  const { solid, top, editor } = scene();
  const axis = pullAxis(editor.world, { node: solid.id, face: top })!;
  nearVec(axis.normal, [0, 1, 0], 1e-9);
  nearVec(axis.origin, [1, 2, 1], 1e-9);
  assert.equal(pullAxis(editor.world, { node: solid.id, face: 99 }), undefined);
  assert.equal(pullAxis(editor.world, { node: "nope", face: 0 }), undefined);
});

test("pulling a face out grows the solid and pushing it in shrinks it, which is one operation", () => {
  const { solid, top } = scene();
  const out = pullFaces(solid.brush, [top], 1)!;
  near(brushBounds(out)!.max[1]!, 3);
  const inwards = pullFaces(solid.brush, [top], -1)!;
  near(brushBounds(inwards)!.max[1]!, 1);
});

test("a pull that would leave no solid behind gives nothing rather than a ruin", () => {
  const { solid, top } = scene();
  assert.equal(pullFaces(solid.brush, [top], -3), undefined);
});

test("a pull that destroys one solid moves none of them", () => {
  const a = brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [2, 2, 2] })));
  const b = brushNode(brushOf(cuboid({ min: [4, 0, 0], max: [4.5, 2, 2] })));
  const world: World = { layers: [layerNode("Main", [a, b])], broom: { grid: -2, scale: 1 } };
  const upOf = (node: BrushNode) => node.brush.poly.faces.findIndex((_, i) => faceNormal(node.brush, i)[1]! > 0.999);
  const faces = [{ node: a.id, face: upOf(a) }, { node: b.id, face: upOf(b) }];
  assert.equal(pullWorld(world, faces, -3), undefined, "half a room raised is a state undo cannot fix");
  assert.ok(pullWorld(world, faces, -1), "and the same pull that fits does go through");
});

test("the material stays on the wall while the wall moves", () => {
  const { solid, top } = scene();
  const brush = { ...solid.brush, faces: solid.brush.faces.map((f) => ({ ...f, material: "brick" })) };
  const out = pullFaces(brush, [top], 1)!;
  assert.equal(out.faces.length, brush.faces.length, "a pull along a normal invents no faces");
  for (const face of out.faces) assert.equal(face.material, "brick");
});

// ---------------------------------------------------------------- the gesture

test("dragging up a front pane pulls the top face up, and it is one entry", () => {
  const { solid, top, editor } = scene();
  const tools = new ToolBox([extrudeTool]);
  let h = history(editor);
  const hit = { hit: { node: solid.id, face: top } };

  tools.down(at(400, 200, hit), h.editor);
  for (let i = 1; i <= 20; i++) h = apply(h, tools.move(at(400, 200 - i * 4), h.editor));
  h = apply(h, tools.up(at(400, 120), h.editor));

  assert.equal(h.past.length, 1);
  const pulled = 80 * METRES;
  near(boundsOf(h.editor, solid.id).max[1]!, 2 + Math.ceil(pulled / 0.25) * 0.25, 1e-9);
  h = undo(h);
  near(boundsOf(h.editor, solid.id).max[1]!, 2);
});

test("the first pixel of a pull already moves the face, which is why the snap is outwards", () => {
  const { solid, top, editor } = scene();
  const tools = new ToolBox([extrudeTool]);
  let h = history(editor);
  tools.down(at(400, 200, { hit: { node: solid.id, face: top } }), h.editor);
  h = apply(h, tools.move(at(400, 195), h.editor)); // five pixels, which is a fraction of a grid cell
  assert.ok(boundsOf(h.editor, solid.id).max[1]! > 2, "rounding to nearest would leave the face sitting still");
  near(boundsOf(h.editor, solid.id).max[1]!, 2 + Math.ceil(5 * METRES / 0.25) * 0.25, 1e-9);
});

test("escaping a pull puts the solid back and leaves nothing on the stack", () => {
  const { solid, top, editor } = scene();
  const tools = new ToolBox([extrudeTool]);
  let h = history(editor);
  tools.down(at(400, 200, { hit: { node: solid.id, face: top } }), h.editor);
  h = apply(h, tools.move(at(400, 100), h.editor));
  assert.ok(boundsOf(h.editor, solid.id).max[1]! > 2);
  h = apply(h, tools.press("escape", at(400, 100), h.editor));
  near(boundsOf(h.editor, solid.id).max[1]!, 2);
  assert.equal(h.past.length, 0);
});

test("a drag that started on nothing is not a drag", () => {
  const { editor } = scene();
  const tools = new ToolBox([extrudeTool]);
  tools.down(at(400, 200), editor);
  assert.equal(tools.move(at(400, 100), editor), undefined);
  assert.ok(!tools.dragging);
});

test("a click picks the face, and shift adds another", () => {
  const { solid, top, editor } = scene();
  const shift = { shift: true, ctrl: false, alt: false };
  const first = extrudeTool.click!(at(400, 200, { hit: { node: solid.id, face: top } }), editor)!;
  let e = first.set!(editor);
  assert.deepEqual(e.selection.faces, [{ node: solid.id, face: top }]);
  const second = extrudeTool.click!(at(400, 200, { hit: { node: solid.id, face: 0 }, mods: shift }), e)!;
  e = second.set!(e);
  assert.equal(e.selection.faces.length, 2);
  assert.equal(extrudeTool.click!(at(400, 200), e), undefined, "a click on nothing picks nothing");
});

test("repeating a pull applies it to whatever faces are selected now", () => {
  const { solid, top, editor } = scene();
  const tools = new ToolBox([extrudeTool]);
  let h = history(editor);
  tools.down(at(400, 200, { hit: { node: solid.id, face: top } }), h.editor);
  h = apply(h, tools.move(at(400, 195), h.editor));
  h = apply(h, tools.up(at(400, 195), h.editor));
  const pulled = boundsOf(h.editor, solid.id).max[1]! - 2;
  assert.ok(pulled > 0);

  // the designer picks the face again and repeats: the same pull, one more time
  h = { ...h, editor: { ...h.editor, selection: selectFaces(h.editor.world, NOTHING, [{ node: solid.id, face: top }]) } };
  const again = h.repeat.at(-1)!;
  h = run(h, { ...again, collate: undefined, apply: again.again! });
  near(boundsOf(h.editor, solid.id).max[1]!, 2 + pulled * 2, 1e-9);
});

test("the tool shows face handles, because a face is what it acts on", () => {
  assert.equal(extrudeTool.handles?.faces, true);
  const { solid, top, editor } = scene();
  nearVec(faceCentre((nodeById(editor.world, solid.id) as BrushNode).brush, top), [1, 2, 1], 1e-9);
});

report("extrude");
