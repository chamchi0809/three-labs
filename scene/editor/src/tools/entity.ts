/**
 * The entity tool: placing data.
 *
 * Every other tool puts something in the level that three will draw — a solid, a patch, a light, a mesh.
 * This one puts a *record* there: `entity.spawner #ogre { position: vec3(4, 0, -2); }` is a point the game
 * reads a table of values off, and nothing renders it at all. tscene's `entity` node is an `Object3D` with
 * no geometry and no material for exactly this, so the tool is the shortest one in the editor: it has no
 * drag, no handles and no options — it takes the definition the entity browser armed and writes one
 * instance of it where the click landed.
 *
 * It shares its placement rule with the object tool on purpose, because a designer clicking in a pane
 * means the same thing whichever of the two is live: on the surface under the cursor if there is one, on
 * the ground if there is not, snapped to the grid either way.
 */
import type { Vec3 } from "tscene";
import { instanceOf, type ObjectDef } from "../doc/catalogue.ts";
import { insertNodes, type ObjectNode } from "../doc/document.ts";
import { gridSize, type Editor } from "../doc/editor.ts";
import { NOTHING, selectNodes } from "../doc/selection.ts";
import { setVec3 } from "../doc/props.ts";
import { placeAt } from "./object.ts";
import type { InputState } from "./input.ts";
import type { Outcome, Tool } from "./tool.ts";

/**
 * The box an entity is drawn and picked in when its definition does not say, in metres either side of
 * the origin. An entity has no size of its own — it is a point — so this is purely the editor giving the
 * designer something to click on, which is why a definition that cares writes `@broom { size }` instead.
 */
const HALF = 0.2;

/** what the next click places, set by the entity browser */
export const entitySettings: { def?: ObjectDef } = {};

export const setEntityDef = (def: ObjectDef): string => ((entitySettings.def = def), def.name);

export const entityNode = (at: Vec3, def: ObjectDef): ObjectNode => {
  const node = instanceOf(def, setVec3([], "position", at));
  return def.size ? node : { ...node, broom: { ...node.broom, size: [-HALF, -HALF, -HALF, HALF, HALF, HALF] } };
};

const place = (input: InputState, editor: Editor): Outcome => {
  const def = entitySettings.def;
  // nothing armed is not a failure to report as an error: the browser is right there, and a click that
  // silently created an entity of no type would be worse than one that says which button to press
  if (!def) return { note: "pick an entity type in the entity browser first" };
  const at = placeAt(input, gridSize(editor));
  const made = (): ObjectNode => entityNode(at, def);
  const put = (e: Editor, node: ObjectNode): Editor => {
    const world = insertNodes(e.world, e.layer, [node]);
    return { ...e, world, selection: selectNodes(world, NOTHING, [node.id], "replace", e.open) };
  };
  const node = made();
  return {
    edit: {
      name: `place ${def.name}`,
      repeatable: true,
      apply: (e) => put(e, node),
      // one more of the same, not the same one twice — a repeated placement needs its own identity
      again: (e) => put(e, made()),
    },
    note: `${def.name} at ${at.join(", ")}`,
  };
};

export const entityTool: Tool = {
  id: "entity",
  title: "entity",
  // `e` is fly-up and belongs to the camera; `o` is the letter next to `n`, the other tool that places
  key: "o",
  hint: "click to place the armed entity type · pick one in the entity browser",

  click: (input, editor) => place(input, editor),
};
