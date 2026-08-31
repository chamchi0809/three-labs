/**
 * What the last two seconds of frames cost.
 *
 * There are no runes in this file on purpose. Everything here is written to sixty times a second, and a
 * `$state` number written at that rate would wake every effect that reads it sixty times a second — which
 * would mean the profiler's own readout was a large part of what the profiler was measuring. So the meter
 * keeps plain numbers in a ring buffer that never grows, and the panel that shows them polls a few times a
 * second and does its own reactive assignment there. Measuring is free; *displaying* is what costs, and
 * displaying is the part that happens four times a second instead of sixty.
 *
 * A frame is broken into named spans rather than reported as one number, because "the editor feels slow"
 * has at least four different causes — a heavy scene, a heavy overlay, a rebuild on every keystroke, a
 * pick running when nothing moved — and one millisecond count tells them apart from none of them.
 */

/** the parts of a frame worth telling apart */
export const SPANS = ["draw", "overlay", "sync", "pick"] as const;
export type Span = (typeof SPANS)[number];

/** two seconds at sixty frames a second: long enough to see a stutter, short enough to still feel live */
const WINDOW = 120;

export type Counts = {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
};

export type Reading = {
  /** frames a second, from the mean gap between the frames in the window */
  fps: number;
  /** the mean gap in milliseconds, which is the number that matters when it is above sixteen */
  ms: number;
  /** the worst frame in the window — a mean of 8 ms with a worst of 90 is a stutter, and reads as smooth */
  worst: number;
  /** mean milliseconds per frame in each named span */
  spans: Record<Span, number>;
  counts: Counts;
  frames: number;
};

class Perf {
  /** the gap before each of the last `WINDOW` frames, oldest overwritten first */
  #gaps = new Float64Array(WINDOW);
  #at = 0;
  #seen = 0;
  #last = 0;

  /** total milliseconds and sample count per span, reset every time a reading is taken */
  #spans: Record<Span, { total: number; n: number }> = {
    draw: { total: 0, n: 0 },
    overlay: { total: 0, n: 0 },
    sync: { total: 0, n: 0 },
    pick: { total: 0, n: 0 },
  };

  #counts: Counts = { drawCalls: 0, triangles: 0, geometries: 0, textures: 0 };

  /** a frame began. `now` is the animation loop's own timestamp, so no clock is read that was not already */
  frame(now: number): void {
    if (this.#last) {
      this.#gaps[this.#at] = now - this.#last;
      this.#at = (this.#at + 1) % WINDOW;
      if (this.#seen < WINDOW) this.#seen++;
    }
    this.#last = now;
  }

  /**
   * Forget everything.
   *
   * For a renderer that has been torn down and rebuilt: the gap across that is a gap containing a device
   * loss and a shader recompile, and leaving it in the window would report a stutter that has already been
   * dealt with as the worst frame for the next two seconds.
   */
  reset(): void {
    this.#gaps.fill(0);
    this.#at = 0;
    this.#seen = 0;
    this.#last = 0;
    for (const name of SPANS) this.#spans[name] = { total: 0, n: 0 };
    this.#counts = { drawCalls: 0, triangles: 0, geometries: 0, textures: 0 };
  }

  span(name: Span, ms: number): void {
    const span = this.#spans[name];
    span.total += ms;
    span.n++;
  }

  /**
   * Time a piece of the frame.
   *
   * Two clock reads and a call, which is the cheapest honest way to do this — a `performance.mark` pair
   * writes an entry into the browser's own buffer per frame and that buffer is not a ring.
   */
  time<T>(name: Span, run: () => T): T {
    const at = performance.now();
    try {
      return run();
    } finally {
      this.span(name, performance.now() - at);
    }
  }

  /** what the renderer drew, straight off its own counters */
  counted(counts: Counts): void {
    this.#counts = counts;
  }

  /**
   * The window as numbers, and the spans reset.
   *
   * Reset on read rather than averaged over the same ring, because a span is not sampled once per frame —
   * `sync` happens when the document changes and `pick` when the pointer moves — and a mean over "the last
   * hundred and twenty times this ran" would be a mean over an hour of a still editor.
   */
  read(): Reading {
    let total = 0;
    let worst = 0;
    for (let i = 0; i < this.#seen; i++) {
      total += this.#gaps[i]!;
      if (this.#gaps[i]! > worst) worst = this.#gaps[i]!;
    }
    const ms = this.#seen ? total / this.#seen : 0;

    const spans = {} as Record<Span, number>;
    for (const name of SPANS) {
      const span = this.#spans[name];
      spans[name] = span.n ? span.total / span.n : 0;
      span.total = 0;
      span.n = 0;
    }

    return {
      fps: ms ? 1000 / ms : 0,
      ms,
      worst,
      spans,
      counts: this.#counts,
      frames: this.#seen,
    };
  }
}

export const perf = new Perf();
