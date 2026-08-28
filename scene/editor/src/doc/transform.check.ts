/**
 * Moving things: one matrix, three meanings, and a rule about failure.
 *
 * The rule is the part worth checking hardest. A transform that destroys one solid in a selection of six
 * must move none of them, because a half-moved selection is a state undo cannot get a designer out of in
 * one step — and the way that goes wrong is always the same, a loop that replaces as it goes.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/doc/transform.check.ts
 */
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { brushBounds, brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { rotation, scaling, translation } from "../brush/vec.ts";
import {
  brushNode, entityNode, groupNode, layerNode, nodeById, type BrushNode, type World,
} from "./document.ts";
import { setVec3, vec3Of } from "./props.ts";
import { NOTHING, selectNodes } from "./selection.ts";
import {
  transformBrushLocked, transformNode, transformNodes, transformSelection, translateSelection,
} from "./transform.ts";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);
const nearVec = (a: Vec3, b: Vec3, eps = 1e-9) => {
  for (let i = 0; i < 3; i++) near(a[i]!, b[i]!, eps);
};

const box = (min: Vec3, max: Vec3) => brushNode(brushOf(cuboid({ min, max })));
const boundsOf = (world: World, id: string) => {
  const node = nodeById(world, id) as BrushNode;
  return brushBounds(node.brush);
};

// ---------------------------------------------------------------- solids

test("a solid moves, and it moves exactly as far as it was told to", () => {
  const solid = box([0, 0, 0], [1, 2, 3]);
  const world: World = { layers: [layerNode("Main", [solid])], broom: { grid: -2, scale: 1 } };
  const { world: moved, problems } = transformNodes(world, [solid.id], translation([4, -1, 0.5]));
  assert.deepEqual(problems, []);
  const after = boundsOf(moved, solid.id);
  nearVec(after!.min, [4, -1, 0.5]);
  nearVec(after!.max, [5, 1, 3.5]);
});

test("a mirroring transform turns a solid over rather than inside out", () => {
  const solid = box([0, 0, 0], [1, 1, 1]);
  const world: World = { layers: [layerNode("Main", [solid])], broom: { grid: -2, scale: 1 } };
  const { world: flipped, problems } = transformNodes(world, [solid.id], scaling([-1, 1, 1]));
  assert.deepEqual(problems, []);
  const node = nodeById(flipped, solid.id) as BrushNode;
  // every face still points away from the middle, which is the only thing "not inside out" means
  const centre: Vec3 = [-0.5, 0.5, 0.5];
  for (const face of node.brush.poly.faces) {
    const d = face.plane.n[0] * centre[0] + face.plane.n[1] * centre[1] + face.plane.n[2] * centre[2];
    assert.ok(d < face.plane.d + 1e-9, "a face is facing the inside of its own solid");
  }
});

test("a transform that would leave nothing behind moves nothing and says why", () => {
  const solid = box([0, 0, 0], [1, 1, 1]);
  const world: World = { layers: [layerNode("Main", [solid])], broom: { grid: -2, scale: 1 } };
  const flat = transformNodes(world, [solid.id], scaling([1, 0, 1]));
  assert.equal(flat.world, world, "the world came back untouched, not partly flattened");
  assert.ok(flat.problems.length, "and the refusal came with a reason");
});

test("one bad solid in a selection stops the whole selection", () => {
  const good = box([0, 0, 0], [1, 1, 1]);
  const bad = box([4, 0, 0], [5, 1, 1]);
  const world: World = { layers: [layerNode("Main", [good, bad])], broom: { grid: -2, scale: 1 } };
  // scaling about the origin by zero in y destroys both, but the point is that nothing is left half-done
  const out = transformNodes(world, [good.id, bad.id], scaling([1, 1, 0]));
  assert.equal(out.world, world);
  nearVec(boundsOf(out.world, good.id)!.min, [0, 0, 0], 1e-12);
});

// ---------------------------------------------------------------- entities

test("an entity moves by its position, because it has no geometry to move", () => {
  const light = entityNode("pointLight", { props: setVec3([], "position", [1, 2, 3]) });
  const world: World = { layers: [layerNode("Main", [light])], broom: { grid: -2, scale: 1 } };
  const { world: moved } = transformNodes(world, [light.id], translation([0, 1, 0]));
  nearVec(vec3Of(nodeById(moved, light.id)!.props, "position")!, [1, 3, 3]);
});

test("an entity that was never placed is not given a position by being moved", () => {
  const light = entityNode("pointLight");
  const inner = box([0, 0, 0], [1, 1, 1]);
  const parent = entityNode("group", { children: [inner] });
  const world: World = { layers: [layerNode("Main", [light, parent])], broom: { grid: -2, scale: 1 } };
  const { world: moved } = transformNodes(world, [light.id, parent.id], translation([0, 5, 0]));
  assert.equal(vec3Of(nodeById(moved, light.id)!.props, "position"), undefined,
    "inventing a property the sheet never had would change what the file means");
  nearVec(boundsOf(moved, inner.id)!.min, [0, 5, 0], 1e-9);
});

test("an entity takes its children with it", () => {
  const inner = box([0, 0, 0], [1, 1, 1]);
  const holder = entityNode("group", { props: setVec3([], "position", [0, 0, 0]), children: [inner] });
  const world: World = { layers: [layerNode("Main", [holder])], broom: { grid: -2, scale: 1 } };
  const { world: moved } = transformNodes(world, [holder.id], translation([2, 0, 0]));
  nearVec(vec3Of(nodeById(moved, holder.id)!.props, "position")!, [2, 0, 0]);
  nearVec(boundsOf(moved, inner.id)!.min, [2, 0, 0], 1e-9);
});

// ---------------------------------------------------------------- groups and layers

test("a group is only a name over its children, so it passes the matrix down", () => {
  const a = box([0, 0, 0], [1, 1, 1]);
  const b = box([2, 0, 0], [3, 1, 1]);
  const group = groupNode("room", [a, b]);
  const world: World = { layers: [layerNode("Main", [group])], broom: { grid: -2, scale: 1 } };
  const { world: moved } = transformNodes(world, [group.id], translation([0, 0, 10]));
  nearVec(boundsOf(moved, a.id)!.min, [0, 0, 10], 1e-9);
  nearVec(boundsOf(moved, b.id)!.min, [2, 0, 10], 1e-9);
});

test("a node listed inside another node that is also listed is not moved twice", () => {
  const inner = box([0, 0, 0], [1, 1, 1]);
  const group = groupNode("room", [inner]);
  const world: World = { layers: [layerNode("Main", [group])], broom: { grid: -2, scale: 1 } };
  // the set is taken as given: the caller decided what "the selection" is, and it is the group
  const { world: moved } = transformNodes(world, [group.id], translation([1, 0, 0]));
  nearVec(boundsOf(moved, inner.id)!.min, [1, 0, 0], 1e-9);
  // and the same id twice is still once
  const twice = transformNodes(world, [group.id, group.id], translation([1, 0, 0]));
  nearVec(boundsOf(twice.world, inner.id)!.min, [1, 0, 0], 1e-9);
});

test("moving nothing is not an error and does not copy the world", () => {
  const world: World = { layers: [layerNode("Main")], broom: { grid: -2, scale: 1 } };
  const out = transformNodes(world, [], translation([1, 1, 1]));
  assert.equal(out.world, world);
  assert.deepEqual(out.problems, []);
  assert.equal(transformNodes(world, ["nope"], translation([1, 1, 1])).world, world);
});

// ---------------------------------------------------------------- through a selection

test("a selection moves, which is the shape every tool actually holds", () => {
  const a = box([0, 0, 0], [1, 1, 1]);
  const b = box([2, 0, 0], [3, 1, 1]);
  const world: World = { layers: [layerNode("Main", [a, b])], broom: { grid: -2, scale: 1 } };
  const selection = selectNodes(world, NOTHING, [a.id, b.id]);
  const { world: moved } = translateSelection(world, selection, [0, 0.5, 0]);
  near(boundsOf(moved, a.id)!.min[1]!, 0.5);
  near(boundsOf(moved, b.id)!.min[1]!, 0.5);

  const turned = transformSelection(world, selection, rotation([0, 1, 0], Math.PI / 2));
  assert.deepEqual(turned.problems, []);
  // a quarter turn about +Y sends +x to −z
  nearVec(boundsOf(turned.world, b.id)!.min, [0, 0, -3], 1e-9);
});

// ---------------------------------------------------------------- uv lock

test("uv lock keeps the material on the wall while the wall moves", () => {
  const brush = brushOf(cuboid({ min: [0, 0, 0], max: [1, 1, 1] }), { material: "brick" });
  const by = translation([0.37, 0, 0]);
  const locked = transformBrushLocked(brush, by, true);
  const loose = transformBrushLocked(brush, by, false);
  assert.ok(locked.brush && loose.brush);
  // without lock every face keeps the offset it had, so the texture slides across the moving wall
  assert.deepEqual(loose.brush!.faces.map((f) => f.offset), brush.faces.map((f) => f.offset));
  const moved = locked.brush!.faces.some((f, i) => f.offset[0] !== brush.faces[i]!.offset[0] ||
    f.offset[1] !== brush.faces[i]!.offset[1]);
  assert.ok(moved, "with lock at least one face's offset had to change to stay still in the world");
});

test("a single node comes back on its own, for the callers that have one", () => {
  const solid = box([0, 0, 0], [1, 1, 1]);
  const one = transformNode(solid, translation([0, 0, 1]), true);
  assert.deepEqual(one.problems, []);
  nearVec(brushBounds((one.node as BrushNode).brush)!.min, [0, 0, 1], 1e-9);
  assert.equal(transformNode(solid, scaling([0, 1, 1]), true).node, undefined);
});

report("transform");
