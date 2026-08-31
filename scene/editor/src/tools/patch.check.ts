/**
 * The patch tool: drawing one, and bending one.
 *
 * Three claims this file exists to hold up, because all three are quiet failures rather than crashes.
 *
 * A patch drawn in a pane stands up in that pane. Every builder in the runtime lifts along Y, so the tool
 * permutes the axes on the way in and back out again; get that wrong and a dome dragged out on a wall
 * appears on the floor, which nobody notices until they go looking for it.
 *
 * A drag on a seam drags its twin. A cylinder's first and last column are one point written twice, and a
 * tool that moved only the one it was handed would tear open a wall along the join.
 *
 * And a drag is one undo entry however many frames it took — the same claim the shape tool has to make, and
 * the same line away from being false.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/patch.check.ts
 */
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { layerNode, patchNode, type PatchNode, type World } from "../doc/document.ts";
import { newEditor, type Editor } from "../doc/editor.ts";
import { history, run, separate, undo, type History } from "../doc/history.ts";
import { NOTHING, prune, selectNodes, selectVertices } from "../doc/selection.ts";
import { columnsOf, patchBounds, patchShape, patchToMesh, rowsOf, spansOf } from "../patch/patch.ts";
import { patchHandles } from "../render/handles.ts";
import { metresPerPixel, newView, type Size } from "../viewport/view.ts";
import { newInput, type InputState } from "./input.ts";
import { patchInBox, patchSettings, patchTool, pointOfPart, setPatch } from "./patch.ts";
import { ToolBox, type Outcome } from "./tool.ts";

const SIZE: Size = { width: 800, height: 400 };
const TOP = { ...newView("top"), target: [0, 0, 0] as Vec3, reach: 20 };
const FRONT = { ...newView("front"), target: [0, 0, 0] as Vec3, reach: 20 };
const METRES = metresPerPixel(TOP, SIZE);

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);
const nearVec = (a: Vec3, b: Vec3, eps = 1e-9) => {
  for (const i of [0, 1, 2]) near(a[i]!, b[i]!, eps);
};

const at = (x: number, y: number, over: Partial<InputState> = {}): InputState =>
  newInput({ camera: TOP, size: SIZE, at: { x, y }, button: 0, ...over });

const empty = (): Editor => {
  const world: World = { layers: [layerNode("Main")], broom: { grid: -2, scale: 1 } };
  return { ...newEditor(world), layer: world.layers[0]!.id };
};

const drawn = (e: Editor) => e.world.layers[0]!.children;
const onlyPatch = (e: Editor): PatchNode => drawn(e)[0] as PatchNode;

function apply(h: History, out: Outcome | undefined): History {
  if (!out) return h;
  let next = h;
  if (out.set) next = { ...next, editor: out.set(next.editor) };
  if (out.edit) next = run(next, out.edit);
  if (out.separate) next = separate(next);
  return next;
}

/** an editor with one patch in it, selected — the state every editing check starts from */
function withPatch(shape: Parameters<typeof patchShape>[0] = "plane"): Editor {
  const patch = patchShape(shape, [0, 0, 0], [4, 4, 4]);
  const e = empty();
  const world = { ...e.world, layers: [{ ...e.world.layers[0]!, children: [patchNode(patch, { id: "p1" })] }] };
  return { ...e, world, selection: selectNodes(world, NOTHING, ["p1"]) };
}

/** the handle standing at a place in the grid, which is how a gesture aims at a control point */
const handleFor = (e: Editor, row: number, column: number) => {
  const patch = (e.world.layers[0]!.children[0] as PatchNode).patch;
  const part = row * columnsOf(patch.grid) + column;
  return patchHandles("p1", patch.grid).find((h) => h.part === part);
};

const reset = () => setPatch({ shape: "plane", cells: 4 });

/** the box the tessellated surface actually occupies, which is not the box its handles do */
function meshBounds(positions: Float32Array): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (const k of [0, 1, 2]) {
      const v = positions[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return { min, max };
}

// ---------------------------------------------------------------- which way is up

test("a patch drawn on the ground lies on the ground, unpermuted", () => {
  const box = { min: [0, 0, 0] as Vec3, max: [4, 0, 6] as Vec3 };
  const flat = patchInBox("plane", box, [0, 1, 0]);
  const b = patchBounds(flat.grid);
  nearVec(b.min, [0, 0, 0]);
  nearVec(b.max, [4, 0, 6]);
});

test("a patch drawn on a wall stands on the wall, rather than lying down behind the designer", () => {
  // the front pane looks along z, so a rectangle drawn in it is flat in z and spread through x and y
  const box = { min: [0, 0, 2] as Vec3, max: [4, 6, 2] as Vec3 };
  const wall = patchInBox("plane", box, [0, 0, 1]);
  const b = patchBounds(wall.grid);
  nearVec(b.min, [0, 0, 2]);
  nearVec(b.max, [4, 6, 2]);
});

test("a cylinder drawn on a wall is a tube lying along the pane's own normal", () => {
  const box = { min: [0, 0, 0] as Vec3, max: [4, 6, 2] as Vec3 };
  const tube = patchInBox("cylinder", box, [0, 0, 1]);
  const b = patchBounds(tube.grid);
  // it fills its box either way; the point is which axis it is round about, and it is round about z
  nearVec(b.min, [0, 0, 0]);
  nearVec(b.max, [4, 6, 2]);
  const { rows, columns } = { rows: rowsOf(tube.grid), columns: columnsOf(tube.grid) };
  assert.equal(rows, 3);
  assert.equal(columns, 9, "nine columns round, the first and the last being the same point");
  // the three rows are the three steps along z, which is what "standing up in the pane's normal" means
  for (const row of [0, 1, 2]) near(tube.grid[row]![0]![2]!, row, 1e-9);
});

test("a permuted patch is the canonical one with its numbers in different slots, exactly", () => {
  // the strongest thing that can be said about the permutation, and the only thing it promises: the shape
  // is the runtime's, unchanged, and no number in it was multiplied on the way through. Whether a given
  // primitive fills its box is the runtime's claim and is checked where the runtime is.
  const box = { min: [-2, 0, -2] as Vec3, max: [2, 4, 2] as Vec3 };
  const slots: [Vec3, [number, number, number]][] = [
    [[0, 1, 0], [0, 1, 2]], // drawn on the ground: nothing moves
    [[0, 0, 1], [0, 2, 1]], // drawn on a wall facing z: the builder's up becomes z
    [[1, 0, 0], [1, 0, 2]], // and on one facing x, it becomes x
  ];
  for (const shape of ["plane", "cylinder", "cone", "dome", "bevel"] as const) {
    for (const [normal, order] of slots) {
      const local: Vec3 = [box.min[order[0]]!, box.min[order[1]]!, box.min[order[2]]!];
      const far: Vec3 = [box.max[order[0]]!, box.max[order[1]]!, box.max[order[2]]!];
      const canonical = patchShape(shape, local, far);
      const placed = patchInBox(shape, box, normal);
      for (const [row, line] of canonical.grid.entries()) {
        for (const [column, p] of line.entries()) {
          const q = placed.grid[row]![column]!;
          for (const k of [0, 1, 2]) near(q[order[k]!]!, p[k]!, 1e-12);
        }
      }
    }
  }
});

test("the surface of a patch drawn on a wall is the same surface, stood up", () => {
  const box = { min: [-2, 0, -2] as Vec3, max: [2, 4, 2] as Vec3 };
  const flat = patchToMesh(patchInBox("cylinder", box, [0, 1, 0])).mesh!;
  const wall = patchToMesh(patchInBox("cylinder", box, [0, 0, 1])).mesh!;
  const a = meshBounds(flat.positions);
  const b = meshBounds(wall.positions);
  // the tube was round about y and is now round about z, so its extents swap between those two axes
  near(b.max[1]! - b.min[1]!, a.max[2]! - a.min[2]!, 1e-6);
  near(b.max[2]! - b.min[2]!, a.max[1]! - a.min[1]!, 1e-6);
  near(b.max[0]! - b.min[0]!, a.max[0]! - a.min[0]!, 1e-6);
});

// ---------------------------------------------------------------- drawing one

test("a drag draws one patch, however many frames it takes", () => {
  reset();
  const tools = new ToolBox([patchTool]);
  let h = history(empty());
  tools.down(at(300, 150), h.editor);
  for (let i = 1; i <= 30; i++) h = apply(h, tools.move(at(300 + i * 4, 150 + i * 2), h.editor));
  h = apply(h, tools.up(at(420, 210), h.editor));

  assert.equal(drawn(h.editor).length, 1, "thirty frames drew thirty patches");
  assert.equal(h.past.length, 1, "and put thirty things on the undo stack");
  assert.equal(onlyPatch(h.editor).kind, "patch");
  assert.deepEqual(h.editor.selection.nodes, [onlyPatch(h.editor).id]);
  h = undo(h);
  assert.equal(drawn(h.editor).length, 0);
});

test("a plane is drawn flat in the pane it was dragged in, whatever the depth is set to", () => {
  reset();
  setPatch({ cells: 4 });
  const tools = new ToolBox([patchTool]);
  let h = history(empty());
  const from = { x: 400 + 1 / METRES, y: 200 + 1 / METRES };
  tools.down(at(from.x, from.y), h.editor);
  h = apply(h, tools.move(at(from.x + 2 / METRES, from.y + 1 / METRES), h.editor));
  h = apply(h, tools.up(at(from.x + 2 / METRES, from.y + 1 / METRES), h.editor));

  const b = patchBounds(onlyPatch(h.editor).patch.grid);
  near(b.max[0]! - b.min[0]!, 2);
  near(b.max[2]! - b.min[2]!, 1);
  near(b.max[1]! - b.min[1]!, 0, 1e-9);
});

test("a solid of revolution gets the third dimension the drag never gave it, in cells", () => {
  reset();
  setPatch({ shape: "cylinder", cells: 4 });
  const tools = new ToolBox([patchTool]);
  let h = history(empty());
  const from = { x: 400, y: 200 };
  tools.down(at(from.x, from.y), h.editor);
  h = apply(h, tools.move(at(from.x + 2 / METRES, from.y + 2 / METRES), h.editor));
  h = apply(h, tools.up(at(from.x + 2 / METRES, from.y + 2 / METRES), h.editor));

  const b = patchBounds(onlyPatch(h.editor).patch.grid);
  near(b.max[1]! - b.min[1]!, 4 * 0.25, 1e-9);
  reset();
});

test("a rectangle too thin to be a surface says so rather than drawing a line", () => {
  reset();
  const tools = new ToolBox([patchTool]);
  const e = empty();
  tools.down(at(400, 200), e);
  const out = tools.move(at(406, 200), e);
  assert.equal(out?.edit, undefined);
  assert.equal(out?.note, "too small");
});

test("escaping mid-draw leaves nothing behind, including on the undo stack", () => {
  reset();
  const tools = new ToolBox([patchTool]);
  let h = history(empty());
  tools.down(at(300, 150), h.editor);
  h = apply(h, tools.move(at(420, 210), h.editor));
  assert.equal(drawn(h.editor).length, 1);
  h = apply(h, tools.press("escape", at(420, 210), h.editor));
  assert.equal(drawn(h.editor).length, 0);
  assert.equal(h.past.length, 0);
  assert.equal(h.editor.selection, NOTHING);
});

test("the front pane draws a standing patch, because the drawing plane is the pane's own", () => {
  reset();
  const tools = new ToolBox([patchTool]);
  let h = history(empty());
  const front = (x: number, y: number) =>
    newInput({ camera: FRONT, size: SIZE, at: { x, y }, button: 0, view: "front" });
  tools.down(front(300, 150), h.editor);
  h = apply(h, tools.move(front(420, 240), h.editor));
  h = apply(h, tools.up(front(420, 240), h.editor));

  const b = patchBounds(onlyPatch(h.editor).patch.grid);
  assert.ok(b.max[1]! - b.min[1]! > 0.5, "a patch drawn on a wall has height");
  near(b.max[2]! - b.min[2]!, 0, 1e-9);
});

// ---------------------------------------------------------------- picking control points

test("a control point is picked by its handle, and named by where it is in the grid", () => {
  const e = withPatch();
  const handle = handleFor(e, 1, 2)!;
  const out = patchTool.click!(at(0, 0, { hit: { node: "p1", handle } }), e)!;
  assert.ok(out.set, "a click on a control point picks it");
  const after = out.set!(e);
  assert.deepEqual(after.selection.vertices, [{ node: "p1", vertex: handle.part }]);
  assert.equal(out.note, "control point 1, 2 of p1");
});

test("a part number is a place in the grid, and one past the end is not a place at all", () => {
  const grid = patchShape("plane", [0, 0, 0], [4, 0, 4]).grid;
  assert.deepEqual(pointOfPart(grid, 0), { row: 0, column: 0 });
  assert.deepEqual(pointOfPart(grid, 5), { row: 1, column: 2 });
  assert.deepEqual(pointOfPart(grid, 8), { row: 2, column: 2 });
  assert.equal(pointOfPart(grid, 9), undefined);
});

test("a picked control point survives a prune, and one whose span was taken away does not", () => {
  const e = withPatch();
  const picked = { ...e, selection: selectVertices(e.selection, [{ node: "p1", vertex: 8 }]) };
  assert.deepEqual(prune(picked.world, picked.selection).vertices, [{ node: "p1", vertex: 8 }]);
  const beyond = { ...e, selection: selectVertices(e.selection, [{ node: "p1", vertex: 9 }]) };
  assert.deepEqual(prune(beyond.world, beyond.selection).vertices, []);
});

// ---------------------------------------------------------------- bending one

test("dragging a control point moves it, and the drag is one undo entry", () => {
  const tools = new ToolBox([patchTool]);
  let h = history(withPatch());
  const handle = handleFor(h.editor, 1, 1)!;
  const grab = at(400, 200, { hit: { node: "p1", handle } });
  tools.down(grab, h.editor);
  for (let i = 1; i <= 10; i++) h = apply(h, tools.move(at(400 + i * 4, 200, { hit: grab.hit }), h.editor));
  h = apply(h, tools.up(at(440, 200, { hit: grab.hit }), h.editor));

  const grid = onlyPatch(h.editor).patch.grid;
  assert.equal(h.past.length, 1, "ten frames of one drag are one entry");
  assert.ok(Math.abs(grid[1]![1]![0]! - 2) > 0.1, "the middle handle did not move");
  nearVec(grid[0]![0]!, [0, 0, 0], 1e-9);
  assert.equal(rowsOf(grid), 3, "a drag reshapes the grid rather than resizing it");
});

test("dragging a cylinder's seam drags its twin, so the tube stays closed", () => {
  const tools = new ToolBox([patchTool]);
  let h = history(withPatch("cylinder"));
  const handle = handleFor(h.editor, 0, 0)!;
  const grab = at(400, 200, { hit: { node: "p1", handle } });
  tools.down(grab, h.editor);
  h = apply(h, tools.move(at(440, 220, { hit: grab.hit }), h.editor));
  h = apply(h, tools.up(at(440, 220, { hit: grab.hit }), h.editor));

  const row = onlyPatch(h.editor).patch.grid[0]!;
  nearVec(row[0]!, row[8]!, 1e-9);
});

test("a stack of control points in one place draws one handle, because they all move together", () => {
  const cone = patchShape("cone", [0, 0, 0], [4, 4, 4]);
  const handles = patchHandles("p1", cone.grid);
  const tip = cone.grid[2]![0]!;
  assert.equal(handles.filter((h) => h.at.every((v, i) => Math.abs(v - tip[i]!) < 1e-9)).length, 1);
});

test("the handles of a patch light up the control points that are picked", () => {
  const grid = patchShape("plane", [0, 0, 0], [4, 0, 4]).grid;
  const lit = patchHandles("p1", grid, new Set([4]));
  assert.equal(lit.find((h) => h.part === 4)!.flags, 1, "SELECTED is bit one");
  assert.equal(lit.find((h) => h.part === 0)!.flags, 0);
});

// ---------------------------------------------------------------- the keys

test("r and c add a span, and held the other way take one off", () => {
  reset();
  let h = history(withPatch());
  const press = (key: string, shift = false) =>
    (h = apply(h, patchTool.press!(key, at(0, 0, { mods: { shift, ctrl: false, alt: false } }), h.editor)));

  press("r");
  assert.deepEqual(spansOf(onlyPatch(h.editor).patch.grid), { down: 2, across: 1 });
  press("c");
  assert.deepEqual(spansOf(onlyPatch(h.editor).patch.grid), { down: 2, across: 2 });
  press("c", true);
  assert.deepEqual(spansOf(onlyPatch(h.editor).patch.grid), { down: 2, across: 1 });
  press("r", true);
  assert.deepEqual(spansOf(onlyPatch(h.editor).patch.grid), { down: 1, across: 1 });
});

test("adding a span leaves the surface where it was — it is a split, not a stretch", () => {
  let h = history(withPatch("dome"));
  const before = patchBounds(onlyPatch(h.editor).patch.grid);
  h = apply(h, patchTool.press!("c", at(0, 0), h.editor));
  const after = patchBounds(onlyPatch(h.editor).patch.grid);
  nearVec(after.min, before.min, 1e-9);
  nearVec(after.max, before.max, 1e-9);
});

test("a span operation drops the picked control points, because they were named by place", () => {
  const e = withPatch();
  const picked = { ...e, selection: selectVertices(e.selection, [{ node: "p1", vertex: 4 }]) };
  const out = patchTool.press!("r", at(0, 0), picked)!;
  assert.deepEqual(out.set!(picked).selection.vertices, []);
});

test("f flips the surface and s puts every handle back on the grid", () => {
  let h = history(withPatch());
  const before = onlyPatch(h.editor).patch.grid;
  h = apply(h, patchTool.press!("f", at(0, 0), h.editor));
  const flipped = onlyPatch(h.editor).patch.grid;
  nearVec(flipped[0]![0]!, before[2]![0]!, 1e-9);

  const off = patchShape("plane", [0.06, 0, 0.06], [4.06, 0, 4.06]);
  let g = history({ ...h.editor, world: {
    ...h.editor.world,
    layers: [{ ...h.editor.world.layers[0]!, children: [patchNode(off, { id: "p1" })] }],
  } });
  g = apply(g, patchTool.press!("s", at(0, 0), g.editor));
  nearVec(onlyPatch(g.editor).patch.grid[0]![0]!, [0, 0, 0], 1e-9);
});

test("a key that no patch is selected for is left for somebody else to claim", () => {
  assert.equal(patchTool.press!("f", at(0, 0), empty()), undefined);
  assert.equal(patchTool.press!("z", at(0, 0), withPatch()), undefined);
});

test("the settings keys cycle the shape and change its depth", () => {
  reset();
  assert.equal(patchTool.press!("tab", undefined, empty())?.note, "cylinder");
  assert.equal(patchTool.press!("+", undefined, empty())?.note, "5 cells deep");
  assert.equal(patchTool.press!("-", undefined, empty())?.note, "4 cells deep");
  setPatch({ cells: 1 });
  patchTool.press!("-", undefined, empty());
  assert.ok(patchSettings.cells >= 1, "a patch one cell deep is as flat as a solid of revolution gets");
  reset();
});

report("patch-tool");
