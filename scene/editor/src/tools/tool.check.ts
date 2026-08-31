/**
 * The press-to-drag state machine, driven the way the host drives it.
 *
 * Every check here is a whole gesture — down, move, move, up — because that is the unit a tool is wrong in.
 * The tool under test records what it was told, so the assertions are about *which* callback ran and *what
 * it was given*, which is where the interesting mistakes are: a drag that begins from where the threshold
 * was crossed rather than from where the button went down, a click that also fires after a drag.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/tools/tool.check.ts
 */
import { strict as assert } from "node:assert";
import { report, test } from "../check.ts";
import { newEditor, type Editor } from "../doc/editor.ts";
import { newView } from "../viewport/view.ts";
import { newInput, type InputState } from "./input.ts";
import { ToolBox, merge, type DragTracker, type Outcome, type Tool, type ToolId } from "./tool.ts";

const SIZE = { width: 800, height: 400 };
const VIEW = newView("top");
const at = (x: number, y: number, over: Partial<InputState> = {}): InputState =>
  newInput({ camera: VIEW, size: SIZE, at: { x, y }, button: 0, ...over });

const editor = (): Editor => newEditor();

/** a tool that does nothing but write down what it was asked to do */
function recorder(id: ToolId = "select") {
  const log: string[] = [];
  let began: InputState | undefined;
  const tracker: DragTracker = {
    move: (input) => (log.push(`move ${input.at.x}`), { note: `move ${input.at.x}` }),
    end: (input) => (log.push(`end ${input.at.x}`), { note: `end ${input.at.x}` }),
    cancel: () => (log.push("cancel"), { note: null }),
  };
  const tool: Tool = {
    id, title: id, key: id[0]!, hint: `${id} hint`,
    click: (input) => (log.push(`click ${input.at.x}`), { note: `click ${input.at.x}` }),
    drag: (input) => ((began = input), log.push(`drag ${input.at.x}`), tracker),
    hover: (input) => (log.push(`hover ${input.at.x}`), undefined),
    leave: () => (log.push("leave"), { note: "left" }),
  };
  return { tool, log, started: () => began };
}

// ---------------------------------------------------------------- click and drag

test("a press that goes nowhere is a click, and the click is the only thing that happens", () => {
  const { tool, log } = recorder();
  const box = new ToolBox([tool]);
  const e = editor();
  box.down(at(100, 100), e);
  box.move(at(102, 101), e); // inside the threshold
  const out = box.up(at(102, 101), e);
  assert.deepEqual(log, ["click 100"]);
  assert.equal(out?.note, "click 100", "a click reports where the button went down, not where it came up");
  assert.equal(out?.separate, true, "and the gesture is over");
});

test("a press that travels becomes a drag, and it begins where the button went down", () => {
  const { tool, log, started } = recorder();
  const box = new ToolBox([tool]);
  const e = editor();
  box.down(at(100, 100), e);
  box.move(at(101, 100), e);
  assert.deepEqual(log, [], "two pixels is a hand shaking, not an instruction");
  box.move(at(120, 100), e);
  assert.equal(started()?.at.x, 100, "a drag that started at the threshold silently loses its first pixels");
  assert.deepEqual(log, ["drag 100", "move 120"]);
});

test("a drag ends with end, and never also with a click", () => {
  const { tool, log } = recorder();
  const box = new ToolBox([tool]);
  const e = editor();
  box.down(at(100, 100), e);
  box.move(at(140, 100), e);
  assert.ok(box.dragging);
  const out = box.up(at(160, 100), e);
  assert.deepEqual(log, ["drag 100", "move 140", "end 160"]);
  assert.ok(!box.dragging);
  assert.equal(out?.separate, true);
});

test("a pointer with no button down only ever hovers", () => {
  const { tool, log } = recorder();
  const box = new ToolBox([tool]);
  box.move(at(10, 10), editor());
  box.move(at(90, 10), editor());
  assert.deepEqual(log, ["hover 10", "hover 90"]);
});

test("only the left button starts anything", () => {
  const { tool, log } = recorder();
  const box = new ToolBox([tool]);
  const e = editor();
  assert.equal(box.down(at(100, 100, { button: 2 }), e), undefined);
  box.move(at(200, 100), e);
  assert.deepEqual(log, ["hover 200"], "the right button belongs to the camera, not to the tool");
});

test("a tool that declines the drag gets neither the drag nor a click out of it", () => {
  const log: string[] = [];
  const tool: Tool = {
    id: "select", title: "t", key: "t", hint: "",
    click: () => (log.push("click"), undefined),
    drag: () => (log.push("declined"), undefined),
  };
  const box = new ToolBox([tool]);
  const e = editor();
  box.down(at(100, 100), e);
  box.move(at(200, 100), e);
  box.move(at(300, 100), e);
  box.up(at(300, 100), e);
  assert.deepEqual(log, ["declined"], "declining once declines the whole gesture");
});

// ---------------------------------------------------------------- getting out of a drag

test("escape cancels the drag rather than reaching the tool's own keys", () => {
  const { tool, log } = recorder();
  const box = new ToolBox([tool]);
  const e = editor();
  box.down(at(100, 100), e);
  box.move(at(200, 100), e);
  const out = box.press("escape", at(200, 100), e);
  assert.deepEqual(log, ["drag 100", "move 200", "cancel"]);
  assert.equal(out?.separate, true);
  assert.ok(!box.dragging);
  box.up(at(200, 100), e);
  assert.deepEqual(log, ["drag 100", "move 200", "cancel"], "the button coming up afterwards is nothing");
});

test("a setting pressed mid-drag redraws the drag where the pointer already is", () => {
  const { tool, log } = recorder();
  tool.press = (key) => (log.push(`press ${key}`), { note: key });
  const box = new ToolBox([tool]);
  const e = editor();
  box.down(at(100, 100), e);
  box.move(at(200, 100), e);
  const out = box.press("+", at(200, 100), e);
  assert.deepEqual(log, ["drag 100", "move 200", "press +", "move 200"],
    "the key changed a setting, so the shape under the pointer is built again from it");
  assert.equal(out?.note, "move 200", "and what the status line says is the redrawn shape, not the key");
});

test("a key the tool does not answer to leaves the drag alone", () => {
  const { tool, log } = recorder();
  tool.press = () => undefined;
  const box = new ToolBox([tool]);
  const e = editor();
  box.down(at(100, 100), e);
  box.move(at(200, 100), e);
  assert.equal(box.press("z", at(200, 100), e), undefined);
  assert.deepEqual(log, ["drag 100", "move 200"]);
});

test("escape with nothing happening is left for the tool", () => {
  const log: string[] = [];
  const tool: Tool = {
    id: "select", title: "t", key: "t", hint: "",
    press: (key) => (log.push(key), { note: key }),
  };
  const box = new ToolBox([tool]);
  assert.equal(box.press("escape", undefined, editor())?.note, "escape");
  assert.deepEqual(log, ["escape"]);
});

test("switching tools ends the drag and lets the tool put back what it was drawing", () => {
  const a = recorder("select");
  const b = recorder("move");
  const box = new ToolBox([a.tool, b.tool]);
  const e = editor();
  box.down(at(100, 100), e);
  box.move(at(200, 100), e);
  const out = box.select("move", e);
  assert.deepEqual(a.log, ["drag 100", "move 200", "cancel", "leave"]);
  assert.equal(box.current.id, "move");
  assert.equal(out?.note, "move hint", "the new tool's hint is what the status line should read");
  assert.equal(out?.separate, true);
});

test("switching to the tool that is already up does nothing at all", () => {
  const { tool, log } = recorder();
  const box = new ToolBox([tool]);
  assert.equal(box.select("select", editor()), undefined);
  assert.deepEqual(log, []);
});

test("a tool is found by its key, and unknown keys find nothing", () => {
  const a = recorder("select");
  const b = recorder("move");
  const box = new ToolBox([a.tool, b.tool]);
  assert.equal(box.byKey("m")?.id, "move");
  assert.equal(box.byKey("q"), undefined);
});

// ---------------------------------------------------------------- merging outcomes

test("merging keeps the lines a tool drew while the box adds its own answer", () => {
  const lines = new Float32Array([1, 2, 3]);
  const both = merge({ decor: { "tool:band": lines }, note: "banding" }, { separate: true });
  assert.equal(both?.decor?.["tool:band"], lines, "a band that survived the mouse coming up is a bug");
  assert.equal(both?.note, "banding");
  assert.equal(both?.separate, true);
});

test("later wins, and clearing something is a value rather than an absence", () => {
  const both = merge({ note: "a", band: { view: "top", rect: { left: 0, top: 0, right: 1, bottom: 1 } } },
                     { note: null, band: null });
  assert.equal(both?.note, null);
  assert.equal(both?.band, null);
  const kept = merge({ note: "a" }, { separate: true });
  assert.equal(kept?.note, "a", "an outcome with no opinion about the note leaves it alone");
});

test("merging with nothing is the other one, unchanged", () => {
  const one: Outcome = { note: "x" };
  assert.equal(merge(one, undefined), one);
  assert.equal(merge(undefined, one), one);
  assert.equal(merge(undefined, undefined), undefined);
});

report("tool");
