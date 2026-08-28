// The two rules that make selection feel like TrenchBroom rather than like a tree view: a click selects
// the group, and faces and objects never coexist.
// Run with: node --experimental-strip-types src/doc/selection.check.ts
import assert from "node:assert/strict";
import { report, test } from "../check.ts";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import {
  brushNode, entityNode, groupNode, layerNode, nodeBounds, nodeById, removeNodes, updateNode,
  type BrushNode, type World,
} from "./document.ts";
import { octreeOf } from "./octree.ts";
import {
  NOTHING, isEmpty, isFaceSelected, isSelectable, isSelected, prune, resolve, selectAll, selectAllFaces,
  selectEdges, selectFaces, selectInBox, selectNodes, selectSiblings, selectTouching, selectVertices,
  selectedBrushes, selectedNodes, selectionBounds, selectionCentre,
} from "./selection.ts";
import { setVec3 } from "./props.ts";

const box = (min: [number, number, number], max: [number, number, number]): BrushNode =>
  brushNode(brushOf(cuboid({ min, max })));

function map() {
  const a = box([0, 0, 0], [1, 1, 1]);
  const b = box([2, 0, 0], [3, 1, 1]);
  const loose = box([0, 4, 0], [1, 5, 1]);
  const light = entityNode("pointLight", { props: setVec3([], "position", [5, 5, 5]) });
  const group = groupNode("pillars", [a, b]);
  const main = layerNode("Main", [group, loose, light]);
  const world: World = { layers: [main], broom: { grid: -2, scale: 1 } };
  return { world, a, b, loose, light, group, main };
}

/** what a viewport would index: the top level of every layer, each by its own extent */
const tree = (world: World) =>
  octreeOf(
    world.layers
      .flatMap((l) => l.children)
      .flatMap((n) => {
        const bounds = nodeBounds(n);
        return bounds ? [{ id: n.id, bounds }] : [];
      }),
  );

test("clicking a solid in a group selects the group, and clicking one outside selects it", () => {
  const { world, a, group, loose } = map();
  assert.equal(resolve(world, a.id), group.id);
  assert.equal(resolve(world, loose.id), loose.id);
  assert.deepEqual(selectNodes(world, NOTHING, [a.id]).nodes, [group.id]);
});

test("once the group is open, its solids are their own", () => {
  const { world, a, group } = map();
  assert.deepEqual(selectNodes(world, NOTHING, [a.id], "replace", group.id).nodes, [a.id]);
});

test("locked and hidden nodes cannot be picked at all", () => {
  const { world, loose } = map();
  const locked = updateNode(world, loose.id, (n) => ({ ...n, broom: { locked: true } }));
  assert.ok(!isSelectable(locked, loose.id));
  assert.deepEqual(selectNodes(locked, NOTHING, [loose.id]).nodes, []);
  const hidden = updateNode(world, loose.id, (n) => ({ ...n, broom: { hidden: true } }));
  assert.deepEqual(selectNodes(hidden, NOTHING, [loose.id]).nodes, []);
});

test("the four ways a click combines with what was already selected", () => {
  const { world, loose, light, group } = map();
  const one = selectNodes(world, NOTHING, [loose.id]);
  assert.deepEqual(selectNodes(world, one, [light.id], "add").nodes, [loose.id, light.id]);
  assert.deepEqual(selectNodes(world, one, [light.id]).nodes, [light.id], "replace");
  assert.deepEqual(selectNodes(world, one, [loose.id], "toggle").nodes, [], "toggle off");
  assert.deepEqual(selectNodes(world, one, [group.id], "toggle").nodes, [loose.id, group.id], "toggle on");
  assert.deepEqual(selectNodes(world, one, [loose.id], "remove").nodes, []);
  assert.ok(isSelected(one, loose.id) && !isSelected(one, light.id));
});

test("a click on nothing clears the selection, but adding nothing does not", () => {
  const { world, loose } = map();
  const one = selectNodes(world, NOTHING, [loose.id]);
  assert.ok(isEmpty(selectNodes(world, one, [])), "clicking empty space");
  assert.deepEqual(selectNodes(world, one, [], "add").nodes, [loose.id], "a shift-click that hit nothing");
});

test("select all takes the top level, or the inside of the open group", () => {
  const { world, group, loose, light, a, b } = map();
  assert.deepEqual(selectAll(world).nodes, [group.id, loose.id, light.id]);
  assert.deepEqual(selectAll(world, group.id).nodes, [a.id, b.id]);
});

test("siblings are the other children of the same parent", () => {
  const { world, a, b, group } = map();
  assert.deepEqual(selectSiblings(world, { ...NOTHING, nodes: [a.id] }).nodes, [a.id, b.id]);
  assert.deepEqual(selectSiblings(world, { ...NOTHING, nodes: [group.id] }).nodes.length, 3, "a group's siblings");
});

// ---------------------------------------------------------------- faces

test("selecting a face drops the objects, and selecting an object drops the faces", () => {
  const { world, loose } = map();
  const objects = selectNodes(world, NOTHING, [loose.id]);
  const faces = selectFaces(world, objects, [{ node: loose.id, face: 0 }]);
  assert.deepEqual(faces.nodes, [], "the objects went");
  assert.ok(isFaceSelected(faces, { node: loose.id, face: 0 }));
  assert.deepEqual(selectNodes(world, faces, [loose.id]).faces, [], "and the faces went back");
});

test("a face of a locked solid, or of something that is not a solid, is not a face", () => {
  const { world, light, loose } = map();
  assert.deepEqual(selectFaces(world, NOTHING, [{ node: light.id, face: 0 }]).faces, []);
  const locked = updateNode(world, loose.id, (n) => ({ ...n, broom: { locked: true } }));
  assert.deepEqual(selectFaces(locked, NOTHING, [{ node: loose.id, face: 0 }]).faces, []);
});

test("every face of a selected group is reachable in one step", () => {
  const { world, group } = map();
  const all = selectAllFaces(world, selectNodes(world, NOTHING, [group.id]));
  assert.equal(all.faces.length, 12, "six faces on each of two solids");
  assert.deepEqual(all.nodes, []);
});

test("handles belong to a solid, and choosing them puts the faces away", () => {
  const { world, loose } = map();
  const faces = selectFaces(world, NOTHING, [{ node: loose.id, face: 0 }]);
  const verts = selectVertices(faces, [{ node: loose.id, vertex: 0 }, { node: loose.id, vertex: 3 }]);
  assert.deepEqual(verts.faces, []);
  assert.equal(verts.vertices.length, 2);
  assert.equal(selectVertices(verts, [{ node: loose.id, vertex: 3 }], "toggle").vertices.length, 1);
  const edges = selectEdges(NOTHING, [{ node: loose.id, a: 1, b: 0 }]);
  assert.equal(selectEdges(edges, [{ node: loose.id, a: 0, b: 1 }], "toggle").edges.length, 0, "an edge has no direction");
});

// ---------------------------------------------------------------- reading it back

test("the selected solids are found through groups, and through a face selection", () => {
  const { world, group, a, b, loose } = map();
  const objects = selectNodes(world, NOTHING, [group.id]);
  assert.deepEqual(selectedBrushes(world, objects).map((n) => n.id), [a.id, b.id]);
  const faces = selectFaces(world, NOTHING, [{ node: loose.id, face: 2 }, { node: loose.id, face: 3 }]);
  assert.deepEqual(selectedBrushes(world, faces).map((n) => n.id), [loose.id], "the same solid once");
});

test("the selection comes back in tree order, whatever order it was clicked in", () => {
  const { world, loose, group } = map();
  const s = selectNodes(world, selectNodes(world, NOTHING, [loose.id]), [group.id], "add");
  assert.deepEqual(selectedNodes(world, s).map((n) => n.id), [group.id, loose.id]);
});

test("the transform box covers objects, and for faces only the face", () => {
  const { world, group, loose } = map();
  assert.deepEqual(selectionBounds(world, selectNodes(world, NOTHING, [group.id])), { min: [0, 0, 0], max: [3, 1, 1] });
  const face = selectFaces(world, NOTHING, [{ node: loose.id, face: 0 }]);
  assert.deepEqual(selectionBounds(world, face), { min: [1, 4, 0], max: [1, 5, 1] }, "the +x face is a flat box");
  assert.deepEqual(selectionCentre(world, selectNodes(world, NOTHING, [loose.id])), [0.5, 4.5, 0.5]);
  assert.equal(selectionBounds(world, NOTHING), undefined);
});

// ---------------------------------------------------------------- staying honest

test("a selection that points at something gone is pruned, not left dangling", () => {
  const { world, loose } = map();
  const s = selectNodes(world, NOTHING, [loose.id]);
  assert.deepEqual(prune(removeNodes(world, [loose.id]), s).nodes, []);
  assert.equal(prune(world, s), s, "and an untouched selection is the same object");
});

test("locking a layer drops what was selected on it, rather than leaving it unmovable", () => {
  const { world, loose, main } = map();
  const s = selectNodes(world, NOTHING, [loose.id]);
  const locked = updateNode(world, main.id, (n) => ({ ...n, broom: { locked: true } }));
  assert.deepEqual(prune(locked, s).nodes, []);
});

test("a face selection is pruned when the solid loses that face", () => {
  const { world, loose } = map();
  const s = selectFaces(world, NOTHING, [{ node: loose.id, face: 5 }]);
  const fewer = updateNode<BrushNode>(world, loose.id, (n) => ({
    ...n,
    brush: { poly: { ...n.brush.poly, faces: n.brush.poly.faces.slice(0, 4) }, faces: n.brush.faces.slice(0, 4) },
  }));
  assert.deepEqual(prune(fewer, s).faces, []);
});

// ---------------------------------------------------------------- the rubber band

test("a rubber band takes what it touches, or only what it swallows", () => {
  const { world, group, loose, light } = map();
  const t = tree(world);
  const dragged = (box: Parameters<typeof selectInBox>[2], whole: boolean) =>
    selectInBox(world, t, box, whole).nodes.slice().sort();
  assert.deepEqual(dragged({ min: [-1, -1, -1], max: [10, 10, 10] }, false), [group.id, loose.id, light.id].sort());
  assert.deepEqual(dragged({ min: [-1, 3, -1], max: [2, 6, 2] }, true), [loose.id], "the light and the group are elsewhere");
  assert.deepEqual(dragged({ min: [-1, 4.5, -1], max: [2, 6, 2] }, true), [], "half in is not in");
  assert.deepEqual(dragged({ min: [-1, 4.5, -1], max: [2, 6, 2] }, false), [loose.id], "but half in is touching");
});

test("what the selection touches is found without a drag, and does not include itself", () => {
  const a = box([0, 0, 0], [2, 2, 2]);
  const b = box([2, 0, 0], [4, 2, 2]);
  const far = box([20, 0, 0], [22, 2, 2]);
  const world: World = { layers: [layerNode("Main", [a, b, far])], broom: { grid: -2, scale: 1 } };
  const t = octreeOf([a, b, far].map((n) => ({ id: n.id, bounds: { min: n.brush.poly.vertices[0]!, max: n.brush.poly.vertices[7]! } })));
  const touching = selectTouching(world, selectNodes(world, NOTHING, [a.id]), t);
  assert.deepEqual(touching.nodes, [b.id]);
});

test("a group whose only child was deleted still resolves clicks on what is left", () => {
  const { world, group, a, b } = map();
  const smaller = removeNodes(world, [b.id]);
  assert.equal(nodeById(smaller, group.id)?.kind, "group");
  assert.deepEqual(selectNodes(smaller, NOTHING, [a.id]).nodes, [group.id]);
});

report("selection");
