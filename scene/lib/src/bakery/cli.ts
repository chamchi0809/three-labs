#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
// tlightmap <scene.tscene> [--out dir] [--size 1024] [--samples 512] ...
import { parseArgs } from "node:util";
import { bakeSceneFile } from "./file.ts";

const USAGE = `tlightmap <scene.tscene> [options]

  --out <dir>          where to write (default: next to the scene)
  --name <name>        output base name (default: the scene's file name)
  --size <px>          atlas resolution (default 1024)
  --samples <n>        paths per texel (default 512)
  --bounces <n>        diffuse bounces (default 4)
  --batch <n>          paths per dispatch (default 32)
  --padding <texels>   space around each chart (default 2)
  --texels-per-unit <n>  fixed lightmap density; 0 fits the atlas (default 0)
  --denoise <radius>   edge-aware blur, 0 to disable (default 1)
  --dilate <texels>    lit-region growth past chart edges (default 4)
  --exr                also write 32-bit float irradiance
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    name: { type: "string" },
    size: { type: "string" },
    samples: { type: "string" },
    bounces: { type: "string" },
    batch: { type: "string" },
    padding: { type: "string" },
    "texels-per-unit": { type: "string" },
    denoise: { type: "string" },
    dilate: { type: "string" },
    exr: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || positionals.length !== 1) {
  process.stdout.write(USAGE);
  process.exit(values.help ? 0 : 1);
}

const num = (v: string | undefined, fallback: number) => (v === undefined ? fallback : Number(v));

let stage = "";
const result = await bakeSceneFile(positionals[0]!, {
  out: values.out,
  name: values.name,
  exr: values.exr,
  size: num(values.size, 1024),
  samples: num(values.samples, 512),
  bounces: num(values.bounces, 4),
  batch: num(values.batch, 32),
  padding: num(values.padding, 2),
  texelsPerUnit: num(values["texels-per-unit"], 0),
  denoiseRadius: num(values.denoise, 1),
  dilateRadius: num(values.dilate, 4),
  onProgress: (next, fraction) => {
    if (next !== stage) process.stderr.write(`${stage ? "\n" : ""}${next} `);
    stage = next;
    process.stderr.write(fraction >= 1 ? "done" : ".");
  },
});

process.stderr.write(
  `\n${result.width}x${result.height}, ${(result.utilization * 100).toFixed(0)}% packed, exposure ${result.exposure.toFixed(3)}\n`,
);
process.stdout.write(`${result.files.join("\n")}\n`);

// the requestAnimationFrame shim keeps a timer alive, so nothing else will end the process
process.exit(0);
