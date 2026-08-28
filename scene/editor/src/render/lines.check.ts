// The line buffer, and the shapes that go into it. Edges are the editor's other draw call, and the one
// place a duplicate is free to draw and expensive to pick — so most of this is about counting.
// Run with: node --experimental-strip-types src/render/lines.check.ts
import assert from "node:assert/strict";
import { boxFaces, buildBrush, type Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { overlaps } from "./arena.ts";
import { HOVERED, SELECTED } from "./batch.ts";
import {
  boxSegments, clearLines, dropLines, edgeSegments, flushLines, guideSegments, newLines, setLineFlags,
  setLines, spikeSegments,
} from "./lines.ts";

const polygonsOf = (min: Vec3, max: Vec3) => {
  const { mesh, problems } = buildBrush(boxFaces(min, max).map((points) => ({ points })));
  assert.deepEqual(problems, []);
  return mesh!.polygons;
};

// ---------------------------------------------------------------- the buffer

test("segments land at the span the arena gave them, in vertices rather than segments", () => {
  const lines = newLines();
  setLines(lines, "a", new Float32Array([0, 0, 0, 1, 0, 0]));
  setLines(lines, "b", new Float32Array([0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0]));

  assert.deepEqual(lines.entries.get("a"), { start: 0, count: 2 }, "one segment is two vertices");
  assert.deepEqual(lines.entries.get("b"), { start: 2, count: 4 });
  assert.deepEqual([...lines.position.slice(6, 12)], [0, 1, 0, 0, 2, 0]);
  assert.deepEqual(overlaps(lines.arena), []);
});

test("a key carries one flag across all of its vertices, and can be re-flagged for nothing", () => {
  const lines = newLines();
  setLines(lines, "a", boxSegments([0, 0, 0], [1, 1, 1]), SELECTED);
  const at = lines.entries.get("a")!;
  for (let i = at.start; i < at.start + at.count; i++) assert.equal(lines.flag[i], SELECTED, `vertex ${i}`);

  flushLines(lines);
  assert.equal(setLineFlags(lines, "a", HOVERED), true);
  assert.deepEqual(flushLines(lines).ranges, [at], "one range, the whole key");
  assert.equal(setLineFlags(lines, "a", HOVERED), false, "and saying it twice uploads nothing");
  assert.deepEqual(flushLines(lines).ranges, []);
});

test("pick numbers a segment's two ends the same, so an edge is picked as one thing", () => {
  const lines = newLines();
  setLines(lines, "a", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 0, {
    object: 7,
    part: (segment) => segment + 10,
  });
  assert.deepEqual([...lines.pick.slice(0, 8)], [7, 10, 7, 10, 7, 11, 7, 11]);
});

test("a key dropped gives its space back and is gone from the entries", () => {
  const lines = newLines();
  setLines(lines, "a", boxSegments([0, 0, 0], [1, 1, 1]));
  setLines(lines, "b", boxSegments([0, 0, 0], [1, 1, 1]));
  dropLines(lines, "a");
  assert.equal(lines.entries.get("a"), undefined);
  assert.equal(setLineFlags(lines, "a", SELECTED), false);
  setLines(lines, "c", boxSegments([0, 0, 0], [1, 1, 1]));
  assert.equal(lines.entries.get("c")!.start, 0, "straight into a's hole");
  assert.deepEqual(overlaps(lines.arena), []);
});

test("a hole is collapsed to a point, so a dropped key stops being drawn", () => {
  const lines = newLines();
  setLines(lines, "a", boxSegments([0, 0, 0], [1, 1, 1]));
  setLines(lines, "b", boxSegments([4, 4, 4], [5, 5, 5]));
  flushLines(lines); // past the growth, so what follows is a partial upload rather than a whole one
  dropLines(lines, "a");

  assert.ok(lines.position.slice(0, 24 * 3).every((v) => v === 0), "a zero-length line draws nothing");
  assert.deepEqual(flushLines(lines).ranges, [{ start: 0, count: 24 }]);
});

test("the three arrays grow together", () => {
  const lines = newLines();
  for (let i = 0; i < 20; i++) setLines(lines, `n${i}`, boxSegments([0, 0, 0], [1, 1, 1]));
  assert.equal(lines.position.length, lines.arena.capacity * 3);
  assert.equal(lines.flag.length, lines.arena.capacity);
  assert.equal(lines.pick.length, lines.arena.capacity * 2);
});

test("clearing empties it and declares the buffers stale", () => {
  const lines = newLines();
  setLines(lines, "a", boxSegments([0, 0, 0], [1, 1, 1]));
  clearLines(lines);
  assert.equal(lines.entries.size, 0);
  assert.equal(flushLines(lines).grew, true);
});

// ---------------------------------------------------------------- brush edges

test("a cuboid is twelve edges, not twenty-four", () => {
  const { segments, faces } = edgeSegments(polygonsOf([0, 0, 0], [1, 1, 1]));
  assert.equal(segments.length / 6, 12, "each shared edge is met twice and taken once");
  assert.equal(faces.length, 12);
  assert.equal(faces.filter((f) => f === 0).length, 4, "the first face met all four of its own");
  assert.ok(faces.every((f) => f >= 0 && f < 6), "and every edge is credited to a face that exists");
});

test("every edge of a cuboid is an axis-aligned unit step", () => {
  const { segments } = edgeSegments(polygonsOf([0, 0, 0], [1, 1, 1]));
  for (let i = 0; i < segments.length; i += 6) {
    const d = [0, 1, 2].map((k) => Math.abs(segments[i + 3 + k]! - segments[i + k]!));
    assert.deepEqual(d.filter((v) => v > 0), [1], `segment ${i / 6} runs along one axis by one metre`);
  }
});

test("a face that bounded nothing contributes no edges", () => {
  const polygons = polygonsOf([0, 0, 0], [1, 1, 1]);
  const holed = [...polygons];
  holed[0] = undefined;
  const { segments } = edgeSegments(holed);
  assert.equal(segments.length / 6, 12, "its four edges belong to its neighbours as well");
});

// ---------------------------------------------------------------- overlays

test("a box is twelve edges and nothing doubled", () => {
  const box = boxSegments([0, 0, 0], [2, 3, 4]);
  assert.equal(box.length / 6, 12);
  const seen = new Set<string>();
  for (let i = 0; i < box.length; i += 6) seen.add([...box.slice(i, i + 6)].join(","));
  assert.equal(seen.size, 12);
});

test("a box's corners are the eight the min and max make", () => {
  const box = boxSegments([0, 0, 0], [2, 3, 4]);
  const corners = new Set<string>();
  for (let i = 0; i < box.length; i += 3) corners.add([...box.slice(i, i + 3)].join(","));
  assert.equal(corners.size, 8);
  assert.ok(corners.has("0,0,0") && corners.has("2,3,4"));
});

test("spikes run through the box on each axis, past both ends", () => {
  const spikes = spikeSegments([0, 0, 0], [2, 2, 2], 100);
  assert.equal(spikes.length / 6, 3, "one per axis");
  assert.deepEqual([...spikes.slice(0, 6)], [-100, 1, 1, 102, 1, 1], "through the centre, out to the reach");
});

test("a guide is a cross on the plane, centred where it was asked for", () => {
  const guide = guideSegments([1, 2, 3], [1, 0, 0], [0, 0, 1], 10);
  assert.equal(guide.length / 6, 2);
  assert.deepEqual([...guide.slice(0, 6)], [-9, 2, 3, 11, 2, 3]);
  assert.deepEqual([...guide.slice(6, 12)], [1, 2, -7, 1, 2, 13]);
});

report("lines");
