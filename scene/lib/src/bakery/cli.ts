#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
// tscene-bake <scene.tscene> [--out dir] [--size 1024] [--samples 512] ...
import { parseArgs } from "node:util";
import { bakeSceneFile } from "./file.ts";

const USAGE = `tscene-bake <scene.tscene> [options]

Every option below can also live in the scene's own \`@bakery { … }\` block; a flag wins over it.

  --out <dir>          where to write (default: next to the scene)
  --name <name>        output base name (default: the scene's file name)
  --size <px>          atlas resolution (default 1024)
  --samples <n>        paths per texel (default 512)
  --bounces <n>        diffuse bounces (default 4)
  --indirect <gain>    gain on everything past the first bounce (default 1)
  --batch <n>          paths per dispatch (default 32)
  --bias <units>       ray origin offset along the normal; 0 picks 1e-4 of the scene diagonal
  --padding <texels>   space around each chart (default: --dilate)
  --texels-per-unit <n>  fixed lightmap density; 0 fits the atlas (default 0)
  --fireflies <n>      clamp a texel more than n times its neighbours' median, 0 to keep them
                       (default 4)
  --denoise <radius>   edge-aware blur, 0 to disable (default 1)
  --dilate <texels>    lit-region growth past chart edges (default 4)
  --default-albedo <n>   reflectance of a material with no colour at all (default 0.8)
  --include <all|none>   bake every mesh, or only the ones with \`@bakery { enabled: true }\`
  --ao                 also write <name>.ao.png and put it on the materials' aoMap
  --ao-distance <units>  how far an occlusion ray looks; 0 picks 5% of the scene diagonal
  --jobs <n>           worker threads for the rasterizer (default: one per core)
  --exposure <n>       fix the PNG divisor instead of taking the atlas' 95th percentile
  --exr                also write 32-bit float irradiance
  --only <keys>        re-trace only these meshes (comma separated), keeping the rest of the
                       atlas that is already there. Needs a previous bake made with --exr.

Ctrl-C stops at the next dispatch and writes nothing; a second one quits immediately.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    name: { type: "string" },
    size: { type: "string" },
    samples: { type: "string" },
    bounces: { type: "string" },
    indirect: { type: "string" },
    batch: { type: "string" },
    bias: { type: "string" },
    padding: { type: "string" },
    "texels-per-unit": { type: "string" },
    fireflies: { type: "string" },
    denoise: { type: "string" },
    dilate: { type: "string" },
    "default-albedo": { type: "string" },
    include: { type: "string" },
    ao: { type: "boolean" },
    "ao-distance": { type: "string" },
    exposure: { type: "string" },
    jobs: { type: "string" },
    exr: { type: "boolean" },
    only: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.include !== undefined && values.include !== "all" && values.include !== "none") {
  process.stderr.write(`tscene-bake: --include expects "all" or "none", got ${JSON.stringify(values.include)}\n`);
  process.exit(1);
}

if (values.help || positionals.length !== 1) {
  process.stdout.write(USAGE);
  process.exit(values.help ? 0 : 1);
}

// an absent flag stays `undefined` so the sheet's `@bakery` — and then the stage default — can fill it in
const num = (name: string, v: string | undefined) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    process.stderr.write(`tscene-bake: --${name} expects a number, got ${JSON.stringify(v)}\n`);
    process.exit(1);
  }
  return n;
};

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

// a rewriting line on a terminal, one line per finished stage when the output is a file
const tty = process.stderr.isTTY;
const started = Date.now();
let stage = "";
let stageStart = started;
let fraction = 0;

/** `trace  42% · 1m03s · 1m24s left`. Only trace reports a fraction; the rest just show elapsed. */
const render = () => {
  const elapsed = Date.now() - stageStart;
  const percent = fraction > 0 ? `${Math.round(fraction * 100)}%`.padStart(4) : "    ";
  const eta = fraction > 0 ? ` · ${clock((elapsed / fraction) * (1 - fraction))} left` : "";
  return `${stage} ${percent} · ${clock(elapsed)}${eta}`;
};
const paint = () => process.stderr.write(`\r${render().padEnd(48)}`);
/**
 * A stage is timed from its own first report to the *next* stage's, and printed then — never when it
 * reports 1. A stage that reports nothing but its finish would otherwise time itself from that finish
 * and claim 0s, and anything a stage does after its last item — indexing the raster, sorting for the
 * exposure — would land in nobody's total. Bake time is the sum of these lines, and has to stay that.
 */
const flush = () => {
  if (!stage) return;
  process.stderr.write(`${tty ? "\r" : ""}${`${stage} done in ${clock(Date.now() - stageStart)}`.padEnd(48)}\n`);
};
// xatlas can sit in one unwrap for a minute, so the clock has to move on its own, not on progress
const ticker = tty ? setInterval(paint, 1000) : undefined;
ticker?.unref();

// Ctrl-C between two dispatches, rather than whenever the OS gets round to killing the process: a bake
// holds a GPU device and a pool of worker threads, and node's default SIGINT leaves both to the driver.
// The second one is the escape hatch for a stage that is inside a call the signal cannot reach.
const stop = new AbortController();
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  stop.abort(new Error("interrupted"));
  process.stderr.write(`${tty ? "\r" : ""}${"tscene-bake: stopping — Ctrl-C again to quit now".padEnd(48)}\n`);
});

const result = await bakeSceneFile(positionals[0]!, {
  signal: stop.signal,
  out: values.out,
  name: values.name,
  exr: values.exr,
  only: values.only?.split(",").map((k) => k.trim()).filter(Boolean),
  size: num("size", values.size),
  samples: num("samples", values.samples),
  bounces: num("bounces", values.bounces),
  indirect: num("indirect", values.indirect),
  batch: num("batch", values.batch),
  bias: num("bias", values.bias),
  padding: num("padding", values.padding),
  texelsPerUnit: num("texels-per-unit", values["texels-per-unit"]),
  fireflyThreshold: num("fireflies", values.fireflies),
  denoiseRadius: num("denoise", values.denoise),
  dilateRadius: num("dilate", values.dilate),
  defaultAlbedo: num("default-albedo", values["default-albedo"]),
  include: values.include as "all" | "none" | undefined,
  ao: values.ao,
  aoDistance: num("ao-distance", values["ao-distance"]),
  exposure: num("exposure", values.exposure),
  jobs: num("jobs", values.jobs),
  // a warning mid-progress has to start its own line or the rewriting one eats it
  onWarn: (message) => process.stderr.write(`${tty ? "\r" : ""}${`tscene-bake: ${message}`.padEnd(48)}\n`),
  onProgress: (next, done) => {
    if (next !== stage) {
      flush();
      stage = next;
      stageStart = Date.now();
    }
    fraction = done;
    if (tty) paint();
  },
  // a bake fails for reasons that are the user's to fix — no adapter, a mesh that moved since the last
  // bake, a sheet that does not parse. A top-level await turns all of them into an unhandled rejection:
  // a stack trace through the tracer, and an exit code node only started setting in v15.
}).catch((e: unknown) => {
  clearInterval(ticker);
  // an interrupt is not a failure to report twice — the handler already said what happened
  if (interrupted) process.exit(130);
  process.stderr.write(`${tty ? "\r" : ""}${`tscene-bake: ${e instanceof Error ? e.message : String(e)}`.padEnd(48)}\n`);
  process.exit(1);
});

clearInterval(ticker);
flush();

process.stderr.write(
  `${result.width}x${result.height}, ${(result.utilization * 100).toFixed(0)}% packed, ` +
    `exposure ${result.exposure.toFixed(3)}, baked in ${clock(Date.now() - started)}\n`,
);
process.stdout.write(`${result.files.join("\n")}\n`);

// the requestAnimationFrame shim keeps a timer alive, so nothing else will end the process
process.exit(0);
