// The tree, and the promises the rest of the editor makes on top of it: that an untouched subtree comes
// back as the very same object, that lock and hide are inherited, and that a group can be taken apart
// and put back where it was.
// Run with: node --experimental-strip-types src/doc/document.check.ts
import assert from "node:assert/strict";
import { report, test } from "../check.ts";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import type { Bounds } from "../brush/builder.ts";
import {
  boundsContain, boundsOverlap, brushNode, brushesUnder, emptyWorld, entityBounds, entityNode, groupNodes,
  groupNode, groupOf, insertNodes, isHidden, isLocked, layerNode, layerOf, moveNodes, nodeBounds, nodeById,
  parents, pathTo, removeNodes, replaceNode, subtreeIds, ungroup, union, updateNode, walk, worldBounds,
  type BrushNode, type World,
} from "./document.ts";
import { numberOf, propOf, setProp, setVec3, str, vec3Of } from "./props.ts";

const box = (min: [number, number, number], max: [number, number, number]): BrushNode =>
  brushNode(brushOf(cuboid({ min, max })));

/** two layers: one with a group of two solids and a light, one with a single solid */
function map() {
  const a = box([0, 0, 0], [1, 1, 1]);
  const b = box([2, 0, 0], [3, 1, 1]);
  const light = entityNode("pointLight", { props: setVec3([], "position", [5, 5, 5]) });
  const group = groupNode("pillars", [a, b]);
  const main = layerNode("Main", [group, light]);
  const far = box([10, 0, 0], [11, 1, 1]);
  const detail = layerNode("Detail", [far]);
  const world: World = { layers: [main, detail], broom: { grid: -2, scale: 1 } };
  return { world, a, b, light, group, main, far, detail };
}

test("walking reaches everything, parents before children", () => {
  const { world, main, group, a, detail } = map();
  const order = [...walk(world)].map((n) => n.id);
  assert.ok(order.includes(a.id), "the deepest solid is reached");
  assert.ok(order.indexOf(main.id) < order.indexOf(group.id), "the layer comes before its group");
  assert.ok(order.indexOf(group.id) < order.indexOf(a.id), "the group before its solids");
  assert.ok(order.indexOf(main.id) < order.indexOf(detail.id), "layers in the order they are listed");
});

test("a node can be found, and its path back to its layer read off", () => {
  const { world, a, group, main } = map();
  assert.equal(nodeById(world, a.id), a);
  assert.deepEqual(pathTo(world, a.id).map((n) => n.id), [main.id, group.id, a.id]);
  assert.equal(layerOf(world, a.id)?.id, main.id);
  assert.deepEqual(pathTo(world, "nobody"), []);
});

test("every node knows its parent, in one pass", () => {
  const { world, a, group, main } = map();
  const p = parents(world);
  assert.equal(p.get(a.id), group.id);
  assert.equal(p.get(group.id), main.id);
  assert.equal(p.get(main.id), undefined);
});

test("a click resolves to the outermost group until that group is opened", () => {
  const { world, a, group } = map();
  assert.equal(groupOf(world, a.id)?.id, group.id);
  assert.equal(groupOf(world, a.id, group.id), undefined, "inside the opened group, the solid is itself");
});

test("locking and hiding are inherited, and only downwards", () => {
  const { world, a, group, main, far } = map();
  const locked = updateNode(world, group.id, (n) => ({ ...n, broom: { ...n.broom, locked: true } }));
  assert.ok(isLocked(locked, a.id), "a solid in a locked group");
  assert.ok(!isLocked(locked, far.id), "a solid on another layer");
  const hidden = updateNode(world, main.id, (n) => ({ ...n, broom: { ...n.broom, hidden: true } }));
  assert.ok(isHidden(hidden, a.id), "a hidden layer hides everything on it");
  assert.ok(!isHidden(hidden, far.id));
});

test("a change to one branch leaves every other branch as the same object", () => {
  const { world, a, detail, main } = map();
  const after = updateNode<BrushNode>(world, a.id, (n) => ({ ...n, broom: { locked: true } }));
  assert.equal(after.layers[1], detail, "the untouched layer is not even copied");
  assert.notEqual(after.layers[0], main, "the branch that changed did change");
});

test("a change to a node that is not there changes nothing at all", () => {
  const { world } = map();
  assert.equal(updateNode(world, "nobody", (n) => n), world);
  assert.equal(replaceNode(world, "nobody", undefined), world);
  assert.equal(removeNodes(world, []), world);
});

test("nodes can be removed several at a time", () => {
  const { world, a, light } = map();
  const after = removeNodes(world, [a.id, light.id]);
  assert.equal(nodeById(after, a.id), undefined);
  assert.equal(nodeById(after, light.id), undefined);
  assert.equal([...walk(after)].length, [...walk(world)].length - 2);
});

test("nodes can be inserted where they are asked for", () => {
  const { world, group, a } = map();
  const fresh = box([9, 9, 9], [10, 10, 10]);
  const after = insertNodes(world, group.id, [fresh], 0);
  const kids = (nodeById(after, group.id) as { children: BrushNode[] }).children;
  assert.deepEqual(kids.map((n) => n.id), [fresh.id, a.id, kids[2]!.id]);
});

test("a node moved to another parent leaves its old one and belongs to nobody in between", () => {
  const { world, a, detail, group } = map();
  const after = moveNodes(world, [a.id], detail.id);
  assert.equal(pathTo(after, a.id)[0]!.id, detail.id, "it is on the other layer now");
  assert.equal((nodeById(after, group.id) as { children: unknown[] }).children.length, 1, "and not on the old one");
});

test("a group cannot be moved inside itself", () => {
  const { world, group, a } = map();
  assert.equal(moveNodes(world, [group.id], a.id), world, "nothing happened, rather than a cycle");
});

test("grouping and ungrouping put things back where they were", () => {
  const { world, light, far } = map();
  const { world: grouped, group } = groupNodes(world, [light.id], "lamps");
  assert.ok(group, "a group was made");
  assert.equal(pathTo(grouped, light.id).map((n) => n.id).includes(group!.id), true);
  const { world: back, freed } = ungroup(grouped, group!.id);
  assert.deepEqual(freed, [light.id]);
  assert.equal(nodeById(back, group!.id), undefined, "the group is gone");
  assert.equal(layerOf(back, light.id)?.name, "Main", "and its child is back on its layer");
  assert.ok(nodeById(back, far.id), "nothing else moved");
});

test("ungrouping leaves the children where the group was in the list", () => {
  const world = emptyWorld();
  const one = box([0, 0, 0], [1, 1, 1]);
  const two = box([2, 0, 0], [3, 1, 1]);
  const three = box([4, 0, 0], [5, 1, 1]);
  const layer = world.layers[0]!.id;
  let w = insertNodes(world, layer, [one, two, three]);
  const { world: grouped, group } = groupNodes(w, [two.id], "middle");
  w = ungroup(grouped, group!.id).world;
  const order = (nodeById(w, layer) as { children: BrushNode[] }).children.map((n) => n.id);
  assert.deepEqual(order, [one.id, three.id, two.id], "grouping moved it to the end, and ungrouping left it there");
});

test("every id under a node is reachable from it", () => {
  const { group, a, b } = map();
  assert.deepEqual([...subtreeIds(group)], [group.id, a.id, b.id]);
});

test("solids are found through however many groups", () => {
  const { world, main, a, b } = map();
  const found = [...brushesUnder(nodeById(world, main.id)!)].map((n) => n.id);
  assert.deepEqual(found, [a.id, b.id]);
});

// ---------------------------------------------------------------- extent

test("a solid's extent is its own, and a group's is all of them", () => {
  const { world, a, group, main } = map();
  assert.deepEqual(nodeBounds(a), { min: [0, 0, 0], max: [1, 1, 1] });
  assert.deepEqual(nodeBounds(nodeById(world, group.id)!), { min: [0, 0, 0], max: [3, 1, 1] });
  const layer = nodeBounds(nodeById(world, main.id)!)!;
  assert.deepEqual(layer.max, [5, 5, 5], "the light counts too");
});

test("an entity with a stated size is a box about its origin, and one without is a point", () => {
  const sized = entityNode("info_player_start", {
    props: setVec3([], "position", [4, 0, 4]),
    broom: { size: [-0.5, 0, -0.5, 0.5, 1.8, 0.5] },
  });
  assert.deepEqual(entityBounds(sized), { min: [3.5, 0, 3.5], max: [4.5, 1.8, 4.5] });
  const bare = entityNode("mesh");
  assert.deepEqual(entityBounds(bare), { min: [0, 0, 0], max: [0, 0, 0] });
});

test("an empty layer encloses nothing, and does not make the world enclose nothing", () => {
  const { world } = map();
  assert.equal(nodeBounds(layerNode("Empty")), undefined);
  assert.deepEqual(worldBounds(world)!.max, [11, 5, 5]);
  assert.equal(worldBounds(emptyWorld()), undefined);
});

test("boxes overlap, contain, and combine", () => {
  const a: Bounds = { min: [0, 0, 0], max: [2, 2, 2] };
  const b: Bounds = { min: [1, 1, 1], max: [3, 3, 3] };
  assert.ok(boundsOverlap(a, b));
  assert.ok(boundsOverlap(a, { min: [2, 0, 0], max: [4, 1, 1] }), "touching counts");
  assert.ok(!boundsOverlap(a, { min: [2.1, 0, 0], max: [4, 1, 1] }));
  assert.ok(boundsContain(a, { min: [0.5, 0.5, 0.5], max: [1, 1, 1] }));
  assert.ok(!boundsContain(a, b));
  assert.deepEqual(union(a, b), { min: [0, 0, 0], max: [3, 3, 3] });
  assert.equal(union(undefined, undefined), undefined);
  assert.equal(union(a, undefined), a);
});

// ---------------------------------------------------------------- properties

test("a property is read as what it literally says, and nothing is guessed", () => {
  const props = setVec3([], "position", [1, 2, 3]);
  assert.deepEqual(vec3Of(props, "position"), [1, 2, 3]);
  assert.equal(vec3Of(props, "scale"), undefined);
  assert.equal(vec3Of(setProp([], "position", str("over there")), "position"), undefined);
  assert.equal(numberOf(setProp([], "intensity", { start: 0, end: 0, kind: "number", value: 3, unit: "" }), "intensity"), 3);
});

test("setting a property that was already there keeps the range it came from", () => {
  const from: Parameters<typeof setProp>[0] = [
    { start: 10, end: 30, kind: "prop", name: "position", value: { start: 20, end: 30, kind: "number", value: 1, unit: "" } },
  ];
  const after = setProp(from, "position", { start: 0, end: 0, kind: "number", value: 2, unit: "" });
  assert.deepEqual([propOf(after, "position")!.start, propOf(after, "position")!.end], [10, 30]);
});

test("a property that was not there is appended, so the author's order survives", () => {
  const props = setProp(setProp([], "a", str("1")), "b", str("2"));
  assert.deepEqual(props.map((m) => (m.kind === "prop" ? m.name : "")), ["a", "b"]);
  assert.deepEqual(setProp(props, "a", str("9")).map((m) => (m.kind === "prop" ? m.name : "")), ["a", "b"]);
});

report("document");
