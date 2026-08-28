/**
 * The create-entity tool: everything in a level that is not a wall.
 *
 * A tscene node is whatever three calls it — `mesh`, `pointLight`, `perspectiveCamera` — so there is no
 * fixed list of entities the way a Quake editor has one, and inventing one here would be inventing a
 * second definition of what a scene may contain. What the tool carries instead is a short list of the
 * types a designer reaches for while laying out a level, and a free type they can set to anything the
 * sheet would accept. M11 replaces the list with the `@template`s the project itself declares, which is
 * where the definitions actually belong.
 *
 * A new entity is given a `@broom { size }` even though nothing in the scene needs one, because an entity
 * with no size is a point, and a point cannot be clicked. The box is what makes the thing the designer
 * just placed something they can then select, move and delete.
 */
import type { Vec3 } from "tscene";
import { entityNode, insertNodes, type EntityNode } from "../doc/document.ts";
import { gridSize, type Editor } from "../doc/editor.ts";
import { NOTHING, selectNodes } from "../doc/selection.ts";
import { setVec3 } from "../doc/props.ts";
import { planeThrough, pointOnDragPlane, snapPoint } from "./drag.ts";
import { planePointOf, type InputState } from "./input.ts";
import type { Outcome, Tool } from "./tool.ts";

/** the types the tool offers, with the box each one is drawn and picked in, in metres about its origin */
export const ENTITY_TYPES: { type: string; half: number }[] = [
  { type: "mesh", half: 0.5 },
  { type: "group", half: 0.25 },
  { type: "pointLight", half: 0.15 },
  { type: "spotLight", half: 0.15 },
  { type: "directionalLight", half: 0.15 },
  { type: "perspectiveCamera", half: 0.25 },
];

export const entitySettings: { type: string } = { type: "pointLight" };

export const setEntityType = (type: string): string => (entitySettings.type = type);

const halfOf = (type: string): number => ENTITY_TYPES.find((e) => e.type === type)?.half ?? 0.25;

/** a new entity of `type`, placed */
export function newEntity(type: string, at: Vec3): EntityNode {
  const half = halfOf(type);
  return entityNode(type, {
    props: setVec3([], "position", at),
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
  const type = entitySettings.type;
  const node = newEntity(type, at);
  return {
    edit: {
      name: `create ${type}`,
      repeatable: true,
      apply: (e) => {
        const world = insertNodes(e.world, e.layer, [node]);
        return { ...e, world, selection: selectNodes(world, NOTHING, [node.id], "replace", e.open) };
      },
      // one more of the same, not the same one twice — a repeated placement needs its own identity
      again: (e) => {
        const made = newEntity(type, at);
        const world = insertNodes(e.world, e.layer, [made]);
        return { ...e, world, selection: selectNodes(world, NOTHING, [made.id], "replace", e.open) };
      },
    },
    note: `${type} at ${at.join(", ")}`,
  };
};

const cycle = (by: number): string => {
  const at = ENTITY_TYPES.findIndex((e) => e.type === entitySettings.type);
  return setEntityType(ENTITY_TYPES[(at + by + ENTITY_TYPES.length) % ENTITY_TYPES.length]!.type);
};

export const entityTool: Tool = {
  id: "entity",
  title: "entity",
  key: "n",
  hint: "click to place · tab cycles the type",

  click: (input, editor) => place(input, editor),

  press(key) {
    if (key === "tab") return { note: cycle(1) };
    return undefined;
  },
};
