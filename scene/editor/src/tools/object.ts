/**
 * The create-object tool: everything in a level that is not a wall.
 *
 * A tscene node is whatever three calls it — `mesh`, `pointLight`, `perspectiveCamera` — so there is no
 * fixed list of objects the way a Quake editor has one, and inventing one here would be inventing a
 * second definition of what a scene may contain. What the tool carries instead is a short list of the
 * types a designer reaches for while laying out a level, and the project's own `@template`s on top of it:
 * the object browser hands one over, and from then on a click places an instance of it.
 *
 * A new object is given a `@broom { size }` even though nothing in the scene needs one, because an object
 * with no size is a point, and a point cannot be clicked. The box is what makes the thing the designer
 * just placed something they can then select, move and delete. A definition brings its own box; a bare
 * type gets a plausible one from the list below.
 */
import type { Vec3 } from "tscene";
import { ANY_NODE, instanceOf, type ObjectDef } from "../doc/catalogue.ts";
import { objectNode, insertNodes, type ObjectNode } from "../doc/document.ts";
import { gridSize, type Editor } from "../doc/editor.ts";
import { NOTHING, selectNodes } from "../doc/selection.ts";
import { setVec3 } from "../doc/props.ts";
import { planeThrough, pointOnDragPlane, snapPoint } from "./drag.ts";
import { planePointOf, type InputState } from "./input.ts";
import type { Outcome, Tool } from "./tool.ts";

/** the types the tool offers, with the box each one is drawn and picked in, in metres about its origin */
export const OBJECT_TYPES: { type: string; half: number }[] = [
  { type: "mesh", half: 0.5 },
  { type: "group", half: 0.25 },
  { type: "pointLight", half: 0.15 },
  { type: "spotLight", half: 0.15 },
  { type: "directionalLight", half: 0.15 },
  { type: "perspectiveCamera", half: 0.25 },
];

/** what the next click places: a plain node of a type, or an instance of a definition */
export type Placing = { type: string; def?: ObjectDef };

export const objectSettings: Placing = { type: "pointLight" };

/** what the tool is set to, said the way the status line and the browser both want it */
export const placingName = (of: Placing = objectSettings): string =>
  of.def ? `${of.type}.${of.def.name}` : of.type;

export function setObjectType(type: string): string {
  delete objectSettings.def;
  objectSettings.type = type;
  return type;
}

/** the object browser's answer: place this definition from now on */
export function setObjectDef(def: ObjectDef): string {
  objectSettings.def = def;
  objectSettings.type = def.node === ANY_NODE ? "object3D" : def.node;
  return placingName();
}

const halfOf = (type: string): number => OBJECT_TYPES.find((e) => e.type === type)?.half ?? 0.25;

/** a new object, placed — an instance of the current definition, or a bare node of the current type */
export function newObject(at: Vec3, of: Placing = objectSettings): ObjectNode {
  const position = setVec3([], "position", at);
  if (of.def) return instanceOf(of.def, position);
  const half = halfOf(of.type);
  return objectNode(of.type, {
    props: position,
    broom: { size: [-half, -half, -half, half, half, half] },
  });
}

/**
 * Where a click puts one.
 *
 * On a surface if there is one under the cursor, so a light placed against a wall starts against the wall,
 * and on the ground otherwise. In an orthographic pane there is no depth to read, so it lands on the
 * pane's own plane — which is the same rule the shape tool draws by, and the reason the two agree.
 */
export function placeAt(input: InputState, grid: number): Vec3 {
  if (input.view !== "3d") return snapPoint(planePointOf(input), grid);
  const on = input.hit?.point;
  if (on) return snapPoint(on, grid);
  // looking exactly along the ground there is no point on it; the world origin is the honest answer, and
  // it is the one place the designer can always find what they just placed
  const ground = pointOnDragPlane(input.camera, input.at, input.size, planeThrough([0, 0, 0], [0, 1, 0]));
  return ground ? snapPoint(ground, grid) : [0, 0, 0];
}

const place = (input: InputState, editor: Editor): Outcome => {
  const at = placeAt(input, gridSize(editor));
  // read once, so that a repeat later places what was placed then rather than whatever is armed now
  const of: Placing = { ...objectSettings };
  const name = placingName(of);
  const node = newObject(at, of);
  return {
    edit: {
      name: `create ${name}`,
      repeatable: true,
      apply: (e) => {
        const world = insertNodes(e.world, e.layer, [node]);
        return { ...e, world, selection: selectNodes(world, NOTHING, [node.id], "replace", e.open) };
      },
      // one more of the same, not the same one twice — a repeated placement needs its own identity
      again: (e) => {
        const made = newObject(at, of);
        const world = insertNodes(e.world, e.layer, [made]);
        return { ...e, world, selection: selectNodes(world, NOTHING, [made.id], "replace", e.open) };
      },
    },
    note: `${name} at ${at.join(", ")}`,
  };
};

const cycle = (by: number): string => {
  const at = OBJECT_TYPES.findIndex((e) => e.type === objectSettings.type);
  return setObjectType(OBJECT_TYPES[(at + by + OBJECT_TYPES.length) % OBJECT_TYPES.length]!.type);
};

export const objectTool: Tool = {
  id: "object",
  title: "object",
  key: "n",
  hint: "click to place · tab cycles the type",

  click: (input, editor) => place(input, editor),

  press(key) {
    if (key === "tab") return { note: cycle(1) };
    return undefined;
  },
};
