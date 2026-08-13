// Atlas space -> surface samples. Every covered texel gets the world position, normal and material
// of the point the path tracer has to shade. Pure CPU, so this is the part that has a unit test.
import type { Atlas } from "./atlas.ts";
import type { BakeMesh } from "./scene.ts";

export type Texels = {
  width: number;
  height: number;
  /** width*height, 1 where a chart covers the texel */
  mask: Uint8Array;
  /** width*height*4 — world position xyz, w unused */
  position: Float32Array;
  /** width*height*4 — world normal xyz, material id in w */
  normal: Float32Array;
  /** width*height*2 — the surface's own uv0, for sampling its albedo map. 0 where the mesh has none. */
  uv: Float32Array;
  /** width*height — index into the mesh list, -1 where nothing covers the texel */
  mesh: Int32Array;
  /** the covered texel indices, ascending — what the compute shader is dispatched over */
  index: Uint32Array;
};

/** One mesh as the rasterizer needs it: geometry, its atlas uv, and its slot in the mesh list. */
export type RasterMesh = {
  positions: Float32Array;
  normals: Float32Array;
  uv?: Float32Array;
  faceMaterial: Uint32Array;
  atlasUV: Float32Array;
  index: number;
};

export type RasterOptions = {
  /**
   * worker threads to rasterize with. 1 stays on the calling thread, 0 or absent asks for one per
   * core. Node only; everywhere else the rasterizer is single-threaded.
   */
  jobs?: number;
  onProgress?: (fraction: number) => void;
};

const raster = (meshes: BakeMesh[], atlas: Atlas): RasterMesh[] =>
  meshes.map((m, index) => ({
    positions: m.positions,
    normals: m.normals,
    uv: m.uv,
    faceMaterial: m.faceMaterial,
    atlasUV: atlas.uv[index]!,
    index,
  }));

/**
 * Texture space, not image space: texel row 0 is v = 0. That matches a `DataTexture` directly and
 * costs the PNG/EXR writers one row flip.
 */
export function rasterize(meshes: BakeMesh[], atlas: Atlas, onProgress?: (fraction: number) => void): Texels {
  const parts = raster(meshes, atlas);
  const texels = allocate(atlas.width, atlas.height, false);
  let done = 0;
  rasterizeInto(texels, parts, () => onProgress?.(++done / parts.length));
  return indexed(texels);
}

/**
 * The same rasterization, spread over worker threads. A wall of 200k triangles is a second of one
 * core per mesh and there is nothing to share between meshes, so this is close to linear.
 * Node only: no `worker_threads`, one mesh, or `jobs: 1` all fall through to {@link rasterize}.
 */
export async function rasterizeParallel(meshes: BakeMesh[], atlas: Atlas, opts: RasterOptions = {}): Promise<Texels> {
  const jobs = Math.min(opts.jobs || (await cores()), meshes.length);
  if (jobs < 2 || typeof SharedArrayBuffer !== "function") return rasterize(meshes, atlas, opts.onProgress);
  try {
    return await inWorkers(raster(meshes, atlas), atlas, jobs, opts.onProgress);
  } catch (e) {
    // a worker that cannot even start (no worker_threads, a bundler that lost this module's url)
    // must not cost the bake — the single-threaded path is the same code
    console.warn(`tscene/bakery: parallel rasterize failed (${(e as Error).message}) — falling back to one thread`);
    return rasterize(meshes, atlas, opts.onProgress);
  }
}

async function cores(): Promise<number> {
  const hardware = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency;
  if (hardware) return Math.max(1, hardware - 1);
  const os = await import("node:os").catch(() => undefined);
  return Math.max(1, (os?.cpus().length ?? 2) - 1);
}

/**
 * The workers write straight into one shared set of buffers: two charts never share a texel, so the
 * writes are disjoint and no lock is needed.
 * ponytail: except the sub-texel triangle fallback, which claims the nearest free texel and can race
 * two meshes onto one. Worst case one texel of one triangle shades from the wrong surface — and it is
 * a texel nothing samples. Partition by chart row if that ever matters.
 */
async function inWorkers(
  parts: RasterMesh[],
  atlas: Atlas,
  jobs: number,
  onProgress?: (fraction: number) => void,
): Promise<Texels> {
  const { Worker } = await import("node:worker_threads");
  const texels = allocate(atlas.width, atlas.height, true);
  const bins = balance(parts, jobs);
  let done = 0;

  await Promise.all(
    bins.map(
      (bin) =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(WORKER, {
            eval: true,
            workerData: { module: import.meta.url, texels, parts: bin },
          });
          worker.on("message", () => onProgress?.(++done / parts.length));
          worker.on("error", reject);
          worker.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`rasterize worker exited with ${code}`))));
        }),
    ),
  );
  return indexed(texels);
}

// CommonJS on purpose: `eval: true` workers are not modules, so this is `require` plus a dynamic
// import of this very file — which keeps the rasterizer in one place instead of a second copy here.
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.module).then((m) => {
  m.rasterizeInto(workerData.texels, workerData.parts, () => parentPort.postMessage(1));
}, (e) => { throw e });
`;

/** Meshes into `jobs` bins of roughly equal triangle count — one huge mesh must not stall a thread. */
function balance(parts: RasterMesh[], jobs: number): RasterMesh[][] {
  const bins: RasterMesh[][] = Array.from({ length: jobs }, () => []);
  const load = new Float64Array(jobs);
  for (const part of [...parts].sort((a, b) => b.faceMaterial.length - a.faceMaterial.length)) {
    let at = 0;
    for (let i = 1; i < jobs; i++) if (load[i]! < load[at]!) at = i;
    bins[at]!.push(part);
    load[at] += part.faceMaterial.length;
  }
  return bins.filter((b) => b.length);
}

function allocate(width: number, height: number, shared: boolean): Texels {
  const n = width * height;
  const buffer = (bytes: number) => (shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
  return {
    width,
    height,
    mask: new Uint8Array(buffer(n)),
    position: new Float32Array(buffer(n * 16)),
    normal: new Float32Array(buffer(n * 16)),
    uv: new Float32Array(buffer(n * 8)),
    mesh: new Int32Array(buffer(n * 4)).fill(-1),
    index: new Uint32Array(0),
  };
}

function indexed(texels: Texels): Texels {
  const { mask } = texels;
  let covered = 0;
  for (let i = 0; i < mask.length; i++) covered += mask[i]!;
  const index = new Uint32Array(covered);
  for (let i = 0, n = 0; i < mask.length; i++) if (mask[i]) index[n++] = i;
  return { ...texels, index };
}

/**
 * The rasterizer proper: `parts` into already-allocated buffers. Exported because a worker thread
 * imports exactly this.
 */
export function rasterizeInto(texels: Texels, parts: RasterMesh[], onMesh?: () => void): void {
  const { width, height, mask, position, normal, uv: uv0, mesh: owner } = texels;

  for (const part of parts) {
    const uv = part.atlasUV;
    const triCount = part.faceMaterial.length;

    for (let t = 0; t < triCount; t++) {
      const i0 = t * 3;
      const ax = uv[i0 * 2]! * width;
      const ay = uv[i0 * 2 + 1]! * height;
      const bx = uv[(i0 + 1) * 2]! * width;
      const by = uv[(i0 + 1) * 2 + 1]! * height;
      const cx = uv[(i0 + 2) * 2]! * width;
      const cy = uv[(i0 + 2) * 2 + 1]! * height;

      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (area === 0) continue; // degenerate in uv space: nothing to shade
      const inv = 1 / area;

      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx) + 0.5));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy) + 0.5));

      let hit = false;
      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) * inv;
          const w2 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * inv;
          const w0 = 1 - w1 - w2;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          write(part, t, w0, w1, w2, y * width + x, mask, position, normal, uv0, owner);
          hit = true;
        }
      }

      // a triangle smaller than a texel covers no center; without this it would bake black
      if (!hit) {
        const x = Math.min(width - 1, Math.max(0, Math.floor((ax + bx + cx) / 3)));
        const y = Math.min(height - 1, Math.max(0, Math.floor((ay + by + cy) / 3)));
        const at = y * width + x;
        if (!mask[at]) write(part, t, 1 / 3, 1 / 3, 1 / 3, at, mask, position, normal, uv0, owner);
      }
    }
    onMesh?.();
  }
}

function write(
  mesh: RasterMesh,
  tri: number,
  w0: number,
  w1: number,
  w2: number,
  at: number,
  mask: Uint8Array,
  position: Float32Array,
  normal: Float32Array,
  uv0: Float32Array,
  owner: Int32Array,
): void {
  const o = tri * 9;
  const d = at * 4;
  for (let k = 0; k < 3; k++) {
    position[d + k] = mesh.positions[o + k]! * w0 + mesh.positions[o + 3 + k]! * w1 + mesh.positions[o + 6 + k]! * w2;
    normal[d + k] = mesh.normals[o + k]! * w0 + mesh.normals[o + 3 + k]! * w1 + mesh.normals[o + 6 + k]! * w2;
  }
  const len = Math.hypot(normal[d]!, normal[d + 1]!, normal[d + 2]!) || 1;
  normal[d] /= len;
  normal[d + 1] /= len;
  normal[d + 2] /= len;
  normal[d + 3] = mesh.faceMaterial[tri]!;
  if (mesh.uv) {
    const u = tri * 6;
    for (let k = 0; k < 2; k++) {
      uv0[at * 2 + k] = mesh.uv[u + k]! * w0 + mesh.uv[u + 2 + k]! * w1 + mesh.uv[u + 4 + k]! * w2;
    }
  }
  owner[at] = mesh.index;
  mask[at] = 1;
}
