/**
 * The bridge from a document to a picture.
 *
 * Everything below this file is buffers and shader graphs that know nothing about maps; everything above
 * it is a tree of nodes that knows nothing about GPUs. This is where an {@link Editor} is diffed into the
 * batches — and *diffed* is the word that matters. A map is rebuilt from scratch once, when it is opened.
 * After that, moving one wall touches one wall's vertices and selecting fifty solids touches fifty floats,
 * because the tree is immutable and a subtree nobody edited comes back as the very same object.
 *
 * That identity check is the whole synchronisation strategy. `node.brush !== seen.brush` is one pointer
 * comparison and it is exactly right: the document model never mutates a brush in place, so a brush that
 * is the same object is a brush with the same geometry. No dirty flags to forget to set, no version
 * numbers to get out of step.
 */
import {
  AmbientLight, BufferAttribute, BufferGeometry, DirectionalLight, Group, HemisphereLight, LineSegments,
  Mesh, PlaneGeometry, Points, Scene, type Object3D,
} from "three/webgpu";
import { brushToMesh } from "../brush/brush.ts";
import type { Bounds } from "../brush/builder.ts";
import type { BrushNode, Node, NodeId, World } from "../doc/document.ts";
import { boundsCentre, childrenOf, nodeById, nodeBounds } from "../doc/document.ts";
import type { Editor } from "../doc/editor.ts";
import { isFaceSelected, isSelected, type Selection } from "../doc/selection.ts";
import type { Upload } from "./arena.ts";
import {
  batchBounds, clearBatch, dropBrush, entryOf, flushBatch, newBatch, setBrush, setFlags, FACE_SELECTED,
  HOVERED, LOCKED, OUTSIDE, SELECTED, type BrushBatch, type Flags,
} from "./batch.ts";
import { brushHandles, newHandles, setHandles, type Handle, type HandleSet } from "./handles.ts";
import { linkSegments, linksOf } from "./links.ts";
import {
  boxSegments, clearLines, dropLines, edgeSegments, flushLines, newLines, setLineFlags, setLines,
  spikeSegments, type LineBatch,
} from "./lines.ts";
import {
  edgeMaterial, faceMaterial, gridPlaneMaterial, handleMaterial, newGridUniforms, type GridUniforms,
} from "./materials.ts";
import { hideLabels, newLabels, setLabel, type Labels } from "./text.ts";

/** what the mouse is currently over, which is the one piece of state the renderer owns itself */
export type Hover = { node: NodeId; face?: number } | undefined;

/** what a brush was last drawn as, so an unchanged one is skipped without asking the GPU anything */
type Seen = { brush: BrushNode["brush"]; flags: number[] };

export type RenderScene = {
  scene: Scene;
  /** the map itself: faces, then edges over them */
  world: Group;
  /** the things drawn over the map — bounds, guides, spikes, links, handles, labels */
  overlays: Group;

  grid: GridUniforms;
  brushes: BrushBatch;
  edges: LineBatch;
  /** bounds, spikes, guides and links all share one buffer; they are all just lines */
  decor: LineBatch;
  handles: HandleSet;
  labels: Labels;

  faceMesh: Mesh;
  edgeLines: LineSegments;
  decorLines: LineSegments;
  handlePoints: Points;
  /** the backdrop an orthographic pane stands on; the 3D pane hides it and uses the grid on the faces */
  gridPlane: Mesh;

  seen: Map<NodeId, Seen>;
  hover: Hover;
  /** the decor keys the last sync wrote, so the ones it did not renew can be dropped in one pass */
  decorKeys: Set<string>;
};

export function newRenderScene(gridSize = 1): RenderScene {
  const scene = new Scene();
  const world = new Group();
  const overlays = new Group();
  scene.add(world, overlays);

  const grid = newGridUniforms(gridSize);

  const faceMesh = new Mesh(new BufferGeometry(), faceMaterial(grid));
  faceMesh.frustumCulled = false; // one mesh holds the whole map, so its box is always on screen
  faceMesh.name = "broom:faces";

  const edgeLines = new LineSegments(new BufferGeometry(), edgeMaterial());
  edgeLines.frustumCulled = false;
  edgeLines.name = "broom:edges";

  const decorLines = new LineSegments(new BufferGeometry(), edgeMaterial());
  decorLines.frustumCulled = false;
  decorLines.renderOrder = 10;
  decorLines.name = "broom:decor";

  const handlePoints = new Points(new BufferGeometry(), handleMaterial());
  handlePoints.frustumCulled = false;
  handlePoints.renderOrder = 20;
  handlePoints.name = "broom:handles";

  // a unit quad the 2D panes stretch across their own frustum; ordered far below everything else so it is
  // painted before the map rather than over it
  const gridPlane = new Mesh(new PlaneGeometry(1, 1), gridPlaneMaterial(grid));
  gridPlane.frustumCulled = false;
  gridPlane.renderOrder = -1000;
  gridPlane.visible = false;
  gridPlane.name = "broom:grid-plane";

  world.add(gridPlane, faceMesh, edgeLines);
  overlays.add(decorLines, handlePoints);
  scene.add(...editorLights());

  return {
    scene, world, overlays, grid,
    brushes: newBatch(),
    edges: newLines(),
    decor: newLines(),
    handles: newHandles(),
    labels: newLabels(overlays),
    faceMesh, edgeLines, decorLines, handlePoints, gridPlane,
    seen: new Map(),
    hover: undefined,
    decorKeys: new Set(),
  };
}

/**
 * The editor's own lighting, which is not the map's.
 *
 * A brush editor is not a preview — the light here exists so that a wall, a floor and a ceiling look like
 * three different things, and for no other reason. So it is fixed to the world rather than authored: a sky
 * fill that separates up-facing surfaces from down-facing ones, one key from over the designer's left
 * shoulder, and enough ambient that nothing is ever unreadably dark. M12's PBR look brings the map's real
 * lights; this stays as what "classic" means.
 */
function editorLights(): Object3D[] {
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(-0.6, 1, 0.45);
  return [new HemisphereLight(0xcfd6e0, 0x2a2c30, 1.1), key, new AmbientLight(0xffffff, 0.35)];
}

// ---------------------------------------------------------------- the diff

/**
 * The whole editor state brought into the batches.
 *
 * One walk of the tree does everything: it carries lock and visibility down as it goes — both are
 * inherited, and asking `isLocked(world, id)` per node would walk the tree once per node — and it decides
 * flags and geometry in the same visit, because both are answered by the node in front of it.
 */
export function syncScene(rs: RenderScene, editor: Editor): void {
  rs.grid.size.value = 2 ** editor.world.broom.grid;

  const alive = new Set<NodeId>();
  walkForDrawing(editor, (node, context) => {
    if (node.kind !== "brush") return;
    alive.add(node.id);
    syncBrush(rs, node, editor.selection, context);
  });

  for (const id of [...rs.seen.keys()]) {
    if (alive.has(id)) continue;
    rs.seen.delete(id);
    dropBrush(rs.brushes, id);
    dropLines(rs.edges, id);
  }

  syncDecor(rs, editor);
  syncLabels(rs, editor);
  upload(rs);
}

/** what is true of a node because of where it sits, rather than because of what it is */
type Context = { locked: boolean; outside: boolean };

/**
 * Every drawable node, with lock and group membership carried down from its ancestors.
 *
 * Hidden subtrees are not descended into at all. A hidden layer is the ordinary way a designer works on
 * one floor of a building, and it should cost nothing — not "drawn invisibly", not "flagged and skipped
 * in the shader", but genuinely absent from the buffers.
 */
function walkForDrawing(editor: Editor, visit: (node: Node, context: Context) => void): void {
  const descend = (node: Node, context: Context) => {
    if (node.broom.hidden === true) return;
    // a group the designer has stepped into makes everything outside it untouchable, which is the whole
    // point of stepping in — it is how you edit a doorway without moving the wall around it
    const inside = node.id === editor.open;
    const here: Context = {
      locked: context.locked || node.broom.locked === true,
      outside: context.outside && !inside,
    };
    visit(node, here);
    for (const kid of childrenOf(node)) descend(kid, inside ? { ...here, outside: false } : here);
  };
  for (const layer of editor.world.layers) {
    descend(layer, { locked: false, outside: editor.open !== undefined });
  }
}

function syncBrush(rs: RenderScene, node: BrushNode, selection: Selection, context: Context): void {
  const flags = faceFlags(rs, node, selection, context);
  const was = rs.seen.get(node.id);

  if (was && was.brush === node.brush) {
    if (same(was.flags, flags)) return;
    setFlags(rs.brushes, node.id, (face) => flags[face] ?? 0);
    // an edge takes the flags of the solid, not of a face: an edge belongs to two faces and would
    // otherwise have to pick one of them to agree with
    setLineFlags(rs.edges, node.id, solidFlags(flags));
    was.flags = flags;
    return;
  }

  const { mesh } = brushToMesh(node.brush);
  if (!mesh) {
    // a solid that bounds no volume draws nothing rather than drawing wrongly; the inspector reports it
    rs.seen.delete(node.id);
    dropBrush(rs.brushes, node.id);
    dropLines(rs.edges, node.id);
    return;
  }

  setBrush(rs.brushes, node.id, mesh, (face) => flags[face] ?? 0);
  const { segments, faces } = edgeSegments(mesh.polygons);
  const ordinal = entryOf(rs.brushes, node.id)!.ordinal;
  setLines(rs.edges, node.id, segments, solidFlags(flags), {
    object: ordinal,
    part: (segment) => faces[segment] ?? 0,
  });
  rs.seen.set(node.id, { brush: node.brush, flags });
}

/** one flag word per face of a solid — the only place the editor's several kinds of state meet */
function faceFlags(rs: RenderScene, node: BrushNode, selection: Selection, context: Context): number[] {
  const base =
    (context.locked ? LOCKED : 0) |
    (context.outside ? OUTSIDE : 0) |
    (isSelected(selection, node.id) ? SELECTED : 0);
  const hoveringSolid = rs.hover?.node === node.id;

  return node.brush.faces.map((_, face) => {
    let flags = base;
    if (isFaceSelected(selection, { node: node.id, face })) flags |= FACE_SELECTED;
    if (hoveringSolid && (rs.hover?.face === undefined || rs.hover.face === face)) flags |= HOVERED;
    return flags;
  });
}

/** what is true of the whole solid: everything any face says except which face was picked */
const solidFlags = (flags: number[]): Flags => flags.reduce((a, b) => a | b, 0) & ~FACE_SELECTED;

const same = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------- what is drawn over the map

/**
 * Selection bounds, spikes and entity links.
 *
 * Every key written here is remembered, and anything not rewritten this pass is dropped — which is what
 * keeps the last selection's box from staying on screen after the selection has moved on. Tools add their
 * own keys through {@link setDecor} under a `tool:` prefix, and those are exempt: a tool owns the whole
 * life of what it draws, and a sync happening mid-drag must not take a guide away from underneath it.
 */
function syncDecor(rs: RenderScene, editor: Editor): void {
  const written = new Set<string>();
  const write = (key: string, segments: Float32Array, flags: Flags) => {
    if (!segments.length) return;
    setLines(rs.decor, key, segments, flags);
    written.add(key);
  };

  const box = selectionBox(rs, editor.selection);
  if (box) {
    write("bounds", boxSegments(box.min, box.max), SELECTED);
    // spikes only while something is actually being moved; standing still they are visual noise
    if (editor.note === "dragging") write("spikes", spikeSegments(box.min, box.max, 500), SELECTED);
  }

  const links = linksOf(editor.world);
  if (links.length) {
    const selected = new Set<NodeId>(editor.selection.nodes);
    const { near, far } = linkSegments(links, (id) => centreIn(editor.world, id), selected);
    write("links", far, 0);
    write("links:near", near, SELECTED);
  }

  for (const key of rs.decorKeys) {
    if (written.has(key) || key.startsWith("tool:")) continue;
    dropLines(rs.decor, key);
  }
  for (const key of rs.decor.entries.keys()) written.add(key);
  rs.decorKeys = written;
}

/**
 * A tool's own lines: guides, a drag preview, a measuring cross. Namespaced under `tool:` so a sync
 * leaves them alone; passing no segments takes them away again.
 */
export function setDecor(rs: RenderScene, key: string, segments: Float32Array, flags: Flags = 0): void {
  const name = `tool:${key}`;
  if (!segments.length) {
    dropLines(rs.decor, name);
    rs.decorKeys.delete(name);
    return;
  }
  setLines(rs.decor, name, segments, flags);
  rs.decorKeys.add(name);
}

export function clearDecor(rs: RenderScene, prefix = "tool:"): void {
  for (const key of [...rs.decor.entries.keys()]) {
    if (!key.startsWith(prefix)) continue;
    dropLines(rs.decor, key);
    rs.decorKeys.delete(key);
  }
}

/** the box around the selection, taken from the batch rather than the document — one is already computed */
function selectionBox(rs: RenderScene, selection: Selection): Bounds | undefined {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const id of selection.nodes) {
    const entry = entryOf(rs.brushes, id);
    if (!entry) continue;
    found = true;
    for (let i = 0; i < 3; i++) {
      if (entry.bounds.min[i]! < min[i]!) min[i] = entry.bounds.min[i]!;
      if (entry.bounds.max[i]! > max[i]!) max[i] = entry.bounds.max[i]!;
    }
  }
  return found ? { min, max } : undefined;
}

/** where a node is, for anything that draws *at* a node rather than *of* one */
function centreIn(world: World, id: NodeId): [number, number, number] | undefined {
  const node = nodeById(world, id);
  if (!node) return undefined;
  const box = nodeBounds(node);
  return box ? boundsCentre(box) : undefined;
}

// ---------------------------------------------------------------- handles

/**
 * The handles for the current selection.
 *
 * Which kinds are shown is the tool's business, not the document's, so it is a parameter — the vertex tool
 * wants corners, the face tool wants centres, and the select tool wants none at all.
 */
export function syncHandles(
  rs: RenderScene,
  editor: Editor,
  kinds?: { vertices?: boolean; edges?: boolean; faces?: boolean },
): void {
  const out: Handle[] = [];
  if (kinds) {
    for (const id of editor.selection.nodes) {
      const node = nodeById(editor.world, id);
      if (node?.kind !== "brush") continue;
      const { mesh } = brushToMesh(node.brush);
      if (mesh) out.push(...brushHandles(id, mesh.polygons, kinds));
    }
  }
  setHandles(rs.handles, out);
  applyHandles(rs);
}

// ---------------------------------------------------------------- labels

/** entity and group names, over the middle of whatever they are */
function syncLabels(rs: RenderScene, editor: Editor): void {
  hideLabels(rs.labels);
  walkForDrawing(editor, (node) => {
    if (node.kind !== "entity" && node.kind !== "group") return;
    const name = node.kind === "group" ? node.name : (node.sheetId ?? node.type);
    const at = centreIn(editor.world, node.id);
    if (!at) return;
    const selected = isSelected(editor.selection, node.id);
    setLabel(rs.labels, node.id, name, at, { colour: selected ? "#ffd7c8" : "#e8e8ee" });
  });
}

// ---------------------------------------------------------------- uploading

/** every batch's changes pushed into its geometry, which is the only place three.js is spoken to */
export function upload(rs: RenderScene): void {
  applyBatch(
    rs.faceMesh.geometry,
    [
      ["position", rs.brushes.position, 3],
      ["normal", rs.brushes.normal, 3],
      ["uv", rs.brushes.uv, 2],
      ["flag", rs.brushes.flag, 1],
      ["pick", rs.brushes.pick, 2],
    ],
    flushBatch(rs.brushes),
  );

  applyBatch(
    rs.edgeLines.geometry,
    [["position", rs.edges.position, 3], ["flag", rs.edges.flag, 1], ["pick", rs.edges.pick, 2]],
    flushLines(rs.edges),
  );

  applyBatch(
    rs.decorLines.geometry,
    [["position", rs.decor.position, 3], ["flag", rs.decor.flag, 1], ["pick", rs.decor.pick, 2]],
    flushLines(rs.decor),
  );

  applyHandles(rs);
}

type Spec = [name: string, array: Float32Array, itemSize: number];

/**
 * One batch into one geometry.
 *
 * The array's *identity* is the signal: the batch replaces its arrays when the arena grows, so an
 * attribute whose array is not the one the batch is holding is one whose buffer no longer exists. Anything
 * else is a partial update, and a partial update names its byte ranges so the driver copies a few hundred
 * bytes instead of a few megabytes.
 */
function applyBatch(geometry: BufferGeometry, spec: Spec[], written: Upload): void {
  for (const [name, array, size] of spec) {
    const held = geometry.getAttribute(name) as BufferAttribute | undefined;
    if (!held || held.array !== array) {
      geometry.setAttribute(name, new BufferAttribute(array, size));
      continue;
    }
    if (!written.ranges.length) continue;
    for (const range of written.ranges) held.addUpdateRange(range.start * size, range.count * size);
    held.needsUpdate = true;
  }
  geometry.setDrawRange(0, written.used);
}

/** handles are rebuilt wholesale, so their attributes are simply replaced when the arrays move */
function applyHandles(rs: RenderScene): void {
  const geometry = rs.handlePoints.geometry;
  const spec: Spec[] = [
    ["position", rs.handles.position, 3],
    ["kind", rs.handles.kind, 1],
    ["flag", rs.handles.flag, 1],
    ["pick", rs.handles.pick, 2],
  ];
  for (const [name, array, size] of spec) {
    const held = geometry.getAttribute(name) as BufferAttribute | undefined;
    if (!held || held.array !== array) geometry.setAttribute(name, new BufferAttribute(array, size));
    else held.needsUpdate = true;
  }
  geometry.setDrawRange(0, rs.handles.count);
  rs.handlePoints.visible = rs.handles.count > 0;
}

// ---------------------------------------------------------------- odds and ends

/** the box around every solid drawn — what "frame all" and the far plane are worked out from */
export const sceneBounds = (rs: RenderScene): Bounds => batchBounds(rs.brushes);

/** the mouse moved onto something else; returns whether anything actually has to be redrawn */
export function setHover(rs: RenderScene, hover: Hover): boolean {
  if (rs.hover?.node === hover?.node && rs.hover?.face === hover?.face) return false;
  rs.hover = hover;
  return true;
}

/** everything thrown away — how a viewport opens a different map */
export function clearScene(rs: RenderScene): void {
  clearBatch(rs.brushes);
  clearLines(rs.edges);
  clearLines(rs.decor);
  setHandles(rs.handles, []);
  hideLabels(rs.labels);
  rs.seen.clear();
  rs.decorKeys.clear();
  rs.hover = undefined;
}

/** the objects a pick pass draws, which is the map's faces and nothing that is drawn over them */
export const pickable = (rs: RenderScene): Object3D[] => [rs.faceMesh];
