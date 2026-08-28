// The grid is arithmetic that fails silently: an off-by-a-half-cell snap looks like a grid that is
// simply offset, and a size that is not a power of two only shows up as drift a hundred operations in.
// Run with: node --experimental-strip-types src/grid/snap.check.ts
import assert from "node:assert/strict";
import { report, test } from "../check.ts";
import {
  DEFAULT_EXPONENT, MAX_EXPONENT, MIN_EXPONENT, clampExponent, exponents, formatSize, gridExtent,
  gridSize, isMajor, snap, snapDelta, snapDown, snapTowards, snapUp,
} from "./snap.ts";

test("every rung of the ladder is an exact power of two", () => {
  for (const e of exponents()) {
    const size = gridSize(e);
    assert.equal(size, 2 ** e);
    // exact in binary: the round trip through a division is lossless
    assert.equal(size / 2 ** e, 1);
  }
});

test("the ladder covers exactly the declared range", () => {
  assert.deepEqual(exponents()[0], MIN_EXPONENT);
  assert.deepEqual(exponents().at(-1), MAX_EXPONENT);
  assert.equal(exponents().length, MAX_EXPONENT - MIN_EXPONENT + 1);
  assert.ok(exponents().includes(DEFAULT_EXPONENT));
});

test("the exponent is clamped and rounded, never left fractional", () => {
  assert.equal(clampExponent(-99), MIN_EXPONENT);
  assert.equal(clampExponent(99), MAX_EXPONENT);
  assert.equal(clampExponent(0.4), 0);
  assert.equal(clampExponent(-1.5), -1); // Math.round ties toward +Infinity
  assert.equal(gridSize(-99), 2 ** MIN_EXPONENT);
});

test("snapping is exact on the default grid", () => {
  const size = gridSize(DEFAULT_EXPONENT); // 0.25
  assert.equal(size, 0.25);
  assert.equal(snap(0, size), 0);
  assert.equal(snap(0.3, size), 0.25);
  assert.equal(snap(0.4, size), 0.5);
  assert.equal(snap(-0.3, size), -0.25);
  assert.equal(snap(12.5, size), 12.5); // already on grid, unchanged
});

test("a value already on the grid is a fixed point of every snap", () => {
  for (const e of exponents()) {
    const size = gridSize(e);
    for (const cells of [-1024, -3, 0, 1, 7, 1024]) {
      const on = cells * size;
      assert.equal(snap(on, size), on, `snap ${on} @ ${size}`);
      assert.equal(snapUp(on, size), on, `snapUp ${on} @ ${size}`);
      assert.equal(snapDown(on, size), on, `snapDown ${on} @ ${size}`);
    }
  }
});

test("snapDown and snapUp bracket the value", () => {
  const size = gridSize(-2);
  for (const v of [0.1, -0.1, 3.7, -3.7, 0]) {
    assert.ok(snapDown(v, size) <= v, `${snapDown(v, size)} <= ${v}`);
    assert.ok(snapUp(v, size) >= v, `${snapUp(v, size)} >= ${v}`);
    assert.ok(snapUp(v, size) - snapDown(v, size) <= size + 1e-12);
  }
});

test("snapTowards never moves back past the start", () => {
  const size = 0.25;
  assert.equal(snapTowards(0.1, size, 1), 0.25);
  assert.equal(snapTowards(0.1, size, -1), 0);
  assert.equal(snapTowards(0.1, size, 0), 0);
  // the first pixel of a pull must not collapse to zero
  assert.ok(snapTowards(0.001, size, 1) > 0);
  assert.equal(snapTowards(-0.001, size, -1), -0.25);
});

test("snapDelta preserves an off-grid origin's offset", () => {
  const size = 0.25;
  const origin = 0.1;
  const delta = snapDelta(origin, 0.3, size);
  // the result lands on the grid...
  assert.equal(snap(origin + delta, size), origin + delta);
  // ...and moving by a whole cell from an off-grid origin does not re-align it
  const whole = snapDelta(origin, size, size);
  assert.ok(Math.abs(origin + whole - 0.25) < 1e-12);
});

test("major lines fall every MAJOR_EVERY cells, origin included", () => {
  assert.ok(isMajor(0));
  assert.ok(isMajor(8));
  assert.ok(isMajor(-8));
  assert.ok(!isMajor(1));
  assert.ok(!isMajor(7));
  assert.ok(isMajor(6, 3));
});

test("the drawn extent stays inside the line budget and the 32 m reach", () => {
  const maxCells = 2048;
  for (const e of exponents()) {
    const size = gridSize(e);
    const extent = gridExtent(size, maxCells);
    assert.ok(extent > 0, `extent ${extent} @ ${size}`);
    assert.ok(extent <= 32, `extent ${extent} exceeds reach @ ${size}`);
    const cells = (2 * extent) / size;
    assert.ok(cells <= maxCells + 1e-9, `${cells} cells exceeds budget @ ${size}`);
  }
});

test("sizes are written exactly, never rounded", () => {
  assert.equal(formatSize(2), "2 m");
  assert.equal(formatSize(0.25), "250 mm");
  assert.equal(formatSize(gridSize(MIN_EXPONENT)), "15.625 mm");
});

report("grid");
