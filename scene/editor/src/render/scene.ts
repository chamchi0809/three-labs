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
  BufferAttribute, BufferGeometry, Group, InstancedBufferAttribute, InstancedBufferGeometry, LineSegments,
  Mesh, PlaneGeometry, Scene, type Material, type Object3D,
} from "three/webgpu";
import { brushOf, brushToMesh } from "../brush/brush.ts";
import { cuboid, type Bounds } from "../brush/builder.ts";
import { hullSegments, patchToBrushMesh } from "../patch/patch.ts";
import type { Catalogue } from "../doc/catalogue.ts";
import type { BrushNode, ObjectNode, Node, NodeId, PatchNode, World } from "../doc/document.ts";
import { boundsCentre, childrenOf, objectBounds, nodeById, nodeBounds } from "../doc/document.ts";
import type { Editor } from "../doc/editor.ts";
import { isFaceSelected, isSelected, type Selection } from "../doc/selection.ts";
import type { Upload } from "./arena.ts";
import {
  batchBounds, clearBatch, dropBrush, entryOf, flushBatch, materialGroups, newBatch, setBrush, setFlags,
  FACE_SELECTED, HOVERED, LOCKED, OUTSIDE, SELECTED, type BrushBatch, type Flags,
} from "./batch.ts";
import {
  brushHandles, newHandles, patchHandles, setHandleFlags, setHandles, type Handle, type HandleSet,
} from "./handles.ts";
import { editorLights, mapLights } from "./lights.ts";
import { linkSegments, linksOf } from "./links.ts";
import {
  boxSegments, clearLines, dropLines, edgeSegments, flushLines, newLines, setLineFlags, setLines,
  spikeSegments, type LineBatch,
} from "./lines.ts";
import {
  edgeMaterial, faceMaterial, gridPlaneMaterial, handleMaterial, newGridUniforms, type GridUniforms,
} from "./materials.ts";
import { newPalette, setMaterials, slotOf, type Look, type Palette } from "./palette.ts";
import { hideLabels, newLabels, setLabel, type Labels } from "./text.ts";

/** what the mouse is currently over, which is the one piece of state the renderer owns itself */
export type Hover = { node: NodeId; face?: number } | undefined;

/**
 * What a surface was last drawn as, so an unchanged one is skipped without asking the GPU anything.
 *
 * `shape` is the solid's `brush` or the patch's `patch` — whichever of the two this node keeps its geometry
 * in. Both are immutable, so one pointer comparison answers "has this changed" for either kind. An object
 * keeps its box in two places at once — a `position` among its properties and a `size` in its `@broom` —
 * so what is remembered for one is the node itself, which is replaced whenever either of them is edited.
 */
type Seen = { shape: BrushNode["brush"] | PatchNode["patch"] | ObjectNode; flags: number[] };

export type RenderScene = {
  scene: Scene;
  /** the map itself: faces, then edges over them */
  world: Group;
  /** the things drawn over the map — bounds, guides, spikes, links, handles, labels */
  overlays: Group;
  /** whatever is currently lighting the map: the editor's fixed rig, or the level's own lights */
  lights: Group;

  grid: GridUniforms;
  /** the one grey material the classic look draws the whole map with */
  classic: Material;
  /** the modern look's material per declaration; the slot numbering is shared by both looks */
  palette: Palette;
  brushes: BrushBatch;
  edges: LineBatch;
  /** bounds, spikes, guides and links all share one buffer; they are all just lines */
  decor: LineBatch;
  handles: HandleSet;
  labels: Labels;

  faceMesh: Mesh;
  edgeLines: LineSegments;
  decorLines: LineSegments;
  /** one instanced quad per handle; the vertex graph blows each centre up to a fixed size in pixels */
  handleMesh: Mesh;
  /** the backdrop an orthographic pane stands on; the 3D pane hides it and uses the grid on the faces */
  gridPlane: Mesh;

  seen: Map<NodeId, Seen>;
  hover: Hover;
  /**
   * Which handle the mouse is over, as an index into the current set.
   *
   * An index rather than the handle itself because the set is rebuilt wholesale whenever the selection or
   * the tool changes, and a held reference to a handle from the previous set is a reference to something
   * that is no longer drawn. The index is cleared at the same moment the set is replaced.
   */
  hoverHandle: number | undefined;
  /** the decor keys the last sync wrote, so the ones it did not renew can be dropped in one pass */
  decorKeys: Set<string>;
  /**
   * What the look was last applied for.
   *
   * Both halves matter and both are compared by identity. Rebuilding the palette recompiles every shader in
   * the map, and rebuilding the lights allocates a light per torch — neither is something to do because the
   * mouse moved, and the mouse moving is most of what makes the renderer run.
   */
  looked: { look: Look; catalogue: Catalogue } | undefined;
  /** what the rig in {@link RenderScene.lights} currently is, as {@link lightSignature} writes it */
  lit: string | undefined;
};

export function newRenderScene(gridSize = 1): RenderScene {
  const scene = new Scene();
  const world = new Group();
  const overlays = new Group();
  scene.add(world, overlays);

  const grid = newGridUniforms(gridSize);
  const palette = newPalette(grid);

  // the classic material is built here and kept for the life of the scene, separately from the palette's
  // own slot 0 — the palette is rebuilt and disposed whenever the catalogue changes, and the material the
  // classic look is holding must not be one of the casualties
  const classic = faceMaterial(grid);
  const faceMesh = new Mesh(new BufferGeometry(), classic);
  faceMesh.frustumCulled = false; // one mesh holds the whole map, so its box is always on screen
  faceMesh.name = "broom:faces";

  const edgeLines = new LineSegments(new BufferGeometry(), edgeMaterial());
  edgeLines.frustumCulled = false;
  edgeLines.name = "broom:edges";

  const decorLines = new LineSegments(new BufferGeometry(), edgeMaterial());
  decorLines.frustumCulled = false;
  decorLines.renderOrder = 10;
  decorLines.name = "broom:decor";

  const handleMesh = new Mesh(handleGeometry(), handleMaterial());
  handleMesh.frustumCulled = false;
  handleMesh.renderOrder = 20;
  handleMesh.visible = false;
  handleMesh.name = "broom:handles";

  // a unit quad the 2D panes stretch across their own frustum; ordered far below everything else so it is
  // painted before the map rather than over it
  const gridPlane = new Mesh(new PlaneGeometry(1, 1), gridPlaneMaterial(grid));
  gridPlane.frustumCulled = false;
  gridPlane.renderOrder = -1000;
  gridPlane.visible = false;
  gridPlane.name = "broom:grid-plane";

  world.add(gridPlane, faceMesh, edgeLines);
  overlays.add(decorLines, handleMesh);

  // a group of its own, so swapping what lights the map is one `clear` and one `add` rather than a search
  // through the scene for which children happened to be lights
  const lights = new Group();
  lights.name = "broom:lights";
  lights.add(...editorLights());
  scene.add(lights);

  return {
    scene, world, overlays, lights, grid, classic, palette,
    brushes: newBatch(),
    edges: newLines(),
    decor: newLines(),
    handles: newHandles(),
    labels: newLabels(overlays),
    faceMesh, edgeLines, decorLines, handleMesh, gridPlane,
    seen: new Map(),
    hover: undefined,
    hoverHandle: undefined,
    decorKeys: new Set(),
    looked: undefined,
    lit: undefined,
  };
}

// ---------------------------------------------------------------- the look

/**
 * The classic/modern switch, and everything that follows from it.
 *
 * Both halves are guarded on identity rather than done every sync, because both are expensive in ways that
 * a mouse move must not be: the palette recompiles a shader per material, and the lights allocate one
 * object per light in the map. The catalogue is in both guards because a sheet that declared a new material
 * changes what the modern look draws, and the world is in the lighting's because moving a torch moves a
 * light.
 *
 * Kept out of {@link syncScene} on purpose. The document knows nothing about which look is showing and the
 * look knows nothing about undo — the two meet here and nowhere else.
 */
export function syncLook(rs: RenderScene, editor: Editor, catalogue: Catalogue, look: Look): void {
  if (rs.looked?.look !== look || rs.looked.catalogue !== catalogue) {
    setMaterials(rs.palette, catalogue.materials);
    rs.faceMesh.material = look === "pbr" ? rs.palette.materials : rs.classic;
    applyGroups(rs, look);
    rs.looked = { look, catalogue };
  }
  syncLights(rs, editor.world, catalogue, look);
}

/**
 * The draw groups on the face mesh, or none at all.
 *
 * None at all is the classic look and it is not an omission: three ignores `geometry.groups` entirely when
 * the material is not an array, so clearing them is what keeps the classic look at literally one draw call
 * — and what keeps the pick pass at one, since it swaps a single material in over whatever is there.
 */
function applyGroups(rs: RenderScene, look: Look = rs.looked?.look ?? "classic"): void {
  const geometry = rs.faceMesh.geometry;
  geometry.clearGroups();
  if (look !== "pbr") {
    rs.brushes.groupsDirty = false;
    return;
  }
  for (const group of materialGroups(rs.brushes)) {
    geometry.addGroup(group.start, group.count, group.materialIndex);
  }
}

/**
 * The map's own lights when it has any, and the editor's rig when it has not.
 *
 * The lights are built every call and then thrown away unless they differ from the ones already up. That
 * sounds backwards — building them is the work — but it is not: walking the map for its light objects is
 * a few hundred property reads, while *installing* them is what costs. Swapping the contents of the light
 * group changes the lighting graph three derives its shaders from, so every material in the map recompiles.
 *
 * The distinction matters because an edit replaces the world rather than mutating it, so a comparison by
 * identity says "different" on every frame of every drag. Dragging a shape out recompiled the whole palette
 * sixty times a second, which is the bulk of why the tools felt like treacle.
 */
function syncLights(rs: RenderScene, world: World, catalogue: Catalogue, look: Look): void {
  const own = look === "pbr" ? mapLights(world, catalogue) : [];
  const lights = own.length ? own : editorLights();

  const signature = look + "|" + lights.map(lightSignature).join(";");
  if (rs.lit === signature) return;
  rs.lit = signature;

  rs.lights.clear();
  for (const light of lights) {
    rs.lights.add(light);
    // a directional or spot light aims at an Object3D, and an Object3D outside the scene graph never gets
    // a world matrix — so the target has to be in the tree even though it draws nothing
    const target = (light as { target?: Object3D }).target;
    if (target && !target.parent) rs.lights.add(target);
  }
}

/**
 * Everything about a light that would change the picture, in one line.
 *
 * Type, colour, intensity, place, aim, and the two falloff numbers a point or spot light carries. Nothing
 * else on a light is read by a renderer, so two lights with the same line are interchangeable and the one
 * already in the scene is the one worth keeping.
 */
function lightSignature(light: Object3D): string {
  const l = light as Object3D & {
    color?: { getHex(): number }; groundColor?: { getHex(): number }; intensity?: number;
    distance?: number; decay?: number; angle?: number; penumbra?: number; target?: Object3D;
  };
  const at = l.position;
  const aim = l.target?.position;
  return [
    l.type, l.color?.getHex(), l.groundColor?.getHex(), l.intensity,
    at.x, at.y, at.z, aim?.x, aim?.y, aim?.z,
    l.distance, l.decay, l.angle, l.penumbra,
  ].join(",");
}

// ---------------------------------------------------------------- the diff

/**
 * The whole editor state brought into the batches.
 *
 * One walk of the tree does everything: it carries lock and visibility down as it goes — both are
 * inherited, and asking `isLocked(world, id)` per node would walk the tree once per node — and it decides
 * flags and geometry in the same visit, because both are answered by the node in front of it.
 */
export function syncScene(rs: RenderScene, editor: Editor, dragging = false): void {
  rs.grid.size.value = 2 ** editor.world.broom.grid;

  const alive = new Set<NodeId>();
  walkForDrawing(editor, (node, context) => {
    if (node.kind === "brush") {
      alive.add(node.id);
      syncBrush(rs, node, editor.selection, context);
    } else if (node.kind === "patch") {
      alive.add(node.id);
      syncPatch(rs, node, editor.selection, context);
    } else if (node.kind === "object") {
      alive.add(node.id);
      syncObject(rs, node, editor.selection, context);
    }
  });

  for (const id of [...rs.seen.keys()]) {
    if (alive.has(id)) continue;
    rs.seen.delete(id);
    dropBrush(rs.brushes, id);
    dropLines(rs.edges, id);
  }

  syncDecor(rs, editor, dragging);
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

  if (was && was.shape === node.brush) {
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

  // the slot is claimed by name whether or not the catalogue has the declaration yet: a face that names a
  // material nobody has read draws grey, and starts drawing brick the moment the sheet it came from is
  // loaded — without a single vertex being rewritten
  setBrush(
    rs.brushes,
    node.id,
    mesh,
    (face) => flags[face] ?? 0,
    (face) => slotOf(rs.palette, node.brush.faces[face]?.material),
  );
  const { segments, faces } = edgeSegments(mesh.polygons);
  const ordinal = entryOf(rs.brushes, node.id)!.ordinal;
  setLines(rs.edges, node.id, segments, solidFlags(flags), {
    object: ordinal,
    part: (segment) => faces[segment] ?? 0,
  });
  rs.seen.set(node.id, { shape: node.brush, flags });
}

/**
 * A patch into the same two batches the solids go into.
 *
 * The surface joins the face batch as one group, which is what gives it selection, hover, the pick buffer
 * and a material slot for free. What goes into the *line* batch is the control net rather than the
 * tessellated wireframe: the net is the thing a designer edits, and drawing sixteen-by-sixteen quads of
 * hairline over a curved wall is a grey smear that hides the very handles it is drawn to explain.
 */
function syncPatch(rs: RenderScene, node: PatchNode, selection: Selection, context: Context): void {
  const flags = [surfaceFlags(rs, node.id, selection, context)];
  const was = rs.seen.get(node.id);

  if (was && was.shape === node.patch) {
    if (same(was.flags, flags)) return;
    setFlags(rs.brushes, node.id, () => flags[0]!);
    setLineFlags(rs.edges, node.id, solidFlags(flags));
    was.flags = flags;
    return;
  }

  const { mesh } = patchToBrushMesh(node.patch);
  if (!mesh) {
    // a grid that is not a grid draws nothing rather than drawing wrongly; the inspector reports it
    rs.seen.delete(node.id);
    dropBrush(rs.brushes, node.id);
    dropLines(rs.edges, node.id);
    return;
  }

  setBrush(rs.brushes, node.id, mesh, () => flags[0]!, () => slotOf(rs.palette, node.patch.material));
  setLines(rs.edges, node.id, hullSegments(node.patch.grid), solidFlags(flags), {
    object: entryOf(rs.brushes, node.id)!.ordinal,
    part: () => 0,
  });
  rs.seen.set(node.id, { shape: node.patch, flags });
}

/**
 * The smallest an object's box may be, in metres either side of its origin.
 *
 * An object with no `@broom { size }` is a point, and a point has no volume to rasterise — so it would be
 * drawn by nothing, picked by nothing, and clickable only by dragging a band across it. The tool that
 * places one writes a size; a sheet written by hand often does not, and those are exactly the nodes a
 * designer then cannot select.
 */
const OBJECT_HALF = 0.125;

/** an object's box, never flatter than {@link OBJECT_HALF} on any axis */
export function objectBox(node: ObjectNode): Bounds {
  const box = objectBounds(node) ?? { min: [0, 0, 0], max: [0, 0, 0] };
  const min: [number, number, number] = [box.min[0], box.min[1], box.min[2]];
  const max: [number, number, number] = [box.max[0], box.max[1], box.max[2]];
  for (let axis = 0; axis < 3; axis++) {
    // per axis rather than all three at once: a sign is a box a designer meant to be flat, and padding
    // the two axes it has thickness in would move its faces away from where they were written
    if (max[axis]! - min[axis]! >= OBJECT_HALF) continue;
    const middle = (min[axis]! + max[axis]!) / 2;
    min[axis] = middle - OBJECT_HALF / 2;
    max[axis] = middle + OBJECT_HALF / 2;
  }
  return { min, max };
}

/**
 * An object into the same two batches the solids go into.
 *
 * Its box is not geometry the level has — the runtime makes a light or a mesh of the node, not a crate —
 * but it is the only thing about an object the *editor* can draw, and drawing it into the face batch is
 * what makes an object clickable at all: the pick pass rasterises that batch and nothing else, so a node
 * outside it is a node no click can ever land on. Which is the state objects were in.
 */
function syncObject(rs: RenderScene, node: ObjectNode, selection: Selection, context: Context): void {
  const flags = [surfaceFlags(rs, node.id, selection, context)];
  const was = rs.seen.get(node.id);

  if (was && was.shape === node) {
    if (same(was.flags, flags)) return;
    setFlags(rs.brushes, node.id, () => flags[0]!);
    setLineFlags(rs.edges, node.id, solidFlags(flags));
    was.flags = flags;
    return;
  }

  const { mesh } = brushToMesh(brushOf(cuboid(objectBox(node))));
  if (!mesh) {
    rs.seen.delete(node.id);
    dropBrush(rs.brushes, node.id);
    dropLines(rs.edges, node.id);
    return;
  }

  // slot 0, always: the box is the editor's own furniture, and a material named on the node is the
  // runtime's business rather than something to paint the marker with
  setBrush(rs.brushes, node.id, mesh, () => flags[0]!, () => 0);
  const { segments, faces } = edgeSegments(mesh.polygons);
  setLines(rs.edges, node.id, segments, solidFlags(flags), {
    object: entryOf(rs.brushes, node.id)!.ordinal,
    part: (segment) => faces[segment] ?? 0,
  });
  rs.seen.set(node.id, { shape: node, flags });
}

/** the same word a solid's face gets, for a node whose whole surface is one thing: a patch, or an object's box */
function surfaceFlags(rs: RenderScene, id: NodeId, selection: Selection, context: Context): number {
  let flags =
    (context.locked ? LOCKED : 0) |
    (context.outside ? OUTSIDE : 0) |
    (isSelected(selection, id) ? SELECTED : 0);
  if (isFaceSelected(selection, { node: id, face: 0 })) flags |= FACE_SELECTED;
  if (rs.hover?.node === id) flags |= HOVERED;
  return flags;
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
 * Selection bounds, spikes and object links.
 *
 * Every key written here is remembered, and anything not rewritten this pass is dropped — which is what
 * keeps the last selection's box from staying on screen after the selection has moved on. Tools add their
 * own keys through {@link setDecor} under a `tool:` prefix, and those are exempt: a tool owns the whole
 * life of what it draws, and a sync happening mid-drag must not take a guide away from underneath it.
 *
 * `dragging` is passed in rather than read off the document because whether a gesture is running is the
 * host's business, not the level's. Keeping it in the editor state meant redo brought it back — spikes
 * standing around a solid nobody was touching, because the state redo restored had been mid-drag once.
 */
function syncDecor(rs: RenderScene, editor: Editor, dragging: boolean): void {
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
    if (dragging) write("spikes", spikeSegments(box.min, box.max, 500), SELECTED);
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
      // a patch has one kind of handle and shows it whenever any of the three are asked for: its control
      // points are neither corners nor midpoints nor centres, and refusing to show them because the tool
      // happened to be in edge mode would mean a patch you cannot edit with the tool that edits patches
      if (node?.kind === "patch") {
        const picked = new Set(editor.selection.vertices.filter((v) => v.node === id).map((v) => v.vertex));
        out.push(...patchHandles(id, node.patch.grid, picked));
        continue;
      }
      if (node?.kind !== "brush") continue;
      const { mesh } = brushToMesh(node.brush);
      if (!mesh) continue;
      const made = brushHandles(id, mesh.polygons, kinds);
      markPicked(made, node.brush, id, editor.selection);
      out.push(...made);
    }
  }
  setHandles(rs.handles, out);
  // the set the index pointed into no longer exists, so the hover starts again from the next pick
  rs.hoverHandle = undefined;
  applyHandles(rs);
}

/** the grid is never finer than a micrometre, so anything closer than this is the same corner */
const NEAR = 1e-6;

const nearby = (a: readonly number[], b: readonly number[]): boolean =>
  Math.abs(a[0]! - b[0]!) < NEAR && Math.abs(a[1]! - b[1]!) < NEAR && Math.abs(a[2]! - b[2]!) < NEAR;

/**
 * The handles that stand for something already picked, lit up.
 *
 * Vertices and edges are matched by position rather than by index, because `brushHandles` deduplicates them
 * across the faces that share them and its numbering has nothing to do with the polyhedron's. A handle sits
 * exactly on the corner it names, so comparing positions is not an approximation — it is the same float.
 * Faces are the exception: a face handle's `part` *is* the face.
 */
function markPicked(handles: Handle[], brush: BrushNode["brush"], id: NodeId, s: Selection): void {
  const corners: number[][] = [];
  for (const r of s.vertices) {
    if (r.node !== id) continue;
    const v = brush.poly.vertices[r.vertex];
    if (v) corners.push(v);
  }
  const midpoints: number[][] = [];
  for (const r of s.edges) {
    if (r.node !== id) continue;
    const a = brush.poly.vertices[r.a];
    const b = brush.poly.vertices[r.b];
    if (a && b) midpoints.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  }
  const faces = new Set(s.faces.filter((f) => f.node === id).map((f) => f.face));

  for (const handle of handles) {
    const on =
      handle.kind === "vertex" ? corners.some((p) => nearby(p, handle.at))
      : handle.kind === "edge" ? midpoints.some((p) => nearby(p, handle.at))
      : handle.kind === "face" ? faces.has(handle.part)
      : false;
    if (on) handle.flags |= SELECTED;
  }
}

/**
 * The handle under the mouse, by index; returns whether anything has to be redrawn.
 *
 * Only the two handles involved are touched. Hovering one of three hundred corners must not rewrite the
 * other two hundred and ninety-nine, because it happens on every frame the mouse moves.
 */
export function setHoverHandle(rs: RenderScene, index: number | undefined): boolean {
  if (rs.hoverHandle === index) return false;
  const before = rs.hoverHandle;
  rs.hoverHandle = index;
  let changed = false;
  if (before !== undefined) {
    const was = rs.handles.handles[before];
    if (was) changed = setHandleFlags(rs.handles, before, was.flags & ~HOVERED) || changed;
  }
  if (index !== undefined) {
    const now = rs.handles.handles[index];
    if (now) changed = setHandleFlags(rs.handles, index, now.flags | HOVERED) || changed;
  }
  if (changed) applyHandles(rs);
  return changed;
}

// ---------------------------------------------------------------- labels

/** object and group names, over the middle of whatever they are */
function syncLabels(rs: RenderScene, editor: Editor): void {
  hideLabels(rs.labels);
  walkForDrawing(editor, (node) => {
    if (node.kind !== "object" && node.kind !== "group") return;
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
  // only geometry moving can change which vertices belong to which material, and only the modern look
  // reads the answer — so this costs nothing at all in the classic one
  if (rs.brushes.groupsDirty) applyGroups(rs);

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

/**
 * The quad every handle is an instance of: a unit square centred on nothing, in the corner order the
 * vertex graph expects. It carries no world position at all — `handleAt` is where the handle is, and
 * `position` is only which corner of the square this vertex is.
 */
function handleGeometry(): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = 0;
  return geometry;
}

/** handles are rebuilt wholesale, so their attributes are simply replaced when the arrays move */
function applyHandles(rs: RenderScene): void {
  const geometry = rs.handleMesh.geometry as InstancedBufferGeometry;
  const spec: Spec[] = [
    ["handleAt", rs.handles.position, 3],
    ["kind", rs.handles.kind, 1],
    ["flag", rs.handles.flag, 1],
  ];
  for (const [name, array, size] of spec) {
    const held = geometry.getAttribute(name) as InstancedBufferAttribute | undefined;
    if (!held || held.array !== array) geometry.setAttribute(name, new InstancedBufferAttribute(array, size));
    else held.needsUpdate = true;
  }
  geometry.instanceCount = rs.handles.count;
  rs.handleMesh.visible = rs.handles.count > 0;
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
  rs.hoverHandle = undefined;
  hideLabels(rs.labels);
  rs.seen.clear();
  rs.decorKeys.clear();
  rs.hover = undefined;
}

/** the objects a pick pass draws, which is the map's faces and nothing that is drawn over them */
export const pickable = (rs: RenderScene): Object3D[] => [rs.faceMesh];
