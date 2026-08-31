/**
 * Groups, and the promise a linked group makes.
 *
 * The promise is: edit one copy and the others change to match, *except* for what makes them separate
 * things — their `#id`, and whatever they protect. Nearly all of this file is that exception, because
 * propagation working is easy to see by eye and the exception is not.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/doc/groups.check.ts
 */
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { brushBounds, brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { rotation, translation } from "../brush/vec.ts";
import { report, test } from "../check.ts";
import {
  brushNode, objectNode, groupNode, layerNode, nodeById, removeNodes, updateNode,
  type BrushNode, type GroupNode, type NodeId, type World,
} from "./document.ts";
import { newEditor } from "./editor.ts";
import {
  atOf, closeGroup, duplicateSelected, freshLink, groupSelected, keepInStep, linkGroups, linkedCopy,
  linkedWith, membersOf, openGroup, propagate, propagateFrom, protectedNames, separateGroup,
  settleLinks, ungroupSelected,
} from "./groups.ts";
import { setNumber, setString, numberOf, stringOf } from "./props.ts";
import { NOTHING } from "./selection.ts";
import { transformNodes } from "./transform.ts";
import type { Node } from "./document.ts";

const box = (min: Vec3, max: Vec3) => brushNode(brushOf(cuboid({ min, max })));
const world = (...children: Node[]): World =>
  ({ layers: [layerNode("Main", children)], broom: { grid: -2, scale: 1 } });
const minOf = (w: World, id: NodeId) => brushBounds((nodeById(w, id) as BrushNode).brush)!.min;
const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);
const nearVec = (a: Vec3, b: Vec3, eps = 1e-9) => { for (let i = 0; i < 3; i++) near(a[i]!, b[i]!, eps); };

// ---------------------------------------------------------------- plain groups

test("grouping the selection leaves the group selected, and ungrouping leaves its children selected", () => {
  const a = box([0, 0, 0], [1, 1, 1]);
  const b = box([2, 0, 0], [3, 1, 1]);
  const e = { ...newEditor(world(a, b)), selection: { ...NOTHING, nodes: [a.id, b.id] } };

  const grouped = groupSelected(e, "room");
  assert.equal(grouped.selection.nodes.length, 1);
  const group = nodeById(grouped.world, grouped.selection.nodes[0]!) as GroupNode;
  assert.equal(group.kind, "group");
  assert.equal(group.name, "room");
  assert.deepEqual(group.children.map((n) => n.id), [a.id, b.id]);

  const back = ungroupSelected(grouped);
  assert.deepEqual(back.selection.nodes.sort(), [a.id, b.id].sort());
  assert.equal(nodeById(back.world, group.id), undefined);
  assert.ok(nodeById(back.world, a.id), "the children outlived the group that held them");
});

test("stepping into a group and back out again leaves the editor where it started", () => {
  const inner = box([0, 0, 0], [1, 1, 1]);
  const group = groupNode("room", [inner]);
  const e = { ...newEditor(world(group)), selection: { ...NOTHING, nodes: [group.id] } };

  const inside = openGroup(e, group.id);
  assert.equal(inside.open, group.id);
  assert.deepEqual(inside.selection.nodes, [], "stepping in means the group is no longer what is meant");

  const out = closeGroup(inside);
  assert.equal(out.open, undefined);
  assert.deepEqual(out.selection.nodes, [group.id]);
});

test("stepping out of a nested group lands in the one outside it, not at the top", () => {
  const inner = groupNode("desk", [box([0, 0, 0], [1, 1, 1])]);
  const outer = groupNode("room", [inner]);
  const e = openGroup(newEditor(world(outer)), inner.id);
  assert.equal(closeGroup(e).open, outer.id);
});

test("a duplicate is a new node with no #id of its own, and it is what is selected", () => {
  const a = box([0, 0, 0], [1, 1, 1]);
  const named = { ...a, sheetId: "crate" };
  const e = { ...newEditor(world(named)), selection: { ...NOTHING, nodes: [named.id] } };
  const done = duplicateSelected(e);

  assert.equal(done.selection.nodes.length, 1);
  const copy = nodeById(done.world, done.selection.nodes[0]!)!;
  assert.notEqual(copy.id, named.id);
  assert.equal(copy.sheetId, undefined, "two nodes answering to #crate is a sheet that reads back wrong");
  nearVec(minOf(done.world, copy.id), [0, 0, 0], 1e-12);
});

// ---------------------------------------------------------------- reading a link

test("a group says which set it is in and what it keeps to itself", () => {
  const g = groupNode("room", [], { broom: { link: "room", protect: "name  visible" } });
  assert.deepEqual(protectedNames(g), ["name", "visible"]);
  assert.deepEqual(atOf(g), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], "no `at` means the set's own space");
  assert.deepEqual(protectedNames(groupNode("plain")), []);
});

test("a link name is derived from the group's name and never collides", () => {
  const taken = groupNode("Great Hall", [], { broom: { link: "great-hall" } });
  assert.equal(freshLink(world(taken), "Great Hall"), "great-hall-2");
  assert.equal(freshLink(world(taken), "Store Room"), "store-room");
  assert.equal(freshLink(world(taken), "  "), "group");
});

// ---------------------------------------------------------------- making copies

test("a linked copy stands where it was put, and both copies know the set", () => {
  const source = groupNode("room", [box([0, 0, 0], [1, 1, 1])]);
  const made = linkedCopy(world(source), source.id, translation([10, 0, 0]));
  assert.ok(made.copy);

  const members = membersOf(made.world, "room");
  assert.equal(members.length, 2);
  nearVec(minOf(made.world, (made.copy!.children[0] as BrushNode).id), [10, 0, 0], 1e-9);
  nearVec(atOf(made.copy!).slice(0, 4) as unknown as Vec3, [1, 0, 0] as Vec3);
  near(atOf(made.copy!)[3]!, 10);
  assert.deepEqual(linkedWith(made.world, source.id).map((g) => g.id), [made.copy!.id]);
});

test("two groups that were moved apart can be linked without either of them jumping", () => {
  const a = groupNode("room", [box([0, 0, 0], [2, 2, 2])]);
  const b = groupNode("room", [box([10, 0, 0], [12, 2, 2])]);
  const linked = linkGroups(world(a, b), [a.id, b.id]);

  const after = propagate(linked, a.id);
  nearVec(minOf(after, (b.children[0] as BrushNode).id), [10, 0, 0], 1e-9);
  nearVec(minOf(after, (a.children[0] as BrushNode).id), [0, 0, 0], 1e-12);
});

test("linking needs two groups; one on its own is left alone", () => {
  const a = groupNode("room");
  const w = world(a);
  assert.equal(linkGroups(w, [a.id]), w);
});

// ---------------------------------------------------------------- propagation

test("an edit in one copy reaches the other, moved into its place", () => {
  const source = groupNode("room", [box([0, 0, 0], [1, 1, 1])]);
  const { world: w, copy } = linkedCopy(world(source), source.id, translation([10, 0, 0]));
  const mine = (source.children[0] as BrushNode).id;
  const theirs = (copy!.children[0] as BrushNode).id;

  // the source's solid is moved a metre up, by hand, the way a drag would
  const moved = updateNode<BrushNode>(w, mine, (n) => brushNode(
    brushOf(cuboid({ min: [0, 1, 0], max: [1, 2, 1] })), { id: n.id, broom: n.broom, props: n.props }));
  const settled = propagate(moved, source.id);

  nearVec(minOf(settled, theirs), [10, 1, 0], 1e-9);
  assert.ok(nodeById(settled, theirs), "the copy's own node id survived the rebuild");
});

test("a rotated copy replays the edit turned into its own frame", () => {
  const source = groupNode("room", [box([0, 0, 0], [1, 1, 1])]);
  const turn = rotation([0, 1, 0], Math.PI / 2);
  const { world: w, copy } = linkedCopy(world(source), source.id, turn);
  const mine = (source.children[0] as BrushNode).id;

  const grown = updateNode<BrushNode>(w, mine, (n) => brushNode(
    brushOf(cuboid({ min: [0, 0, 0], max: [4, 1, 1] })), { id: n.id, broom: n.broom, props: n.props }));
  const settled = propagate(grown, source.id);
  // a quarter turn about +Y sends +x to −z, so the copy grew along −z instead
  const box2 = brushBounds((nodeById(settled, (copy!.children[0] as BrushNode).id) as BrushNode).brush)!;
  nearVec(box2.min, [0, 0, -4], 1e-9);
  nearVec(box2.max, [1, 1, 0], 1e-9);
});

test("a protected property stays the copy's own while everything else follows", () => {
  const lamp = objectNode("pointLight", { props: setNumber(setString([], "label", "north"), "intensity", 1) });
  const source = groupNode("lamp", [lamp]);
  const { world: made, copy } = linkedCopy(world(source), source.id, translation([10, 0, 0]));

  // the copy's lamp is given a name of its own and told to keep it
  const theirs = copy!.children[0]!.id;
  let w = updateNode(made, theirs, (n) => ({
    ...n, broom: { ...n.broom, protect: "label" }, props: setString(n.props, "label", "south"),
  }));
  // then the source's lamp is turned up
  w = updateNode(w, lamp.id, (n) => ({ ...n, props: setNumber(n.props, "intensity", 4) }));
  const settled = propagate(w, source.id);

  const after = nodeById(settled, theirs)!;
  assert.equal(numberOf(after.props, "intensity"), 4, "the shared property followed");
  assert.equal(stringOf(after.props, "label"), "south", "the protected one did not");
  assert.equal(after.broom.protect, "label", "and the copy still knows it is protecting it");
});

test("a protected property the source has and the copy does not stays absent from the copy", () => {
  const lamp = objectNode("pointLight");
  const source = groupNode("lamp", [lamp]);
  const { world: made, copy } = linkedCopy(world(source), source.id, translation([10, 0, 0]));
  const theirs = copy!.children[0]!.id;

  let w = updateNode(made, theirs, (n) => ({ ...n, broom: { ...n.broom, protect: "label" } }));
  w = updateNode(w, lamp.id, (n) => ({ ...n, props: setString(n.props, "label", "north") }));
  const after = nodeById(propagate(w, source.id), theirs)!;
  assert.equal(stringOf(after.props, "label"), undefined, "protecting a property protects not having it");
});

test("a #id never travels, so two copies never both answer to one name", () => {
  const lamp = objectNode("pointLight", { sheetId: "north-lamp" });
  const source = groupNode("lamp", [lamp]);
  const { world: made, copy } = linkedCopy(world(source), source.id, translation([10, 0, 0]));
  const theirs = copy!.children[0]!.id;

  const named = updateNode(made, theirs, (n) => ({ ...n, sheetId: "south-lamp" }));
  const after = nodeById(propagate(named, source.id), theirs)!;
  assert.equal(after.sheetId, "south-lamp");
});

test("hiding one copy does not hide the others", () => {
  const source = groupNode("room", [box([0, 0, 0], [1, 1, 1])]);
  const { world: made, copy } = linkedCopy(world(source), source.id, translation([10, 0, 0]));
  const theirs = copy!.children[0]!.id;
  const hidden = updateNode(made, theirs, (n) => ({ ...n, broom: { ...n.broom, hidden: true } }));
  const settled = propagate(hidden, source.id);
  assert.equal(nodeById(settled, theirs)!.broom.hidden, true);
  assert.equal(nodeById(settled, source.children[0]!.id)!.broom.hidden, undefined);
});

test("propagation finds the group from anything inside it, however deep", () => {
  const inner = box([0, 0, 0], [1, 1, 1]);
  const nested = groupNode("desk", [inner]);
  const source = groupNode("room", [nested]);
  const { world: made, copy } = linkedCopy(world(source), source.id, translation([10, 0, 0]));

  const moved = updateNode<BrushNode>(made, inner.id, (n) => brushNode(
    brushOf(cuboid({ min: [0, 3, 0], max: [1, 4, 1] })), { id: n.id, broom: n.broom, props: n.props }));
  const settled = propagateFrom(moved, inner.id);
  const theirs = ((copy!.children[0] as GroupNode).children[0] as BrushNode).id;
  nearVec(minOf(settled, theirs), [10, 3, 0], 1e-9);
});

test("settling several changed nodes propagates each set once and leaves loose nodes alone", () => {
  const loose = box([0, 0, 0], [1, 1, 1]);
  const source = groupNode("room", [box([0, 0, 0], [1, 1, 1])]);
  const { world: made } = linkedCopy(world(loose, source), source.id, translation([10, 0, 0]));
  const both = settleLinks(made, [loose.id, source.children[0]!.id]);
  assert.equal(membersOf(both, "room").length, 2);
  nearVec(minOf(both, loose.id), [0, 0, 0], 1e-12);
});

test("moving a linked copy moves where it stands, so the next edit does not snap it back", () => {
  const source = groupNode("room", [box([0, 0, 0], [1, 1, 1])]);
  const { world: made, copy } = linkedCopy(world(source), source.id, translation([10, 0, 0]));

  // the copy is dragged a further two metres along z, the way the move tool does it
  const dragged = transformNodes(made, [copy!.id], translation([0, 0, 2]));
  assert.deepEqual(dragged.problems, []);
  const settled = propagate(dragged.world, source.id);
  nearVec(minOf(settled, (copy!.children[0] as BrushNode).id), [10, 0, 2], 1e-9);
});

test("a group taken out of its set stops following, and a set of one stops being a set", () => {
  const source = groupNode("room", [box([0, 0, 0], [1, 1, 1])]);
  const { world: made, copy } = linkedCopy(world(source), source.id, translation([10, 0, 0]));

  const apart = separateGroup(made, copy!.id);
  assert.equal(nodeById(apart, copy!.id)!.broom.link, undefined);
  assert.equal(nodeById(apart, source.id)!.broom.link, undefined,
    "one group on its own is not a linked group, and saying so in the sheet would be a lie");
  assert.deepEqual(membersOf(apart, "room"), []);
});

// ---------------------------------------------------------------- what the command processor does

test("an edit inside an opened copy reaches the other copies, without the tool asking", () => {
  const source = groupNode("room", [box([0, 0, 0], [1, 1, 1])]);
  const { world: made, copy } = linkedCopy(world(source), source.id, translation([10, 0, 0]));

  // the designer steps into the copy and drags its solid, which is all a tool ever does
  const before = { ...newEditor(made), open: copy!.id, selection: { ...NOTHING, nodes: [copy!.children[0]!.id] } };
  const dragged = transformNodes(made, [copy!.children[0]!.id], translation([0, 0, 3]));
  const after = keepInStep(before, { ...before, world: dragged.world });

  nearVec(minOf(after.world, source.children[0]!.id), [0, 0, 3], 1e-9);
  nearVec(minOf(after.world, copy!.children[0]!.id), [10, 0, 3], 1e-9);
});

test("an edit that touched no set, or changed nothing at all, is handed back untouched", () => {
  const loose = box([0, 0, 0], [1, 1, 1]);
  const before = { ...newEditor(world(loose)), selection: { ...NOTHING, nodes: [loose.id] } };
  assert.equal(keepInStep(before, before), before, "a command that changed nothing is left alone");

  const moved = transformNodes(before.world, [loose.id], translation([1, 0, 0]));
  const after = { ...before, world: moved.world };
  assert.equal(keepInStep(before, after), after, "a solid in no set costs no copy of the editor");
});

test("a copy deleted from a set still settles the set it was deleted from", () => {
  const source = groupNode("room", [box([0, 0, 0], [1, 1, 1]), box([2, 0, 0], [3, 1, 1])]);
  const { world: made, copy } = linkedCopy(world(source), source.id, translation([10, 0, 0]));

  // the second solid is deleted from inside the source; the id is gone by the time the command ends, and
  // only the open group is left to say which set was touched
  const gone = removeNodes(made, [source.children[1]!.id]);
  const before = { ...newEditor(made), open: source.id, selection: { ...NOTHING, nodes: [source.children[1]!.id] } };
  const after = keepInStep(before, { ...before, world: gone });
  assert.equal((nodeById(after.world, copy!.id) as GroupNode).children.length, 1);
});

test("an unlinked group propagates to nothing rather than to everything", () => {
  const a = groupNode("room", [box([0, 0, 0], [1, 1, 1])]);
  const w = world(a);
  assert.equal(propagate(w, a.id), w);
  assert.equal(propagateFrom(w, a.children[0]!.id), w);
});

report("groups");
