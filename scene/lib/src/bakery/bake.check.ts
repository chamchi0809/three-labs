// node --experimental-strip-types src/bake.check.ts
//
// Needs a GPU, and says so by skipping rather than failing when there is none — CI runs on machines
// with no driver, and everything below measures a shader.
//
// Radiometry, against closed forms. Every configuration here has an irradiance you can write down,
// so a shader that is merely plausible still fails:
//
//   1. unshadowed directional light, normal on           E = color * intensity
//   2. the same light behind an occluder                  E = 0
//   3. a uniform sky of radiance L                        E = PI * L
//   4. a square emitter of radiance L overhead            E = PI * L * F   (parallel-square view factor)
//   5. a perfectly red floor under that sky               E.r = PI exactly, E.g = PI * (1 - F)
//
// (5) is the colour-bleeding check and it is the sharpest one: with albedo 1 the red channel is a
// furnace, so any energy the bounce loses or invents shows up as a deviation from PI.
//
// The probes are just positions and normals handed to trace() — they are not in the BVH, so they
// measure without occluding. Then one real bake at the end, to catch the wiring between the stages.
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { albedoAtlas, bake, reuseAtlas, subset } from "./bake.ts";
import { createHeadlessRenderer, hasWebGPU } from "./headless.ts";
import { rasterize, type Texels } from "./raster.ts";
import { collectScene } from "./scene.ts";
import { trace } from "./tracer.ts";

/** View factor from a differential element to a parallel square of side 2a, centred h above it. */
function squareViewFactor(a: number, h: number): number {
  const x = a / h;
  const s = x / Math.sqrt(1 + x * x);
  return (4 / Math.PI) * s * Math.atan(s);
}

type Probe = { p: [number, number, number]; n: [number, number, number] };

/**
 * Probes as a `Texels`: only `index`, `position` and `normal` are read. `atlas` overrides the width
 * and height, which the shader uses for nothing but indexing an albedo atlas.
 */
function probes(list: Probe[], atlas?: { width: number; height: number }): Texels {
  const position = new Float32Array(list.length * 4);
  const normal = new Float32Array(list.length * 4);
  list.forEach((probe, i) => {
    position.set(probe.p, i * 4);
    normal.set(probe.n, i * 4);
  });
  return {
    width: atlas?.width ?? list.length,
    height: atlas?.height ?? 1,
    mask: new Uint8Array(list.length).fill(1),
    position,
    normal,
    uv: new Float32Array(list.length * 2),
    mesh: new Int32Array(list.length).fill(-1),
    index: Uint32Array.from(list, (_, i) => i),
  };
}

/** A `size` x `size` plane in the XZ plane at height `y`. `up` picks which way it faces. */
function plane(y: number, size: number, up: boolean, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  mesh.rotation.x = up ? -Math.PI / 2 : Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}

const black = () => new THREE.MeshStandardMaterial({ color: 0x000000, metalness: 0 });

if (!(await hasWebGPU())) {
  console.log("bake.check.ts skipped — no WebGPU adapter on this machine");
  process.exit(0);
}

const renderer = await createHeadlessRenderer();

/** Irradiance per probe, as [r, g, b] triples. */
async function measure(root: THREE.Object3D, list: Probe[], samples: number, bounces: number, indirect = 1) {
  const raw = await trace(renderer, collectScene(root), probes(list), { samples, bounces, batch: 256, indirect });
  return list.map((_, i) => {
    const n = raw[i * 4 + 3];
    assert.equal(n, samples, "every probe must accumulate exactly the requested sample count");
    return [raw[i * 4] / n, raw[i * 4 + 1] / n, raw[i * 4 + 2] / n] as [number, number, number];
  });
}

const close = (got: number, want: number, tol: number, what: string) =>
  assert.ok(
    Number.isFinite(got) && Math.abs(got - want) <= tol,
    `${what}: expected ${want.toFixed(6)} +/- ${tol.toFixed(6)}, got ${got}`,
  );

// --- 1 + 2: a delta light, with and without something in the way ----------------------------------
{
  const root = new THREE.Group();
  root.add(plane(2, 4, true, black())); // occluder over the origin, spanning x,z in [-2,2]
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(0, 10, 0);
  root.add(sun);

  const [lit, shadowed] = await measure(
    root,
    [
      { p: [10, 0, 0], n: [0, 1, 0] }, // clear of the occluder
      { p: [0, 0, 0], n: [0, 1, 0] }, // directly under it
    ],
    64,
    2,
  );

  close(lit[0], 1, 1e-5, "unshadowed directional irradiance");
  close(lit[1], 1, 1e-5, "unshadowed directional irradiance (g)");
  close(shadowed[0], 0, 1e-6, "occluded directional irradiance");

  // a 45-degree surface takes cos(45) of it, and nothing about the falloff should change that
  const [tilted] = await measure(root, [{ p: [10, 0, 0], n: [Math.SQRT1_2, Math.SQRT1_2, 0] }], 64, 0);
  close(tilted[0], Math.SQRT1_2, 1e-5, "cosine term");
}

// --- 3 + 5: a uniform sky, and one bounce off a perfectly red floor -------------------------------
{
  const root = new THREE.Group();
  root.add(plane(0, 4, true, new THREE.MeshStandardMaterial({ color: 0xff0000, metalness: 0 })));
  root.add(new THREE.AmbientLight(0xffffff, Math.PI)); // == a sky of radiance 1

  const F = squareViewFactor(2, 1);
  const samples = 1 << 15;
  const [open, facingFloor] = await measure(
    root,
    [
      { p: [0, 1, 0], n: [0, 1, 0] }, // nothing above it: pure sky
      { p: [0, 1, 0], n: [0, -1, 0] }, // looking down at the red floor
    ],
    samples,
    1,
  );

  close(open[0], Math.PI, 1e-4, "unoccluded sky irradiance");
  close(open[2], Math.PI, 1e-4, "unoccluded sky irradiance (b)");

  // albedo 1 in red: whatever the floor takes from the sky it gives back, so the total is still PI
  close(facingFloor[0], Math.PI, Math.PI * 0.02, "red-channel furnace");
  // green and blue only see the fraction of the hemisphere the floor does not cover
  close(facingFloor[1], Math.PI * (1 - F), Math.PI * 0.02, "colour bleeding (green)");
  close(facingFloor[2], Math.PI * (1 - F), Math.PI * 0.02, "colour bleeding (blue)");
  assert.ok(facingFloor[0] > facingFloor[1] * 2, "the bounce must actually be red");

  // the indirect gain scales exactly the bounce and nothing else: E.r = PI * (1 - F) + gain * PI * F
  for (const gain of [0, 0.5]) {
    const [dimmed] = await measure(root, [{ p: [0, 1, 0], n: [0, -1, 0] }], samples, 1, gain);
    close(dimmed[0], Math.PI * (1 - F + gain * F), Math.PI * 0.02, `indirect ${gain} (red)`);
    close(dimmed[1], Math.PI * (1 - F), Math.PI * 0.02, `indirect ${gain} must not touch direct sky (green)`);
  }
}

// --- 4: an emissive square overhead --------------------------------------------------------------
{
  const root = new THREE.Group();
  const emitter = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 1 });
  root.add(plane(1, 4, false, emitter));

  const F = squareViewFactor(2, 1);
  // bounces 0: next-event estimation only, which is exactly the quantity the view factor predicts
  const [under] = await measure(root, [{ p: [0, 0, 0], n: [0, 1, 0] }], 1 << 15, 0);
  close(under[0], Math.PI * F, Math.PI * F * 0.04, "emissive area-light irradiance");
  close(under[1], Math.PI * F, Math.PI * F * 0.04, "emissive area-light irradiance (g)");

  // facing away from it there is nothing at all to receive
  const [away] = await measure(root, [{ p: [0, 0, 0], n: [0, -1, 0] }], 256, 0);
  close(away[0], 0, 1e-6, "back-facing probe");
}

// --- the whole pipeline, once, on a scene with an actual unwrap -----------------------------------
{
  const root = new THREE.Group();
  const floor = plane(0, 4, true, new THREE.MeshStandardMaterial({ color: 0xff0000, metalness: 0 }));
  floor.name = "floor";
  root.add(floor);
  const lamp = plane(4, 2, false, new THREE.MeshStandardMaterial({ emissive: 0xffffff, emissiveIntensity: 4 }));
  lamp.name = "lamp";
  root.add(lamp);

  const stages: string[] = [];
  const result = await bake(root, {
    renderer,
    size: 64,
    samples: 64,
    bounces: 2,
    batch: 32,
    dilateRadius: 2,
    onProgress: (stage) => {
      if (stages.at(-1) !== stage) stages.push(stage);
    },
  });

  assert.deepEqual(stages, ["unwrap", "rasterize", "trace", "filter"]);
  // xatlas scales the charts from `size` and then packs, so the atlas lands near it, not on it
  assert.ok(result.width >= 32 && result.width < 256, `atlas ${result.width}x${result.height}`);
  assert.equal(result.image.length, result.width * result.height * 4);
  assert.equal(result.manifest.width, result.width);
  assert.ok(result.utilization > 0.05, `the charts should fill the atlas, got ${result.utilization}`);
  assert.ok(result.exposure > 0 && Number.isFinite(result.exposure), `exposure ${result.exposure}`);
  assert.ok(result.image.every(Number.isFinite), "a NaN anywhere in the atlas poisons the whole texture");

  let covered = 0;
  let lit = 0;
  for (let i = 0; i < result.width * result.height; i++) {
    if (result.image[i * 4 + 3] <= 0) continue;
    covered++;
    if (result.image[i * 4] > 1e-3) lit++;
  }
  assert.ok(covered > 64, `expected a decent covered area, got ${covered} texels`);
  assert.ok(lit > 64, `the lamp should light the floor, got ${lit} lit texels`);

  assert.deepEqual(
    result.manifest.meshes.map((m) => [m.key, m.vertices]),
    [
      ["floor", 6],
      ["lamp", 6],
    ],
    "the manifest keys the runtime by node path and pins the de-indexed vertex count",
  );
  assert.equal(result.manifest.intensity, result.exposure);
}

// --- the bounce reads the albedo map under the point it hit, not the whole texture's mean ----------
{
  // 2x2, red column then green column: only u decides the colour, so world x does
  const map = new THREE.DataTexture(
    new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255]),
    2,
    2,
  );
  map.colorSpace = THREE.SRGBColorSpace;
  map.needsUpdate = true;

  const root = new THREE.Group();
  root.add(plane(0, 4, true, new THREE.MeshStandardMaterial({ map, metalness: 0 })));
  root.add(new THREE.AmbientLight(0xffffff, Math.PI)); // a sky of radiance 1

  const scene = collectScene(root);
  // the atlas is the plane itself: uv = (x + 2) / 4, (z + 2) / 4
  const uv = new Float32Array(12);
  const p = scene.meshes[0]!.positions;
  for (let i = 0; i < 6; i++) {
    uv[i * 2] = (p[i * 3]! + 2) / 4;
    uv[i * 2 + 1] = (p[i * 3 + 2]! + 2) / 4;
  }
  const atlas = { width: 64, height: 64, uv: [uv], utilization: 1 };
  const albedo = albedoAtlas(scene, rasterize(scene.meshes, atlas));
  assert.ok(albedo, "a material with a decodable map has to produce an albedo atlas");

  const list: Probe[] = [
    { p: [-1.5, 0.35, 0], n: [0, -1, 0] }, // over the red half
    { p: [1.5, 0.35, 0], n: [0, -1, 0] }, // over the green half
  ];
  const run = async (perTexel: boolean) => {
    const raw = await trace(renderer, scene, probes(list, atlas), {
      samples: 1 << 14,
      bounces: 1,
      batch: 256,
      lightmapUV: atlas.uv,
      albedo: perTexel ? albedo : undefined,
    });
    return list.map((_, i) => [0, 1, 2].map((k) => raw[i * 4 + k]! / raw[i * 4 + 3]!) as [number, number, number]);
  };

  const [left, right] = await run(true);
  assert.ok(left![0]! > left![1]! * 1.5, `over the red half the bounce must be red, got ${left}`);
  assert.ok(right![1]! > right![0]! * 1.5, `over the green half it must be green, got ${right}`);
  close(left![0]!, right![1]!, right![1]! * 0.1, "the two halves are mirror images of each other");
  close(left![2]!, right![2]!, 1e-3, "neither half has any blue to give back");

  // without the atlas every bounce takes the map's mean instead, and the two probes agree
  const [meanLeft, meanRight] = await run(false);
  close(meanLeft![0]!, meanLeft![1]!, meanLeft![0]! * 0.05, "the mean of a red/green map is grey");
  close(meanLeft![0]!, meanRight![0]!, meanLeft![0]! * 0.05, "and it is the same everywhere");
  assert.ok(left![0]! > meanLeft![0]! * 1.3, "which is exactly what the per-texel lookup is an improvement on");
}

// --- a partial rebake keeps every texel it was not asked to touch ------------------------------------
{
  const root = new THREE.Group();
  const floor = plane(0, 4, true, new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0 }));
  floor.name = "floor";
  root.add(floor);
  const lampMaterial = new THREE.MeshStandardMaterial({ emissive: 0xffffff, emissiveIntensity: 2 });
  const lamp = plane(4, 2, false, lampMaterial);
  lamp.name = "lamp";
  root.add(lamp);

  // the filters would smear the patch into its neighbours, and this is about which texels are written
  const opts = { renderer, size: 48, samples: 32, bounces: 1, batch: 32, denoiseRadius: 0, dilateRadius: 0 };
  const first = await bake(root, opts);

  lampMaterial.emissiveIntensity = 4;
  const second = await bake(root, { ...opts, previous: { manifest: { ...first.manifest, texture: "" }, image: first.image }, only: ["floor"] });

  assert.equal(second.width, first.width, "a rebake reuses the layout instead of unwrapping again");
  const scene = collectScene(root);
  const texels = rasterize(scene.meshes, reuseAtlas({ ...first.manifest, texture: "" }, scene));
  const mean = (at: Uint32Array, image: Float32Array) =>
    [...at].reduce((sum, i) => sum + image[i * 4]!, 0) / Math.max(1, at.length);

  const lampTexels = subset(texels, scene, ["lamp"]);
  for (const i of lampTexels) {
    assert.equal(second.image[i * 4], first.image[i * 4], `texel ${i} was not asked to change`);
  }
  const before = mean(subset(texels, scene, ["floor"]), first.image);
  const after = mean(subset(texels, scene, ["floor"]), second.image);
  close(after, before * 2, before * 0.3, "twice the lamp is twice the irradiance on the retraced floor");
}

console.log("bake.check.ts ok");
// the requestAnimationFrame shim keeps a timer alive, so nothing else will end the process
process.exit(0);
