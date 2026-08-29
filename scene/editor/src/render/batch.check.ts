// The brush batch: that a solid's vertices land where the arena said, that its faces can be found again
// afterwards, and — the part the whole design rests on — that changing how a face looks writes floats and
// nothing else.
// Run with: node --experimental-strip-types src/render/batch.check.ts
import assert from "node:assert/strict";
import { boxFaces, buildBrush, type BrushMesh, type Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { overlaps } from "./arena.ts";
import {
  batchBounds, clearBatch, dropBrush, entryOf, flagsOf, flushBatch, idOf, materialGroups, newBatch,
  setBrush, setFlags, FACE_SELECTED, HOVERED, SELECTED,
} from "./batch.ts";

/** a solid, built the way the kernel builds one, so the checks are about real vertex counts */
function box(min: Vec3, max: Vec3): BrushMesh {
  const { mesh, problems } = buildBrush(boxFaces(min, max).map((points) => ({ points })));
  assert.deepEqual(problems, []);
  return mesh!;
}

const UNIT = box([0, 0, 0], [1, 1, 1]);
const TALL = box([0, 0, 0], [1, 4, 1]);

test("a cuboid is six faces of two triangles, which is what the batch has to hold", () => {
  assert.equal(UNIT.groups.length, 6);
  assert.equal(UNIT.positions.length / 3, 36, "six quads fanned into twelve triangles");
});

// ---------------------------------------------------------------- putting solids in

test("two solids sit end to end and each knows where its own faces are", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  setBrush(batch, "b", UNIT);

  const a = entryOf(batch, "a")!;
  const b = entryOf(batch, "b")!;
  assert.deepEqual(a.span, { start: 0, count: 36 });
  assert.deepEqual(b.span, { start: 36, count: 36 });

  assert.equal(a.faces.length, 6);
  assert.deepEqual(a.faces[0], { face: 0, start: 0, count: 6, slot: 0 });
  assert.deepEqual(b.faces[0], { face: 0, start: 36, count: 6, slot: 0 }, "face spans are absolute, not per-solid");
  assert.deepEqual(overlaps(batch.arena), []);
});

test("the vertices written are the mesh's own, at the solid's offset", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  setBrush(batch, "b", TALL);
  const b = entryOf(batch, "b")!;

  assert.deepEqual(
    [...batch.position.slice(b.span.start * 3, b.span.start * 3 + 9)],
    [...TALL.positions.slice(0, 9)],
  );
  assert.deepEqual([...batch.normal.slice(b.span.start * 3, b.span.start * 3 + 3)], [...TALL.normals.slice(0, 3)]);
  assert.deepEqual([...batch.uv.slice(b.span.start * 2, b.span.start * 2 + 2)], [...TALL.uvs.slice(0, 2)]);
});

test("the arrays grow together, and what was already in them survives", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  const was = [...batch.position.slice(0, 9)];
  for (let i = 0; i < 20; i++) setBrush(batch, `n${i}`, UNIT);

  assert.equal(batch.arena.capacity, 1024, "36 * 21 = 756, doubled up from the floor");
  assert.equal(batch.position.length, 1024 * 3);
  assert.equal(batch.normal.length, 1024 * 3);
  assert.equal(batch.uv.length, 1024 * 2);
  assert.equal(batch.flag.length, 1024);
  assert.equal(batch.pick.length, 1024 * 2);
  assert.deepEqual([...batch.position.slice(0, 9)], was, "the first solid is still where it was");
});

test("a solid's bounds are kept, so framing never reads the vertex arrays", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  setBrush(batch, "b", box([-2, 0, 0], [-1, 1, 1]));
  assert.deepEqual(entryOf(batch, "b")!.bounds, { min: [-2, 0, 0], max: [-1, 1, 1] });
  assert.deepEqual(batchBounds(batch), { min: [-2, 0, 0], max: [1, 1, 1] });
});

test("an empty batch has bounds nothing can be framed from, and says so in the numbers", () => {
  const bounds = batchBounds(newBatch());
  assert.equal(bounds.min[0], Infinity);
  assert.equal(bounds.max[0], -Infinity);
});

// ---------------------------------------------------------------- picking

test("every vertex of a face carries which solid and which face it is", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  setBrush(batch, "b", UNIT);
  const b = entryOf(batch, "b")!;
  const face = b.faces[3]!;

  for (let i = face.start; i < face.start + face.count; i++) {
    assert.equal(batch.pick[i * 2], b.ordinal);
    assert.equal(batch.pick[i * 2 + 1], face.face);
  }
  assert.equal(idOf(batch, b.ordinal), "b", "and the ordinal reads back as the node it came from");
});

test("ordinals start at one, because an unwritten pick buffer reads as zero", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  assert.equal(entryOf(batch, "a")!.ordinal, 1);
  assert.equal(idOf(batch, 0), undefined, "nothing is nothing");
});

test("a solid rewritten keeps its ordinal, so a pick made last frame still means it", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  setBrush(batch, "b", UNIT);
  const was = entryOf(batch, "b")!.ordinal;
  setBrush(batch, "b", TALL); // the same solid, dragged taller
  assert.equal(entryOf(batch, "b")!.ordinal, was);
});

test("a dropped solid's ordinal is handed to the next one rather than counting on forever", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  setBrush(batch, "b", UNIT);
  dropBrush(batch, "b");
  assert.equal(idOf(batch, 2), undefined, "it stops meaning what it meant");
  setBrush(batch, "c", UNIT);
  assert.equal(entryOf(batch, "c")!.ordinal, 2);
  assert.equal(idOf(batch, 2), "c");
});

test("dropping gives the space back, and the next solid goes into it", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  setBrush(batch, "b", UNIT);
  setBrush(batch, "c", UNIT);
  dropBrush(batch, "b");
  setBrush(batch, "d", UNIT);
  assert.equal(entryOf(batch, "d")!.span.start, 36, "b's hole");
  assert.equal(batch.arena.used, 108, "and nothing was added to the end");
  assert.deepEqual(overlaps(batch.arena), []);
});

test("a hole is collapsed to the origin, so a deleted solid stops being drawn", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  setBrush(batch, "b", TALL);
  setBrush(batch, "c", UNIT);
  flushBatch(batch); // past the growth, so what follows is a partial upload rather than a whole one
  dropBrush(batch, "b");

  const hole = batch.position.slice(36 * 3, 72 * 3);
  assert.ok(hole.every((v) => v === 0), "every vertex of the hole is at the origin");
  assert.deepEqual(flushBatch(batch).ranges, [{ start: 36, count: 36 }], "and the zeroes were uploaded");
});

test("dropping the last solid zeroes nothing, because the draw range already stops short", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  setBrush(batch, "b", TALL);
  flushBatch(batch);
  dropBrush(batch, "b");

  assert.equal(batch.arena.used, 36, "the tail came back");
  assert.notEqual(batch.position[36 * 3 + 1], 0, "and what is past it was left alone");
  assert.deepEqual(flushBatch(batch).ranges, [], "no upload for something nobody draws");
});

// ---------------------------------------------------------------- appearance

test("flags are written per face, from the callback", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT, (face) => (face === 2 ? FACE_SELECTED : 0));
  assert.equal(flagsOf(batch, "a", 2), FACE_SELECTED);
  assert.equal(flagsOf(batch, "a", 1), 0);
  assert.equal(flagsOf(batch, "a", 9), undefined, "a face it has not got");

  const face = entryOf(batch, "a")!.faces.find((f) => f.face === 2)!;
  for (let i = face.start; i < face.start + face.count; i++) {
    assert.equal(batch.flag[i], FACE_SELECTED, `vertex ${i}`);
  }
});

test("selecting a solid marks the faces dirty and nothing else — no reallocation, no geometry", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  setBrush(batch, "b", UNIT);
  const positions = batch.position;
  flushBatch(batch);

  assert.equal(setFlags(batch, "b", () => SELECTED), true);
  const upload = flushBatch(batch);
  assert.equal(upload.grew, false, "highlighting must never reallocate");
  assert.deepEqual(upload.ranges, [{ start: 36, count: 36 }], "one merged range, because a solid's faces adjoin");
  assert.equal(batch.position, positions, "and the geometry array is the same object it was");
});

test("flags already right are not written again, which is what keeps a sweep cheap", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT, () => SELECTED);
  flushBatch(batch);
  assert.equal(setFlags(batch, "a", () => SELECTED), false, "nothing changed");
  assert.deepEqual(flushBatch(batch).ranges, [], "so nothing goes to the GPU");
});

test("one face hovered uploads that face and not the solid", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  flushBatch(batch);
  setFlags(batch, "a", (face) => (face === 4 ? HOVERED : 0));
  const face = entryOf(batch, "a")!.faces.find((f) => f.face === 4)!;
  assert.deepEqual(flushBatch(batch).ranges, [{ start: face.start, count: face.count }]);
});

test("flags survive a re-set of the same solid only if they are asked for again", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT, () => SELECTED);
  setBrush(batch, "a", UNIT);
  assert.equal(flagsOf(batch, "a", 0), 0, "geometry and appearance are written together, deliberately");
});

test("flags on a solid the batch never had are a no-op rather than a throw", () => {
  const batch = newBatch();
  assert.equal(setFlags(batch, "gone", () => SELECTED), false);
});

// ---------------------------------------------------------------- material groups

test("faces of one material next to each other are one group, not six", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT, undefined, () => 2);
  assert.deepEqual(materialGroups(batch), [{ start: 0, count: 36, materialIndex: 2 }]);
});

test("a run breaks where the slot changes and picks up again after it", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT, undefined, (face) => (face === 3 ? 1 : 0));
  assert.deepEqual(materialGroups(batch), [
    { start: 0, count: 18, materialIndex: 0 },
    { start: 18, count: 6, materialIndex: 1 },
    { start: 24, count: 12, materialIndex: 0 },
  ]);
});

test("groups are in draw order across solids, whatever order they went in", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT, undefined, () => 0);
  setBrush(batch, "b", UNIT, undefined, () => 0);
  setBrush(batch, "a", UNIT, undefined, () => 1); // rewritten last, still first in the buffer
  assert.deepEqual(materialGroups(batch), [
    { start: 0, count: 36, materialIndex: 1 },
    { start: 36, count: 36, materialIndex: 0 },
  ]);
});

test("a hole left by a dropped solid does not join the runs either side of it", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT, undefined, () => 1);
  setBrush(batch, "b", UNIT, undefined, () => 1);
  setBrush(batch, "c", UNIT, undefined, () => 1);
  dropBrush(batch, "b");
  assert.deepEqual(materialGroups(batch), [
    { start: 0, count: 36, materialIndex: 1 },
    { start: 72, count: 36, materialIndex: 1 },
  ], "the hole is collapsed geometry, and drawing it would draw a point at the origin");
});

test("only the things that move a face into a different run mark the groups stale", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  assert.equal(batch.groupsDirty, true);
  materialGroups(batch);
  assert.equal(batch.groupsDirty, false);

  setFlags(batch, "a", () => SELECTED);
  assert.equal(batch.groupsDirty, false, "hovering and selecting must never re-sort the groups");
  dropBrush(batch, "a");
  assert.equal(batch.groupsDirty, true);
});

// ---------------------------------------------------------------- starting over

test("clearing empties the batch but keeps the buffers for the next map", () => {
  const batch = newBatch();
  setBrush(batch, "a", UNIT);
  const buffer = batch.position;
  clearBatch(batch);

  assert.equal(entryOf(batch, "a"), undefined);
  assert.equal(idOf(batch, 1), undefined);
  assert.equal(batch.position, buffer, "the memory is kept");
  assert.equal(flushBatch(batch).grew, true, "but everything in it is stale");

  setBrush(batch, "z", UNIT);
  assert.equal(entryOf(batch, "z")!.ordinal, 1, "numbering starts over too");
  assert.equal(entryOf(batch, "z")!.span.start, 0);
});

report("batch");
