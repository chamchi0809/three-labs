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
import { SYNTHETIC, hex, num, setProp, setVec3, vec3 } from "./props.ts";
import {
  brushNode, entityNode, groupNode, layerNode, type BrushNode, type Node, type World,
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
  const sky = entityNode("hemisphereLight", {
    sheetId: "sky",
    props: body([["color", hex(0x9fb4cc)], ["groundColor", hex(0x3a352e)], ["intensity", num(0.9)]]),
  });
  const sun = entityNode("directionalLight", {
    sheetId: "sun",
    props: body([
      ["position", vec3([-24, 40, 18])],
      ["color", hex(0xfff2dd)],
      ["intensity", num(1.4)],
    ]),
  });

  const light = entityNode("pointLight", {
    sheetId: "lamp",
    classes: ["lamp"],
    props: setVec3([], "position", [0, 3.2, 3]),
    broom: { size: [-0.2, -0.2, -0.2, 0.2, 0.2, 0.2] },
  });
  const switchPlate = box([7.9, 1.1, 2], [8, 1.5, 2.4], "trim");
  const button = entityNode("mesh", {
    sheetId: "switch",
    props: [
      ...setVec3([], "position", [7.95, 1.3, 2.2]),
      { ...SYNTHETIC, kind: "prop", name: "lamp", value: { ...SYNTHETIC, kind: "ref", name: "lamp", namePos: SYNTHETIC } },
    ],
    broom: { size: [-0.1, -0.2, -0.2, 0.1, 0.2, 0.2] },
  });

  // the switch and its plate move as one thing, which is what a group is for
  const mechanism = groupNode("door switch", [switchPlate, button]);

  const children: Node[] = [floor, ceiling, ...walls, pillar, sky, sun, light, mechanism];
  return { layers: [layerNode("Default", children)], broom: { grid: -2, scale: 1 } };
}

/**
 * The definitions the demo room is built against: five materials and five entities.
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
--plaster: meshStandardMaterial { color: #cfcabc; roughness: 1; }
--stone: meshStandardMaterial { color: #8d8f94; roughness: 0.9; metalness: 0; }
--trim: meshStandardMaterial { color: #3f4a5a; roughness: 0.45; metalness: 0.6; }

@template pointLight.lamp {
  @broom { icon: "light"; color: #ffcc66; size: [-0.2, -0.2, -0.2, 0.2, 0.2, 0.2]; }
  color: #ffddaa;
  intensity: 12;
  distance: 9;
  castShadow: true;
}

@template mesh.crate {
  @broom { icon: "crate"; color: #a9773f; size: [-0.4, 0, -0.4, 0.4, 0.8, 0.4]; }
  geometry: box(0.8, 0.8, 0.8);
  material: var(--wall);
  castShadow: true;
}

@template mesh.button {
  @broom { icon: "switch"; color: #6fd08c; size: [-0.1, -0.2, -0.2, 0.1, 0.2, 0.2]; }
  geometry: box(0.05, 0.2, 0.2);
  material: var(--trim);
  target: ref(#lamp);
}

@template perspectiveCamera.viewpoint {
  @broom { icon: "camera"; color: #7aa2f7; size: [-0.25, -0.2, -0.35, 0.25, 0.2, 0.35]; }
  fov: 70;
  near: 0.1;
  far: 400;
}

@template group.trigger {
  @broom { kind: "brush"; icon: "trigger"; color: #d08770; }
  name: "trigger";
  visible: false;
}
`;

let cached: Catalogue | undefined;

/** the demo catalogue, parsed once — the sheet above is constant, so parsing it twice says nothing new */
export function demoCatalogue(): Catalogue {
  cached ??= catalogueOfSheets([parse(DEMO_SHEET, "demo.tscene")]);
  return cached;
}
