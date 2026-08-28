/**
 * The move tool, driven as a gesture rather than as a function.
 *
 * The three things worth checking are the three things the file's header claims: sixty frames land one
 * entry on the undo stack, the drag is measured against the start so a slow drag and a fast one agree, and
 * the snap keeps an off-grid corner's offset instead of quietly re-aligning it.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/move.check.ts
 */
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { brushBounds, brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { brushNode, layerNode, nodeById, type BrushNode, type World } from "../doc/document.ts";
import { newEditor, type Editor } from "../doc/editor.ts";
import { history, run, separate, undo, type History } from "../doc/history.ts";
import { NOTHING, selectNodes } from "../doc/selection.ts";
import { metresPerPixel, newView, type Size } from "../viewport/view.ts";
import { newInput, type InputState } from "./input.ts";
import { moveDelta, moveTool } from "./move.ts";
import { ToolBox, type Outcome } from "./tool.ts";

const SIZE: Size = { width: 800, height: 400 };
const VIEW = { ...newView("top"), target: [0, 0, 0] as Vec3, reach: 20 };
const METRES = metresPerPixel(VIEW, SIZE);

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);
const nearVec = (a: Vec3, b: Vec3, eps = 1e-9) => {
  for (let i = 0; i < 3; i++) near(a[i]!, b[i]!, eps);
};

const at = (x: number, y: number, over: Partial<InputState> = {}): InputState =>
  newInput({ camera: VIEW, size: SIZE, at: { x, y }, button: 0, ...over });

/** one solid, selected, on a 0.25 m grid */
function scene(min: Vec3 = [0, 0, 0], max: Vec3 = [2, 2, 2]) {
  const solid = brushNode(brushOf(cuboid({ min, max })));
  const world: World = { layers: [layerNode("Main", [solid])], broom: { grid: -2, scale: 1 } };
  const editor: Editor = {
    ...newEditor(world), layer: world.layers[0]!.id, selection: selectNodes(world, NOTHING, [solid.id]),
  };
  return { solid, editor };
}

const boundsOf = (e: Editor, id: string) => brushBounds((nodeById(e.world, id) as BrushNode).brush)!;

/** the host, as `tools.svelte.ts` writes it: set, then edit, then separate */
function apply(h: History, out: Outcome | undefined): History {
  if (!out) return h;
  let next = h;
  if (out.set) next = { ...next, editor: out.set(next.editor) };
  if (out.edit) next = run(next, out.edit);
  if (out.separate) next = separate(next);
  return next;
}

// ---------------------------------------------------------------- the delta

test("a move puts the solid's corner on the grid, not the distance it travelled", () => {
  const start = at(400, 200);
  const now = at(400 + 3 / METRES, 200); // three metres to the right in a top pane
  // a corner at 0.1 dragged three metres lands on 3, so the move is 2.9 — the alignment is what is fixed
  nearVec(moveDelta(start, now, [0.1, 0, 0], [1, 1, 1], 0.25)!, [2.9, 0, 0], 1e-9);
  nearVec(moveDelta(start, now, [0, 0, 0], [1, 1, 1], 0.25)!, [3, 0, 0], 1e-9);
});

test("shift holds the axis the drag is most along", () => {
  const start = at(400, 200);
  const shift = { shift: true, ctrl: false, alt: false };
  const now = at(400 + 3 / METRES, 200 + 0.5 / METRES, { mods: shift });
  nearVec(moveDelta(start, now, [0, 0, 0], [1, 1, 1], 0.25)!, [3, 0, 0], 1e-9);
});

test("alt stands the drag plane up, so a drag in the 3D pane lifts instead of sliding", () => {
  const view = newView("3d");
  const flat = newInput({ camera: view, size: SIZE, at: { x: 400, y: 200 } });
  const up = { shift: false, ctrl: false, alt: true };
  const lifted = moveDelta(flat, newInput({ camera: view, size: SIZE, at: { x: 400, y: 100 }, mods: up }),
    [0, 0, 0], [0, 0, 0], 0.25)!;
  assert.ok(lifted[1] > 0, "dragging up a vertical plane goes up");
  const along = moveDelta(flat, newInput({ camera: view, size: SIZE, at: { x: 400, y: 100 } }),
    [0, 0, 0], [0, 0, 0], 0.25)!;
  near(along[1]!, 0, 1e-12);
});

// ---------------------------------------------------------------- the gesture

test("sixty frames of a drag are one entry, and undo puts the solid back where it started", () => {
  const { solid, editor } = scene();
  const tools = new ToolBox([moveTool]);
  let h = history(editor);

  tools.down(at(400, 200), h.editor);
  for (let i = 1; i <= 60; i++) h = apply(h, tools.move(at(400 + i * 4, 200), h.editor));
  h = apply(h, tools.up(at(400 + 240, 200), h.editor));

  assert.equal(h.past.length, 1, "a drag is one thing that happened, not sixty");
  near(boundsOf(h.editor, solid.id).min[0]!, Math.round((240 * METRES) / 0.25) * 0.25, 1e-9);
  h = undo(h);
  nearVec(boundsOf(h.editor, solid.id).min, [0, 0, 0], 1e-9);
});

test("a slow drag and a fast one over the same distance end in the same place", () => {
  const drag = (steps: number): Editor => {
    const { editor } = scene();
    const tools = new ToolBox([moveTool]);
    let h = history(editor);
    tools.down(at(400, 200), h.editor);
    for (let i = 1; i <= steps; i++) h = apply(h, tools.move(at(400 + (240 * i) / steps, 200), h.editor));
    return apply(h, tools.up(at(640, 200), h.editor)).editor;
  };
  // the ids differ between scenes, so compare the shape of the answer rather than the node
  const only = (e: Editor) => brushBounds((e.world.layers[0]!.children[0] as BrushNode).brush)!;
  nearVec(only(drag(120)).min, only(drag(2)).min, 1e-12);
});

test("escaping out of a move puts the solid back and leaves nothing on the stack", () => {
  const { solid, editor } = scene();
  const tools = new ToolBox([moveTool]);
  let h = history(editor);
  tools.down(at(400, 200), h.editor);
  h = apply(h, tools.move(at(560, 200), h.editor));
  assert.ok(boundsOf(h.editor, solid.id).min[0]! > 0, "it did move first");
  h = apply(h, tools.press("escape", at(560, 200), h.editor));
  nearVec(boundsOf(h.editor, solid.id).min, [0, 0, 0], 1e-9);
  assert.equal(h.past.length, 0, "a cancelled drag left the world as it found it, so there is no entry");
});

test("pressing an unselected solid selects it, and the drag then moves what was just picked", () => {
  const { solid, editor } = scene();
  const tools = new ToolBox([moveTool]);
  let h = history({ ...editor, selection: NOTHING });
  tools.down(at(400, 200, { hit: { node: solid.id } }), h.editor);
  h = apply(h, tools.move(at(560, 200), h.editor));
  assert.deepEqual(h.editor.selection.nodes, [solid.id]);
  assert.ok(boundsOf(h.editor, solid.id).min[0]! > 0);
});

test("a drag with nothing selected and nothing under it does nothing", () => {
  const { editor } = scene();
  const tools = new ToolBox([moveTool]);
  const empty = { ...editor, selection: NOTHING };
  tools.down(at(400, 200), empty);
  assert.equal(tools.move(at(560, 200), empty), undefined);
  assert.ok(!tools.dragging);
});

// ---------------------------------------------------------------- nudging

test("an arrow moves by one cell along the axis the pane's own right and up point at", () => {
  const { solid, editor } = scene();
  let h = history(editor);
  h = apply(h, moveTool.press!("arrowright", at(400, 200), h.editor));
  near(boundsOf(h.editor, solid.id).min[0]!, 0.25);
  // up the screen in a top pane is −z
  h = apply(h, moveTool.press!("arrowup", at(400, 200), h.editor));
  near(boundsOf(h.editor, solid.id).min[2]!, -0.25);
});

test("a held arrow is one entry, and letting go starts the next one", () => {
  const { solid, editor } = scene();
  let h = history(editor);
  for (let i = 0; i < 8; i++) h = apply(h, moveTool.press!("arrowright", at(400, 200), h.editor));
  assert.equal(h.past.length, 1);
  near(boundsOf(h.editor, solid.id).min[0]!, 2);
  h = separate(h);
  h = apply(h, moveTool.press!("arrowright", at(400, 200), h.editor));
  assert.equal(h.past.length, 2);
  h = undo(h);
  near(boundsOf(h.editor, solid.id).min[0]!, 2, 1e-9);
});

test("nudging nothing does nothing, and a key that is not an arrow is not claimed", () => {
  const { editor } = scene();
  assert.equal(moveTool.press!("arrowright", at(0, 0), { ...editor, selection: NOTHING }), undefined);
  assert.equal(moveTool.press!("q", at(0, 0), editor), undefined);
  assert.equal(moveTool.press!("arrowright", undefined, editor), undefined);
});

// ---------------------------------------------------------------- repeat

test("repeating a drag moves whatever is selected now, rather than rewinding to where it began", () => {
  const { solid, editor } = scene();
  const tools = new ToolBox([moveTool]);
  let h = history(editor);
  tools.down(at(400, 200), h.editor);
  h = apply(h, tools.move(at(400 + 2 / METRES, 200), h.editor));
  h = apply(h, tools.up(at(400 + 2 / METRES, 200), h.editor));
  const once = boundsOf(h.editor, solid.id).min[0]!;
  near(once, 2, 1e-9);

  const again = h.repeat.at(-1)!;
  assert.ok(again.again, "a drag has to carry an `again`, or repeating it would put the world back");
  h = run(h, { ...again, collate: undefined, apply: again.again! });
  near(boundsOf(h.editor, solid.id).min[0]!, 4, 1e-9);
});

report("move");
