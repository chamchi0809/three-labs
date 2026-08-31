/**
 * The hierarchy's flat list and its drop arithmetic — the half of drag and drop that is not pixels.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/doc/tree.check.ts
 */
import { strict as assert } from "node:assert";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { report, test } from "../check.ts";
import {
  brushNode, groupNode, layerNode, moveNodes, nodeById, objectNode, childrenOf,
  type NodeId, type World,
} from "./document.ts";
import { dropAt, dropOn, rowsOf, zoneOf } from "./tree.ts";

const a = objectNode("mesh", { sheetId: "a" });
const b = objectNode("mesh", { sheetId: "b" });
// a solid is the only thing in a level that cannot hold children: an object can, which is the whole
// point of a hierarchy — a lamp under a lift moves with the lift
const c = brushNode(brushOf(cuboid({ min: [0, 0, 0], max: [1, 1, 1] })), { sheetId: "c" });
const inner = groupNode("inner", [c]);
const group = groupNode("room", [b, inner]);
const worldOf = (): World =>
  ({ layers: [layerNode("Main", [a, group])], broom: { grid: -2, scale: 1 } });

const names = (world: World) => rowsOf(world).map((r) => r.node.sheetId ?? nameOf(world, r.node.id));
const nameOf = (world: World, id: NodeId) => {
  const node = nodeById(world, id);
  return node && (node.kind === "group" || node.kind === "layer") ? node.name : id;
};
const row = (world: World, id: NodeId) => rowsOf(world).find((r) => r.node.id === id)!;

// ---------------------------------------------------------------- the flat list

test("the tree is one array in document order, each row knowing its depth and its parent", () => {
  const world = worldOf();
  assert.deepEqual(names(world), ["Main", "a", "room", "b", "inner", "c"]);
  assert.deepEqual(rowsOf(world).map((r) => r.depth), [0, 1, 1, 2, 2, 3]);
  assert.equal(row(world, a.id).parent, world.layers[0]!.id);
  assert.equal(row(world, world.layers[0]!.id).parent, undefined, "a root belongs to the world");
  assert.deepEqual([row(world, a.id).index, row(world, group.id).index], [0, 1]);
  assert.deepEqual([row(world, group.id).kids, row(world, a.id).kids], [2, 0]);
});

test("a collapsed parent takes its whole subtree off the list", () => {
  const world = worldOf();
  assert.deepEqual(rowsOf(world, new Set([group.id])).map((r) => r.node.id).includes(c.id), false);
  assert.deepEqual(rowsOf(world, new Set([inner.id])).map((r) => r.node.sheetId ?? ""), ["", "a", "", "b", ""]);
  assert.equal(row(world, group.id).open, true);
  assert.equal(rowsOf(world, new Set([group.id])).find((r) => r.node.id === group.id)!.open, false);
  assert.equal(row(world, a.id).open, false, "a leaf is never open");
});

test("hidden and locked say whose flag it is: this node's, or something above it", () => {
  const world: World = {
    layers: [layerNode("Main", [groupNode("room", [b], { broom: { hidden: true } })], { broom: { locked: true } })],
    broom: { grid: -2, scale: 1 },
  };
  const rows = rowsOf(world);
  const room = rows.find((r) => r.node.kind === "group")!;
  const leaf = rows.find((r) => r.node.id === b.id)!;
  assert.deepEqual([room.hidden, room.locked], [true, false]);
  assert.deepEqual(room.byParent, { hidden: false, locked: true });
  assert.deepEqual([leaf.hidden, leaf.locked], [false, false]);
  assert.deepEqual(leaf.byParent, { hidden: true, locked: true }, "both come down the tree");
});

// ---------------------------------------------------------------- where a drag means to put things

test("a row that holds children gives a quarter to each edge; a leaf splits down the middle", () => {
  assert.deepEqual([zoneOf(0.1, true), zoneOf(0.5, true), zoneOf(0.9, true)], ["before", "inside", "after"]);
  assert.deepEqual([zoneOf(0.4, false), zoneOf(0.6, false)], ["before", "after"]);
});

test("a drop reads as a parent and an index, and the line is drawn at the depth it lands", () => {
  const world = worldOf();
  const rows = rowsOf(world);
  const at = (id: NodeId, t: number, moving: NodeId[] = [c.id]) =>
    dropOn(world, rows, rows.findIndex((r) => r.node.id === id), t, moving);

  assert.deepEqual(at(a.id, 0.1), { where: "before", row: a.id, parent: world.layers[0]!.id, index: 0, depth: 1 });
  assert.deepEqual(at(a.id, 0.9), { where: "after", row: a.id, parent: world.layers[0]!.id, index: 1, depth: 1 });
  // inside a group appends, and the line belongs one step further in than the row it was dropped on
  assert.deepEqual(at(group.id, 0.5), { where: "inside", row: group.id, parent: group.id, index: 2, depth: 2 });
  // a solid has no inside: the middle of it is still a side
  assert.equal(at(c.id, 0.5, [a.id])!.where, "after");
  assert.equal(at(a.id, 0.5)!.where, "inside", "an object with no children can still take one");
});

test("a drop that cannot happen offers no marker at all", () => {
  const world = worldOf();
  const rows = rowsOf(world);
  const at = (id: NodeId, t: number, moving: NodeId[]) =>
    dropOn(world, rows, rows.findIndex((r) => r.node.id === id), t, moving);
  const root = world.layers[0]!.id;

  assert.equal(at(root, 0.1, [a.id])!.where, "inside", "a root has no siblings, so its whole height is inside");
  assert.notEqual(at(group.id, 0.5, [group.id])!.where, "inside", "a group cannot go inside itself");
  assert.equal(at(inner.id, 0.5, [group.id]), undefined, "nor inside anything it contains");
  assert.equal(at(c.id, 0.9, [group.id]), undefined, "which includes beside anything it contains");
  assert.equal(at(a.id, 0.5, [a.id])!.where, "after", "a drop that changes nothing is still a drop");

  const shut: World = {
    layers: [layerNode("Main", [groupNode("box", [], { broom: { locked: true } }), a])],
    broom: { grid: -2, scale: 1 },
  };
  const shutRows = rowsOf(shut);
  assert.equal(dropOn(shut, shutRows, 1, 0.5, [a.id]), undefined, "a locked parent takes no deliveries");
});

// ---------------------------------------------------------------- the index moveNodes wants

test("dragging down inside one parent lands where the line was, not one short", () => {
  const world: World = { layers: [layerNode("Main", [a, b, c])], broom: { grid: -2, scale: 1 } };
  const root = world.layers[0]!.id;
  const order = (w: World) => childrenOf(nodeById(w, root)!).map((n) => n.sheetId);

  // a, b, c → drop `a` after `c`: the visible index is 3, but only b and c are left to count
  assert.equal(dropAt(world, root, [a.id], 3), 2);
  assert.deepEqual(order(moveNodes(world, [a.id], root, dropAt(world, root, [a.id], 3))), ["b", "c", "a"]);

  // and upwards, where nothing moving sits before the line, the two indexes agree
  assert.equal(dropAt(world, root, [c.id], 0), 0);
  assert.deepEqual(order(moveNodes(world, [c.id], root, dropAt(world, root, [c.id], 0))), ["c", "a", "b"]);

  // two at once, dropped between what is left
  assert.equal(dropAt(world, root, [a.id, b.id], 2), 0);
  assert.deepEqual(order(moveNodes(world, [a.id, b.id], root, dropAt(world, root, [a.id, b.id], 2))), ["a", "b", "c"]);

  // a move to another parent counts nothing, because nothing moving was ever in it
  const nested = worldOf();
  assert.equal(dropAt(nested, group.id, [a.id], 2), 2);
});

report("tree");
