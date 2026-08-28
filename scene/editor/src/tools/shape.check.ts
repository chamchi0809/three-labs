/**
 * Drawing a solid.
 *
 * The claim this file exists to hold up is the one in `shape.ts`'s header: the solid is *really* inserted
 * on every frame, and sixty frames of a drag are sixty versions of one node rather than sixty nodes. That
 * is the mistake this tool is one line away from at all times.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/shape.check.ts
 */
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { brushBounds, brushOf, brushVolume } from "../brush/brush.ts";
import { layerNode, type BrushNode, type World } from "../doc/document.ts";
import { newEditor, type Editor } from "../doc/editor.ts";
import { history, run, separate, undo, type History } from "../doc/history.ts";
import { NOTHING } from "../doc/selection.ts";
import { metresPerPixel, newView, type Size } from "../viewport/view.ts";
import { planeThrough } from "./drag.ts";
import { newInput, type InputState } from "./input.ts";
import {
  SHAPE_KINDS, boxBetween, drawPlane, setShape, shapePolyhedron, shapeSettings, shapeTool,
} from "./shape.ts";
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

const empty = (): Editor => {
  const world: World = { layers: [layerNode("Main")], broom: { grid: -2, scale: 1 } };
  return { ...newEditor(world), layer: world.layers[0]!.id };
};

const solids = (e: Editor) => e.world.layers[0]!.children;

function apply(h: History, out: Outcome | undefined): History {
  if (!out) return h;
  let next = h;
  if (out.set) next = { ...next, editor: out.set(next.editor) };
  if (out.edit) next = run(next, out.edit);
  if (out.separate) next = separate(next);
  return next;
}

// every check starts from the same settings, whatever the last one left behind
const reset = () => setShape({ kind: "cuboid", sides: 8, rings: 4, cells: 4 });

// ---------------------------------------------------------------- the box a drag makes

test("depth runs towards the viewer, so what was drawn is not behind the designer", () => {
  // a footprint drawn on the ground grows upwards
  const up = boxBetween([0, 0, 0], [2, 0, 3], [0, 1, 0], 1);
  nearVec(up.min, [0, 0, 0]);
  nearVec(up.max, [2, 1, 3]);
  // and a rectangle drawn on a wall facing −x grows the other way along x
  const back = boxBetween([0, 0, 0], [0, 2, 3], [-1, 0, 0], 1);
  nearVec(back.min, [-1, 0, 0]);
  nearVec(back.max, [0, 2, 3]);
});

test("the corners can be given in any order and mean the same box", () => {
  const a = boxBetween([2, 0, 3], [0, 0, 0], [0, 1, 0], 1);
  const b = boxBetween([0, 0, 0], [2, 0, 3], [0, 1, 0], 1);
  nearVec(a.min, b.min);
  nearVec(a.max, b.max);
});

test("an orthographic pane draws on its own plane and the 3D pane draws on the ground", () => {
  const flat = drawPlane(at(400, 200));
  nearVec(flat.normal, [0, 1, 0], 1e-12); // a top pane looks down, so its plane is the ground
  const view = newView("3d");
  const on3d = drawPlane(newInput({ camera: view, size: SIZE, at: { x: 400, y: 200 } }));
  nearVec(on3d.normal, [0, 1, 0]);
  nearVec(on3d.origin, [0, 0, 0]);
  // over something, it draws at the height of what it is over, which is how a block goes on top of a block
  const above = drawPlane(newInput({
    camera: view, size: SIZE, at: { x: 400, y: 200 }, hit: { node: "n1", point: [1, 3, 1] },
  }));
  nearVec(above.origin, [0, 3, 0]);
  assert.equal(planeThrough([0, 3, 0], [0, 1, 0]).origin[1], 3);
});

// ---------------------------------------------------------------- the solids themselves

test("every shape the tool offers is a solid with an inside", () => {
  const box = { min: [0, 0, 0] as Vec3, max: [2, 3, 2] as Vec3 };
  for (const kind of SHAPE_KINDS) {
    const poly = shapePolyhedron(box, { kind, sides: 8, rings: 4, cells: 4 });
    assert.ok(poly, `${kind} made nothing`);
    const brush = brushOf(poly!);
    assert.ok(brushVolume(brush) > 0, `${kind} has no volume`);
    const bounds = brushBounds(brush)!;
    // every shape stands in its box: a sphere touches all six walls, a cone touches five
    for (let i = 0; i < 3; i++) {
      assert.ok(bounds.min[i]! >= box.min[i]! - 1e-9 && bounds.max[i]! <= box.max[i]! + 1e-9,
        `${kind} left its box on axis ${i}`);
    }
  }
});

test("a round shape asked for fewer sides than a triangle gets a triangle", () => {
  const box = { min: [0, 0, 0] as Vec3, max: [1, 1, 1] as Vec3 };
  const thin = shapePolyhedron(box, { kind: "cylinder", sides: 2, rings: 4, cells: 4 })!;
  assert.ok(thin, "the builder clamps rather than handing the tool an impossible solid");
  assert.equal(thin.faces.length, 5, "a three-sided prism: three walls, a top and a bottom");
});

// ---------------------------------------------------------------- the gesture

test("a drag draws one solid, however many frames it takes", () => {
  reset();
  const tools = new ToolBox([shapeTool]);
  let h = history(empty());
  tools.down(at(300, 150), h.editor);
  for (let i = 1; i <= 30; i++) h = apply(h, tools.move(at(300 + i * 4, 150 + i * 2), h.editor));
  h = apply(h, tools.up(at(420, 210), h.editor));

  assert.equal(solids(h.editor).length, 1, "sixty frames drew sixty solids");
  assert.equal(h.past.length, 1, "and put sixty things on the undo stack");
  assert.deepEqual(h.editor.selection.nodes, [solids(h.editor)[0]!.id], "what was drawn is what is selected");
  h = undo(h);
  assert.equal(solids(h.editor).length, 0);
});

test("the solid drawn is the size of the rectangle, four cells deep by default", () => {
  reset();
  const tools = new ToolBox([shapeTool]);
  let h = history(empty());
  // exactly two metres across and one along, from a corner on a grid line
  const from = { x: 400 + 1 / METRES, y: 200 + 1 / METRES };
  tools.down(at(from.x, from.y), h.editor);
  h = apply(h, tools.move(at(from.x + 2 / METRES, from.y + 1 / METRES), h.editor));
  h = apply(h, tools.up(at(from.x + 2 / METRES, from.y + 1 / METRES), h.editor));

  const bounds = brushBounds((solids(h.editor)[0] as BrushNode).brush)!;
  near(bounds.max[0]! - bounds.min[0]!, 2, 1e-9);
  near(bounds.max[2]! - bounds.min[2]!, 1, 1e-9);
  near(bounds.max[1]! - bounds.min[1]!, 4 * 0.25, 1e-9);
});

test("a rectangle too small to hold a solid says so instead of drawing a sliver", () => {
  reset();
  const tools = new ToolBox([shapeTool]);
  const e = empty();
  tools.down(at(400, 200), e);
  const out = tools.move(at(406, 200), e);
  assert.equal(out?.edit, undefined);
  assert.equal(out?.note, "too small");
});

test("escaping mid-draw leaves nothing behind, including on the undo stack", () => {
  reset();
  const tools = new ToolBox([shapeTool]);
  let h = history(empty());
  tools.down(at(300, 150), h.editor);
  h = apply(h, tools.move(at(420, 210), h.editor));
  assert.equal(solids(h.editor).length, 1);
  h = apply(h, tools.press("escape", at(420, 210), h.editor));
  assert.equal(solids(h.editor).length, 0);
  assert.equal(h.past.length, 0);
  assert.equal(h.editor.selection, NOTHING);
});

test("drawing again makes another solid rather than moving the one just drawn", () => {
  reset();
  const tools = new ToolBox([shapeTool]);
  let h = history(empty());
  tools.down(at(300, 150), h.editor);
  h = apply(h, tools.move(at(420, 210), h.editor));
  h = apply(h, tools.up(at(420, 210), h.editor));
  const first = solids(h.editor)[0]!.id;
  const again = h.repeat.at(-1)!;
  h = run(h, { ...again, collate: undefined, apply: again.again! });
  assert.equal(solids(h.editor).length, 2);
  assert.notEqual(solids(h.editor)[1]!.id, first, "a repeat that reused the id would replace the solid");
});

// ---------------------------------------------------------------- settings

test("the settings keys cycle the shape and change its sides and depth", () => {
  reset();
  assert.equal(shapeTool.press!("tab", undefined, empty())?.note, "wedge");
  setShape({ kind: "cylinder" });
  assert.equal(shapeTool.press!(".", undefined, empty())?.note, "9 sides");
  assert.equal(shapeTool.press!(",", undefined, empty())?.note, "8 sides");
  assert.equal(shapeTool.press!("+", undefined, empty())?.note, "5 cells deep");
  assert.equal(shapeTool.press!("-", undefined, empty())?.note, "4 cells deep");
  assert.equal(shapeTool.press!("z", undefined, empty()), undefined, "an unclaimed key stays unclaimed");
  reset();
});

test("sides and depth cannot be driven below what makes a solid", () => {
  reset();
  setShape({ sides: 3, cells: 1 });
  shapeTool.press!(",", undefined, empty());
  assert.ok(shapeSettings.sides >= 3);
  shapeTool.press!("-", undefined, empty());
  assert.ok(shapeSettings.cells >= 1);
  reset();
});

report("shape");
