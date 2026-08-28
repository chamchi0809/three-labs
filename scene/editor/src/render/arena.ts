/**
 * Where each thing lives inside one big buffer.
 *
 * The editor draws a map as a handful of draw calls, not one per solid, so every brush's vertices sit in
 * the same attribute arrays and each one owns a span of them. That is what makes a ten-thousand-solid map
 * turn at sixty frames — but it means moving one wall has to become "rewrite vertices 8412..8484 and
 * upload exactly those", never "rebuild the map".
 *
 * So this is a plain suballocator, and it is a separate file with its own checks because it is the piece
 * where a bug is invisible: a span handed out twice does not throw, it draws one brush inside another and
 * looks like a modelling mistake.
 *
 * Two things it deliberately does not do.
 *
 * - **It never moves anything.** A span keeps its address for as long as it is held, so the renderer can
 *   cache "brush #4 starts at 8412" and be right next frame. The cost is fragmentation, which is reported
 *   through {@link fragmentation} for the caller to act on rather than papered over.
 * - **It knows nothing about GPUs.** It counts *elements* — vertices, instances, segments — and the caller
 *   multiplies by whatever an element is worth in each attribute. That is what lets the same arena drive
 *   five parallel arrays with different item sizes and keep them in step.
 */

/** a half-open run of elements: `[start, start + count)` */
export type Span = { start: number; count: number };

export type Arena = {
  /** elements the buffers are sized for */
  capacity: number;
  /** one past the last element ever handed out — everything above this is untouched */
  used: number;
  spans: Map<string, Span>;
  /** holes below `used`, sorted by start and never adjacent to one another */
  free: Span[];
  /** what has been written since the last {@link flush} */
  dirty: Span[];
  /** whether the buffers themselves were replaced, which makes every dirty range moot */
  grew: boolean;
};

/** the smallest arena worth allocating: below this the growth arithmetic costs more than the memory */
const FLOOR = 256;

export const newArena = (capacity = 0): Arena => ({
  capacity,
  used: 0,
  spans: new Map(),
  free: [],
  dirty: [],
  grew: false,
});

export const spanOf = (arena: Arena, key: string): Span | undefined => arena.spans.get(key);

// ---------------------------------------------------------------- handing space out

/**
 * The span `key` should write into, `count` elements long.
 *
 * A key that already holds a span of exactly this size keeps it — which is the common case by a mile,
 * since dragging a wall changes where its vertices are and never how many there are — and the span is
 * marked dirty so the caller re-uploads it. Any other size gives the old span back first, so growing a
 * solid can reuse the hole it just made.
 */
export function reserve(arena: Arena, key: string, count: number): Span {
  const held = arena.spans.get(key);
  if (held && held.count === count) {
    markDirty(arena, held);
    return held;
  }
  if (held) release(arena, key);
  if (count === 0) {
    const empty = { start: 0, count: 0 };
    arena.spans.set(key, empty);
    return empty;
  }

  const span = take(arena, count);
  arena.spans.set(key, span);
  markDirty(arena, span);
  return span;
}

/**
 * A span out of the free list, or off the end.
 *
 * First fit rather than best fit: best fit spends a scan of the whole list to leave a smaller remainder,
 * and the remainders it leaves are the ones too small to ever be used again. First fit leaves bigger
 * holes, which are the ones that get reused.
 */
function take(arena: Arena, count: number): Span {
  for (const [i, hole] of arena.free.entries()) {
    if (hole.count < count) continue;
    const span = { start: hole.start, count };
    if (hole.count === count) arena.free.splice(i, 1);
    else ((hole.start += count), (hole.count -= count));
    return span;
  }

  const span = { start: arena.used, count };
  arena.used += count;
  if (arena.used > arena.capacity) grow(arena, arena.used);
  return span;
}

/** capacity doubled until it fits, so a map built one solid at a time reallocates a handful of times */
function grow(arena: Arena, need: number) {
  let capacity = Math.max(arena.capacity, FLOOR);
  while (capacity < need) capacity *= 2;
  arena.capacity = capacity;
  arena.grew = true;
}

// ---------------------------------------------------------------- taking it back

/** the space `key` held, returned to the free list and merged with whatever it now touches */
export function release(arena: Arena, key: string): void {
  const span = arena.spans.get(key);
  arena.spans.delete(key);
  if (!span || span.count === 0) return;

  // the tail is not a hole, it is simply unused again — this is what keeps a build-then-clear cycle flat
  if (span.start + span.count === arena.used) {
    arena.used = span.start;
    trimTail(arena);
    return;
  }

  let at = arena.free.findIndex((f) => f.start > span.start);
  if (at < 0) at = arena.free.length;
  arena.free.splice(at, 0, { start: span.start, count: span.count });
  coalesce(arena, at);
}

/** a free span merged with its neighbours; `at` is where the new one was just inserted */
function coalesce(arena: Arena, at: number) {
  const here = arena.free[at]!;
  const next = arena.free[at + 1];
  if (next && here.start + here.count === next.start) {
    here.count += next.count;
    arena.free.splice(at + 1, 1);
  }
  const prev = arena.free[at - 1];
  if (prev && prev.start + prev.count === here.start) {
    prev.count += here.count;
    arena.free.splice(at, 1);
  }
}

/** free spans that have ended up against the high-water mark are not holes; they are the tail */
function trimTail(arena: Arena) {
  for (let i = arena.free.length - 1; i >= 0; i--) {
    const hole = arena.free[i]!;
    if (hole.start + hole.count !== arena.used) break;
    arena.used = hole.start;
    arena.free.pop();
  }
}

/** everything released at once, keeping the buffers — how a viewport starts a fresh map */
export function clear(arena: Arena): void {
  arena.spans.clear();
  arena.free.length = 0;
  arena.used = 0;
  arena.dirty.length = 0;
  arena.grew = arena.capacity > 0; // whatever was there is stale
}

// ---------------------------------------------------------------- what to upload

/**
 * A range that has been written. Ranges are merged as they arrive rather than at flush time: the editor
 * writes a face at a time, and a solid's faces are next to each other, so the list would otherwise be a
 * hundred entries that are really one.
 */
export function markDirty(arena: Arena, span: Span): void {
  if (span.count === 0 || arena.grew) return;
  let at = arena.dirty.findIndex((d) => d.start > span.start);
  if (at < 0) at = arena.dirty.length;
  arena.dirty.splice(at, 0, { start: span.start, count: span.count });

  // merge forwards past everything this now reaches, then backwards into what reaches it
  const here = arena.dirty[at]!;
  while (at + 1 < arena.dirty.length && arena.dirty[at + 1]!.start <= here.start + here.count) {
    const next = arena.dirty.splice(at + 1, 1)[0]!;
    here.count = Math.max(here.start + here.count, next.start + next.count) - here.start;
  }
  const prev = arena.dirty[at - 1];
  if (prev && here.start <= prev.start + prev.count) {
    prev.count = Math.max(prev.start + prev.count, here.start + here.count) - prev.start;
    arena.dirty.splice(at, 1);
  }
}

export type Upload = {
  /** the buffers were replaced; every attribute has to go up whole and the ranges mean nothing */
  grew: boolean;
  /** merged, sorted, disjoint, and never touching each other */
  ranges: Span[];
  /** one past the last live element, so a draw call knows how much of the buffer is real */
  used: number;
};

/** what to send to the GPU this frame, and the arena reset to clean */
export function flush(arena: Arena): Upload {
  const upload: Upload = { grew: arena.grew, ranges: arena.grew ? [] : arena.dirty, used: arena.used };
  arena.dirty = [];
  arena.grew = false;
  return upload;
}

// ---------------------------------------------------------------- housekeeping

/** the share of the live region that is holes — when this gets high, the caller rebuilds from scratch */
export function fragmentation(arena: Arena): number {
  if (arena.used === 0) return 0;
  let holes = 0;
  for (const f of arena.free) holes += f.count;
  return holes / arena.used;
}

/**
 * Every span checked against every other. Only the checks call this; it is quadratic, and it exists
 * because "two things at the same address" is the one bug here that never announces itself.
 */
export function overlaps(arena: Arena): string[] {
  const all = [...arena.spans.entries()]
    .filter(([, s]) => s.count > 0)
    .map(([key, s]) => ({ key, ...s }))
    .sort((a, b) => a.start - b.start);
  const problems: string[] = [];
  for (const [i, a] of all.entries()) {
    const b = all[i + 1];
    if (b && a.start + a.count > b.start) problems.push(`${a.key} and ${b.key} overlap at ${b.start}`);
    if (a.start + a.count > arena.used) problems.push(`${a.key} runs past the high-water mark`);
  }
  for (const [i, hole] of arena.free.entries()) {
    const next = arena.free[i + 1];
    if (next && hole.start + hole.count >= next.start) problems.push(`free ${hole.start} touches ${next.start}`);
    for (const s of all) {
      if (hole.start < s.start + s.count && s.start < hole.start + hole.count) {
        problems.push(`free ${hole.start} overlaps ${s.key}`);
      }
    }
  }
  return problems;
}
