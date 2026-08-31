/**
 * A room to open on, and the definitions it is built out of.
 *
 * An editor that starts empty is one whose renderer cannot be looked at, and every part of M6 — the batch,
 * the wireframe, the on-face grid, groups, labels, links — needs geometry in front of it before anyone can
 * tell whether it is right. So the app opens on a small room instead of a void: a floor, four walls with a
 * doorway cut through one of them, a pillar, and a light wired to a switch.
 *
 * This is a starting document, not a fixture. It is deliberately built the way a designer would build it —
 * solids on the grid, a group for the mechanism, a `ref()` from the switch to the light — so that opening
 * the editor and opening a real map exercise the same code.
 *
 * The catalogue is written as a sheet and parsed, rather than assembled as objects. The inspectors read a
 * project's own `@template`s and `--var`s and nothing else, so a demo catalogue built by hand would be a
 * second way of producing one, and the only way it could be wrong is by being easier than the real one.
 */
import { parse } from "tscene";
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import type { Vec3 } from "tscene";
import type { Member, Value } from "tscene";
import { catalogueOfSheets, type Catalogue } from "./catalogue.ts";
import { setField } from "./entity.ts";
import { colour, num, record, ref, setProp, setVec3, vec3 } from "./props.ts";
import {
  brushNode, objectNode, groupNode, layerNode, type BrushNode, type Node, type World,
} from "./document.ts";

const box = (min: Vec3, max: Vec3, material?: string): BrushNode =>
  brushNode(brushOf(cuboid({ min, max }), material ? { material } : {}));

/** a node's body written out in order, which is what a sheet would have produced for the same thing */
const body = (entries: [string, Value][]): Member[] =>
  entries.reduce<Member[]>((props, [name, value]) => setProp(props, name, value), []);

export function demoMap(): World {
  const floor = box([-8, -0.5, -6], [8, 0, 6], "floor");
  const ceiling = box([-8, 4, -6], [8, 4.5, 6], "plaster");

  // three whole walls and a fourth in two pieces with a doorway between them — the ordinary way a room is
  // built out of solids, and the reason a brush editor exists at all
  const walls = [
    box([-8, 0, -6.5], [8, 4, -6], "wall"),
    box([-8, 0, 6], [8, 4, 6.5], "wall"),
    box([-8.5, 0, -6], [-8, 4, 6], "wall"),
    box([8, 0, -6], [8.5, 4, -1], "wall"),
    box([8, 0, 1], [8.5, 4, 6], "wall"),
    box([8, 2.5, -1], [8.5, 4, 1], "wall"), // the lintel over the doorway
  ];

  const pillar = box([-1, 0, -1], [1, 4, 1], "stone");

  // a sky fill and a sun, which are things a level has rather than things an editor has: the modern look
  // lights the room with what the map declares, and a room whose only light is one lamp is a room that is
  // mostly black. The sun's direction is where it is — that is what a directional light's position means —
  // so it is written a long way out along the axis it comes down.
  const sky = objectNode("hemisphereLight", {
    sheetId: "sky",
    props: body([["color", colour(0x9fb4cc)], ["groundColor", colour(0x3a352e)], ["intensity", num(0.9)]]),
  });
  const sun = objectNode("directionalLight", {
    sheetId: "sun",
    props: body([
      ["position", vec3([-24, 40, 18])],
      ["color", colour(0xfff2dd)],
      ["intensity", num(1.4)],
    ]),
  });

  const light = objectNode("pointLight", {
    sheetId: "lamp",
    classes: ["lamp"],
    props: setVec3([], "position", [0, 3.2, 3]),
    broom: { size: [-0.2, -0.2, -0.2, 0.2, 0.2, 0.2] },
  });
  const switchPlate = box([7.9, 1.1, 2], [8, 1.5, 2.4], "trim");
  // `.button` is what gives it its geometry and material — an object is a template applied to a node, and
  // one that names no template is a `mesh` with nothing in it. What it points at is the instance's own
  // business, though, the way `target` is a per-object key in TrenchBroom and not part of the definition.
  //
  // Under `userData` because a `Mesh` has no `target`, and tscene means that literally: it would assign one
  // anyway, warn, and hand the game an object three does not describe. `userData` is where three itself
  // keeps what the engine on top of it cares about, and `refsIn` follows a `ref()` into a record, so the
  // link is still drawn between the switch and the lamp.
  const button = objectNode("mesh", {
    sheetId: "switch",
    classes: ["button"],
    props: setProp(setVec3([], "position", [7.95, 1.3, 2.2]), "userData", record([["target", ref("lamp")]])),
    broom: { size: [-0.1, -0.2, -0.2, 0.1, 0.2, 0.2] },
  });

  // the switch and its plate move as one thing, which is what a group is for
  const mechanism = groupNode("door switch", [switchPlate, button]);

  // data at a point: nothing draws these, and that is what an entity is. Placed here so the entity
  // panel has values to edit the moment the editor opens.
  const spawn = objectNode("entity", {
    sheetId: "start",
    classes: ["spawn"],
    props: body([["position", vec3([-6, 0, 4])]]),
    broom: { size: [-0.3, 0, -0.3, 0.3, 1.8, 0.3] },
  });
  const ogre = objectNode("entity", {
    sheetId: "ogre",
    classes: ["monster"],
    props: setField(body([["position", vec3([4, 0, -3])]]), "hp", num(80)),
  });

  const children: Node[] = [floor, ceiling, ...walls, pillar, sky, sun, light, mechanism, spawn, ogre];
  return { layers: [layerNode("Default", children)], broom: { grid: -2, scale: 1 } };
}

/**
 * The definitions the demo room is built against: five materials and five objects.
 *
 * Enough of each that the browsers have something to filter and the property grid has one of every editor
 * to draw — a number, a colour, a place, a flag, a name and a reference — and no more than that. A demo
 * catalogue is a thing to look at, not a library to build a level from.
 *
 * Two of the five have relief on them, because the modern look's whole argument is one a screenshot has to
 * make: the walls are six planes and they have bricks in them, and the bricks are in a texture rather than
 * in the geometry the player will collide with. The `broom:` urls are generated in `render/sample.ts` — the
 * demo has no directory behind it to keep a `brick.png` in, and committing one so that a shader has
 * something to point at would put a binary in the repository for the sake of a demo.
 */
export const DEMO_SHEET = `
--floor: heightMaterial {
  map: texture("broom:tile/map");
  normalMap: texture("broom:tile/normal");
  heightMap: texture("broom:tile/height");
  roughness: 0.95;
  depth: 0.02;
}
--wall: heightMaterial {
  map: texture("broom:brick/map");
  normalMap: texture("broom:brick/normal");
  heightMap: texture("broom:brick/height");
  roughness: 0.85;
  depth: 0.035;
}
--plaster: meshStandardMaterial { color: color(#cfcabc); roughness: 1; }
--stone: meshStandardMaterial { color: color(#8d8f94); roughness: 0.9; metalness: 0; }
--trim: meshStandardMaterial { color: color(#3f4a5a); roughness: 0.45; metalness: 0.6; }

@template pointLight.lamp {
  @broom { icon: "light"; color: #ffcc66; size: [-0.2, -0.2, -0.2, 0.2, 0.2, 0.2]; }
  color: color(#ffddaa);
  intensity: 12;
  distance: 9;
  castShadow: true;
}

@template mesh.crate {
  @broom { icon: "crate"; color: #a9773f; size: [-0.4, 0, -0.4, 0.4, 0.8, 0.4]; }
  geometry: boxGeometry(0.8, 0.8, 0.8);
  material: var(--wall);
  castShadow: true;
}

@template mesh.button {
  @broom { icon: "switch"; color: #6fd08c; size: [-0.1, -0.2, -0.2, 0.1, 0.2, 0.2]; }
  geometry: boxGeometry(0.05, 0.2, 0.2);
  material: var(--trim);
  @entity { target: ""; once: true; }
}

@template perspectiveCamera.viewpoint {
  @broom { icon: "camera"; color: #7aa2f7; size: [-0.25, -0.2, -0.35, 0.25, 0.2, 0.35]; }
  fov: 70;
  near: 0.1;
  far: 400;
}

@template group.trigger {
  @broom { kind: brush; icon: "trigger"; color: #d08770; }
  name: "trigger";
  visible: false;
  @entity { event: "open"; once: false; }
}

/* the choices a field can draw from — one list, shared by every field that names it */
--damage: ["none", "fire", "ice", "holy"];

/* an entity is data at a point and nothing else: no geometry, no material, nothing to draw. Three of
   them, in two categories, between them asking for one of every field type there is. */
@template entity.spawn {
  @broom { category: "gameplay"; color: #6fd08c; doc: "where the player comes in";
           size: [-0.3, 0, -0.3, 0.3, 1.8, 0.3]; }
  @fields {
    facing: { type: float; min: -180; max: 180; doc: "degrees about Y" };
    team: { type: int; min: 0; max: 3 };
  };
  @entity { facing: 0; team: 0; }
}

@template entity.monster {
  @broom { category: "gameplay"; color: #d0607a; doc: "one enemy, placed"; }
  @fields {
    hp: { type: int; min: 1; max: 999 };
    weakness: { type: enum; enum: "damage" };
    patrol: { type: point; doc: "walks to here and back" };
    tint: { type: color };
    asleep: { type: bool };
    brain: { type: script; doc: "runs every tick" };
  };
  @entity { hp: 30; weakness: "fire"; patrol: [0, 0, 0]; tint: #d0607a; asleep: false; }
}

@template entity.sign {
  @broom { category: "story"; color: #7aa2f7; doc: "a line the game shows"; }
  @fields {
    say: { type: lines; localized: true; doc: "what it says" };
    icon: { type: file };
    once: { type: bool };
  };
  @entity { say: "Open the door"; once: true; }
}

@locale { ko: { "Open the door": "문을 여어라" } };
`;

let cached: Catalogue | undefined;

/** the demo catalogue, parsed once — the sheet above is constant, so parsing it twice says nothing new */
export function demoCatalogue(): Catalogue {
  cached ??= catalogueOfSheets([parse(DEMO_SHEET, "demo.tscene")]);
  return cached;
}
