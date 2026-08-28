// node --experimental-strip-types --disable-warning=ExperimentalWarning src/viewport/layout.check.ts
import { strict as assert } from "node:assert";
import { report, test } from "../check.ts";
import {
  LAYOUTS, MIN_FRACTION, cellAt, cellsOf, clampSplit, cycleLayout, rectOf, soloCell, splittersOf,
} from "./layout.ts";

const SPLIT = { x: 0.6, y: 0.4 };

test("every layout tiles the whole area, with no overlap and nothing left over", () => {
  for (const kind of LAYOUTS) {
    const cells = cellsOf(kind, SPLIT);
    const area = cells.reduce((sum, cell) => sum + cell.w * cell.h, 0);
    assert.ok(Math.abs(area - 1) < 1e-12, `${kind} covers ${area} of the area`);
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i]!;
        const b = cells[j]!;
        const over =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.ok(!over, `${kind}: ${a.view} overlaps ${b.view}`);
      }
    }
  }
});

test("the 3D view is in every layout and comes first", () => {
  for (const kind of LAYOUTS) assert.equal(cellsOf(kind, SPLIT)[0]!.view, "3d");
});

test("each layout has one more pane than the last", () => {
  assert.deepEqual(LAYOUTS.map((kind) => cellsOf(kind, SPLIT).length), [1, 2, 3, 4]);
});

test("panes are named once each", () => {
  for (const kind of LAYOUTS) {
    const views = cellsOf(kind, SPLIT).map((cell) => cell.view);
    assert.equal(new Set(views).size, views.length, `${kind} shows a view twice`);
  }
});

test("rounded rectangles share their edges, so no seam is ever left unpainted", () => {
  const area = { width: 1437, height: 811 }; // deliberately odd, which is where a gap would show
  for (const kind of LAYOUTS) {
    for (const cell of cellsOf(kind, SPLIT)) {
      const rect = rectOf(cell, area);
      assert.ok(rect.width > 0 && rect.height > 0, `${kind}: ${cell.view} rounded away to nothing`);
      // a cell that reaches an edge of the container must land exactly on it
      if (cell.x === 0) assert.equal(rect.left, 0);
      if (cell.y === 0) assert.equal(rect.top, 0);
      if (Math.abs(cell.x + cell.w - 1) < 1e-12) assert.equal(rect.left + rect.width, area.width);
      if (Math.abs(cell.y + cell.h - 1) < 1e-12) assert.equal(rect.top + rect.height, area.height);
    }
  }
  // and neighbours meet: the four-pane layout's left column ends where its right column starts
  const [topLeft, topRight] = cellsOf("four", SPLIT).map((cell) => rectOf(cell, area));
  assert.equal(topLeft!.left + topLeft!.width, topRight!.left);
});

test("a split cannot squeeze a pane out of existence", () => {
  assert.deepEqual(clampSplit({ x: -3, y: 9 }), { x: MIN_FRACTION, y: 1 - MIN_FRACTION });
  const cells = cellsOf("four", { x: 0, y: 1 });
  for (const cell of cells) assert.ok(cell.w >= MIN_FRACTION && cell.h >= MIN_FRACTION);
});

test("cycling walks the whole set and wraps both ways", () => {
  let kind = LAYOUTS[0]!;
  const seen = [kind];
  for (let i = 0; i < LAYOUTS.length - 1; i++) seen.push((kind = cycleLayout(kind)));
  assert.deepEqual(seen, LAYOUTS);
  assert.equal(cycleLayout(LAYOUTS[LAYOUTS.length - 1]!), LAYOUTS[0]);
  assert.equal(cycleLayout(LAYOUTS[0]!, -1), LAYOUTS[LAYOUTS.length - 1]);
});

test("a point lands in the pane that holds it", () => {
  const cells = cellsOf("four", SPLIT);
  assert.equal(cells[cellAt(cells, { x: 0.1, y: 0.1 })]!.view, "3d");
  assert.equal(cells[cellAt(cells, { x: 0.9, y: 0.1 })]!.view, "top");
  assert.equal(cells[cellAt(cells, { x: 0.1, y: 0.9 })]!.view, "front");
  assert.equal(cells[cellAt(cells, { x: 0.9, y: 0.9 })]!.view, "side");
  // the split itself belongs to the pane on its far side, so no point falls between two panes
  assert.equal(cells[cellAt(cells, { x: SPLIT.x, y: SPLIT.y })]!.view, "side");
  assert.equal(cellAt(cells, { x: 1.5, y: 0.5 }), -1);
});

test("a maximised pane is the only one there is", () => {
  const cells = soloCell("front");
  assert.deepEqual(cells, [{ view: "front", x: 0, y: 0, w: 1, h: 1 }]);
});

test("a splitter exists for every division the layout actually has", () => {
  assert.deepEqual(splittersOf("one", SPLIT), []);
  assert.equal(splittersOf("two", SPLIT).length, 1);
  assert.equal(splittersOf("three", SPLIT).length, 2);
  assert.equal(splittersOf("four", SPLIT).length, 2);

  // in three panes the horizontal split only divides the right-hand column; in four it crosses everything
  const [, three] = splittersOf("three", SPLIT);
  assert.equal(three!.x, SPLIT.x);
  assert.ok(Math.abs(three!.w - (1 - SPLIT.x)) < 1e-12);
  const [, four] = splittersOf("four", SPLIT);
  assert.equal(four!.x, 0);
  assert.equal(four!.w, 1);
});

report("layout");
