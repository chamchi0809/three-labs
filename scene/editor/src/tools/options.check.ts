/**
 * The sub-toolbar's table of settings.
 *
 * It is a second way into state the keys already reach, and the way that goes wrong silently is a getter
 * and a setter that disagree — a button that lights up on the wrong word, or one that sets a shape the
 * builder has never heard of. So: every choice reads back what it was set to, and every value it offers
 * is one the tool actually draws.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/options.check.ts
 */
import { strict as assert } from "node:assert";
import { report, test } from "../check.ts";
import { TOOL_KEYS, TOOL_OPTIONS, optionsFor } from "./options.ts";
import { setShape, shapeSettings } from "./shape.ts";
import { TOOLS } from "./tools.ts";
import type { ToolId } from "./tool.ts";

test("every choice reads back what it was set to", () => {
  for (const [id, options] of Object.entries(TOOL_OPTIONS)) {
    for (const option of options) {
      if (option.kind !== "choice") continue;
      assert.ok(option.values.length > 1, `${id} ${option.label} is a choice of one`);
      const was = option.get();
      for (const value of option.values) {
        option.set(value);
        assert.equal(option.get(), value, `${id} ${option.label} does not read back ${value}`);
      }
      option.set(was);
    }
  }
});

test("every stepper clamps rather than going to nothing", () => {
  for (const [id, options] of Object.entries(TOOL_OPTIONS)) {
    for (const option of options) {
      if (option.kind !== "number") continue;
      const was = option.get();
      option.set(-10);
      assert.ok(option.get() >= 1, `${id} ${option.label} went to ${option.get()}`);
      option.set(was);
    }
  }
});

test("the sides only show for the shapes that have sides", () => {
  setShape({ kind: "cuboid" });
  assert.ok(!optionsFor("shape").some((o) => o.label === "sides"));
  setShape({ kind: "cylinder" });
  assert.ok(optionsFor("shape").some((o) => o.label === "sides"));
  setShape({ kind: "cuboid", sides: 8, rings: 4, cells: 4 });
  assert.equal(shapeSettings.kind, "cuboid");
});

test("the table only names tools that exist", () => {
  const ids = new Set<ToolId>(TOOLS.map((t) => t.id));
  for (const id of [...Object.keys(TOOL_OPTIONS), ...Object.keys(TOOL_KEYS)]) {
    assert.ok(ids.has(id as ToolId), `no tool called ${id}`);
  }
});

report("tools/options");
