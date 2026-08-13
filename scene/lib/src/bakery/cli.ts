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
  --padding <texels>   space around each chart (default 2)
  --texels-per-unit <n>  fixed lightmap density; 0 fits the atlas (default 0)
  --denoise <radius>   edge-aware blur, 0 to disable (default 1)
  --dilate <texels>    lit-region growth past chart edges (default 4)
  --exr                also write 32-bit float irradiance
  --only <keys>        re-trace only these meshes (comma separated), keeping the rest of the
                       atlas that is already there. Needs a previous bake made with --exr.
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
    padding: { type: "string" },
    "texels-per-unit": { type: "string" },
    denoise: { type: "string" },
    dilate: { type: "string" },
    exr: { type: "boolean" },
    only: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

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
// xatlas can sit in one unwrap for a minute, so the clock has to move on its own, not on progress
const ticker = tty ? setInterval(paint, 1000) : undefined;
ticker?.unref();

const result = await bakeSceneFile(positionals[0]!, {
  out: values.out,
  name: values.name,
  exr: values.exr,
  only: values.only?.split(",").map((k) => k.trim()).filter(Boolean),
  size: num("size", values.size),
  samples: num("samples", values.samples),
  bounces: num("bounces", values.bounces),
  indirect: num("indirect", values.indirect),
  batch: num("batch", values.batch),
  padding: num("padding", values.padding),
  texelsPerUnit: num("texels-per-unit", values["texels-per-unit"]),
  denoiseRadius: num("denoise", values.denoise),
  dilateRadius: num("dilate", values.dilate),
  onProgress: (next, done) => {
    if (next !== stage) {
      stage = next;
      stageStart = Date.now();
    }
    fraction = done;
    if (done >= 1) {
      process.stderr.write(`${tty ? "\r" : ""}${`${next} done in ${clock(Date.now() - stageStart)}`.padEnd(48)}\n`);
    } else if (tty) {
      paint();
    }
  },
});

clearInterval(ticker);

process.stderr.write(
  `${result.width}x${result.height}, ${(result.utilization * 100).toFixed(0)}% packed, ` +
    `exposure ${result.exposure.toFixed(3)}, baked in ${clock(Date.now() - started)}\n`,
);
process.stdout.write(`${result.files.join("\n")}\n`);

// the requestAnimationFrame shim keeps a timer alive, so nothing else will end the process
process.exit(0);
