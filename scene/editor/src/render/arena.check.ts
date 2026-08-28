// The suballocator. Every check ends with `overlaps()` clean, because a span handed out twice does not
// throw — it draws one solid inside another and reads as a modelling mistake.
// Run with: node --experimental-strip-types src/render/arena.check.ts
import assert from "node:assert/strict";
import { report, test } from "../check.ts";
import {
  clear, flush, fragmentation, markDirty, newArena, overlaps, release, reserve, spanOf, type Arena,
} from "./arena.ts";

const sound = (arena: Arena, why = "") => assert.deepEqual(overlaps(arena), [], why);

test("spans are handed out end to end and the buffer grows to hold them", () => {
  const arena = newArena();
  assert.deepEqual(reserve(arena, "a", 12), { start: 0, count: 12 });
  assert.deepEqual(reserve(arena, "b", 6), { start: 12, count: 6 });
  assert.equal(arena.used, 18);
  assert.equal(arena.capacity, 256, "the floor, not eighteen — growing one vertex at a time is the bug");
  sound(arena);
});

test("capacity doubles rather than fitting exactly", () => {
  const arena = newArena();
  reserve(arena, "a", 300);
  assert.equal(arena.capacity, 512);
  reserve(arena, "b", 700);
  assert.equal(arena.capacity, 1024);
  assert.equal(arena.used, 1000);
  sound(arena);
});

test("a span reserved again at the same size keeps its address", () => {
  const arena = newArena();
  const first = reserve(arena, "a", 12);
  reserve(arena, "b", 6);
  flush(arena);
  const again = reserve(arena, "a", 12);
  assert.deepEqual(again, first, "a wall that moved has the same vertex count and must not move in the buffer");
  assert.deepEqual(flush(arena).ranges, [{ start: 0, count: 12 }], "but it does have to be uploaded again");
  sound(arena);
});

test("a hole is reused by whatever fits in it next", () => {
  const arena = newArena();
  reserve(arena, "a", 12);
  reserve(arena, "b", 6);
  reserve(arena, "c", 12);
  release(arena, "b");
  assert.deepEqual(arena.free, [{ start: 12, count: 6 }]);

  assert.deepEqual(reserve(arena, "d", 4), { start: 12, count: 4 }, "it goes in the hole");
  assert.deepEqual(arena.free, [{ start: 16, count: 2 }], "and leaves the remainder");
  assert.equal(arena.used, 30, "nothing was added to the end");
  sound(arena);
});

test("a hole too small is stepped over rather than split", () => {
  const arena = newArena();
  reserve(arena, "a", 4);
  reserve(arena, "b", 4);
  reserve(arena, "c", 4);
  release(arena, "b");
  assert.deepEqual(reserve(arena, "d", 8), { start: 12, count: 8 }, "off the end");
  assert.deepEqual(arena.free, [{ start: 4, count: 4 }], "the hole is still there for something smaller");
  sound(arena);
});

test("neighbouring holes are merged, so a cleared room is one hole and not forty", () => {
  const arena = newArena();
  for (const key of ["a", "b", "c", "d", "e"]) reserve(arena, key, 10);
  release(arena, "b");
  release(arena, "d");
  release(arena, "c");
  assert.deepEqual(arena.free, [{ start: 10, count: 30 }], "b, c and d became one");
  assert.deepEqual(reserve(arena, "big", 30), { start: 10, count: 30 });
  assert.deepEqual(arena.free, []);
  sound(arena);
});

test("releasing the last span gives the tail back instead of leaving a hole", () => {
  const arena = newArena();
  reserve(arena, "a", 10);
  reserve(arena, "b", 10);
  release(arena, "b");
  assert.equal(arena.used, 10);
  assert.deepEqual(arena.free, [], "the tail is not fragmentation");
  sound(arena);
});

test("a hole that ends up against the tail is absorbed into it", () => {
  const arena = newArena();
  reserve(arena, "a", 10);
  reserve(arena, "b", 10);
  reserve(arena, "c", 10);
  release(arena, "b");
  release(arena, "c");
  assert.equal(arena.used, 10, "b's hole reached the mark once c went");
  assert.deepEqual(arena.free, []);
  sound(arena);
});

test("building a map and clearing it twice does not creep", () => {
  const arena = newArena();
  const build = () => {
    for (let i = 0; i < 200; i++) reserve(arena, `n${i}`, 36);
  };
  build();
  const high = arena.used;
  for (let i = 0; i < 200; i++) release(arena, `n${i}`);
  assert.equal(arena.used, 0);
  assert.deepEqual(arena.free, []);
  build();
  assert.equal(arena.used, high, "the second map is the same size as the first");
  sound(arena);
});

test("a span that grows frees its old address first, so it can land back on it", () => {
  const arena = newArena();
  reserve(arena, "a", 10);
  reserve(arena, "b", 10);
  reserve(arena, "c", 10);
  release(arena, "b");
  // `a` grows by four: its own ten plus b's ten is twenty contiguous, and a wants fourteen
  const grown = reserve(arena, "a", 14);
  assert.deepEqual(grown, { start: 0, count: 14 });
  assert.deepEqual(arena.free, [{ start: 14, count: 6 }]);
  sound(arena);
});

test("reserving nothing is legal and holds no address", () => {
  const arena = newArena();
  reserve(arena, "a", 10);
  assert.deepEqual(reserve(arena, "empty", 0), { start: 0, count: 0 });
  assert.equal(arena.used, 10, "an empty solid takes no room");
  release(arena, "empty");
  sound(arena);
});

// ---------------------------------------------------------------- uploads

test("dirty ranges are merged as they arrive", () => {
  const arena = newArena(1024);
  markDirty(arena, { start: 10, count: 5 });
  markDirty(arena, { start: 15, count: 5 });
  assert.deepEqual(flush(arena).ranges, [{ start: 10, count: 10 }], "adjacent is one range");

  markDirty(arena, { start: 40, count: 5 });
  markDirty(arena, { start: 10, count: 5 });
  assert.deepEqual(flush(arena).ranges, [{ start: 10, count: 5 }, { start: 40, count: 5 }], "apart is two");
});

test("a range swallowed by one already marked does not widen it", () => {
  const arena = newArena(1024);
  markDirty(arena, { start: 10, count: 20 });
  markDirty(arena, { start: 14, count: 4 });
  assert.deepEqual(flush(arena).ranges, [{ start: 10, count: 20 }]);
});

test("a range bridging two others joins all three", () => {
  const arena = newArena(1024);
  markDirty(arena, { start: 0, count: 4 });
  markDirty(arena, { start: 20, count: 4 });
  markDirty(arena, { start: 40, count: 4 });
  markDirty(arena, { start: 2, count: 40 });
  assert.deepEqual(flush(arena).ranges, [{ start: 0, count: 44 }]);
});

test("growing makes the ranges moot and says so", () => {
  const arena = newArena();
  reserve(arena, "a", 10);
  const first = flush(arena);
  assert.equal(first.grew, true, "the buffers did not exist a moment ago");
  assert.deepEqual(first.ranges, [], "there is no point listing ranges of a buffer being replaced whole");

  reserve(arena, "b", 10);
  const second = flush(arena);
  assert.equal(second.grew, false);
  assert.deepEqual(second.ranges, [{ start: 10, count: 10 }]);
});

test("a flush leaves nothing behind, so an idle frame uploads nothing", () => {
  const arena = newArena();
  reserve(arena, "a", 10);
  flush(arena);
  const idle = flush(arena);
  assert.equal(idle.grew, false);
  assert.deepEqual(idle.ranges, []);
  assert.equal(idle.used, 10, "the draw call still needs to know how much is real");
});

test("clearing keeps the buffers but declares everything in them stale", () => {
  const arena = newArena();
  reserve(arena, "a", 10);
  flush(arena);
  clear(arena);
  assert.equal(arena.used, 0);
  assert.equal(spanOf(arena, "a"), undefined);
  assert.equal(flush(arena).grew, true);
  assert.equal(arena.capacity, 256, "the memory is kept — the next map goes straight into it");
});

// ---------------------------------------------------------------- fragmentation

test("fragmentation is the share of the live region that is holes", () => {
  const arena = newArena();
  for (const key of ["a", "b", "c", "d"]) reserve(arena, key, 10);
  assert.equal(fragmentation(arena), 0);
  release(arena, "b");
  assert.equal(fragmentation(arena), 0.25, "ten holes in forty");
  reserve(arena, "b", 10);
  assert.equal(fragmentation(arena), 0);
  sound(arena);
});

test("a thousand random reserves and releases leave the arena sound", () => {
  const arena = newArena();
  const live = new Set<string>();
  // a fixed sequence rather than Math.random: a check that fails one run in ten is a check nobody trusts
  let seed = 12345;
  const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed);

  for (let i = 0; i < 1000; i++) {
    const key = `n${next() % 60}`;
    if (live.has(key) && next() % 3 === 0) {
      release(arena, key);
      live.delete(key);
    } else {
      reserve(arena, key, 3 + (next() % 40));
      live.add(key);
    }
    if (i % 50 === 0) sound(arena, `after ${i}`);
  }
  sound(arena, "at the end");
  for (const key of live) release(arena, key);
  assert.equal(arena.used, 0, "everything given back leaves an empty arena");
  assert.deepEqual(arena.free, []);
});

report("arena");
