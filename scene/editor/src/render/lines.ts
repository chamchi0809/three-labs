/**
 * Every line in the map, in one buffer: brush edges, selection bounds, guides, spikes, object links.
 *
 * Lines are the editor's other draw call. A solid is read from its silhouette long before it is read from
 * its shading, and in a wireframe view the edges *are* the picture — so they get the same treatment the
 * faces get: one arena, one upload of exactly what moved, and appearance in a flag attribute so that
 * highlighting an edge does not touch its endpoints.
 *
 * Every line here is a plain `GL_LINES` segment pair rather than a screen-space quad. Wide lines would
 * mean expanding each segment into two triangles and carrying the neighbour along to mitre the joins,
 * which is real work for a look the editor does not want: an edge that stays hairline at any distance is
 * exactly how a designer tells a wall's corner from its highlight.
 */
import {
  clear as clearArena, flush as flushArena, markDirty, newArena, release, reserve, type Arena, type Upload,
} from "./arena.ts";
import type { Flags } from "./batch.ts";

export type LineBatch = {
  arena: Arena;
  /** vec3, two vertices per segment */
  position: Float32Array;
  /** float, the same bit field the faces use */
  flag: Float32Array;
  /** vec2: what this line belongs to and which part of it, for picking an edge */
  pick: Float32Array;
  /** by key, which is a NodeId for brush edges and a made-up name for the overlays */
  entries: Map<string, { start: number; count: number }>;
};

export const newLines = (): LineBatch => ({
  arena: newArena(),
  position: new Float32Array(0),
  flag: new Float32Array(0),
  pick: new Float32Array(0),
  entries: new Map(),
});

/** one segment, as the six numbers that go into the buffer */
export type Segment = [number, number, number, number, number, number];

/**
 * A key's segments written into the batch. `count` is in vertices — two per segment — because that is
 * what the draw call and the arena both count in, and converting in one place is one place to be wrong.
 */
export function setLines(
  lines: LineBatch,
  key: string,
  segments: ArrayLike<number>,
  flags: Flags = 0,
  pick?: { object: number; part: (segment: number) => number },
): void {
  const vertices = Math.floor(segments.length / 3);
  // where it was before the arena is asked, because a key whose size changed is handed a *different* span
  // and the one it gave up is left holding the lines it was drawn with last frame
  const before = lines.entries.get(key);
  const span = reserve(lines.arena, key, vertices);
  fit(lines);
  // ...which is the same ghost `dropLines` collapses, arriving by the other door: a moved wall whose edge
  // count came out different re-let its space and went on being drawn out of the hole it left. Blanked
  // before the new vertices go in, so a key that shrank in place keeps what it is about to write.
  if (before && (before.start !== span.start || before.count !== span.count)) blank(lines, before);

  lines.position.set(segments as ArrayLike<number> & Iterable<number>, span.start * 3);
  lines.flag.fill(flags, span.start, span.start + vertices);
  for (let i = 0; i < vertices; i++) {
    lines.pick[(span.start + i) * 2] = pick?.object ?? 0;
    lines.pick[(span.start + i) * 2 + 1] = pick ? pick.part(i >> 1) : 0;
  }
  lines.entries.set(key, { start: span.start, count: vertices });
}

export function dropLines(lines: LineBatch, key: string): void {
  const at = lines.entries.get(key);
  if (!at) return;
  lines.entries.delete(key);
  // released first, because that is what pulls the high-water mark back over a span at the tail — and a
  // span above the mark is one `blank` then knows it has no work to do
  release(lines.arena, key);
  blank(lines, at);
}

/**
 * Vertices a key has stopped using, collapsed to a point.
 *
 * The same hole the faces have: a segment left in the middle of the draw range goes on being drawn, and one
 * collapsed to a point has no length to draw. Only the part still below the high-water mark is worth
 * touching — above it the draw range stops short and the numbers are nobody's.
 */
function blank(lines: LineBatch, at: { start: number; count: number }): void {
  const end = Math.min(at.start + at.count, lines.arena.used);
  if (end <= at.start) return;
  lines.position.fill(0, at.start * 3, end * 3);
  markDirty(lines.arena, { start: at.start, count: end - at.start });
}

/** a key's appearance changed and nothing else — the same free highlight the faces get */
export function setLineFlags(lines: LineBatch, key: string, flags: Flags): boolean {
  const at = lines.entries.get(key);
  if (!at || lines.flag[at.start] === flags) return false;
  lines.flag.fill(flags, at.start, at.start + at.count);
  markDirty(lines.arena, at);
  return true;
}

export function clearLines(lines: LineBatch): void {
  clearArena(lines.arena);
  lines.entries.clear();
}

export const flushLines = (lines: LineBatch): Upload => flushArena(lines.arena);

function fit(lines: LineBatch) {
  const want = lines.arena.capacity;
  if (lines.flag.length >= want) return;
  lines.position = grown(lines.position, want * 3);
  lines.flag = grown(lines.flag, want);
  lines.pick = grown(lines.pick, want * 2);
}

const grown = (was: Float32Array, size: number): Float32Array => {
  const next = new Float32Array(size);
  next.set(was);
  return next;
};

// ---------------------------------------------------------------- brush edges

/**
 * The edges of a solid, each one once.
 *
 * A convex solid's edge is shared by exactly two faces, so walking the polygons and taking every edge
 * would draw each twice — which costs nothing visually and doubles the buffer, the upload and the pick
 * ambiguity. Keying on the two endpoints, smallest first, is enough: the kernel gives every face the same
 * vertex objects, so two faces that share an edge share its numbers exactly.
 */
export function edgeSegments(polygons: (readonly (readonly number[])[] | undefined)[]): {
  segments: Float32Array;
  /** which face each segment was first met on, so picking an edge can say what it belongs to */
  faces: number[];
} {
  const seen = new Set<string>();
  const out: number[] = [];
  const faces: number[] = [];

  for (const [face, poly] of polygons.entries()) {
    if (!poly) continue;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const key = edgeKey(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!);
      faces.push(face);
    }
  }
  return { segments: new Float32Array(out), faces };
}

/** the two endpoints in a fixed order, so an edge met from either side hashes the same */
function edgeKey(a: readonly number[], b: readonly number[]): string {
  const first = a[0]! < b[0]! || (a[0] === b[0] && (a[1]! < b[1]! || (a[1] === b[1] && a[2]! <= b[2]!)));
  const [p, q] = first ? [a, b] : [b, a];
  return `${p[0]},${p[1]},${p[2]}|${q[0]},${q[1]},${q[2]}`;
}

// ---------------------------------------------------------------- boxes

/** the twelve edges of an axis-aligned box, as the numbers `setLines` wants */
export function boxSegments(min: readonly number[], max: readonly number[]): Float32Array {
  const [x0, y0, z0] = [min[0]!, min[1]!, min[2]!];
  const [x1, y1, z1] = [max[0]!, max[1]!, max[2]!];
  const corner = (i: number): [number, number, number] => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const out: number[] = [];
  for (let i = 0; i < 8; i++) {
    // the three neighbours with a higher index, which is every edge exactly once
    for (const bit of [1, 2, 4]) {
      if (i & bit) continue;
      out.push(...corner(i), ...corner(i | bit));
    }
  }
  return new Float32Array(out);
}

/**
 * The "spikes": from each corner of a box, a line along every axis to the far edge of the world.
 *
 * TrenchBroom draws these while a solid is being dragged, and they are the reason a designer can line a
 * wall up with something forty metres behind it in a perspective view. Depth alone cannot tell you two
 * things are level; a line that visibly passes through both can.
 */
export function spikeSegments(
  min: readonly number[],
  max: readonly number[],
  reach: number,
): Float32Array {
  const out: number[] = [];
  const centre = [0, 1, 2].map((i) => (min[i]! + max[i]!) / 2);
  for (const axis of [0, 1, 2]) {
    const a = [...centre];
    const b = [...centre];
    a[axis] = min[axis]! - reach;
    b[axis] = max[axis]! + reach;
    out.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!);
  }
  return new Float32Array(out);
}

/**
 * A guide: the plane a face lies on, drawn as a cross on that plane so the eye can read where it extends
 * to. Two segments through the centre, along the plane's own axes.
 */
export function guideSegments(
  centre: readonly number[],
  u: readonly number[],
  v: readonly number[],
  reach: number,
): Float32Array {
  const along = (d: readonly number[]): number[] => [
    centre[0]! - d[0]! * reach, centre[1]! - d[1]! * reach, centre[2]! - d[2]! * reach,
    centre[0]! + d[0]! * reach, centre[1]! + d[1]! * reach, centre[2]! + d[2]! * reach,
  ];
  return new Float32Array([...along(u), ...along(v)]);
}
