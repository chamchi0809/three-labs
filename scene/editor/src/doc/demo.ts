/**
 * A room to open on.
 *
 * An editor that starts empty is one whose renderer cannot be looked at, and every part of M6 — the batch,
 * the wireframe, the on-face grid, groups, labels, links — needs geometry in front of it before anyone can
 * tell whether it is right. So the app opens on a small room instead of a void: a floor, four walls with a
 * doorway cut through one of them, a pillar, and a light wired to a switch.
 *
 * This is a starting document, not a fixture. It is deliberately built the way a designer would build it —
 * solids on the grid, a group for the mechanism, a `ref()` from the switch to the light — so that opening
 * the editor and opening a real map exercise the same code.
 */
import { brushOf } from "../brush/brush.ts";
import { cuboid } from "../brush/builder.ts";
import type { Vec3 } from "tscene";
import { SYNTHETIC, setVec3 } from "./props.ts";
import {
  brushNode, entityNode, groupNode, layerNode, type BrushNode, type Node, type World,
} from "./document.ts";

const box = (min: Vec3, max: Vec3): BrushNode => brushNode(brushOf(cuboid({ min, max })));

export function demoMap(): World {
  const floor = box([-8, -0.5, -6], [8, 0, 6]);
  const ceiling = box([-8, 4, -6], [8, 4.5, 6]);

  // three whole walls and a fourth in two pieces with a doorway between them — the ordinary way a room is
  // built out of solids, and the reason a brush editor exists at all
  const walls = [
    box([-8, 0, -6.5], [8, 4, -6]),
    box([-8, 0, 6], [8, 4, 6.5]),
    box([-8.5, 0, -6], [-8, 4, 6]),
    box([8, 0, -6], [8.5, 4, -1]),
    box([8, 0, 1], [8.5, 4, 6]),
    box([8, 2.5, -1], [8.5, 4, 1]), // the lintel over the doorway
  ];

  const pillar = box([-1, 0, -1], [1, 4, 1]);

  const light = entityNode("pointLight", {
    sheetId: "lamp",
    props: setVec3([], "position", [0, 3.2, 3]),
    broom: { size: [-0.2, -0.2, -0.2, 0.2, 0.2, 0.2] },
  });
  const switchPlate = box([7.9, 1.1, 2], [8, 1.5, 2.4]);
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

  const children: Node[] = [floor, ceiling, ...walls, pillar, light, mechanism];
  return { layers: [layerNode("Default", children)], broom: { grid: -2, scale: 1 } };
}
