// The document-to-picture diff: that a world becomes buffers, that syncing the same world twice touches
// nothing, that a selection is floats rather than geometry, and that hidden and locked mean what the tree
// says they mean. Nothing here draws — the point is exactly that the diff is decidable without a GPU.
// Run with: node --experimental-strip-types src/render/scene.check.ts
import assert from "node:assert/strict";
import type { BufferAttribute } from "three/webgpu";
import { report, test } from "../check.ts";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import {
  brushNode, groupNode, layerNode, type BrushNode, type LayerNode, type World,
} from "../doc/document.ts";
import { newEditor, type Editor } from "../doc/editor.ts";
import { entryOf, flagsOf, FACE_SELECTED, HOVERED, LOCKED, OUTSIDE, SELECTED } from "./batch.ts";
import {
  clearScene, newRenderScene, sceneBounds, setDecor, setHover, syncHandles, syncScene,
} from "./scene.ts";

// A label rasterises text onto a canvas, and node has neither a canvas nor a document. What this file is
// about is the diff, which does not care what a label looks like — only that one is placed — so the two
// calls text.ts makes are stubbed here rather than the renderer being taught to work without text.
(globalThis as { document?: unknown }).document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      font: "",
      textBaseline: "",
      fillStyle: "",
      measureText: (text: string) => ({ width: text.length * 7 }),
      beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, fillText() {},
    }),
  }),
};

const solid = (min: [number, number, number], max: [number, number, number]): BrushNode =>
  brushNode(brushOf(cuboid({ min, max })));

/** the position attribute's pending uploads, reset so a check can watch exactly one sync */
function watch(rs: ReturnType<typeof newRenderScene>): BufferAttribute {
  const position = rs.faceMesh.geometry.getAttribute("position") as BufferAttribute;
  position.clearUpdateRanges();
  return position;
}

/** a world of loose solids in one layer, which is the shape almost every check below wants */
function worldOf(...nodes: BrushNode[]): { world: World; layer: LayerNode } {
  const layer = layerNode("Default", nodes);
  return { world: { layers: [layer], broom: { grid: -2, scale: 1 } }, layer };
}

const editorOf = (world: World): Editor => ({ ...newEditor(world), layer: world.layers[0]!.id });

// ---------------------------------------------------------------- a world becomes buffers

test("every solid in the world is in the batch, with its own span", () => {
  const [a, b] = [solid([0, 0, 0], [1, 1, 1]), solid([4, 0, 0], [5, 1, 1])];
  const { world } = worldOf(a, b);
  const rs = newRenderScene();
  syncScene(rs, editorOf(world));

  assert.equal(rs.brushes.entries.size, 2);
  assert.equal(entryOf(rs.brushes, a.id)!.span.count, 36);
  assert.equal(entryOf(rs.brushes, b.id)!.span.start, 36, "the second solid follows the first");
  assert.equal(rs.edges.entries.size, 2, "and each has its wireframe");
  assert.equal(rs.edges.entries.get(a.id)!.count, 24, "twelve edges, two vertices each");
});

test("the geometry reaches the attributes, and grows with the map", () => {
  const rs = newRenderScene();
  const { world } = worldOf(solid([0, 0, 0], [1, 1, 1]));
  syncScene(rs, editorOf(world));

  const position = rs.faceMesh.geometry.getAttribute("position");
  assert.equal(position.itemSize, 3);
  assert.equal(position.array, rs.brushes.position, "the attribute is a view of the batch, not a copy");
  assert.equal(rs.faceMesh.geometry.drawRange.count, 36, "and only what is used is drawn");

  const more = worldOf(
    ...world.layers[0]!.children as BrushNode[],
    ...Array.from({ length: 40 }, (_, i) => solid([i * 2 + 4, 0, 0], [i * 2 + 5, 1, 1])),
  );
  syncScene(rs, editorOf(more.world));
  assert.equal(rs.faceMesh.geometry.getAttribute("position").array, rs.brushes.position, "re-pointed on growth");
  assert.equal(rs.faceMesh.geometry.drawRange.count, 41 * 36);
});

test("the world box is the union of the solids drawn", () => {
  const rs = newRenderScene();
  const { world } = worldOf(solid([0, 0, 0], [1, 1, 1]), solid([4, -2, 0], [5, 1, 1]));
  syncScene(rs, editorOf(world));
  assert.deepEqual(sceneBounds(rs), { min: [0, -2, 0], max: [5, 1, 1] });
});

test("the grid uniform follows the sheet's exponent, which is what `[` and `]` step", () => {
  const rs = newRenderScene();
  const { world } = worldOf(solid([0, 0, 0], [1, 1, 1]));
  syncScene(rs, { ...editorOf(world), world: { ...world, broom: { grid: 1, scale: 1 } } });
  assert.equal(rs.grid.size.value, 2);
});

// ---------------------------------------------------------------- the diff proper

test("syncing an unchanged world writes nothing at all", () => {
  const rs = newRenderScene();
  const { world } = worldOf(solid([0, 0, 0], [1, 1, 1]), solid([4, 0, 0], [5, 1, 1]));
  const editor = editorOf(world);
  syncScene(rs, editor);

  const before = rs.brushes.position;
  const position = watch(rs);
  syncScene(rs, editor);
  assert.equal(rs.brushes.position, before, "no growth");
  assert.deepEqual(position.updateRanges, [], "and nothing sent to the GPU either");
});

test("a solid the tree replaced is rebuilt; its neighbour is not", () => {
  const a = solid([0, 0, 0], [1, 1, 1]);
  const b = solid([4, 0, 0], [5, 1, 1]);
  const { world, layer } = worldOf(a, b);
  const rs = newRenderScene();
  syncScene(rs, editorOf(world));

  const moved: BrushNode = { ...b, brush: brushOf(cuboid({ min: [4, 2, 0], max: [5, 3, 1] })) };
  const next: World = { ...world, layers: [{ ...layer, children: [a, moved] }] };
  const position = watch(rs);
  syncScene(rs, editorOf(next));

  assert.equal(rs.brushes.entries.size, 2);
  assert.equal(entryOf(rs.brushes, b.id)!.bounds.min[1], 2, "the changed solid moved");
  assert.deepEqual(
    position.updateRanges,
    [{ start: 36 * 3, count: 36 * 3 }],
    "and only the changed solid's vertices went to the GPU",
  );
});

test("a solid taken out of the tree gives its space back", () => {
  const a = solid([0, 0, 0], [1, 1, 1]);
  const b = solid([4, 0, 0], [5, 1, 1]);
  const { world, layer } = worldOf(a, b);
  const rs = newRenderScene();
  syncScene(rs, editorOf(world));

  syncScene(rs, editorOf({ ...world, layers: [{ ...layer, children: [a] }] }));
  assert.equal(rs.brushes.entries.size, 1);
  assert.equal(rs.edges.entries.size, 1);
  assert.equal(rs.brushes.arena.used, 36, "the tail came back rather than leaving a hole");
});

// ---------------------------------------------------------------- state is floats

test("selecting a solid writes flags and not geometry", () => {
  const a = solid([0, 0, 0], [1, 1, 1]);
  const { world } = worldOf(a);
  const rs = newRenderScene();
  const editor = editorOf(world);
  syncScene(rs, editor);

  const before = rs.brushes.position;
  syncScene(rs, { ...editor, selection: { ...editor.selection, nodes: [a.id] } });
  assert.equal(rs.brushes.position, before, "the same buffer");
  assert.equal(flagsOf(rs.brushes, a.id, 0), SELECTED);
  assert.equal(rs.edges.flag[rs.edges.entries.get(a.id)!.start], SELECTED, "the wireframe agrees");
});

test("a selected face is marked on that face alone, and the solid's edges do not claim it", () => {
  const a = solid([0, 0, 0], [1, 1, 1]);
  const { world } = worldOf(a);
  const rs = newRenderScene();
  const editor = editorOf(world);
  syncScene(rs, editor);

  syncScene(rs, { ...editor, selection: { ...editor.selection, faces: [{ node: a.id, face: 2 }] } });
  assert.equal(flagsOf(rs.brushes, a.id, 2), FACE_SELECTED);
  assert.equal(flagsOf(rs.brushes, a.id, 1), 0);
  assert.equal(rs.edges.flag[rs.edges.entries.get(a.id)!.start], 0, "an edge belongs to two faces");
});

test("hover is the renderer's own state and one face of it", () => {
  const a = solid([0, 0, 0], [1, 1, 1]);
  const { world } = worldOf(a);
  const rs = newRenderScene();
  const editor = editorOf(world);
  syncScene(rs, editor);

  assert.equal(setHover(rs, { node: a.id, face: 3 }), true);
  assert.equal(setHover(rs, { node: a.id, face: 3 }), false, "the same hover is not a redraw");
  syncScene(rs, editor);
  assert.equal(flagsOf(rs.brushes, a.id, 3), HOVERED);
  assert.equal(flagsOf(rs.brushes, a.id, 4), 0);

  setHover(rs, { node: a.id });
  syncScene(rs, editor);
  assert.equal(flagsOf(rs.brushes, a.id, 4), HOVERED, "a solid hovered without a face is hovered whole");
});

// ---------------------------------------------------------------- what the tree says

test("a hidden layer costs nothing, not even a span", () => {
  const a = solid([0, 0, 0], [1, 1, 1]);
  const layer = layerNode("Default", [a]);
  const world: World = { layers: [layer], broom: { grid: -2, scale: 1 } };
  const rs = newRenderScene();
  syncScene(rs, editorOf(world));
  assert.equal(rs.brushes.entries.size, 1);

  const hidden: World = { ...world, layers: [{ ...layer, broom: { hidden: true } }] };
  syncScene(rs, editorOf(hidden));
  assert.equal(rs.brushes.entries.size, 0, "gone from the buffers, not flagged in them");
  assert.equal(rs.edges.entries.size, 0);
});

test("lock is inherited, and a locked solid is drawn as locked", () => {
  const a = solid([0, 0, 0], [1, 1, 1]);
  const group = groupNode("props", [a], { broom: { locked: true } });
  const layer = layerNode("Default", [group]);
  const world: World = { layers: [layer], broom: { grid: -2, scale: 1 } };
  const rs = newRenderScene();
  syncScene(rs, editorOf(world));
  assert.equal(flagsOf(rs.brushes, a.id, 0), LOCKED);
});

test("stepping into a group puts everything else outside it", () => {
  const inside = solid([0, 0, 0], [1, 1, 1]);
  const outside = solid([4, 0, 0], [5, 1, 1]);
  const group = groupNode("room", [inside]);
  const layer = layerNode("Default", [group, outside]);
  const world: World = { layers: [layer], broom: { grid: -2, scale: 1 } };
  const rs = newRenderScene();

  syncScene(rs, editorOf(world));
  assert.equal(flagsOf(rs.brushes, outside.id, 0), 0, "with nothing open, nothing is outside");

  syncScene(rs, { ...editorOf(world), open: group.id });
  assert.equal(flagsOf(rs.brushes, inside.id, 0), 0);
  assert.equal(flagsOf(rs.brushes, outside.id, 0), OUTSIDE);
});

// ---------------------------------------------------------------- overlays

test("the selection box is drawn around the selection and taken away with it", () => {
  const a = solid([0, 0, 0], [1, 1, 1]);
  const b = solid([4, 0, 0], [5, 1, 1]);
  const { world } = worldOf(a, b);
  const rs = newRenderScene();
  const editor = editorOf(world);
  syncScene(rs, editor);
  assert.equal(rs.decor.entries.has("bounds"), false, "nothing selected, nothing drawn");

  const selected = { ...editor, selection: { ...editor.selection, nodes: [a.id, b.id] } };
  syncScene(rs, selected);
  const box = rs.decor.entries.get("bounds")!;
  assert.equal(box.count, 24, "twelve edges");
  assert.equal(Math.min(...rs.decor.position.slice(box.start * 3, (box.start + box.count) * 3)), 0);
  assert.equal(Math.max(...rs.decor.position.slice(box.start * 3, (box.start + box.count) * 3)), 5);

  syncScene(rs, editor);
  assert.equal(rs.decor.entries.has("bounds"), false, "the last selection's box does not linger");
});

test("spikes appear while dragging and not otherwise", () => {
  const a = solid([0, 0, 0], [1, 1, 1]);
  const { world } = worldOf(a);
  const rs = newRenderScene();
  const selected = { ...editorOf(world), selection: { ...editorOf(world).selection, nodes: [a.id] } };
  syncScene(rs, selected);
  assert.equal(rs.decor.entries.has("spikes"), false);
  syncScene(rs, { ...selected, note: "dragging" });
  assert.equal(rs.decor.entries.get("spikes")!.count, 6, "three lines through the centre");
});

test("a tool's own lines survive a sync, because a sync happens mid-drag", () => {
  const a = solid([0, 0, 0], [1, 1, 1]);
  const { world } = worldOf(a);
  const rs = newRenderScene();
  const editor = editorOf(world);
  syncScene(rs, editor);

  setDecor(rs, "guide", new Float32Array([0, 0, 0, 1, 0, 0]));
  syncScene(rs, editor);
  assert.equal(rs.decor.entries.has("tool:guide"), true);

  setDecor(rs, "guide", new Float32Array());
  assert.equal(rs.decor.entries.has("tool:guide"), false, "and the tool takes them away itself");
});

// ---------------------------------------------------------------- handles

test("handles are the selection's, in the kinds the tool asked for", () => {
  const a = solid([0, 0, 0], [1, 1, 1]);
  const b = solid([4, 0, 0], [5, 1, 1]);
  const { world } = worldOf(a, b);
  const rs = newRenderScene();
  const editor = editorOf(world);
  const selected = { ...editor, selection: { ...editor.selection, nodes: [a.id] } };
  syncScene(rs, selected);

  syncHandles(rs, selected, { vertices: true });
  assert.equal(rs.handles.count, 8, "one solid's corners, not both solids'");
  assert.equal(rs.handlePoints.geometry.drawRange.count, 8);

  syncHandles(rs, selected, { vertices: true, faces: true });
  assert.equal(rs.handles.count, 14);

  syncHandles(rs, selected, undefined);
  assert.equal(rs.handles.count, 0, "a tool that wants none gets none");
  assert.equal(rs.handlePoints.visible, false);
});

// ---------------------------------------------------------------- starting over

test("clearing keeps the buffers and forgets the map", () => {
  const { world } = worldOf(solid([0, 0, 0], [1, 1, 1]), solid([4, 0, 0], [5, 1, 1]));
  const rs = newRenderScene();
  syncScene(rs, editorOf(world));
  const buffer = rs.brushes.position;

  clearScene(rs);
  assert.equal(rs.brushes.entries.size, 0);
  assert.equal(rs.seen.size, 0);
  assert.equal(rs.hover, undefined);
  assert.equal(rs.brushes.position, buffer, "the capacity a big map earned is kept");

  syncScene(rs, editorOf(world));
  assert.equal(rs.brushes.entries.size, 2, "and it fills again");
});

report("scene");
