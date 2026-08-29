/**
 * The face-attribute tool: what a wall is made of, and where the material sits on it.
 *
 * The gesture that gets used more than every key put together is alt-click — "make these forty faces look
 * like that one" — so it is checked across two solids rather than within one. The drag is checked by the
 * property it exists for: the point of the wall the gesture started on stays under the cursor, whatever the
 * face's rotation and scale happen to be. Everything else is a key applied to the *selection*, never to what
 * is hovered, because a key that acted on the pointer would mean holding the mouse still to press it.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/attributes.check.ts
 */
import { strict as assert } from "node:assert";
import type { Vec2, Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { brushOf, faceNormal, type Brush } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { uvOf, withFace } from "../brush/uv.ts";
import { brushNode, layerNode, nodeById, type BrushNode, type NodeId, type World } from "../doc/document.ts";
import { newEditor, type Editor } from "../doc/editor.ts";
import { NOTHING, selectFaces } from "../doc/selection.ts";
import { metresPerPixel, newView, projectPoint, type Size } from "../viewport/view.ts";
import { attributesTool, changeFaces } from "./attributes.ts";
import { newInput, type InputState } from "./input.ts";

const SIZE: Size = { width: 800, height: 400 };
const FRONT = { ...newView("front"), target: [3, 1, 1] as Vec3, reach: 20 };
const PIXELS = 1 / metresPerPixel(FRONT, SIZE);
const DEGREE = Math.PI / 180;

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);

const ALT = { shift: false, ctrl: false, alt: true };

function faceTowards(brush: Brush, n: Vec3): number {
  const found = brush.poly.faces.findIndex((_, i) => {
    const m = faceNormal(brush, i);
    return Math.abs(m[0] - n[0]) < 1e-6 && Math.abs(m[1] - n[1]) < 1e-6 && Math.abs(m[2] - n[2]) < 1e-6;
  });
  assert.ok(found >= 0, `no face pointing ${n.join(", ")}`);
  return found;
}

/** two cubes facing the front pane, so a material can be copied and slid from one to the other */
function scene() {
  const one = brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [2, 2, 2] })));
  const two = brushNode(brushOf(cuboid({ min: [4, 0, 0], max: [6, 2, 2] })));
  const world: World = { layers: [layerNode("Main", [one, two])], broom: { grid: -2, scale: 1 } };
  const base = newEditor(world);
  const editor: Editor = { ...base, layer: world.layers[0]!.id, material: "brick" };
  return { one, two, north: faceTowards(one.brush, [0, 0, 1]), world, editor };
}

const at = (x: number, y: number, over: Partial<InputState> = {}): InputState =>
  newInput({ camera: FRONT, size: SIZE, at: { x, y }, button: 0, ...over });

const brushIn = (world: World, id: NodeId): Brush => (nodeById(world, id) as BrushNode).brush;
const attributesIn = (world: World, id: NodeId, face: number) => brushIn(world, id).faces[face]!;

/** the editor with some faces picked, which is what every key below acts on */
const picking = (editor: Editor, refs: { node: NodeId; face: number }[]): Editor => ({
  ...editor,
  selection: selectFaces(editor.world, NOTHING, refs, "replace"),
});

const pressed = (editor: Editor, key: string, input?: InputState): Editor => {
  const out = attributesTool.press!(key, input, editor);
  assert.ok(out?.edit, `${key} did nothing`);
  return out.edit!.apply(editor);
};

// ---------------------------------------------------------------- applying a change

test("a change reaches every named face, grouped by the solid it belongs to", () => {
  const { one, two, north, world } = scene();
  const after = changeFaces(
    world,
    [{ node: one.id, face: north }, { node: two.id, face: 0 }, { node: one.id, face: 1 }],
    (b, i) => withFace(b, i, { material: "brick" }),
  );
  assert.equal(brushIn(after, one.id).faces[north]!.material, "brick");
  assert.equal(brushIn(after, one.id).faces[1]!.material, "brick");
  assert.equal(brushIn(after, two.id).faces[0]!.material, "brick");
  assert.equal(brushIn(after, two.id).faces[1]!.material, undefined, "nothing else was touched");
});

test("a face named twice is changed once, because a nudge is not meant to double", () => {
  const { one, north, world } = scene();
  const twice = changeFaces(
    world,
    [{ node: one.id, face: north }, { node: one.id, face: north }],
    (b, i) => withFace(b, i, { offset: [b.faces[i]!.offset[0] + 1, 0] }),
  );
  near(brushIn(twice, one.id).faces[north]!.offset[0]!, 1);
});

test("a face or a solid that is not there is stepped over rather than thrown at", () => {
  const { one, world } = scene();
  const after = changeFaces(
    world,
    [{ node: "nope" as NodeId, face: 0 }, { node: one.id, face: 99 }],
    (b, i) => withFace(b, i, { material: "brick" }),
  );
  assert.deepEqual(after, world);
});

// ---------------------------------------------------------------- the keys

test("nothing picked is a refusal that says so, not an edit that changes nothing", () => {
  const { editor } = scene();
  const out = attributesTool.press!("arrowright", at(0, 0), editor)!;
  assert.equal(out.edit, undefined);
  assert.match(out.note!, /no faces picked/);
});

test("the arrows slide the material by a grid cell each", () => {
  const { one, north, editor } = scene();
  const picked = picking(editor, [{ node: one.id, face: north }]);
  const right = pressed(picked, "arrowright", at(0, 0));
  near(attributesIn(right.world, one.id, north).offset[0]!, 0.25);
  const back = pressed(right, "arrowleft", at(0, 0));
  near(attributesIn(back.world, one.id, north).offset[0]!, 0);
  const up = pressed(picked, "arrowup", at(0, 0));
  near(attributesIn(up.world, one.id, north).offset[1]!, 0.25);
});

test("a turn is fifteen degrees, and alt makes it one", () => {
  const { one, north, editor } = scene();
  const picked = picking(editor, [{ node: one.id, face: north }]);
  near(attributesIn(pressed(picked, ".", at(0, 0)).world, one.id, north).rotation, 15 * DEGREE);
  near(attributesIn(pressed(picked, ",", at(0, 0)).world, one.id, north).rotation, -15 * DEGREE);
  near(attributesIn(pressed(picked, ".", at(0, 0, { mods: ALT })).world, one.id, north).rotation, 1 * DEGREE);
});

test("the size doubles and halves, and reset puts everything back", () => {
  const { one, north, editor } = scene();
  const picked = picking(editor, [{ node: one.id, face: north }]);
  const big = pressed(picked, "=", at(0, 0));
  near(attributesIn(big.world, one.id, north).scale[0]!, 2);
  const small = pressed(big, "-", at(0, 0));
  near(attributesIn(small.world, one.id, north).scale[0]!, 1);

  const messed = pressed(pressed(big, "arrowright", at(0, 0)), ".", at(0, 0));
  const reset = pressed(messed, "0", at(0, 0));
  const a = attributesIn(reset.world, one.id, north);
  assert.deepEqual([a.offset, a.scale, a.rotation], [[0, 0], [1, 1], 0]);
});

test("fit stretches one tile over the whole wall, and flip turns it over", () => {
  const { one, north, editor } = scene();
  const picked = picking(editor, [{ node: one.id, face: north }]);
  const fitted = pressed(picked, "9", at(0, 0));
  const scale = attributesIn(fitted.world, one.id, north).scale;
  near(Math.abs(scale[0]!), 2, 1e-9);
  near(Math.abs(scale[1]!), 2, 1e-9);

  const flipped = pressed(picked, "j", at(0, 0));
  assert.ok(attributesIn(flipped.world, one.id, north).scale[0]! < 0, "flipping across u makes u run backwards");
});

test("enter puts the current material on every picked face, across solids", () => {
  const { one, two, north, editor } = scene();
  const picked = picking(editor, [{ node: one.id, face: north }, { node: two.id, face: 0 }]);
  const after = pressed(picked, "enter", at(0, 0));
  assert.equal(attributesIn(after.world, one.id, north).material, "brick");
  assert.equal(attributesIn(after.world, two.id, 0).material, "brick");
});

test("a key repeated runs on whatever is picked then, not on what was picked when it ran", () => {
  const { one, two, north, editor } = scene();
  const picked = picking(editor, [{ node: one.id, face: north }]);
  const out = attributesTool.press!("arrowright", at(0, 0), picked)!;
  const moved = picking(out.edit!.apply(picked), [{ node: two.id, face: 0 }]);
  const again = out.edit!.again!(moved);
  near(attributesIn(again.world, two.id, 0).offset[0]!, 0.25);
  near(attributesIn(again.world, one.id, north).offset[0]!, 0.25);
});

// ---------------------------------------------------------------- picking and copying

test("clicking a face picks it and adopts its material, so the next solid drawn matches", () => {
  const { one, north, editor } = scene();
  const painted = { ...editor, world: changeFaces(editor.world, [{ node: one.id, face: north }], (b, i) => withFace(b, i, { material: "stone" })) };
  const out = attributesTool.click!(at(400, 200, { hit: { node: one.id, face: north } }), painted)!;
  const after = out.set!(painted);
  assert.deepEqual(after.selection.faces, [{ node: one.id, face: north }]);
  assert.equal(after.material, "stone");
  assert.match(out.note!, /stone/);
});

test("alt-click copies the whole of a face onto everything picked, including onto another solid", () => {
  const { one, two, north, editor } = scene();
  const source: Vec2 = [1, 2];
  const painted: Editor = {
    ...editor,
    world: changeFaces(editor.world, [{ node: one.id, face: north }], (b, i) =>
      withFace(b, i, { material: "stone", offset: source, scale: [4, 4], rotation: 30 * DEGREE })),
  };
  const picked = picking(painted, [{ node: two.id, face: 0 }, { node: two.id, face: 1 }]);
  const out = attributesTool.click!(at(400, 200, { mods: ALT, hit: { node: one.id, face: north } }), picked)!;
  const after = out.edit!.apply(picked);

  for (const face of [0, 1]) {
    const a = attributesIn(after.world, two.id, face);
    assert.equal(a.material, "stone");
    assert.deepEqual(a.offset, source);
    assert.deepEqual(a.scale, [4, 4]);
    near(a.rotation, 30 * DEGREE);
  }
  assert.notEqual(attributesIn(after.world, two.id, 0), attributesIn(painted.world, two.id, 0));
});

test("alt-click with nothing picked says so rather than copying into the void", () => {
  const { one, north, editor } = scene();
  const out = attributesTool.click!(at(400, 200, { mods: ALT, hit: { node: one.id, face: north } }), editor)!;
  assert.equal(out.edit, undefined);
  assert.match(out.note!, /no faces picked/);
});

// ---------------------------------------------------------------- the drag

/** the pixel a point on the north wall of the first cube sits at, so a drag can start exactly on it */
const pixelAt = (p: Vec3) => projectPoint(FRONT, p, SIZE)!;

test("the point the drag started on stays under the cursor", () => {
  const { one, north, editor } = scene();
  const grabbed: Vec3 = [1, 1, 2];
  const pinned = uvOf(one.brush, north, grabbed);
  const start = pixelAt(grabbed);
  const from = at(start.x, start.y, { mods: ALT, hit: { node: one.id, face: north, point: grabbed } });

  const tracker = attributesTool.drag!(from, editor)!;
  const out = tracker.move(at(start.x + PIXELS, start.y, { mods: ALT }), editor)!;
  const after = out.edit!.apply(editor);

  const now = uvOf(brushIn(after.world, one.id), north, [2, 1, 2]);
  near(now[0]!, pinned[0]!, 1e-6);
  near(now[1]!, pinned[1]!, 1e-6);
});

test("without alt the offset itself lands on the grid, so seams stay on grid lines", () => {
  const { one, north, editor } = scene();
  const grabbed: Vec3 = [1, 1, 2];
  const start = pixelAt(grabbed);
  const hit = { node: one.id, face: north, point: grabbed };
  const tracker = attributesTool.drag!(at(start.x, start.y, { hit }), editor)!;

  const small = tracker.move(at(start.x + 0.1 * PIXELS, start.y), editor)!;
  assert.equal(small.edit, undefined, "a tenth of a metre is less than half a cell, so nothing moves");
  assert.match(small.note!, /0 m/);

  const far = tracker.move(at(start.x + 1.6 * PIXELS, start.y), editor)!;
  const offset = attributesIn(far.edit!.apply(editor).world, one.id, north).offset;
  near(offset[0]! % 0.25, 0, 1e-9);
  near(Math.abs(offset[0]!), 1.5, 1e-9);
});

test("a drag on a face of a picked set slides the whole set together", () => {
  const { one, two, north, editor } = scene();
  const far = faceTowards(two.brush, [0, 0, 1]);
  const picked = picking(editor, [{ node: one.id, face: north }, { node: two.id, face: far }]);
  const grabbed: Vec3 = [1, 1, 2];
  const start = pixelAt(grabbed);
  const hit = { node: one.id, face: north, point: grabbed };

  const tracker = attributesTool.drag!(at(start.x, start.y, { hit }), picked)!;
  const after = tracker.move(at(start.x + PIXELS, start.y), picked)!.edit!.apply(picked);
  const a = attributesIn(after.world, one.id, north).offset;
  const b = attributesIn(after.world, two.id, far).offset;
  assert.deepEqual(a, b, "a room's worth of walls slides together and stays aligned");
  near(Math.abs(a[0]!), 1);
});

test("a drag on a face outside the picked set moves only that face", () => {
  const { one, two, north, editor } = scene();
  const far = faceTowards(two.brush, [0, 0, 1]);
  const picked = picking(editor, [{ node: two.id, face: far }]);
  const grabbed: Vec3 = [1, 1, 2];
  const start = pixelAt(grabbed);
  const hit = { node: one.id, face: north, point: grabbed };

  const tracker = attributesTool.drag!(at(start.x, start.y, { hit }), picked)!;
  const after = tracker.move(at(start.x + PIXELS, start.y), picked)!.edit!.apply(picked);
  near(Math.abs(attributesIn(after.world, one.id, north).offset[0]!), 1);
  near(attributesIn(after.world, two.id, far).offset[0]!, 0);
});

test("a drag with nothing under it is declined, and a cancelled one puts the world back", () => {
  const { one, north, editor } = scene();
  assert.equal(attributesTool.drag!(at(400, 200), editor), undefined);

  const grabbed: Vec3 = [1, 1, 2];
  const start = pixelAt(grabbed);
  const hit = { node: one.id, face: north, point: grabbed };
  const tracker = attributesTool.drag!(at(start.x, start.y, { hit }), editor)!;
  const after = tracker.move(at(start.x + PIXELS, start.y), editor)!.edit!.apply(editor);
  const undone = tracker.cancel(after)!.edit!.apply(after);
  near(attributesIn(undone.world, one.id, north).offset[0]!, 0);
});

report("attributes");
