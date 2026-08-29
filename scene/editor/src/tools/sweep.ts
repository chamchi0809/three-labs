/**
 * The sweep tool: a face pulled off a solid, leaving new solids behind it.
 *
 * Extrude grows the solid it is given. Sweep leaves that solid exactly where it was and builds the volume
 * the face swept through as *new* solids — which is the difference between thickening a wall and running a
 * skirting board along it. The face keeps its outline the whole way, so a hexagonal column sweeps a
 * hexagonal beam and an L-shaped floor sweeps an L-shaped storey.
 *
 * **The sweep is cut into segments.** One drag with the count at eight makes eight solids, not one — a
 * staircase, a run of tiles, a colonnade — and each is a separate brush the designer can then move, clip or
 * delete on its own. A single segment is the plain case: one new solid pulled off a face. `,` and `.` set
 * the count, and it is a setting on the tool rather than an undo entry for the same reason the shape
 * settings are: it is the gesture in the designer's hand, not anything about the level.
 *
 * **The new solids inherit the source's materials.** The sides come from the walls the face was joined to
 * and the caps from the face itself, which is what `fromPoints(…, brushPlanes(brush))` and `settle` do
 * between them — so a swept step comes out already matching the staircase it came off.
 *
 * Sweeping backwards is allowed and means what it says: the segments are built inside the solid rather than
 * outside it. That is how a recess gets a set of solids to subtract.
 */
import type { Vec3 } from "tscene";
import { brushPlanes, facePolygon, faceNormal, settle, type Brush } from "../brush/brush.ts";
import { fromPoints } from "../brush/csg.ts";
import {
  brushNode, insertNodes, nodeById, parents, type BrushNode, type NodeId, type World,
} from "../doc/document.ts";
import { gridSize, type Editor } from "../doc/editor.ts";
import { prune, selectFaces, selectNodes, NOTHING, type FaceRef } from "../doc/selection.ts";
import { snapTowards } from "../grid/snap.ts";
import { axisDelta } from "./drag.ts";
import { facesToPull, pullAxis } from "./extrude.ts";
import type { InputState } from "./input.ts";
import type { DragTracker, Outcome, Tool } from "./tool.ts";

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const brushAt = (world: World, id: NodeId): BrushNode | undefined => {
  const node = nodeById(world, id);
  return node?.kind === "brush" ? node : undefined;
};

export const MAX_SEGMENTS = 64;

/** how many solids one drag leaves behind; module state, because it is the tool and not the level */
export const sweepState = { segments: 1 };

export const setSegments = (n: number): number =>
  (sweepState.segments = Math.max(1, Math.min(MAX_SEGMENTS, Math.round(n))));

// ---------------------------------------------------------------- one segment

const along = (p: Vec3, n: Vec3, by: number): Vec3 => [p[0] + n[0] * by, p[1] + n[1] * by, p[2] + n[2] * by];

/**
 * The slab a face sweeps between two distances along its own normal.
 *
 * Built from the two copies of the outline as a hull rather than from planes, because the face may be any
 * convex polygon and the hull is the one construction that does not care how many sides it has.
 */
export function sweepSlab(brush: Brush, face: number, from: number, to: number): Brush | undefined {
  const outline = facePolygon(brush, face);
  if (outline.length < 3 || from === to) return undefined;
  const n = faceNormal(brush, face);
  const points = [
    ...outline.map((p) => along(p, n, from)),
    ...outline.map((p) => along(p, n, to)),
  ];
  const poly = fromPoints(points, brushPlanes(brush));
  return poly && settle(brush, poly);
}

export type Swept = { world: World; made: NodeId[] };

/**
 * Every face in `faces` swept, or nothing when any segment of any of them comes out degenerate.
 *
 * All-or-nothing across the faces, same as every other multi-solid edit here: half a staircase is worse
 * than none, because the designer has to find which half is missing before they can undo it.
 */
export function sweepWorld(
  world: World,
  faces: FaceRef[],
  distance: number,
  segments: number,
): Swept | undefined {
  if (!distance || segments < 1) return undefined;
  const owners = parents(world);
  const made: NodeId[] = [];
  let out = world;

  for (const ref of faces) {
    const node = brushAt(world, ref.node);
    if (!node) continue;
    const built: BrushNode[] = [];
    for (let i = 0; i < segments; i++) {
      const slab = sweepSlab(node.brush, ref.face, (distance * i) / segments, (distance * (i + 1)) / segments);
      if (!slab) return undefined;
      built.push(brushNode(slab, { props: [...node.props] }));
    }
    out = insertNodes(out, owners.get(ref.node) ?? out.layers[0]!.id, built);
    made.push(...built.map((b) => b.id));
  }

  return made.length ? { world: out, made } : undefined;
}

/** the swept solids in the world, and selected, because they are what the designer will move next */
function applySweep(e: Editor, from: World, faces: FaceRef[], distance: number, segments: number): Editor {
  const result = sweepWorld(from, faces, distance, segments);
  if (!result) return e;
  // the face selection named faces of the *source* solid, and it would point at the wrong thing now
  const selection = selectNodes(result.world, NOTHING, result.made, "replace", e.open);
  return { ...e, world: result.world, selection: prune(result.world, selection) };
}

// ---------------------------------------------------------------- the drag

const say = (): string => {
  const n = sweepState.segments;
  return `${n} segment${n === 1 ? "" : "s"} · , and . change it`;
};

function sweepDrag(start: InputState, editor: Editor): DragTracker | undefined {
  const node = start.hit?.node;
  const face = start.hit?.face;
  if (!node || face === undefined) return undefined;
  const hit: FaceRef = { node, face };
  const axis = pullAxis(editor.world, hit);
  if (!axis) return undefined;

  const faces = facesToPull(editor, hit);
  const from = editor.world;
  const grid = gridSize(editor);
  // snapped where the swept face lands, not on the distance, so the far end of a sweep sits on a grid line
  const at = dot(axis.origin, axis.normal);
  let last = 0;

  const step = (input: InputState): Outcome => {
    const raw = axisDelta(input.camera, input.size, start.at, input.at, axis.origin, axis.normal);
    if (raw === undefined) return { note: `swept ${last} m` };
    const by = snapTowards(at + raw, grid, raw) - at;
    last = by;
    // read at the frame, not at the drag's start, so , and . answer while the button is still down
    const segments = sweepState.segments;
    if (!by) return { note: `swept 0 m · ${say()}` };
    return {
      edit: {
        name: segments > 1 ? `sweep ${segments} segments` : "sweep face",
        collate: "drag:sweep",
        repeatable: true,
        apply: (e) => applySweep(e, from, faces, by, segments),
        // repeated, it sweeps whatever faces are selected now the same distance — the next flight of stairs
        again: (e) =>
          e.selection.faces.length ? applySweep(e, e.world, e.selection.faces, by, segments) : e,
      },
      note: `swept ${Math.round(by * 1000) / 1000} m into ${segments} · ${say()}`,
    };
  };

  return {
    move: step,
    end: (input) => ({ ...step(input), note: null }),
    cancel: () => ({
      edit: { name: "sweep face", collate: "drag:sweep", apply: (e) => ({ ...e, world: from }) },
      note: null,
    }),
  };
}

// ---------------------------------------------------------------- the tool

export const sweepTool: Tool = {
  id: "sweep",
  title: "sweep",
  key: "k",
  hint: "drag a face to leave new solids behind it · , and . set how many",
  handles: { faces: true },

  click(input) {
    const node = input.hit?.node;
    const face = input.hit?.face;
    if (!node || face === undefined) return undefined;
    return {
      set: (e) => ({
        ...e,
        selection: selectFaces(e.world, e.selection, [{ node, face }], input.mods.shift ? "toggle" : "replace"),
      }),
      note: `face ${face} of ${node} · ${say()}`,
    };
  },

  drag: sweepDrag,

  press(key) {
    if (key === ",") return { note: `${setSegments(sweepState.segments - 1)} segments` };
    if (key === ".") return { note: `${setSegments(sweepState.segments + 1)} segments` };
    return undefined;
  },
};
