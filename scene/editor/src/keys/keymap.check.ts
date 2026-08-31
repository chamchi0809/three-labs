// The keymap: what a chord means, what a designer's changes do to it, and what makes two rows a conflict.
// Run with: node --experimental-strip-types src/keys/keymap.check.ts
import assert from "node:assert/strict";
import { report, test } from "../check.ts";
import {
  bindingsOf, chordKey, chordOf, chordsFor, commandFor, conflictsOf, COMMANDS, DEFAULTS, isFlyChord,
  isViewCommand, keyOf, parseChord, printChord, rowKey, type Binding, type Custom,
} from "./keymap.ts";

const press = (key: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) =>
  ({ key, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt });

// ---------------------------------------------------------------- chords

test("a chord has one spelling, whichever order the modifiers were written in", () => {
  assert.equal(chordKey({ key: "s", ctrl: true, shift: true }), "ctrl+shift+s");
  assert.equal(chordKey({ key: "s", shift: true, ctrl: true }), "ctrl+shift+s");
  assert.equal(chordKey({ key: "s" }), "s");
});

test("⌘ and ctrl are the same intent and are never told apart", () => {
  assert.deepEqual(chordOf(press("S", { meta: true })), chordOf(press("s", { ctrl: true })));
});

test("a modifier on its own is not a chord, because it is the start of one", () => {
  for (const key of ["Control", "Meta", "Shift", "Alt"]) assert.equal(chordOf(press(key)), undefined);
  assert.deepEqual(chordOf(press("Escape")), { key: "escape" });
});

test("a chord survives being written down and read back", () => {
  for (const binding of DEFAULTS) {
    const back = parseChord(chordKey(binding.chord));
    assert.equal(back && chordKey(back), chordKey(binding.chord), `${chordKey(binding.chord)} did not`);
  }
  assert.equal(parseChord("ctrl+meta+s"), undefined, "there is no fourth modifier");
});

test("a chord prints in the symbols the hints already use", () => {
  assert.equal(printChord({ key: "s", ctrl: true, shift: true }), "⇧⌘S", "modifiers in menu-bar order");
  assert.equal(printChord({ key: " " }), "space");
  assert.equal(printChord({ key: "escape" }), "esc");
  assert.equal(printChord({ key: "[" }), "[");
  assert.equal(printChord({ key: "h", ctrl: true, alt: true }), "⌥⌘H");
});

// ---------------------------------------------------------------- the defaults

test("every default binds a command that exists", () => {
  const known = new Set(COMMANDS.map((c) => c.id));
  for (const binding of DEFAULTS) {
    assert.ok(known.has(binding.command), `${binding.command} is bound but is not a command`);
  }
});

test("the defaults have no conflicts in them", () => {
  assert.deepEqual([...conflictsOf(DEFAULTS).keys()], []);
});

test("redo answers to both spellings of redo", () => {
  const both = chordsFor(DEFAULTS, "edit.redo").map(chordKey);
  assert.deepEqual(both.sort(), ["ctrl+shift+z", "ctrl+y"].sort());
});

test("the two halves of the editor do not overlap", () => {
  const view = COMMANDS.filter((c) => isViewCommand(c.id)).map((c) => c.id);
  assert.deepEqual(view, [
    "view.layout1", "view.layout2", "view.layout3", "view.layout4",
    "view.maximise", "view.frame", "view.frameAll",
  ]);
  assert.ok(isViewCommand("tool.shape"), "a tool is the viewport's to switch");
  assert.ok(!isViewCommand("file.save"));
});

// ---------------------------------------------------------------- what a designer changes

const custom = (over: Partial<Custom> = {}): Custom => ({ off: [], on: [], ...over });

test("a row that was taken out is not in force, and the rest of the map is untouched", () => {
  const gone = rowKey({ chord: { key: "y", ctrl: true }, command: "edit.redo" });
  const now = bindingsOf(DEFAULTS, custom({ off: [gone] }));
  assert.equal(commandFor(now, { key: "y", ctrl: true }), undefined);
  assert.equal(commandFor(now, { key: "z", ctrl: true, shift: true }), "edit.redo", "the other one stayed");
  assert.equal(commandFor(now, { key: "s", ctrl: true }), "file.save");
});

test("a row that was put in wins over the default it was meant to replace", () => {
  const on: Binding[] = [{ chord: { key: "f", ctrl: true }, command: "file.save" }];
  const now = bindingsOf(DEFAULTS, custom({ on }));
  assert.equal(commandFor(now, { key: "f", ctrl: true }), "file.save");
  assert.equal(commandFor(now, { key: "s", ctrl: true }), "file.save", "and the default is still there");
});

test("a command added after the designer customised their map still arrives with its key", () => {
  // the reason the difference is stored rather than the whole table: pretend `DEFAULTS` has just grown
  const grown = [...DEFAULTS, { chord: { key: "b", ctrl: true }, command: "later.command" }];
  const theirs = custom({ off: [rowKey(DEFAULTS[0]!)] });
  assert.equal(commandFor(bindingsOf(grown, theirs), { key: "b", ctrl: true }), "later.command");
});

test("two commands on one chord is a conflict, and says which two", () => {
  const on: Binding[] = [{ chord: { key: "s", ctrl: true }, command: "file.saveAs" }];
  const found = conflictsOf(bindingsOf(DEFAULTS, custom({ on })));
  assert.deepEqual([...found.keys()], ["ctrl+s"]);
  assert.deepEqual(found.get("ctrl+s"), ["file.save", "file.saveAs"]);
});

test("the same command bound twice to the same chord is not a conflict with itself", () => {
  const on: Binding[] = [{ chord: { key: "s", ctrl: true }, command: "file.save" }];
  assert.deepEqual([...conflictsOf(bindingsOf(DEFAULTS, custom({ on }))).keys()], []);
});

// ---------------------------------------------------------------- input methods

test("a key an input method rewrote is still the key that was pressed", () => {
  // what Chrome reports for the W key with a Hangul keyboard on
  assert.equal(keyOf({ key: "\u3148", code: "KeyW" }), "w");
  assert.equal(keyOf({ key: "\u3141", code: "KeyA" }), "a");
  assert.equal(keyOf({ key: "1", code: "Digit1" }), "1");
  assert.equal(chordOf({ key: "\u3145", code: "KeyS", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false })?.key, "s");
});

test("a latin layout is taken at its word, not by where QWERTY puts the key", () => {
  // Dvorak: the key QWERTY calls S types O, and O is what the designer meant
  assert.equal(keyOf({ key: "o", code: "KeyS" }), "o");
  assert.equal(keyOf({ key: "Escape", code: "Escape" }), "escape");
  assert.equal(keyOf({ key: "[", code: "BracketLeft" }), "[");
  assert.equal(keyOf({ key: "w" }), "w", "an event with no code is still a key");
});

test("the camera keeps wasd and qe: a binding on one of them is dropped, modified is fine", () => {
  const on = [
    { chord: { key: "w" }, command: "tool.shape" },
    { chord: { key: "e", shift: true }, command: "tool.entity" },
    { chord: { key: "d", ctrl: true }, command: "edit.duplicate" },
  ];
  const live = bindingsOf([], { off: [], on });
  assert.deepEqual(live.map((b) => b.command), ["edit.duplicate"], "shift alone does not free a fly key");
  assert.equal(isFlyChord({ key: "q" }), true);
  assert.equal(isFlyChord({ key: "q", ctrl: true }), false);
  assert.equal(isFlyChord({ key: "f" }), false);
  // and nothing shipped is on one of them
  for (const b of DEFAULTS) assert.equal(isFlyChord(b.chord), false, `${b.command} is bound to a fly key`);
});

report("keys");
