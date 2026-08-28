// Placing everything in a level that is not a wall.
// node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/entity.check.ts
import { strict as assert } from "node:assert";
import type { Vec3 } from "tscene";
import { report, test } from "../check.ts";
import { layerNode, nodeBounds, type World } from "../doc/document.ts";
import { newEditor, type Editor } from "../doc/editor.ts";
import { history, run, separate, undo, type History } from "../doc/history.ts";
import { vec3Of } from "../doc/props.ts";
import { newView, type Size } from "../viewport/view.ts";
import { ENTITY_TYPES, entitySettings, entityTool, newEntity, placeAt, setEntityType } from "./entity.ts";
import { newInput, type InputState } from "./input.ts";
import { ToolBox, type Outcome } from "./tool.ts";

const SIZE: Size = { width: 800, height: 400 };
const VIEW = { ...newView("top"), target: [0, 0, 0] as Vec3, reach: 20 };

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);
const nearVec = (a: Vec3, b: Vec3, eps = 1e-9) => {
  for (let i = 0; i < 3; i++) near(a[i]!, b[i]!, eps);
};

const at = (x: number, y: number, over: Partial<InputState> = {}): InputState =>
  newInput({ camera: VIEW, size: SIZE, at: { x, y }, button: 0, ...over });

const empty = (): Editor => {
  const world: World = { layers: [layerNode("Main")], broom: { grid: -2, scale: 1 } };
  return { ...newEditor(world), layer: world.layers[0]!.id };
};

const placed = (e: Editor) => e.world.layers[0]!.children;

function apply(h: History, out: Outcome | undefined): History {
  if (!out) return h;
  let next = h;
  if (out.set) next = { ...next, editor: out.set(next.editor) };
  if (out.edit) next = run(next, out.edit);
  if (out.separate) next = separate(next);
  return next;
}

// ---------------------------------------------------------------- what a new entity is

test("a new entity is written with the position it was placed at", () => {
  const light = newEntity("pointLight", [1, 2, 3]);
  assert.equal(light.type, "pointLight");
  nearVec(vec3Of(light.props, "position")!, [1, 2, 3]);
});

test("a new entity is given a box, because a point cannot be clicked", () => {
  for (const { type, half } of ENTITY_TYPES) {
    const box = nodeBounds(newEntity(type, [0, 0, 0]));
    assert.ok(box, `${type} has nothing to pick`);
    near(box!.max[0]! - box!.min[0]!, half * 2);
  }
  // a type the list has never heard of still gets one, so the free type stays usable
  assert.ok(nodeBounds(newEntity("audioListener", [0, 0, 0])));
});

// ---------------------------------------------------------------- where it goes

test("in an orthographic pane it lands on the pane's own plane, snapped", () => {
  // the middle of a top pane is the pivot, and the pivot here is the origin
  nearVec(placeAt(at(400, 200), 0.25), [0, 0, 0]);
});

test("on a surface it lands on the surface, so a light put against a wall starts against it", () => {
  const view = newView("3d");
  const on = placeAt(newInput({
    camera: view, size: SIZE, at: { x: 400, y: 200 }, hit: { node: "n1", point: [1.03, 2.99, -0.1] },
  }), 0.25);
  nearVec(on, [1, 3, 0], 1e-9);
});

test("with nothing under it in the 3D pane it lands on the ground", () => {
  const view = { ...newView("3d"), target: [0, 0, 0] as Vec3 };
  const on = placeAt(newInput({ camera: view, size: SIZE, at: { x: 400, y: 200 } }), 0.25);
  near(on[1]!, 0, 1e-9);
});

test("looking exactly along the ground it lands at the origin, where it can be found again", () => {
  const flat = { ...newView("3d"), target: [0, 0, 0] as Vec3, pitch: 0 };
  nearVec(placeAt(newInput({ camera: flat, size: SIZE, at: { x: 400, y: 200 } }), 0.25), [0, 0, 0]);
});

// ---------------------------------------------------------------- the gesture

test("a click places one, selects it, and undo takes it away again", () => {
  setEntityType("pointLight");
  const tools = new ToolBox([entityTool]);
  let h = history(empty());
  tools.down(at(400, 200), h.editor);
  h = apply(h, tools.up(at(400, 200), h.editor));
  assert.equal(placed(h.editor).length, 1);
  assert.deepEqual(h.editor.selection.nodes, [placed(h.editor)[0]!.id]);
  h = undo(h);
  assert.equal(placed(h.editor).length, 0);
});

test("a drag is not a placement: only a click puts one down", () => {
  const tools = new ToolBox([entityTool]);
  const e = empty();
  tools.down(at(400, 200), e);
  assert.equal(tools.move(at(500, 200), e), undefined, "the tool has no drag, so there is nothing to do");
  assert.equal(tools.up(at(500, 200), e), undefined);
});

test("repeating a placement makes another one rather than moving the first", () => {
  setEntityType("pointLight");
  const tools = new ToolBox([entityTool]);
  let h = history(empty());
  tools.down(at(400, 200), h.editor);
  h = apply(h, tools.up(at(400, 200), h.editor));
  const first = placed(h.editor)[0]!.id;
  const again = h.repeat.at(-1)!;
  h = run(h, { ...again, collate: undefined, apply: again.again! });
  assert.equal(placed(h.editor).length, 2);
  assert.notEqual(placed(h.editor)[1]!.id, first);
});

test("tab walks the list of types and wraps", () => {
  setEntityType(ENTITY_TYPES[0]!.type);
  const seen = [entitySettings.type];
  for (let i = 1; i < ENTITY_TYPES.length; i++) seen.push(entityTool.press!("tab", undefined, empty())!.note!);
  assert.deepEqual(seen, ENTITY_TYPES.map((t) => t.type));
  assert.equal(entityTool.press!("tab", undefined, empty())?.note, ENTITY_TYPES[0]!.type);
  assert.equal(entityTool.press!("q", undefined, empty()), undefined);
  setEntityType("pointLight");
});

report("entity");
