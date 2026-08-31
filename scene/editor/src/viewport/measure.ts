/**
 * The numbers TrenchBroom draws over the picture.
 *
 * TrenchBroom's `SelectionBoundsRenderer` puts a measurement against the selection in every pane: the size
 * along each axis, written on the box's own edges, updating live while a drag is happening. It is the single
 * most useful thing on its screen — a level is built out of numbers, and an editor that keeps them in a
 * status line makes you look away from the thing you are building to read them.
 *
 * This is that renderer, as a function from a box to screen-space guides. Nothing here draws, touches the
 * DOM, or knows what a canvas is, which is what makes the interesting parts — *which* edge of eight carries
 * the number, and which way the number is nudged off it — checkable under bare node.
 *
 * Two departures from TrenchBroom, both deliberate. It picks the labelled edge by testing the box's faces
 * against the camera direction; this picks it in screen space, by asking which candidate edge ends up
 * furthest out from the middle of the projected box. The two agree on every ordinary view and this one keeps
 * agreeing when the box is nearly edge-on, where a face test has no strong opinion and flickers between
 * edges as the camera turns. And an axis that projects to almost nothing gets no guide at all rather than a
 * crowded one, which is what makes a 2D pane show two measurements instead of three without a special case.
 */
import type { Vec3 } from "tscene";
import type { Bounds } from "../brush/builder.ts";
import { screenOf, type Point, type Size, type View } from "./view.ts";

/** one measurement: the edge it is taken along, and the number that goes beside it */
export type Guide = {
  /** 0, 1 or 2 — which axis this is the length of, so the pane can colour it like the axis cross does */
  axis: 0 | 1 | 2;
  /** the box edge the number belongs to, projected to pane pixels */
  from: Point;
  to: Point;
  /** where the number goes: off the edge, on the side away from the box */
  at: Point;
  label: string;
};

/** an edge shorter than this is being seen end-on, and a number written on it would not point at anything */
const MIN_EDGE = 14;

/** how far off its edge a number sits, in pixels — clear of the line, still obviously attached to it */
const OFFSET = 13;

/** how close to the pane's own border a number may be pushed before it is pulled back in */
const MARGIN = 4;

/**
 * The measurements for a box, one per axis that is worth measuring.
 *
 * Empty when the box is behind the eye, which is what a 3D view says about a selection you have flown past.
 * Drawing it anyway is worse than drawing nothing: a perspective divide by a negative depth is a perfectly
 * plausible pixel in the wrong half of the pane, and the guide would appear to point at something else.
 */
export function boundsGuides(box: Bounds, view: View, size: Size): Guide[] {
  if (size.width <= 0 || size.height <= 0) return [];

  const corners = CORNERS.map((c) => screenOf(view, cornerOf(box, c), size));
  if (corners.some((p) => !p || p.depth <= 0)) return [];
  const seen = corners as { x: number; y: number; depth: number }[];

  const middle = {
    x: seen.reduce((a, p) => a + p.x, 0) / 8,
    y: seen.reduce((a, p) => a + p.y, 0) / 8,
  };

  const guides: Guide[] = [];
  for (const axis of [0, 1, 2] as const) {
    const span = box.max[axis]! - box.min[axis]!;
    if (span <= 0) continue;

    const edge = outermostEdge(axis, seen, middle);
    if (!edge) continue;

    guides.push({
      axis,
      from: { x: edge.a.x, y: edge.a.y },
      to: { x: edge.b.x, y: edge.b.y },
      at: nudge(edge, middle, size),
      label: formatSpan(span),
    });
  }
  return guides;
}

/**
 * The one of the four edges along an axis that the number should be written on.
 *
 * The four are the box's edges parallel to `axis`; the one chosen is whichever midpoint ends up furthest
 * from the middle of the projected box, so the number lands on the silhouette rather than across the front
 * of the solid. Ties — and in an orthographic view straight down an axis, all four tie exactly — go to the
 * nearest, which is the edge a designer would say they were looking at.
 */
function outermostEdge(
  axis: 0 | 1 | 2,
  seen: { x: number; y: number; depth: number }[],
  middle: Point,
): { a: (typeof seen)[number]; b: (typeof seen)[number] } | undefined {
  let best: { a: (typeof seen)[number]; b: (typeof seen)[number] } | undefined;
  let bestOut = -1;
  let bestDepth = Infinity;

  for (let i = 0; i < 8; i++) {
    // the corner's partner along this axis is the one that differs in this bit and nothing else, and taking
    // only the four where the bit is clear is what visits each edge once rather than twice
    if (CORNERS[i]![axis] === 1) continue;
    const a = seen[i]!;
    const b = seen[i ^ (1 << axis)]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < MIN_EDGE) continue;

    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const out = Math.hypot(mid.x - middle.x, mid.y - middle.y);
    const depth = (a.depth + b.depth) / 2;
    // a whole pixel of daylight before "further out" beats "nearer", so a box seen very nearly flat-on does
    // not swap edges every frame as the camera drifts
    if (out > bestOut + 1 || (out > bestOut - 1 && depth < bestDepth)) {
      best = { a, b };
      bestOut = Math.max(bestOut, out);
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * Where the number goes: off the middle of its edge, perpendicular, on the side away from the box.
 *
 * Perpendicular rather than along, because a number pushed along its own edge slides past the corner and
 * stops being that edge's number. The result is then held inside the pane, so a selection half off-screen
 * still says how big it is instead of writing its size into the pane next door.
 */
function nudge(
  edge: { a: Point; b: Point },
  middle: Point,
  size: Size,
): Point {
  const mid = { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 };
  const dx = edge.b.x - edge.a.x;
  const dy = edge.b.y - edge.a.y;
  const length = Math.hypot(dx, dy) || 1;

  let px = -dy / length;
  let py = dx / length;
  // away from the box, unless the edge runs straight through the middle — then either side will do
  if (px * (mid.x - middle.x) + py * (mid.y - middle.y) < 0) {
    px = -px;
    py = -py;
  }

  return {
    x: clamp(mid.x + px * OFFSET, MARGIN, size.width - MARGIN),
    y: clamp(mid.y + py * OFFSET, MARGIN, size.height - MARGIN),
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * A length, written the way a designer reads it.
 *
 * Metres above a metre and millimetres below, which is the same split `formatSize` makes for the grid — but
 * rounded, because a measurement is not a grid size. A dragged box is the sum of a snap and a floating-point
 * subtraction, and `3.9999999999999996 m` is a true answer to a question nobody asked.
 */
export function formatSpan(metres: number): string {
  if (metres < 1) {
    const mm = round(metres * 1000, 1);
    return `${mm} mm`;
  }
  return `${round(metres, 3)} m`;
}

const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** the eight corners as bits: bit `k` set means "the max end of axis `k`" */
const CORNERS: readonly (readonly [0 | 1, 0 | 1, 0 | 1])[] = Array.from(
  { length: 8 },
  (_, i) => [(i & 1) as 0 | 1, ((i >> 1) & 1) as 0 | 1, ((i >> 2) & 1) as 0 | 1] as const,
);

const cornerOf = (box: Bounds, c: readonly [0 | 1, 0 | 1, 0 | 1]): Vec3 => [
  c[0] ? box.max[0]! : box.min[0]!,
  c[1] ? box.max[1]! : box.min[1]!,
  c[2] ? box.max[2]! : box.min[2]!,
];
