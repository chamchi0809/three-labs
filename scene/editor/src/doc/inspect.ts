/**
 * What the inspectors show, and what they change.
 *
 * The panels are Svelte and the panels are thin: everything here is a plain function of the document, so
 * that "what does the grid show for two lights that disagree about `intensity`" is a question with a
 * checkable answer rather than one that has to be looked at.
 *
 * Two rules run through all of it.
 *
 * **Multiple selection is the normal case.** A designer picks eleven walls and sets one number, and the
 * grid has to be honest about the ten values it is replacing — so every row carries how many nodes wrote
 * it and whether they agreed, and a row that is mixed shows nothing rather than showing the first one's
 * value and quietly making it everybody's.
 *
 * **A definition is shown, not copied.** A property the `@template` declares and the node did not is
 * listed, greyed, at the definition's value; editing it is what writes it onto the node, and clearing it
 * is what gives it back. This is the difference between an editor that shows a prefab and one that
 * flattens it the first time anybody looks at it.
 */
import type { UvMode, Value, Vec2, Vec3 } from "tscene";
import { faceAttributes, facePolygon, type Brush, type FaceAttributes } from "../brush/brush.ts";
import { uvOf } from "../brush/uv.ts";
import { sameValue } from "../io/literal.ts";
import { defFor, propType, type Catalogue, type EntityDef, type PropType } from "./catalogue.ts";
import {
  brushesUnder, nodeById, updateNode, type Node, type NodeId, type World,
} from "./document.ts";
import { propOf, removeProp, setProp } from "./props.ts";
import type { FaceRef, Selection } from "./selection.ts";

// ---------------------------------------------------------------- the property grid

export type Row = {
  name: string;
  type: PropType;
  /** what every node that wrote it agrees on, or the definition's value when none of them did */
  value?: Value;
  /** how many of the inspected nodes wrote it themselves */
  written: number;
  /** they wrote it and disagreed; `value` is nothing, and the box shows a placeholder instead */
  mixed: boolean;
  /** nobody wrote it — this is the definition speaking, and the row is drawn greyed */
  inherited: boolean;
};

/**
 * The rows for a set of nodes.
 *
 * The definition's properties come first, in the order it declared them, and the nodes' own extras follow
 * in the order they were first seen. Not sorted: a definition lists `color` before `castShadow` because
 * that is the order somebody thought about them in, and an inspector that alphabetises loses that for
 * nothing.
 */
export function rowsFor(nodes: Node[], def?: EntityDef): Row[] {
  const names: string[] = [];
  for (const p of def?.props ?? []) names.push(p.name);
  for (const node of nodes) {
    for (const m of node.props) if (m.kind === "prop" && !names.includes(m.name)) names.push(m.name);
  }
  return names.map((name) => rowFor(nodes, name, def));
}

function rowFor(nodes: Node[], name: string, def?: EntityDef): Row {
  const written = nodes.map((n) => propOf(n.props, name)?.value).filter((v): v is Value => !!v);
  const agreed = written.length === nodes.length && written.every((v) => sameValue(v, written[0]));
  const fallback = def?.props.find((p) => p.name === name)?.value;
  const value = agreed ? written[0] : written.length ? undefined : fallback;
  return {
    name,
    // a mixed row still needs an editor, and the first value is as good a guide to which one as any
    type: propType(value ?? written[0] ?? fallback),
    ...(value ? { value } : {}),
    written: written.length,
    mixed: !agreed && written.length > 0,
    inherited: written.length === 0 && !!fallback,
  };
}

/** the definition every inspected node is an instance of, when they are all instances of the same one */
export function commonDef(catalogue: Catalogue, nodes: Node[]): EntityDef | undefined {
  const first = nodes[0] && defFor(catalogue, nodes[0]);
  if (!first) return undefined;
  return nodes.every((n) => defFor(catalogue, n) === first) ? first : undefined;
}

/** what to call the selection in the inspector's header: `pointLight`, or `3 nodes` when they differ */
export function describeNodes(nodes: Node[]): string {
  if (!nodes.length) return "nothing selected";
  const kinds = new Set(nodes.map(typeName));
  if (kinds.size === 1) return nodes.length === 1 ? [...kinds][0]! : `${nodes.length} × ${[...kinds][0]}`;
  return `${nodes.length} nodes`;
}

export const typeName = (node: Node): string =>
  node.kind === "entity" ? node.type : node.kind === "brush" ? "brush" : node.kind;

// ---------------------------------------------------------------- writing properties

/** one property set on every named node, each node's other bytes untouched */
export const setNodesProp = (world: World, ids: NodeId[], name: string, value: Value): World =>
  ids.reduce((w, id) => updateNode(w, id, (n: Node) => ({ ...n, props: setProp(n.props, name, value) })), world);

export const removeNodesProp = (world: World, ids: NodeId[], name: string): World =>
  ids.reduce((w, id) => updateNode(w, id, (n: Node) => ({ ...n, props: removeProp(n.props, name) })), world);

/**
 * A property renamed on every node that has it.
 *
 * Written as a remove and a set rather than as a rename in place, because the new name may already be
 * there — renaming `targetname` to `target` on a node that has both has to end with one property, and the
 * one it ends with is the value the designer was looking at when they typed.
 */
export function renameNodesProp(world: World, ids: NodeId[], from: string, to: string): World {
  if (!to || from === to) return world;
  return ids.reduce(
    (w, id) =>
      updateNode(w, id, (n: Node) => {
        const was = propOf(n.props, from);
        if (!was) return n;
        return { ...n, props: setProp(removeProp(n.props, from), to, was.value) };
      }),
    world,
  );
}

/** a group's or a layer's name, which is its own field rather than one of its properties */
export const renameNode = (world: World, id: NodeId, name: string): World =>
  updateNode(world, id, (n: Node) => (n.kind === "group" || n.kind === "layer" ? { ...n, name } : n));

/** the `#id` a sheet knows a node by — what a `ref()` elsewhere in the map points at */
export function setSheetId(world: World, id: NodeId, sheetId: string): World {
  return updateNode(world, id, (n: Node) => {
    if (sheetId) return { ...n, sheetId };
    const { sheetId: _gone, ...rest } = n;
    return rest as Node;
  });
}

/** the `.class` list on a node's head, which is what makes it an instance of a definition */
export const setClasses = (world: World, ids: NodeId[], classes: string[]): World =>
  ids.reduce((w, id) => updateNode(w, id, (n: Node) => ({ ...n, classes })), world);

/** every `#id` in the map, for the reference editor's list — a `ref()` may only name one of these */
export function sheetIds(world: World): string[] {
  const out: string[] = [];
  const visit = (node: Node) => {
    if (node.sheetId && !out.includes(node.sheetId)) out.push(node.sheetId);
    for (const kid of node.kind === "brush" ? [] : node.children) visit(kid);
  };
  for (const layer of world.layers) visit(layer);
  return out;
}

// ---------------------------------------------------------------- faces

/**
 * The faces an attribute change applies to: the picked faces, or every face of the picked solids.
 *
 * The second half is what makes the material browser usable. A designer who has selected a room's worth
 * of walls and clicks `brick` means all of it, and making them switch to the face tool and press
 * "select all faces" first would be making them say something they have already said.
 */
export function facesInScope(world: World, selection: Selection): FaceRef[] {
  if (selection.faces.length) return selection.faces;
  const out: FaceRef[] = [];
  for (const id of selection.nodes) {
    const node = nodeById(world, id);
    if (!node) continue;
    for (const b of brushesUnder(node)) b.brush.poly.faces.forEach((_, face) => out.push({ node: b.id, face }));
  }
  return out;
}

/** one field of the face inspector: what they agree on, or that they do not */
export type Agreed<T> = { value: T; mixed: boolean };

export type FaceInfo = {
  count: number;
  material: Agreed<string | undefined>;
  uv: Agreed<UvMode>;
  offset: Agreed<Vec2>;
  scale: Agreed<Vec2>;
  rotation: Agreed<number>;
  /** the one face the UV editor draws, when exactly one is picked */
  only?: { brush: Brush; face: number };
};

export function faceInfo(world: World, faces: FaceRef[]): FaceInfo | undefined {
  const all: { brush: Brush; face: number; a: FaceAttributes }[] = [];
  for (const f of faces) {
    const node = nodeById(world, f.node);
    if (node?.kind !== "brush" || !node.brush.poly.faces[f.face]) continue;
    all.push({ brush: node.brush, face: f.face, a: node.brush.faces[f.face] ?? faceAttributes() });
  }
  if (!all.length) return undefined;
  const first = all[0]!.a;
  const agree = <T>(value: T, same: (x: FaceAttributes) => boolean): Agreed<T> => ({
    value,
    mixed: !all.every((x) => same(x.a)),
  });
  return {
    count: all.length,
    material: agree(first.material, (x) => x.material === first.material),
    uv: agree(first.uv, (x) => sameUv(x.uv, first.uv)),
    offset: agree(first.offset, (x) => x.offset[0] === first.offset[0] && x.offset[1] === first.offset[1]),
    scale: agree(first.scale, (x) => x.scale[0] === first.scale[0] && x.scale[1] === first.scale[1]),
    rotation: agree(first.rotation, (x) => x.rotation === first.rotation),
    ...(all.length === 1 ? { only: { brush: all[0]!.brush, face: all[0]!.face } } : {}),
  };
}

const sameUv = (a: UvMode, b: UvMode): boolean =>
  a.kind === b.kind && sameAxis(a.kind === "parallel" ? a.u : undefined, b.kind === "parallel" ? b.u : undefined);

const sameAxis = (a: Vec3 | undefined, b: Vec3 | undefined): boolean =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

/**
 * A face's outline in tile coordinates — what the UV editor draws the material's grid behind.
 *
 * In tiles rather than in metres because that is the space the numbers in the panel are in: a face that
 * covers 2 × 3 tiles is one the designer can see covers two tiles across, and an offset of half a tile is
 * a shift they can see is half of one square.
 */
export const uvPolygon = (brush: Brush, face: number): Vec2[] =>
  facePolygon(brush, face).map((p) => uvOf(brush, face, p));

// ---------------------------------------------------------------- the map

export type MapStats = { brushes: number; entities: number; groups: number; layers: number; faces: number };

export function mapStats(world: World): MapStats {
  const stats: MapStats = { brushes: 0, entities: 0, groups: 0, layers: 0, faces: 0 };
  const visit = (node: Node) => {
    if (node.kind === "brush") {
      stats.brushes++;
      stats.faces += node.brush.poly.faces.filter(Boolean).length;
      return;
    }
    if (node.kind === "entity") stats.entities++;
    else if (node.kind === "group") stats.groups++;
    else stats.layers++;
    for (const kid of node.children) visit(kid);
  };
  for (const layer of world.layers) visit(layer);
  return stats;
}
