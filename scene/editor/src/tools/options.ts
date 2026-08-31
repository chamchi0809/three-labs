/**
 * The settings a tool has, listed so the sub-toolbar can draw them.
 *
 * The keys were always there — tab cycles the shape, `,` and `.` step the sides — but a key you have to
 * have read the hint to know about is a setting only half the designers ever find. This is the same state
 * behind a row of buttons, so the tool bar can show what the tool is set to without either half becoming
 * the source of truth: every entry reads and writes the tool's own module state, and the key handlers are
 * left exactly as they were.
 *
 * `key` is what the button row prints next to the control ("[tab] to cycle"), not a binding — the tools
 * still own their own presses.
 */
import { clampSides } from "../brush/builder.ts";
import { PATCH_SHAPES } from "tscene";
import { KEEPS, clipState } from "./clip.ts";
import { OBJECT_TYPES, objectSettings, placingName, setObjectType } from "./object.ts";
import { patchSettings, setPatch } from "./patch.ts";
import { SHAPE_KINDS, setShape, shapeSettings } from "./shape.ts";
import { MAX_SEGMENTS, setSegments, sweepState } from "./sweep.ts";
import type { ToolId } from "./tool.ts";

/** one of a short list of words, shown as a row of buttons */
export type Choice = {
  kind: "choice";
  label: string;
  /** what it means, for the tooltip */
  about: string;
  /** the key that steps through it, if it has one */
  key?: string;
  values: readonly string[];
  get(): string;
  /** returns what the status line should say */
  set(value: string): string;
};

/** a number with a floor, shown as −/+ around the value */
export type Stepper = {
  kind: "number";
  label: string;
  about: string;
  /** the pair of keys that step it, if it has one */
  keys?: [string, string];
  get(): number;
  set(value: number): string;
  /** hidden while the tool is set to something the number means nothing for */
  shown?(): boolean;
};

export type ToolOption = Choice | Stepper;

const round = (kind: string) => kind === "cylinder" || kind === "cone" || kind === "sphere";

export const TOOL_OPTIONS: Partial<Record<ToolId, ToolOption[]>> = {
  shape: [
    {
      kind: "choice", label: "shape", about: "what a drag draws", key: "tab", values: SHAPE_KINDS,
      get: () => shapeSettings.kind,
      set: (v) => setShape({ kind: v as (typeof SHAPE_KINDS)[number] }).kind,
    },
    {
      kind: "number", label: "sides", about: "how many sides a round shape has", keys: [",", "."],
      get: () => shapeSettings.sides,
      set: (v) => `${setShape({ sides: clampSides(v) }).sides} sides`,
      shown: () => round(shapeSettings.kind),
    },
    {
      kind: "number", label: "rings", about: "how many horizontal bands a sphere has",
      get: () => shapeSettings.rings,
      set: (v) => `${setShape({ rings: Math.max(1, Math.round(v)) }).rings} rings`,
      shown: () => shapeSettings.kind === "sphere" || shapeSettings.kind === "icosphere",
    },
    {
      kind: "number", label: "depth", about: "how tall the shape is, in grid cells", keys: ["-", "+"],
      get: () => shapeSettings.cells,
      set: (v) => `${setShape({ cells: Math.max(1, Math.round(v)) }).cells} cells deep`,
    },
  ],
  patch: [
    {
      kind: "choice", label: "patch", about: "what a drag draws", key: "tab", values: PATCH_SHAPES,
      get: () => patchSettings.shape,
      set: (v) => setPatch({ shape: v as (typeof PATCH_SHAPES)[number] }).shape,
    },
    {
      kind: "number", label: "depth", about: "how far the curve bends, in grid cells", keys: ["-", "+"],
      get: () => patchSettings.cells,
      set: (v) => `${setPatch({ cells: Math.max(1, Math.round(v)) }).cells} cells deep`,
      shown: () => patchSettings.shape !== "plane",
    },
  ],
  object: [
    {
      kind: "choice", label: "type", about: "what a click places", key: "tab", values: OBJECT_TYPES.map((e) => e.type),
      // a definition picked in the browser is a type the row has no button for, so it reads the whole name
      get: () => (objectSettings.def ? placingName() : objectSettings.type),
      set: setObjectType,
    },
  ],
  clip: [
    {
      kind: "choice", label: "keep", about: "which side of the cut to keep", key: "tab", values: KEEPS,
      get: () => clipState.keep,
      set: (v) => `keep ${(clipState.keep = v as (typeof KEEPS)[number])}`,
    },
  ],
  sweep: [
    {
      kind: "number", label: "segments", about: "how many copies to leave behind", keys: [",", "."],
      get: () => sweepState.segments,
      set: (v) => `${setSegments(Math.min(MAX_SEGMENTS, v))} segments`,
    },
  ],
};

/**
 * The rest of a tool's keys — the ones that do something rather than set something.
 *
 * The same argument as the options: a key nobody can see is a key nobody presses. These are printed as
 * plain chips along the row, so every tool says everything it answers to without the designer having to
 * find it in a hint or a keymap.
 */
export const TOOL_KEYS: Partial<Record<ToolId, [string, string][]>> = {
  select: [["⌘A", "select all"], ["esc", "deselect"], ["shift", "add to selection"], ["alt", "pick a face"]],
  move: [["arrows", "move one cell"], ["alt", "move up and down"], ["shift", "lock to one axis"]],
  rotate: [["alt", "1° steps"]],
  scale: [["shift", "keep the proportions"], ["alt", "scale from the middle"]],
  shear: [],
  patch: [
    ["r", "add a row"], ["c", "add a column"], ["shift", "remove instead"], ["f", "flip"],
    ["s", "snap to the grid"],
  ],
  extrude: [["shift", "add to selection"]],
  clip: [["enter", "cut"], ["backspace", "undo the last point"], ["esc", "clear the points"]],
  vertex: [["shift", "add to selection"], ["alt", "drag up and down"]],
  edge: [["shift", "add to selection"], ["alt", "drag up and down"]],
  face: [["shift", "add to selection"], ["alt", "drag up and down"], ["x", "extrude"]],
  attributes: [
    ["arrows", "move the material"], [", .", "rotate"], ["- =", "resize"], ["0", "reset"],
    ["9", "fit to the face"], ["j l", "flip"], ["enter", "apply the material"],
    ["alt+click", "copy the material"],
  ],
};

/** what the sub-toolbar should draw for a tool: the options it has that apply right now */
export const optionsFor = (id: ToolId): ToolOption[] =>
  (TOOL_OPTIONS[id] ?? []).filter((o) => o.kind === "choice" || (o.shown?.() ?? true));
