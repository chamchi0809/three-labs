// The click and the rubber band.
// node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/select.check.ts
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { brushNode, groupNode, layerNode, type World } from "../doc/document.ts";
import { newEditor, type Editor } from "../doc/editor.ts";
import { NOTHING } from "../doc/selection.ts";
import { newView, projectPoint, type Size } from "../viewport/view.ts";
import { newInput, type InputState } from "./input.ts";
import { candidates, modeOf, nodesInBand, projectBounds, selectTool } from "./select.ts";
import { ToolBox, type Outcome } from "./tool.ts";

const SIZE: Size = { width: 800, height: 400 };
const VIEW = { ...newView("top"), target: [0, 0, 0] as Vec3, reach: 20 };

const box = (min: Vec3, max: Vec3) => brushNode(brushOf(cuboid({ min, max })));
const at = (x: number, y: number, over: Partial<InputState> = {}): InputState =>
  newInput({ camera: VIEW, size: SIZE, at: { x, y }, button: 0, ...over });

/** two solids a few metres apart on the ground, so the top pane sees them side by side */
function scene() {
  const left = box([-4, 0, -1], [-2, 2, 1]);
  const right = box([2, 0, -1], [4, 2, 1]);
  const world: World = { layers: [layerNode("Main", [left, right])], broom: { grid: -2, scale: 1 } };
  return { left, right, editor: { ...newEditor(world), layer: world.layers[0]!.id } as Editor };
}

/** the host, in one line: a selection change is the only thing this tool ever asks for */
const settle = (e: Editor, out: Outcome | undefined): Editor => (out?.set ? out.set(e) : e);

/** where a world point lands in the pane, so a band can be dragged around something on purpose */
const screen = (p: Vec3) => projectPoint(VIEW, p, SIZE)!;

// ---------------------------------------------------------------- modifiers

test("plain replaces, shift toggles, ctrl removes, and both together only ever add", () => {
  assert.equal(modeOf({ shift: false, ctrl: false, alt: false }), "replace");
  assert.equal(modeOf({ shift: true, ctrl: false, alt: false }), "toggle");
  assert.equal(modeOf({ shift: false, ctrl: true, alt: false }), "remove");
  assert.equal(modeOf({ shift: true, ctrl: true, alt: false }), "add");
});

// ---------------------------------------------------------------- clicking

test("a click takes what was under it, and clicking again takes the other one instead", () => {
  const { left, right, editor } = scene();
  let e = settle(editor, selectTool.click!(at(0, 0, { hit: { node: left.id } }), editor));
  assert.deepEqual(e.selection.nodes, [left.id]);
  e = settle(e, selectTool.click!(at(0, 0, { hit: { node: right.id } }), e));
  assert.deepEqual(e.selection.nodes, [right.id], "plain click replaces rather than accumulating");
});

test("shift-clicking builds a selection and takes things back out of it", () => {
  const { left, right, editor } = scene();
  const shift = { shift: true, ctrl: false, alt: false };
  let e = settle(editor, selectTool.click!(at(0, 0, { hit: { node: left.id }, mods: shift }), editor));
  e = settle(e, selectTool.click!(at(0, 0, { hit: { node: right.id }, mods: shift }), e));
  assert.deepEqual([...e.selection.nodes].sort(), [left.id, right.id].sort());
  e = settle(e, selectTool.click!(at(0, 0, { hit: { node: right.id }, mods: shift }), e));
  assert.deepEqual(e.selection.nodes, [left.id]);
});

test("a click on nothing clears, but a shift-click on nothing is a slip and is ignored", () => {
  const { left, editor } = scene();
  let e = settle(editor, selectTool.click!(at(0, 0, { hit: { node: left.id } }), editor));
  const slip = selectTool.click!(at(700, 380, { mods: { shift: true, ctrl: false, alt: false } }), e);
  assert.equal(slip, undefined, "throwing away a half-built selection is never what was meant");
  e = settle(e, selectTool.click!(at(700, 380), e));
  assert.deepEqual(e.selection.nodes, [], "an unmodified click on empty space does clear it");
});

test("alt reaches past the solid to the face under the cursor", () => {
  const { left, editor } = scene();
  const alt = { shift: false, ctrl: false, alt: true };
  const out = selectTool.click!(at(0, 0, { hit: { node: left.id, face: 3 }, mods: alt }), editor);
  const e = settle(editor, out);
  assert.deepEqual(e.selection.faces, [{ node: left.id, face: 3 }]);
  assert.deepEqual(e.selection.nodes, [], "picking a face is not picking the solid it is on");
});

test("clicking a solid inside a group takes the group, until the group has been stepped into", () => {
  const inner = box([0, 0, 0], [1, 1, 1]);
  const group = groupNode("room", [inner]);
  const world: World = { layers: [layerNode("Main", [group])], broom: { grid: -2, scale: 1 } };
  const editor: Editor = { ...newEditor(world), layer: world.layers[0]!.id };
  let e = settle(editor, selectTool.click!(at(0, 0, { hit: { node: inner.id } }), editor));
  assert.deepEqual(e.selection.nodes, [group.id]);
  const opened: Editor = { ...editor, open: group.id };
  e = settle(opened, selectTool.click!(at(0, 0, { hit: { node: inner.id } }), opened));
  assert.deepEqual(e.selection.nodes, [inner.id]);
});

// ---------------------------------------------------------------- what a band can catch

test("what a band tests is what a click could have taken", () => {
  const inner = box([0, 0, 0], [1, 1, 1]);
  const group = groupNode("room", [inner]);
  const world: World = { layers: [layerNode("Main", [group])], broom: { grid: -2, scale: 1 } };
  assert.deepEqual(candidates(world).map((n) => n.id), [group.id]);
  assert.deepEqual(candidates(world, group.id).map((n) => n.id), [inner.id]);
});

test("a box on screen is the rectangle its eight corners fill", () => {
  const rect = projectBounds(VIEW, SIZE, { min: [-4, 0, -1], max: [-2, 2, 1] })!;
  const a = screen([-4, 0, -1]);
  const b = screen([-2, 2, 1]);
  assert.equal(rect.left, Math.min(a.x, b.x));
  assert.equal(rect.right, Math.max(a.x, b.x));
  assert.ok(rect.right > rect.left && rect.bottom > rect.top);
});

test("a box behind the eye has no rectangle, so a band cannot swallow what is behind the designer", () => {
  const view = newView("3d");
  const behind = projectBounds(view, SIZE, { min: [0, 0, 100], max: [1, 1, 101] });
  assert.equal(behind, undefined);
});

test("a band takes what it crosses, and with alt only what it holds whole", () => {
  const { left, right, editor } = scene();
  const world = editor.world;
  // a rectangle over the left solid's near half only
  const a = screen([-4, 0, -1]);
  const b = screen([-3, 0, 1]);
  const rect = { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
  assert.deepEqual(nodesInBand(world, VIEW, SIZE, rect, false), [left.id]);
  assert.deepEqual(nodesInBand(world, VIEW, SIZE, rect, true), [], "half a solid is not a whole one");

  const all = { left: 0, top: 0, right: SIZE.width, bottom: SIZE.height };
  assert.deepEqual(nodesInBand(world, VIEW, SIZE, all, true).sort(), [left.id, right.id].sort());
});

// ---------------------------------------------------------------- the band as a gesture

test("dragging a band selects while it is being dragged and puts the rectangle away at the end", () => {
  const { left, editor } = scene();
  const tools = new ToolBox([selectTool]);
  const a = screen([-4.5, 0, -1.5]);
  const b = screen([-1.5, 0, 1.5]);

  tools.down(at(a.x, a.y), editor);
  const during = tools.move(at(b.x, b.y), editor);
  const e = settle(editor, during);
  assert.deepEqual(e.selection.nodes, [left.id]);
  assert.equal(during?.band?.view, "top", "the band is drawn in the pane it started in");
  assert.ok(during?.note?.includes("1 in the band"));
  assert.equal(during?.edit, undefined, "a selection change has no business on the undo stack");

  const end = tools.up(at(b.x, b.y), e);
  assert.equal(end?.band, null, "a band left on screen after the mouse came up is a bug");
  assert.deepEqual(settle(e, end).selection.nodes, [left.id], "and the far solid was never in it");
});

test("escaping out of a band puts back the selection that was there before it", () => {
  const { left, right, editor } = scene();
  const tools = new ToolBox([selectTool]);
  const before = settle(editor, selectTool.click!(at(0, 0, { hit: { node: right.id } }), editor));

  const a = screen([-4.5, 0, -1.5]);
  const b = screen([-1.5, 0, 1.5]);
  tools.down(at(a.x, a.y), before);
  const e = settle(before, tools.move(at(b.x, b.y), before));
  assert.deepEqual(e.selection.nodes, [left.id]);
  const out = tools.press("escape", at(b.x, b.y), e);
  assert.deepEqual(settle(e, out).selection.nodes, [right.id]);
  assert.equal(out?.band, null);
});

test("shift-banding adds to what was already selected instead of starting again", () => {
  const { left, right, editor } = scene();
  const tools = new ToolBox([selectTool]);
  const before = settle(editor, selectTool.click!(at(0, 0, { hit: { node: right.id } }), editor));
  const shift = { shift: true, ctrl: false, alt: false };
  const a = screen([-4.5, 0, -1.5]);
  const b = screen([-1.5, 0, 1.5]);
  tools.down(at(a.x, a.y, { mods: shift }), before);
  const e = settle(before, tools.move(at(b.x, b.y, { mods: shift }), before));
  assert.deepEqual([...e.selection.nodes].sort(), [left.id, right.id].sort());
});

// ---------------------------------------------------------------- keys

test("ctrl-a takes everything and escape takes nothing", () => {
  const { left, right, editor } = scene();
  const ctrl = { shift: false, ctrl: true, alt: false };
  let e = settle(editor, selectTool.press!("a", at(0, 0, { mods: ctrl }), editor));
  assert.deepEqual([...e.selection.nodes].sort(), [left.id, right.id].sort());
  assert.equal(selectTool.press!("a", at(0, 0), e), undefined, "bare a belongs to flying, not to selecting");
  e = settle(e, selectTool.press!("escape", at(0, 0), e));
  assert.equal(e.selection, NOTHING);
});

report("select");
