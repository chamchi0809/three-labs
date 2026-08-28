// The index every pick and every rubber band goes through. A query that misses something is a solid the
// designer cannot click on, which is the least debuggable kind of bug there is: nothing happens.
// Run with: node --experimental-strip-types src/doc/octree.check.ts
import assert from "node:assert/strict";
import { report, test } from "../check.ts";
import type { Bounds } from "../brush/builder.ts";
import { boundsOverlap } from "./document.ts";
import { depth, insert, items, octree, octreeOf, queryBounds, queryInside, queryRay, rayBounds, remove, type Item } from "./octree.ts";

const at = (x: number, y: number, z: number, size = 1): Bounds => ({
  min: [x, y, z], max: [x + size, y + size, z + size],
});

/** a wall of solids: enough of them, and spread far enough, that the tree has to actually split */
const many = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `n${i}`, bounds: at((i % 10) * 4, Math.floor(i / 10) * 4, (i % 7) * 4) }));

test("everything put in comes back out, however deep it went", () => {
  const list = many(200);
  const tree = octreeOf(list);
  assert.equal(tree.count, 200);
  assert.deepEqual(items(tree).map((i) => i.id).sort(), list.map((i) => i.id).sort());
  assert.ok(depth(tree) > 2, `the tree actually split: depth ${depth(tree)}`);
});

test("a query finds exactly what a brute-force pass would", () => {
  const list = many(200);
  const tree = octreeOf(list);
  for (const box of [at(0, 0, 0, 6), at(15, 12, 3, 10), at(-50, -50, -50, 5), at(0, 0, 0, 1000)]) {
    const found = queryBounds(tree, box).map((i) => i.id).sort();
    const expected = list.filter((i) => boundsOverlap(i.bounds, box)).map((i) => i.id).sort();
    assert.deepEqual(found, expected, `the box at ${box.min}`);
  }
});

test("inside is stricter than touching", () => {
  const tree = octreeOf([{ id: "a", bounds: at(0, 0, 0) }, { id: "b", bounds: at(5, 5, 5) }]);
  const box = at(-1, -1, -1, 4);
  assert.deepEqual(queryBounds(tree, box).map((i) => i.id), ["a"]);
  assert.deepEqual(queryInside(tree, box).map((i) => i.id), ["a"]);
  assert.deepEqual(queryInside(tree, at(0.5, 0, 0, 4)).map((i) => i.id), [], "half in is not in");
});

test("an item can be taken out again, once", () => {
  const tree = octreeOf(many(60));
  assert.ok(remove(tree, "n42"));
  assert.equal(tree.count, 59);
  assert.equal(items(tree).find((i) => i.id === "n42"), undefined);
  assert.ok(!remove(tree, "n42"), "and not twice");
});

test("a solid outside the tree's extent still lands somewhere, rather than nowhere", () => {
  const tree = octree(at(0, 0, 0, 10));
  insert(tree, { id: "far", bounds: at(1000, 0, 0) });
  assert.deepEqual(queryBounds(tree, at(999, -1, -1, 5)).map((i) => i.id), ["far"]);
});

// ---------------------------------------------------------------- rays

test("a ray finds where it enters and leaves, and misses what it misses", () => {
  const box = at(1, -1, -1, 2);
  const hit = rayBounds([0, 0, 0], [1, 0, 0], box)!;
  assert.equal(hit.near, 1);
  assert.equal(hit.far, 3);
  assert.equal(rayBounds([0, 5, 0], [1, 0, 0], box), undefined, "over the top");
  assert.equal(rayBounds([0, 0, 0], [-1, 0, 0], box), undefined, "the wrong way");
});

test("a ray that starts inside is still a hit, and says so with a negative entry", () => {
  const hit = rayBounds([2, 0, 0], [1, 0, 0], at(1, -1, -1, 2))!;
  assert.ok(hit.near < 0 && hit.far > 0, `${hit.near} to ${hit.far}`);
});

test("a ray parallel to a pair of faces is in or out, not divided by zero", () => {
  const box = at(0, 0, 0, 2);
  assert.ok(rayBounds([1, -5, 1], [0, 1, 0], box), "straight up through it");
  assert.equal(rayBounds([9, -5, 1], [0, 1, 0], box), undefined, "straight up beside it");
});

test("a click gets its candidates nearest first", () => {
  const tree = octreeOf([
    { id: "far", bounds: at(20, 0, 0) },
    { id: "near", bounds: at(2, 0, 0) },
    { id: "middle", bounds: at(9, 0, 0) },
    { id: "aside", bounds: at(5, 40, 0) },
  ]);
  assert.deepEqual(queryRay(tree, [0, 0.5, 0.5], [1, 0, 0]).map((h) => h.item.id), ["near", "middle", "far"]);
});

test("a ray through an empty tree hits nothing and does not mind", () => {
  assert.deepEqual(queryRay(octreeOf([]), [0, 0, 0], [1, 0, 0]), []);
});

report("octree");
