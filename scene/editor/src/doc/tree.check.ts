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
  const at = (id: NodeId, t: number, moving: NodeId[] = [c.id], depth = row(world, id).depth + 1) =>
    dropOn(world, rows, rows.findIndex((r) => r.node.id === id), t, depth, moving);

  assert.deepEqual(at(a.id, 0.1), { where: "before", row: a.id, parent: world.layers[0]!.id, index: 0, depth: 1 });
  assert.deepEqual(at(a.id, 0.9), { where: "after", row: a.id, parent: world.layers[0]!.id, index: 1, depth: 1 });
  // inside a group appends, and the line belongs one step further in than the row it was dropped on
  assert.deepEqual(at(group.id, 0.5), { where: "inside", row: group.id, parent: group.id, index: 2, depth: 2 });
  // a solid has no inside: the middle of it is still a side
  assert.equal(at(c.id, 0.5, [a.id])!.where, "after");
  assert.equal(at(a.id, 0.5)!.where, "inside", "an object with no children can still take one");
});

test("pulling the end of a subtree left drops after its ancestor instead of back inside it", () => {
  const world = worldOf();
  const rows = rowsOf(world);
  const at = (depth: number) => dropOn(world, rows, 5, 0.9, depth, [a.id]);

  assert.deepEqual(at(3), { where: "after", row: c.id, parent: inner.id, index: 1, depth: 3 });
  assert.deepEqual(at(2), { where: "after", row: c.id, parent: group.id, index: 2, depth: 2 });
  assert.deepEqual(at(1), {
    where: "after", row: c.id, parent: world.layers[0]!.id, index: 2, depth: 1,
  });

  const followedGroup = groupNode("room", [inner, b]);
  const followed: World = {
    layers: [layerNode("Main", [a, followedGroup])],
    broom: { grid: -2, scale: 1 },
  };
  const followedRows = rowsOf(followed);
  const cIndex = followedRows.findIndex((candidate) => candidate.node.id === c.id);
  assert.deepEqual(
    dropOn(followed, followedRows, cIndex, 0.9, 1, [a.id]),
    { where: "after", row: c.id, parent: followedGroup.id, index: 1, depth: 2 },
    "the pointer cannot outdent past a sibling that still follows inside the ancestor",
  );
});

test("a container's own indent band makes its upper and lower halves sibling insertion targets", () => {
  const first = groupNode("first", [c]);
  const world: World = {
    layers: [layerNode("Main", [first, a])],
    broom: { grid: -2, scale: 1 },
  };
  const root = world.layers[0]!.id;
  const rows = rowsOf(world);
  const groupIndex = rows.findIndex((candidate) => candidate.node.id === first.id);
  const childIndex = rows.findIndex((candidate) => candidate.node.id === c.id);

  const before = dropOn(world, rows, groupIndex, 0.4, 1, [c.id]);
  assert.deepEqual(before, { where: "before", row: first.id, parent: root, index: 0, depth: 1 });
  assert.deepEqual(
    childrenOf(nodeById(moveNodes(world, [c.id], root, dropAt(world, root, [c.id], before!.index)), root)!)
      .map((node) => node.id),
    [c.id, first.id, a.id],
    "a child dragged above the first group is unparented before it",
  );

  const siblingBefore = dropOn(world, rows, groupIndex, 0.4, 1, [a.id]);
  assert.deepEqual(siblingBefore, { where: "before", row: first.id, parent: root, index: 0, depth: 1 });

  const after = dropOn(world, rows, childIndex, 0.6, 1, [c.id]);
  assert.deepEqual(after, { where: "after", row: c.id, parent: root, index: 1, depth: 1 });
  assert.deepEqual(
    childrenOf(nodeById(moveNodes(world, [c.id], root, dropAt(world, root, [c.id], after!.index)), root)!)
      .map((node) => node.id),
    [first.id, c.id, a.id],
    "a child dragged left at the expanded group's bottom is unparented after it",
  );

  assert.deepEqual(
    dropOn(world, rows, groupIndex, 0.6, 1, [a.id]),
    { where: "after", row: c.id, parent: root, index: 1, depth: 1 },
    "an expanded group's after marker is drawn below its last visible child",
  );
  assert.equal(dropOn(world, rows, groupIndex, 0.6, 2, [a.id])!.where, "inside");
});

test("a nested group can cross depth zero and become a root layer between two others", () => {
  const gameplay = groupNode("Gameplay", [a]);
  const architecture = layerNode("Architecture", [gameplay]);
  const lighting = layerNode("Lighting");
  const world: World = { layers: [architecture, lighting], broom: { grid: -2, scale: 1 } };
  const rows = rowsOf(world);
  const gameplayIndex = rows.findIndex((candidate) => candidate.node.id === gameplay.id);

  const afterArchitecture = dropOn(world, rows, gameplayIndex, 0.5, 0, [gameplay.id]);
  assert.deepEqual(afterArchitecture, {
    where: "after", row: a.id, parent: undefined, index: 1, depth: 0,
  });
  const promoted = moveNodes(
    world,
    [gameplay.id],
    undefined,
    dropAt(world, undefined, [gameplay.id], afterArchitecture!.index),
  );
  assert.deepEqual(promoted.layers.map((layer) => layer.name), ["Architecture", "Gameplay", "Lighting"]);
  assert.deepEqual(rowsOf(promoted).map((candidate) => candidate.depth), [0, 0, 1, 0]);
  assert.equal(promoted.layers[0]!.children.length, 0);
  assert.equal(promoted.layers[1]!.kind, "layer");

  const architectureIndex = rows.findIndex((candidate) => candidate.node.id === architecture.id);
  const aboveArchitecture = dropOn(world, rows, architectureIndex, 0.4, 0, [gameplay.id]);
  assert.deepEqual(aboveArchitecture, {
    where: "before", row: architecture.id, parent: undefined, index: 0, depth: 0,
  });
  const promotedBefore = moveNodes(world, [gameplay.id], undefined, aboveArchitecture!.index);
  assert.deepEqual(promotedBefore.layers.map((layer) => layer.name), ["Gameplay", "Architecture", "Lighting"]);

  const nestedAgain = moveNodes(promoted, [gameplay.id], architecture.id, 0);
  assert.equal(nodeById(nestedAgain, gameplay.id)!.kind, "group", "a layer nested again becomes a group");
});

test("a drop that cannot happen offers no marker at all", () => {
  const world = worldOf();
  const rows = rowsOf(world);
  const at = (id: NodeId, t: number, moving: NodeId[]) =>
    dropOn(world, rows, rows.findIndex((r) => r.node.id === id), t, row(world, id).depth + 1, moving);
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
  assert.equal(dropOn(shut, shutRows, 1, 0.5, 2, [a.id]), undefined, "a locked parent takes no deliveries");
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
