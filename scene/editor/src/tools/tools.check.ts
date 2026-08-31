/**
 * The tool bar itself: the list, the keys, and the order.
 *
 * Two tools that answer to the same key means one of them can never be reached, and a tool that exists but
 * is missing from `TOOLS` means it can never be reached either — neither shows up as a type error and both
 * are invisible until someone presses the key and gets the wrong tool. So both are asserted here, and the
 * order is pinned too, because the order is the tool bar and the tool bar is muscle memory.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/tools.check.ts
 */
import { strict as assert } from "node:assert";
import { report, test } from "../check.ts";
import { attributesTool } from "./attributes.ts";
import { clipTool } from "./clip.ts";
import { edgeTool, faceTool, vertexTool } from "./corners.ts";
import { entityTool } from "./entity.ts";
import { objectTool } from "./object.ts";
import { extrudeTool } from "./extrude.ts";
import { rotateTool, scaleTool, shearTool } from "./gizmo.ts";
import { moveTool } from "./move.ts";
import { patchTool } from "./patch.ts";
import { selectTool } from "./select.ts";
import { shapeTool } from "./shape.ts";
import { sweepTool } from "./sweep.ts";
import { FLY_KEYS } from "../keys/keymap.ts";
import type { Tool, ToolId } from "./tool.ts";
import { TOOLS, newToolBox } from "./tools.ts";

/** every tool this editor has, named one at a time so a new one that never reaches `TOOLS` is caught */
const EVERY: Tool[] = [
  selectTool, moveTool, rotateTool, scaleTool, shearTool, shapeTool, patchTool, objectTool, entityTool,
  extrudeTool, sweepTool, clipTool, vertexTool, edgeTool, faceTool, attributesTool,
];

test("every tool that exists is in the bar, and nothing is in it twice", () => {
  for (const tool of EVERY) assert.ok(TOOLS.includes(tool), `${tool.id} exists but the bar never shows it`);
  assert.equal(TOOLS.length, EVERY.length);
  assert.equal(new Set(TOOLS).size, TOOLS.length);
});

test("the order is the order of a working day: pick and place, draw, shape, dress", () => {
  const ids: ToolId[] = [
    "select", "move", "rotate", "scale", "shear",
    "shape", "patch", "object", "entity",
    "extrude", "sweep", "clip",
    "vertex", "edge", "face",
    "attributes",
  ];
  assert.deepEqual(TOOLS.map((t) => t.id), ids);
});

test("no two tools answer to the same key, and no two carry the same id", () => {
  const keys = TOOLS.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length, `two tools share a key: ${keys.sort().join(" ")}`);
  const ids = TOOLS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("no tool takes a key the panes fly with", () => {
  // a tool letter becomes a keymap binding, and the keymap is read before the camera is — so a tool on `w`
  // would take flying away for as long as it was in hand. See FLY_KEYS in keys/keymap.ts.
  for (const tool of TOOLS) {
    assert.ok(!(FLY_KEYS as readonly string[]).includes(tool.key), `${tool.id} is on ${tool.key}, which flies`);
  }
});

test("a key is one lower-case character, because that is what a key event will hand it", () => {
  for (const tool of TOOLS) {
    assert.equal(tool.key.length, 1, `${tool.id} has a key of ${tool.key.length} characters`);
    assert.equal(tool.key, tool.key.toLowerCase());
    assert.ok(/[a-z]/.test(tool.key), `${tool.id} answers to ${tool.key}, which is not a letter`);
  }
});

test("every tool says what it is and what to do with it", () => {
  for (const tool of TOOLS) {
    assert.ok(tool.title.length > 0, `${tool.id} has no title`);
    assert.ok(tool.hint.length > 0, `${tool.id} has no hint`);
    assert.ok(tool.click || tool.drag || tool.press, `${tool.id} answers to nothing at all`);
  }
});

test("the tools that work on parts of a solid are the ones that ask for handles", () => {
  assert.deepEqual(vertexTool.handles, { vertices: true });
  // the patch tool asks for the same kind, and gets a patch's control points instead — they are the one
  // thing about a patch a designer takes hold of, and there is no other kind of handle they could be
  assert.deepEqual(patchTool.handles, { vertices: true });
  assert.deepEqual(edgeTool.handles, { edges: true });
  assert.deepEqual(faceTool.handles, { faces: true });
  assert.deepEqual(sweepTool.handles, { faces: true });
  assert.deepEqual(attributesTool.handles, { faces: true });
  for (const tool of [selectTool, moveTool, rotateTool, scaleTool, shearTool, shapeTool, clipTool]) {
    assert.equal(tool.handles, undefined, `${tool.id} shows handles it has no use for`);
  }
});

test("a fresh box starts on select, and every key in the bar reaches its tool", () => {
  const box = newToolBox();
  assert.equal(box.current.id, "select");
  for (const tool of TOOLS) assert.equal(box.byKey(tool.key), tool);
  assert.equal(box.byKey("q"), undefined);
});

report("tools");
