/**
 * What the editor and the dev server say to each other about a bake.
 *
 * Its own file, imported by both halves, because the two live in different runtimes: `server.ts` runs in
 * node inside vite and pulls in Dawn, sharp and xatlas; everything else here runs in a browser. A type
 * either of them declared privately would be a type the other one could get wrong silently, and the one
 * failure mode of a streaming protocol is a field that quietly stopped being sent.
 *
 * Nothing in this file imports anything. That is the point of it.
 */

/**
 * Where the bake routes live.
 *
 * `/@` because that is vite's own marker for "this is the tooling talking, not a file in your project",
 * so it cannot collide with a path a map might legitimately want.
 */
export const BAKE_ROUTE = "/@bake";

/** the stages a bake reports, in the order they happen — the baker's own `BakeStage`, restated here so
 * the client does not have to import a node module to know what a progress line can say */
export const STAGES = [
  "load",
  "collect",
  "unwrap",
  "rasterize",
  "prepare",
  "trace",
  "probe",
  "filter",
  "write",
] as const;

export type Stage = (typeof STAGES)[number];

/** roughly how much of a bake each stage is, for a bar that does not stall at 5% for four minutes */
export const WEIGHTS: Record<Stage, number> = {
  load: 1,
  collect: 1,
  unwrap: 6,
  rasterize: 4,
  prepare: 3,
  trace: 70,
  probe: 6,
  filter: 3,
  write: 6,
};

/** whether the machine running the dev server can bake at all, and why not when it cannot */
export type Ready = {
  ok: boolean;
  /** in a sentence a designer can act on: no adapter, no baker installed, already baking */
  why?: string;
  /** where the bake reads relative paths from, relative to the project — shown so a missing texture reads */
  dir?: string;
};

/** the settings a designer can reach. Everything else is left to the sheet's `@bakery` and the defaults */
export type Settings = {
  /** atlas resolution */
  size: number;
  /** paths per texel */
  samples: number;
  /** diffuse bounces */
  bounces: number;
  /** lightmap texels per world unit; 0 fits the atlas to whatever is there */
  texelsPerUnit: number;
  /** also bake ambient occlusion into its own atlas */
  ao: boolean;
  /** also write the 32-bit float irradiance, which is what a partial rebake needs */
  exr: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  size: 1024,
  samples: 256,
  bounces: 3,
  texelsPerUnit: 0,
  ao: false,
  exr: false,
};

/**
 * A bake request: the document as text, not as a path.
 *
 * The editor holds a map that may never have been saved, and a browser is never told where the file it
 * opened lives — so the sheets travel in the body and the server loads them from memory. `dir` is only
 * ever the server's own idea of where relative texture paths point; the client cannot name it, because a
 * client that could name a directory could name any directory.
 */
export type Request = {
  /** every sheet of the project, keyed by the path it imports itself as */
  files: Record<string, string>;
  /** which of them is the map */
  root: string;
  settings: Partial<Settings>;
};

/** one line of the NDJSON a bake streams back */
export type Event =
  | { kind: "stage"; stage: Stage; done: number }
  | { kind: "warn"; text: string }
  | { kind: "failed"; text: string }
  | {
      kind: "done";
      /** url of the manifest, which is what `applyLightmap` is pointed at */
      manifest: string;
      /** the file names written, for the log */
      files: string[];
      width: number;
      height: number;
      /** fraction of the atlas the charts cover */
      utilization: number;
      exposure: number;
      ms: number;
    };

/**
 * How far along a bake is, as one number.
 *
 * A stage-weighted total rather than the stage's own fraction, because the stage's own fraction goes
 * back to zero eight times and a bar that does that reads as a bar that is broken. The weights are
 * approximate by nature — an unwrap of a huge map can outlast a cheap trace — so this is honest about
 * being an estimate and never goes backwards.
 */
export function progressOf(stage: Stage, done: number): number {
  let before = 0;
  let total = 0;
  for (const s of STAGES) {
    total += WEIGHTS[s];
    if (STAGES.indexOf(s) < STAGES.indexOf(stage)) before += WEIGHTS[s];
  }
  return (before + WEIGHTS[stage] * Math.min(1, Math.max(0, done))) / total;
}

/** `4m03s`, which is how a bake's length is read — never `243.2s` and never `0.07 hours` */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * The events out of a response body, a line at a time.
 *
 * Here rather than beside the store because it is the other half of what `server.ts` writes: one file
 * decides that a bake is newline-delimited json and one file is where that decision can be checked.
 *
 * A line at a time rather than `res.json()` at the end, because the whole value of the stream is that a
 * four-minute trace says where it has got to while it is getting there. The tail is flushed on close — the
 * last line has no newline after it, and it is the one that says the bake succeeded.
 */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Event> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let held = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      held += decoder.decode(value, { stream: true });
      let at = held.indexOf("\n");
      while (at >= 0) {
        const line = held.slice(0, at).trim();
        held = held.slice(at + 1);
        if (line) yield JSON.parse(line) as Event;
        at = held.indexOf("\n");
      }
    }
    const last = held.trim();
    if (last) yield JSON.parse(last) as Event;
  } finally {
    reader.releaseLock();
  }
}
