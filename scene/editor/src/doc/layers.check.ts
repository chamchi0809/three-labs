/**
 * Layers, hiding, locking, and the one that is easy to get wrong: isolate.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/doc/layers.check.ts
 */
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { report, test } from "../check.ts";
import {
  brushNode, groupNode, isHidden, isLocked, layerNode, nodeById, type NodeId, type World,
} from "./document.ts";
import { newEditor } from "./editor.ts";
import {
  addLayer, defaultLayer, freshLayerName, hiddenBecause, hideSelected, isolateSelected, lockSelected,
  moveToLayer, removeLayer, renameLayer, setHidden, showAll, toggleHidden, toggleLocked, unlockAll,
} from "./layers.ts";
import { NOTHING } from "./selection.ts";

const box = (min: Vec3 = [0, 0, 0], max: Vec3 = [1, 1, 1]) => brushNode(brushOf(cuboid({ min, max })));
const pick = (world: World, ...nodes: NodeId[]) =>
  ({ ...newEditor(world), selection: { ...NOTHING, nodes } });

// ---------------------------------------------------------------- the layer list

test("a new layer gets a name nobody is using", () => {
  let world: World = { layers: [layerNode("Layer")], broom: { grid: -2, scale: 1 } };
  assert.equal(freshLayerName(world), "Layer 2");
  world = addLayer(world).world;
  assert.deepEqual(world.layers.map((l) => l.name), ["Layer", "Layer 2"]);
  assert.equal(addLayer(world).layer.name, "Layer 3");
});

test("removing a layer keeps what was on it", () => {
  const solid = box();
  const world: World = {
    layers: [layerNode("Ground", [box()]), layerNode("Upper", [solid])],
    broom: { grid: -2, scale: 1 },
  };
  const after = removeLayer(world, world.layers[1]!.id);
  assert.equal(after.layers.length, 1);
  assert.ok(nodeById(after, solid.id), "the geometry moved down rather than away");
});

test("the last layer cannot be removed, because the next solid would have nowhere to go", () => {
  const world: World = { layers: [layerNode("Ground")], broom: { grid: -2, scale: 1 } };
  assert.equal(removeLayer(world, world.layers[0]!.id), world);
});

test("a layer can be renamed, but not to nothing", () => {
  const world: World = { layers: [layerNode("Ground")], broom: { grid: -2, scale: 1 } };
  const id = world.layers[0]!.id;
  assert.equal(renameLayer(world, id, " Rooftop ").layers[0]!.name, "Rooftop");
  assert.equal(renameLayer(world, id, "   ").layers[0]!.name, "Ground");
});

test("the selection moves onto another layer and nothing else does", () => {
  const solid = box();
  const stays = box();
  const world: World = {
    layers: [layerNode("Ground", [solid, stays]), layerNode("Upper")],
    broom: { grid: -2, scale: 1 },
  };
  const upper = world.layers[1]!.id;
  const after = moveToLayer(pick(world, solid.id), upper);
  assert.deepEqual((nodeById(after.world, upper) as { children: { id: string }[] }).children.map((n) => n.id), [solid.id]);
  assert.deepEqual(after.world.layers[0]!.children.map((n) => n.id), [stays.id]);
  assert.equal(defaultLayer(after.world).id, world.layers[0]!.id);
});

// ---------------------------------------------------------------- hiding and locking

test("hiding a group hides what is inside it without saying so on every child", () => {
  const inner = box();
  const group = groupNode("room", [inner]);
  const world: World = { layers: [layerNode("Ground", [group])], broom: { grid: -2, scale: 1 } };

  const after = setHidden(world, group.id, true);
  assert.ok(isHidden(after, inner.id));
  assert.equal(nodeById(after, inner.id)!.broom.hidden, undefined, "one flag, not one per node");
  assert.equal(hiddenBecause(after, inner.id), "parent");
  assert.equal(hiddenBecause(after, group.id), "self");
  assert.equal(hiddenBecause(showAll(after), inner.id), undefined, "show all reaches down the tree");
});

test("a flag turned off is removed rather than written as false, so the sheet stays quiet", () => {
  const solid = box();
  const world: World = { layers: [layerNode("Ground", [solid])], broom: { grid: -2, scale: 1 } };
  const on = toggleHidden(world, solid.id);
  assert.equal(nodeById(on, solid.id)!.broom.hidden, true);
  const off = toggleHidden(on, solid.id);
  assert.ok(!("hidden" in nodeById(off, solid.id)!.broom));
});

test("hiding the selection clears it, and locking it does too", () => {
  const a = box();
  const b = box([2, 0, 0], [3, 1, 1]);
  const world: World = { layers: [layerNode("Ground", [a, b])], broom: { grid: -2, scale: 1 } };

  const hidden = hideSelected(pick(world, a.id));
  assert.deepEqual(hidden.selection.nodes, [], "editing what you cannot see is how a map gets broken");
  assert.ok(isHidden(hidden.world, a.id));
  assert.ok(!isHidden(hidden.world, b.id));

  const locked = lockSelected(pick(world, a.id));
  assert.ok(isLocked(locked.world, a.id));
  assert.deepEqual(locked.selection.nodes, []);
  assert.ok(!isLocked(unlockAll(locked.world), a.id));
});

test("locking a layer locks everything on it, and unlock all lets go of the lot", () => {
  const solid = box();
  const world: World = { layers: [layerNode("Ground", [solid])], broom: { grid: -2, scale: 1 } };
  const locked = toggleLocked(world, world.layers[0]!.id);
  assert.ok(isLocked(locked, solid.id));
  assert.ok(!isLocked(unlockAll(locked), solid.id));
});

// ---------------------------------------------------------------- isolate

test("isolate leaves the selection visible and hides everything else", () => {
  const kept = box();
  const sibling = box([2, 0, 0], [3, 1, 1]);
  const elsewhere = box([9, 0, 0], [10, 1, 1]);
  const room = groupNode("room", [kept, sibling]);
  const world: World = {
    layers: [layerNode("Ground", [room]), layerNode("Upper", [elsewhere])],
    broom: { grid: -2, scale: 1 },
  };

  const after = isolateSelected(pick(world, kept.id)).world;
  assert.ok(!isHidden(after, kept.id));
  assert.ok(isHidden(after, sibling.id));
  assert.ok(isHidden(after, elsewhere.id));
  assert.equal(nodeById(after, room.id)!.broom.hidden, undefined, "the group holding it stayed visible");
  assert.equal(after.layers[1]!.broom.hidden, true, "a layer with nothing in the selection goes as a whole");
});

test("isolate is a view, not a pile: the second one shows the second thing", () => {
  const a = box();
  const b = box([2, 0, 0], [3, 1, 1]);
  const world: World = { layers: [layerNode("Ground", [a, b])], broom: { grid: -2, scale: 1 } };

  const first = isolateSelected(pick(world, a.id)).world;
  const second = isolateSelected(pick(first, b.id)).world;
  assert.ok(!isHidden(second, b.id));
  assert.ok(isHidden(second, a.id));
});

test("isolating a whole group keeps its children visible without touching them", () => {
  const inner = box();
  const room = groupNode("room", [inner]);
  const other = box([9, 0, 0], [10, 1, 1]);
  const world: World = { layers: [layerNode("Ground", [room, other])], broom: { grid: -2, scale: 1 } };

  const after = isolateSelected(pick(world, room.id)).world;
  assert.ok(!isHidden(after, inner.id));
  assert.ok(isHidden(after, other.id));
});

test("isolating nothing changes nothing, because it would otherwise hide the entire map", () => {
  const world: World = { layers: [layerNode("Ground", [box()])], broom: { grid: -2, scale: 1 } };
  const e = newEditor(world);
  assert.equal(isolateSelected(e), e);
});

report("layers");
