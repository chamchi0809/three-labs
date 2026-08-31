/**
 * CSG, from the kernel's answer up to the tree it lands in.
 *
 * Two things are checked here that the kernel's own suite cannot see. The first is **attribution**: the
 * inside of a hole has to come out with the cutter's material on it and the outside with the wall's, which
 * is entirely a question of whose face numbering won. The second is **identity**: a carved wall must still
 * be the same node afterwards — same `#id`, same place in the file — while the fragments beside it must be
 * new nodes with no `#id` at all, or a save writes a sheet in which two solids answer to the same name.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/doc/csg.check.ts
 */
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { brushOf, brushProblems, brushVolume, type Brush } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import { carve, common, hull, shell } from "../brush/carve.ts";
import { report, test } from "../check.ts";
import { hollowSelection, intersectSelection, mergeSelection, subtractSelection } from "./csg.ts";
import {
  brushNode, groupNode, layerNode, nodeById, pathTo, walk,
  type BrushNode, type Node, type NodeId, type World,
} from "./document.ts";
import { newEditor, type Editor } from "./editor.ts";
import { NOTHING } from "./selection.ts";

const brush = (min: Vec3, max: Vec3, material?: string): Brush =>
  brushOf(cuboid({ min, max }), material ? { material } : {});

const world = (...children: Node[]): World =>
  ({ layers: [layerNode("Main", children)], broom: { grid: -2, scale: 1 } });

/** an editor over these nodes with the named ones selected */
const editing = (w: World, ...selected: NodeId[]): Editor =>
  ({ ...newEditor(w), selection: { ...NOTHING, nodes: selected } });

/** the editor an attempt produced, failing the check if it declined */
function done(result: Editor | string, why: string): Editor {
  assert.equal(typeof result, "object", `${why}: declined with "${result as string}"`);
  return result as Editor;
}

const solids = (w: World): BrushNode[] => [...walk(w)].filter((n): n is BrushNode => n.kind === "brush");
const materialsOf = (b: Brush): string[] => [...new Set(b.faces.map((f) => f.material ?? "none"))].sort();

// ---------------------------------------------------------------- carving one brush with another

test("a carved wall keeps its own material outside and takes the cutter's inside", () => {
  const wall = brush([0, 0, 0], [4, 4, 1], "--stone");
  const result = carve(wall, brush([1, 1, -1], [2, 2, 2], "--doorway"));
  assert.ok(result, "the cutter passes right through the wall");
  assert.ok(result.brushes.length > 0);
  assert.deepEqual(result.dropped, []);
  for (const part of result.brushes) assert.deepEqual(brushProblems(part), []);
  const seen = new Set(result.brushes.flatMap((b) => b.faces.map((f) => f.material)));
  assert.ok(seen.has("--stone"), "the wall's own faces kept their material");
  assert.ok(seen.has("--doorway"), "the faces the cutter made are textured from the cutter");
  assert.ok(!seen.has(undefined), "no face came out blank");
});

test("the pieces of a carve add up to the brush minus the cutter", () => {
  const result = carve(brush([0, 0, 0], [4, 4, 4]), brush([1, 1, 1], [2, 2, 2]))!;
  const total = result.brushes.reduce((sum, b) => sum + brushVolume(b), 0);
  assert.ok(Math.abs(total - (64 - 1)) < 1e-9, `${total} is not 63`);
});

test("a cutter that misses changes nothing, and one that swallows leaves nothing", () => {
  const wall = brush([0, 0, 0], [1, 1, 1]);
  assert.equal(carve(wall, brush([5, 5, 5], [6, 6, 6])), undefined);
  assert.equal(carve(wall, brush([1, 0, 0], [2, 1, 1])), undefined, "flush neighbours do not overlap");
  assert.deepEqual(carve(wall, brush([-1, -1, -1], [2, 2, 2]))?.brushes, []);
});

test("an intersection is the volume every solid shares", () => {
  const { brush: both } = common([brush([0, 0, 0], [3, 3, 3], "--a"), brush([2, 0, 0], [5, 3, 3], "--b")]);
  assert.ok(both);
  assert.ok(Math.abs(brushVolume(both) - 9) < 1e-9);
  assert.deepEqual(brushProblems(both), []);
  assert.deepEqual(materialsOf(both), ["--a", "--b"], "both operands' faces are still named");
});

test("an intersection that shares nothing says so rather than returning an empty solid", () => {
  assert.match(common([brush([0, 0, 0], [1, 1, 1]), brush([4, 4, 4], [5, 5, 5])]).problem!, /share no volume/);
  assert.match(common([brush([0, 0, 0], [1, 1, 1])]).problem!, /two solids or more/);
});

test("a merge of two solids that fit together is exact, and one of two that do not is not", () => {
  const snug = hull([brush([0, 0, 0], [1, 2, 2], "--left"), brush([1, 0, 0], [3, 2, 2], "--right")]);
  assert.ok(snug.exact, "two boxes face to face are a box");
  assert.ok(Math.abs(brushVolume(snug.brush!) - 12) < 1e-9, `${brushVolume(snug.brush!)} is not 12`);
  assert.deepEqual(materialsOf(snug.brush!), ["--left", "--right"]);

  const apart = hull([brush([0, 0, 0], [1, 1, 1]), brush([2, 2, 2], [3, 3, 3])]);
  assert.ok(apart.brush, "a hull still exists");
  assert.equal(apart.exact, false, "it filled in the space between them");
});

test("a hollowed solid is a shell, and one too small to hollow says nothing happened", () => {
  const result = shell(brush([0, 0, 0], [4, 4, 4], "--stone"), 0.5)!;
  assert.ok(result);
  assert.equal(result.brushes.length, 6, "one wall per face");
  const total = result.brushes.reduce((sum, b) => sum + brushVolume(b), 0);
  assert.ok(Math.abs(total - (64 - 27)) < 1e-9, `${total} is not 37`);
  for (const wall of result.brushes) {
    assert.deepEqual(brushProblems(wall), []);
    assert.deepEqual(materialsOf(wall), ["--stone"], "inside and out are the same stone");
  }
  assert.equal(shell(brush([0, 0, 0], [1, 1, 1]), 2), undefined, "a wall thicker than the room is a wall");
});

// ---------------------------------------------------------------- subtract, in the tree

test("subtracting carves everything the selection overlaps and then deletes the selection", () => {
  const wall = brushNode(brush([0, 0, 0], [4, 4, 1], "--stone"), { sheetId: "wall", classes: ["solid"] });
  const away = brushNode(brush([20, 0, 0], [21, 1, 1]));
  const cutter = brushNode(brush([1, 1, -1], [2, 2, 2], "--doorway"));
  const e = done(subtractSelection(editing(world(wall, away, cutter), cutter.id)), "a doorway through a wall");

  assert.equal(nodeById(e.world, cutter.id), undefined, "the knife is put away afterwards");
  assert.ok(nodeById(e.world, away.id), "a solid nowhere near it is untouched");
  const carved = nodeById(e.world, wall.id) as BrushNode;
  assert.ok(carved, "the wall is still the same node, so the writer patches what it already wrote");
  assert.equal(carved.sheetId, "wall");

  const pieces = solids(e.world).filter((n) => n.id !== away.id);
  assert.ok(pieces.length > 1, "the wall came apart");
  const total = pieces.reduce((sum, n) => sum + brushVolume(n.brush), 0);
  assert.ok(Math.abs(total - (16 - 1)) < 1e-9, `${total} is not 15`);
  for (const piece of pieces) {
    assert.deepEqual(piece.classes, ["solid"], "every fragment is still one of these");
    if (piece.id !== wall.id) {
      assert.equal(piece.sheetId, undefined, "a fragment must not answer to the wall's #id");
      assert.equal(piece.origin, undefined, "a fragment is a new solid and is written out in full");
    }
  }
  assert.deepEqual([...e.selection.nodes].sort(), pieces.map((p) => p.id).sort(), "the result is selected");
});

test("fragments stay in the group the solid they came from was in", () => {
  const wall = brushNode(brush([0, 0, 0], [4, 4, 1]));
  const room = groupNode("room", [wall]);
  const cutter = brushNode(brush([1, 1, -1], [2, 2, 2]));
  const e = done(subtractSelection(editing(world(room, cutter), cutter.id)), "carving inside a group");
  for (const piece of solids(e.world)) {
    assert.equal(pathTo(e.world, piece.id).at(-2)?.id, room.id, `${piece.id} left the group`);
  }
});

test("a subtraction that touches nothing declines instead of deleting the selection", () => {
  const wall = brushNode(brush([0, 0, 0], [1, 1, 1]));
  const cutter = brushNode(brush([9, 9, 9], [10, 10, 10]));
  const refused = subtractSelection(editing(world(wall, cutter), cutter.id));
  assert.equal(typeof refused, "string");
  assert.match(refused as string, /overlaps nothing/);
  assert.equal(typeof subtractSelection(editing(world(wall))), "string", "and so does an empty selection");
});

test("locked and hidden solids are not carved", () => {
  const locked = brushNode(brush([0, 0, 0], [4, 4, 1]), { broom: { locked: true } });
  const hidden = brushNode(brush([0, 6, 0], [4, 10, 1]), { broom: { hidden: true } });
  const open = brushNode(brush([0, 12, 0], [4, 16, 1]));
  const cutter = brushNode(brush([1, -1, -1], [2, 20, 2]));
  const e = done(subtractSelection(editing(world(locked, hidden, open, cutter), cutter.id)), "one of three");

  assert.ok(Math.abs(brushVolume((nodeById(e.world, locked.id) as BrushNode).brush) - 16) < 1e-9);
  assert.ok(Math.abs(brushVolume((nodeById(e.world, hidden.id) as BrushNode).brush) - 16) < 1e-9);
  assert.equal(nodeById(e.world, open.id) && brushVolume((nodeById(e.world, open.id) as BrushNode).brush) < 16, true);
});

// ---------------------------------------------------------------- the other three, in the tree

test("intersecting collapses the selection onto the first solid's node", () => {
  const a = brushNode(brush([0, 0, 0], [3, 3, 3]), { sheetId: "keep" });
  const b = brushNode(brush([2, 0, 0], [5, 3, 3]));
  const e = done(intersectSelection(editing(world(a, b), a.id, b.id)), "two overlapping boxes");
  assert.deepEqual(solids(e.world).map((n) => n.id), [a.id], "one solid, and it is the one that had the name");
  assert.equal((nodeById(e.world, a.id) as BrushNode).sheetId, "keep");
  assert.ok(Math.abs(brushVolume((nodeById(e.world, a.id) as BrushNode).brush) - 9) < 1e-9);

  const miss = world(brushNode(brush([0, 0, 0], [1, 1, 1])), brushNode(brush([8, 8, 8], [9, 9, 9])));
  const ids = solids(miss).map((n) => n.id);
  assert.match(intersectSelection(editing(miss, ...ids)) as string, /share no volume/);
});

test("merging says so when the hull filled in space nobody drew", () => {
  const snug = world(brushNode(brush([0, 0, 0], [1, 2, 2])), brushNode(brush([1, 0, 0], [3, 2, 2])));
  const tidy = done(mergeSelection(editing(snug, ...solids(snug).map((n) => n.id))), "two boxes face to face");
  assert.match(tidy.note!, /^merged 2$/);

  const apart = world(brushNode(brush([0, 0, 0], [1, 1, 1])), brushNode(brush([3, 3, 3], [4, 4, 4])));
  const loose = done(mergeSelection(editing(apart, ...solids(apart).map((n) => n.id))), "two boxes apart");
  assert.match(loose.note!, /filled in/);
});

test("hollowing uses the grid as the wall thickness", () => {
  const box = brushNode(brush([0, 0, 0], [4, 4, 4], "--stone"), { sheetId: "room" });
  const e = done(hollowSelection(editing(world(box), box.id)), "a four-metre box on a 25 cm grid");
  const walls = solids(e.world);
  assert.equal(walls.length, 6);
  assert.equal((nodeById(e.world, box.id) as BrushNode).sheetId, "room", "the original node is still the room");
  const total = walls.reduce((sum, n) => sum + brushVolume(n.brush), 0);
  // 4³ minus the 3.5³ cavity a quarter-metre wall leaves
  assert.ok(Math.abs(total - (64 - 3.5 ** 3)) < 1e-9, `${total}`);
  assert.deepEqual([...e.selection.nodes].sort(), walls.map((w) => w.id).sort());

  const thin = brushNode(brush([0, 0, 0], [0.2, 0.2, 0.2]));
  assert.match(hollowSelection(editing(world(thin), thin.id)) as string, /thick enough/);
});

report("csg-doc");
