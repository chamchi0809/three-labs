// Undo. The feature a level editor is judged on, and the one where "it mostly works" is not a grade.
// Run with: node --experimental-strip-types src/doc/history.check.ts
import assert from "node:assert/strict";
import { report, test } from "../check.ts";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import type { MaterialDef } from "./catalogue.ts";
import { brushNode, insertNodes, layerNode, nodeById, removeNodes, type World } from "./document.ts";
import { newEditor, type Editor } from "./editor.ts";
import {
  begin, canRedo, canUndo, change, clearRepeat, commit, history, redo, redoName, repeat, repeatName,
  rollback, run, separate, transact, undo, undoName,
} from "./history.ts";
import { NOTHING, selectNodes } from "./selection.ts";

const box = (min: [number, number, number], max: [number, number, number]) =>
  brushNode(brushOf(cuboid({ min, max })));

const start = (): Editor => {
  const first = box([0, 0, 0], [1, 1, 1]);
  const world: World = { layers: [layerNode("Main", [first])], broom: { grid: -2, scale: 1 } };
  return { ...newEditor(world), layer: world.layers[0]!.id };
};

/**
 * The counter every check below moves: the grid exponent stands in for any numeric edit. It returns the
 * editor it was given when there is nothing to do, which is the contract every real command keeps.
 */
const setGrid = (n: number) => (e: Editor): Editor =>
  e.world.broom.grid === n ? e : { ...e, world: { ...e.world, broom: { ...e.world.broom, grid: n } } };
const grid = (e: Editor) => e.world.broom.grid;
const nudge = (n: number) => ({ name: "nudge", apply: setGrid(n), collate: "nudge" });

test("a command runs, and undo puts it back", () => {
  let h = history(start());
  h = change(h, "set the grid", setGrid(0));
  assert.equal(grid(h.editor), 0);
  assert.equal(undoName(h), "set the grid");
  h = undo(h);
  assert.equal(grid(h.editor), -2);
  assert.equal(redoName(h), "set the grid");
  h = redo(h);
  assert.equal(grid(h.editor), 0);
});

test("undo and redo run out, and say so before they do", () => {
  let h = history(start());
  assert.ok(!canUndo(h) && !canRedo(h));
  h = change(h, "a", setGrid(0));
  assert.ok(canUndo(h) && !canRedo(h));
  h = undo(h);
  assert.ok(!canUndo(h) && canRedo(h));
  assert.equal(undo(h), h, "undoing nothing is not an error, it is nothing");
});

test("a command that changed nothing leaves no trace", () => {
  let h = history(start());
  h = change(h, "set the grid to what it already is", setGrid(-2));
  assert.equal(h.past.length, 0);
  assert.ok(!canUndo(h));
  h = change(h, "a tool that copied the editor and then changed its mind", (e) => ({ ...e }));
  assert.equal(h.past.length, 0, "a copy of an unchanged editor is still an unchanged editor");
});

test("doing something new throws away what was undone", () => {
  let h = history(start());
  h = change(h, "a", setGrid(0));
  h = undo(h);
  h = change(h, "b", setGrid(1));
  assert.ok(!canRedo(h), "the branch that was undone is gone");
  assert.equal(grid(h.editor), 1);
});

test("undo restores the selection too, because a designer expects what came back to be selected", () => {
  let h = history(start());
  const solid = h.editor.world.layers[0]!.children[0]!.id;
  h = change(h, "select", (e) => ({ ...e, selection: selectNodes(e.world, NOTHING, [solid]) }));
  h = change(h, "delete", (e) => ({ ...e, world: removeNodes(e.world, e.selection.nodes) }));
  assert.deepEqual(h.editor.selection.nodes, [], "the selection was pruned when the solid went");
  h = undo(h);
  assert.deepEqual(h.editor.selection.nodes, [solid], "and came back with it");
});

// ---------------------------------------------------------------- collation

test("a held key is one entry, not forty", () => {
  let h = history(start());
  for (let i = 0; i < 40; i++) h = run(h, nudge(i));
  assert.equal(h.past.length, 1);
  assert.equal(grid(h.editor), 39);
  h = undo(h);
  assert.equal(grid(h.editor), -2, "the whole gesture came back, not the last step of it");
});

test("letting go ends the gesture, and the next press starts a new entry", () => {
  let h = history(start());
  h = run(h, nudge(0));
  h = run(h, nudge(1));
  h = separate(h);
  h = run(h, nudge(2));
  assert.equal(h.past.length, 2);
  h = undo(h);
  assert.equal(grid(h.editor), 1, "back to the end of the first gesture");
});

test("a different command in between ends the gesture by itself", () => {
  let h = history(start());
  h = run(h, nudge(0));
  h = change(h, "something else", (e) => ({ ...e, material: "brick" }));
  h = run(h, nudge(1));
  assert.equal(h.past.length, 3);
});

// ---------------------------------------------------------------- transactions

test("a gesture made of six changes is one entry", () => {
  let h = history(start());
  h = begin(h, "build a room");
  for (let i = 0; i < 6; i++) h = change(h, `wall ${i}`, (e) => ({
    ...e,
    world: insertNodes(e.world, e.layer, [box([i, 0, 0], [i + 1, 1, 1])]),
  }));
  assert.equal(h.past.length, 0, "nothing lands while the transaction is open");
  assert.ok(!canUndo(h), "and undo is unavailable rather than half-applied");
  h = commit(h);
  assert.equal(h.past.length, 1);
  assert.equal(undoName(h), "build a room");
  assert.equal(h.editor.world.layers[0]!.children.length, 7);
  h = undo(h);
  assert.equal(h.editor.world.layers[0]!.children.length, 1, "all six went together");
});

test("transactions nest, and only the outermost one lands", () => {
  let h = history(start());
  h = begin(h, "outer");
  h = begin(h, "inner");
  h = change(h, "a", setGrid(0));
  h = commit(h);
  assert.equal(h.past.length, 0);
  h = commit(h);
  assert.equal(h.past.length, 1);
  assert.equal(undoName(h), "outer");
});

test("a transaction that did nothing lands nothing", () => {
  let h = history(start());
  h = commit(begin(h, "a gesture that was cancelled"));
  assert.equal(h.past.length, 0);
});

test("a rolled-back transaction leaves no mark on the editor or the stack", () => {
  let h = history(start());
  const before = h.editor;
  h = begin(h, "a drag that was escaped out of");
  h = change(h, "move", setGrid(3));
  h = rollback(h);
  assert.equal(h.editor, before);
  assert.equal(h.past.length, 0);
});

test("transact is the two halves in one call", () => {
  let h = history(start());
  h = transact(h, "two things", (inner) => change(change(inner, "a", setGrid(0)), "b", setGrid(1)));
  assert.equal(h.past.length, 1);
  assert.equal(undoName(h), "two things");
  assert.equal(grid(undo(h).editor), -2);
});

test("committing without beginning is not an error", () => {
  const h = history(start());
  assert.equal(commit(h), h);
  assert.equal(rollback(h), h);
});

// ---------------------------------------------------------------- limits

test("the stack is bounded, and it is the oldest that goes", () => {
  let h = history(start(), 5);
  for (let i = 0; i < 20; i++) h = change(h, `step ${i}`, setGrid(i % 4));
  assert.equal(h.past.length, 5);
  assert.equal(h.past[0]!.name, "step 15");
});

// ---------------------------------------------------------------- repeat

test("a repeatable command is remembered and can be done again", () => {
  let h = history(start());
  h = run(h, {
    name: "add a solid",
    repeatable: true,
    apply: (e) => ({ ...e, world: insertNodes(e.world, e.layer, [box([0, 0, 0], [1, 1, 1])]) }),
  });
  assert.equal(repeatName(h), "add a solid");
  h = repeat(h);
  assert.equal(h.editor.world.layers[0]!.children.length, 3);
  assert.equal(undoName(h), "add a solid");
  h = undo(h);
  assert.equal(h.editor.world.layers[0]!.children.length, 2, "the repeat undid as one entry");
});

test("several repeatable actions replay together, as one entry", () => {
  let h = history(start());
  h = run(h, { name: "a", repeatable: true, apply: (e) => ({ ...e, world: insertNodes(e.world, e.layer, [box([0, 0, 0], [1, 1, 1])]) }) });
  h = run(h, { name: "b", repeatable: true, apply: (e) => ({ ...e, world: insertNodes(e.world, e.layer, [box([2, 0, 0], [3, 1, 1])]) }) });
  assert.equal(repeatName(h), "2 actions");
  const entries = h.past.length;
  h = repeat(h);
  assert.equal(h.past.length, entries + 1);
  assert.equal(h.editor.world.layers[0]!.children.length, 5);
});

test("what is not repeatable is not repeated", () => {
  let h = history(start());
  h = change(h, "select", (e) => ({ ...e, material: "brick" }));
  assert.equal(repeatName(h), undefined);
  assert.equal(repeat(h), h);
  h = clearRepeat(h);
  assert.equal(h.repeat.length, 0);
});

// ---------------------------------------------------------------- repeating a gesture

/** one frame of a drag: sixty of these a second is what the collapsing below is for */
const frame = (n: number) => ({
  name: "drag a wall out",
  collate: "drag:move",
  repeatable: true,
  apply: (e: Editor): Editor => ({ ...e, world: insertNodes(e.world, e.layer, [box([n, 0, 0], [n + 1, 1, 1])]) }),
});

test("the frames of one drag are one thing to repeat, not a hundred and twenty", () => {
  let h = history(start());
  for (let i = 0; i < 40; i++) h = run(h, frame(i));
  assert.equal(h.repeat.length, 1, "replaying every frame of a drag would replay the drag forty times");
  assert.equal(repeatName(h), "drag a wall out");
});

test("a repeated gesture is its own entry rather than a continuation of the drag it came from", () => {
  let h = history(start());
  h = run(h, frame(0));
  h = run(h, frame(1));
  assert.equal(h.past.length, 1, "the drag itself is one entry");
  h = separate(h);
  const solids = h.editor.world.layers[0]!.children.length;
  h = repeat(h);
  assert.equal(h.past.length, 2);
  assert.equal(h.editor.world.layers[0]!.children.length, solids + 1);
});

test("letting go of a drag means the next one is recorded after it, not over it", () => {
  let h = history(start());
  h = run(h, frame(0));
  h = separate(h);
  h = run(h, frame(5));
  assert.equal(h.repeat.length, 2, "two drags are two things to repeat");
  assert.equal(repeatName(h), "2 actions");
});

test("repeat runs a drag's `again`, because its `apply` would rewind the world to before it", () => {
  let h = history(start());
  const before = h.editor.world;
  h = run(h, {
    name: "move",
    collate: "drag:move",
    repeatable: true,
    // written against the world the drag started from, which is how a drag avoids accumulating rounding
    apply: (e) => ({ ...e, world: insertNodes(before, e.layer, [box([0, 0, 0], [1, 1, 1])]) }),
    again: (e) => ({ ...e, world: insertNodes(e.world, e.layer, [box([9, 0, 0], [10, 1, 1])]) }),
  });
  h = separate(h);
  const solids = h.editor.world.layers[0]!.children.length;
  h = repeat(h);
  assert.equal(h.editor.world.layers[0]!.children.length, solids + 1,
    "replaying `apply` would have thrown away everything since the drag began");
});

test("a drag that came back to where it started leaves nothing behind, not an entry that does nothing", () => {
  let h = history(start());
  const before = h.editor;
  h = run(h, { ...nudge(0), repeatable: true });
  h = run(h, { ...nudge(3), repeatable: true });
  assert.equal(h.past.length, 1);
  // the last frame of an escaped drag: the same collate key, putting the world back as it was
  h = run(h, { name: "nudge", collate: "nudge", apply: () => before });
  assert.equal(h.past.length, 0, "undo has nothing to do, so there is nothing on the stack");
  assert.equal(h.repeat.length, 0, "and nothing to repeat either — the gesture was cancelled");
  assert.equal(grid(h.editor), -2);
});

test("a material declaration changed is an edit like any other", () => {
  let h = history(start());
  const wall: MaterialDef = { name: "wall", type: "meshStandardMaterial", maps: {}, roughness: 0.2 };
  h = change(h, "set roughness", (e) => ({ ...e, materials: new Map(e.materials).set("wall", wall) }));
  assert.equal(h.past.length, 1, "a declaration nobody pushed is one ⌘Z steps over");
  h = undo(h);
  assert.equal(h.editor.materials.size, 0);
  h = redo(h);
  assert.equal(h.editor.materials.get("wall"), wall);
});

test("the editor is settled after every command, so nothing points at what is gone", () => {
  let h = history(start());
  const solid = h.editor.world.layers[0]!.children[0]!.id;
  h = change(h, "open a group that is not one", (e) => ({ ...e, open: solid }));
  assert.equal(h.editor.open, undefined, "a solid is not a group to step into");
  h = change(h, "throw the layer away", (e) => ({ ...e, world: { ...e.world, layers: [layerNode("Other")] } }));
  assert.ok(nodeById(h.editor.world, h.editor.layer), "the current layer is one that exists");
});

report("history");
