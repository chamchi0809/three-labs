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
// The measurement points are just positions and normals handed to trace() — they are not in the BVH,
// so they measure without occluding. Then a reflection probe, whose texels are radiance rather than
// irradiance, and one real bake at the end to catch the wiring between the stages.
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { albedoAtlas, bake, reuseAtlas, subset } from "./bake.ts";
import { createHeadlessRenderer, hasWebGPU } from "./headless.ts";
import { rasterize, type Texels } from "./raster.ts";
import { collectScene } from "./scene.ts";
import { trace, traceProbes } from "./tracer.ts";

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

/**
 * Irradiance per probe, as [r, g, b] triples. The divisor is the requested sample count — `.w` of the
 * accumulator is openness, not a running count, so nothing on the GPU has to be read back to know it.
 */
async function measure(root: THREE.Object3D, list: Probe[], samples: number, bounces: number, indirect = 1) {
  const raw = await trace(renderer, collectScene(root), probes(list), { samples, bounces, batch: 256, indirect });
  return list.map((_, i) => {
    const open = raw[i * 4 + 3] / samples;
    assert.ok(open >= 0 && open <= 1 + 1e-6, `openness must be a fraction of the samples, got ${open}`);
    return [raw[i * 4] / samples, raw[i * 4 + 1] / samples, raw[i * 4 + 2] / samples] as [number, number, number];
  });
}

/** Cosine-weighted openness per probe — exactly what the occlusion atlas holds. */
async function openness(root: THREE.Object3D, list: Probe[], samples: number, aoDistance: number) {
  const raw = await trace(renderer, collectScene(root), probes(list), { samples, bounces: 0, batch: 256, aoDistance });
  return list.map((_, i) => raw[i * 4 + 3] / samples);
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

// --- a see-through occluder attenuates the shadow ray instead of stopping it -----------------------
//
// Direct light through a delta light is analytic, so the expected transmittance is a product of
// coverages and nothing here is noisy. The last probe is the documented ceiling: the layered walk
// gives up after SHADOW_LAYERS surfaces and calls itself blocked.
{
  const root = new THREE.Group();
  const glass = () => new THREE.MeshStandardMaterial({ color: 0x000000, transparent: true, opacity: 0.25 });
  root.add(plane(1, 4, true, glass()), plane(2, 4, true, glass()));
  // glTF glass: `transmission` alone, no opacity and not transparent
  const pane = plane(1, 4, true, new THREE.MeshPhysicalMaterial({ color: 0x000000, transmission: 0.9 }));
  pane.position.x = 10;
  root.add(pane);
  for (let i = 1; i <= 5; i++) {
    const layer = plane(i, 4, true, glass());
    layer.position.x = -10;
    root.add(layer);
  }
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(0, 20, 0);
  root.add(sun);

  const [stacked, transmissive, clear, tooMany] = await measure(
    root,
    [
      { p: [0, 0, 0], n: [0, 1, 0] },
      { p: [10, 0, 0], n: [0, 1, 0] },
      { p: [20, 0, 0], n: [0, 1, 0] },
      { p: [-10, 0, 0], n: [0, 1, 0] },
    ],
    64,
    0,
  );
  close(stacked[0], 0.75 * 0.75, 1e-5, "two panes of coverage 0.25 each");
  close(transmissive[0], 0.9, 1e-5, "transmission 0.9 lets 0.9 of the ray through");
  close(clear[0], 1, 1e-5, "nothing in the way");
  close(tooMany[0], 0, 1e-6, "past SHADOW_LAYERS the ray reports blocked");
}

// --- ambient occlusion: the cosine-weighted fraction of the hemisphere nothing blocks -------------
//
// which is the view factor again, so the closed form is free: a square lid of half-side a at height h
// covers exactly F of the cosine-weighted hemisphere, and openness is 1 - F.
{
  const root = new THREE.Group();
  root.add(plane(2, 4, true, black()));
  const F = squareViewFactor(2, 2);
  const list: Probe[] = [
    { p: [0, 0, 0], n: [0, 1, 0] }, // under the lid
    { p: [10, 0, 0], n: [0, 1, 0] }, // clear of it
  ];

  const [under, clear] = await openness(root, list, 1 << 14, 10);
  close(under, 1 - F, 0.02, "occlusion under a square lid");
  // not exactly 1: from 8 units to the side the lid is still a sliver above the horizon, and 10 units
  // of search reach it
  close(clear, 1, 5e-3, "nothing overhead is as good as fully open");

  // the lid is 2 units up, so a 1-unit search must not find it — this is the knob a room-scale bake
  // turns down to stop distant walls darkening everything
  const [ranged] = await openness(root, list, 1 << 12, 1);
  close(ranged, 1, 1e-6, "a blocker past aoDistance does not occlude");
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

// --- 5: two emitters, four fifths of the picks going to one of them -------------------------------
// One emitter is its own control: with a single light in the scene every weighting agrees, and an
// area-proportional pick, a power-proportional one and a plain 1/n all bake the same picture. Put a
// small bright square under the probe and a large dim one well above it and they stop agreeing — the
// bright one takes 80% of the picks and the dim one has to be worth five times as much when it is
// finally drawn. Each probe sees exactly one of the two, so both closed forms are the single-emitter
// one, unchanged. The heights are chosen so that cosLight/distSq * (1/pdf) stays under the estimator's
// solid-angle ceiling everywhere on both squares — 80/3^2 and 1.25/1^2 against 4PI — because that
// clamp is a known bias and this check is about the pick, not about it.
{
  const root = new THREE.Group();
  const white = (intensity: number) =>
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: intensity });
  // 16 m^2 at radiance 1 above, 1 m^2 at radiance 64 below: 16 of the light against 64, a fifth of it
  root.add(plane(3, 4, false, white(1)));
  root.add(plane(-1, 1, true, white(64)));

  const samples = 1 << 16;
  const up = Math.PI * squareViewFactor(2, 3);
  const down = Math.PI * 64 * squareViewFactor(0.5, 1);
  const [over, under] = await measure(
    root,
    [
      { p: [0, 0, 0], n: [0, 1, 0] },
      { p: [0, 0, 0], n: [0, -1, 0] },
    ],
    samples,
    0,
  );
  // the rarely picked one: 1/pdf has to carry the five times back, or the dim half of a scene bakes dark
  close(over[0], up, up * 0.04, "the dim emitter survives being picked a fifth as often");
  // and the one taking the picks must not be paid the whole set's area for them
  close(under[0], down, down * 0.04, "the bright emitter is not overcounted for taking most of them");
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
  const settings = {
    renderer,
    size: 64,
    samples: 64,
    bounces: 2,
    batch: 32,
    dilateRadius: 2,
    ao: true,
    // the lamp is 4 units up, well past the 5% of the scene diagonal aoDistance defaults to
    aoDistance: 8,
    onProgress: (stage: string) => {
      if (stages.at(-1) !== stage) stages.push(stage);
    },
  };
  const result = await bake(root, settings);

  // every stage announces itself when it starts, and the next one is what marks it finished — a
  // stage missing from here is a stage whose seconds land in its neighbour's total
  assert.deepEqual(stages, ["collect", "unwrap", "rasterize", "prepare", "trace", "filter"]);
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

  // the occlusion atlas rides on the same texels, and the floor under a lamp is not fully open
  assert.ok(result.ao, "ao: true has to produce an atlas");
  assert.equal(result.ao!.length, result.image.length);
  assert.ok(
    [...result.ao!].every((v) => v >= 0 && v <= 1),
    "openness is a fraction, and the PNG writer clamps rather than scales",
  );
  const open = [...result.ao!].filter((_, i) => i % 4 === 0 && result.image[i + 3]! > 0);
  assert.ok(
    open.some((v) => v < 0.999) && open.some((v) => v > 0.5),
    "a floor with a lamp over it is neither fully open nor fully closed",
  );

  assert.deepEqual(
    result.manifest.meshes.map((m) => [m.key, m.vertices]),
    [
      ["floor", 6],
      ["lamp", 6],
    ],
    "the manifest keys the runtime by node path and pins the de-indexed vertex count",
  );
  assert.equal(result.manifest.intensity, result.exposure);

  // `@bakery { exposure }` is how a scene whose percentile wanders gets the same quantization twice
  const fixed = await bake(root, { ...settings, exposure: 0.5 });
  assert.equal(fixed.exposure, 0.5, "a given exposure wins over the percentile");
  assert.equal(fixed.manifest.intensity, 0.5, "and the runtime undoes exactly that");
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

// --- a reflection probe: radiance per direction, mapped the way the runtime unmaps it --------------
//
// A probe texel is `L = emission + albedo/PI * E`, so an albedo-1 red floor under a sky of radiance 1
// reads exactly 1 in red — the furnace of (5), seen from the other side. Which texel is which is the
// part nothing else would catch: the mapping has to be the inverse of three's `equirectUV`, or every
// reflection in the scene comes out rotated. A blue emissive patch lying on the floor is the landmark,
// coplanar so it blocks none of the sky the rest of the floor is lit by.
{
  const root = new THREE.Group();
  root.add(plane(0, 200, true, new THREE.MeshStandardMaterial({ color: 0xff0000, metalness: 0 })));
  root.add(new THREE.AmbientLight(0xffffff, Math.PI)); // == a sky of radiance 1
  const patch = plane(0.01, 1.2, true, new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x0000ff, emissiveIntensity: 3 }));
  patch.position.x = 1.5;
  root.add(patch);

  const node = new THREE.Object3D();
  node.name = "probe";
  node.position.set(0, 1, 0);
  Object.assign(node, { bakery: { probe: 16 } });
  root.add(node);

  const [equirect] = await traceProbes(renderer, collectScene(root), { samples: 512, bounces: 0, batch: 128 });
  assert.ok(equirect, "the sheet placed a probe, so the bake captured one");
  assert.deepEqual([equirect.width, equirect.height], [16, 8], "an equirect is twice as wide as it is tall");
  const texel = (x: number, y: number) => [0, 1, 2].map((k) => equirect.image[(y * 16 + x) * 4 + k]!);

  close(texel(4, 7)[0]!, 1, 1e-6, "the last row looks up, at nothing but sky");
  close(texel(4, 7)[2]!, 1, 1e-6, "the last row looks up, at nothing but sky (b)");
  close(texel(4, 0)[0]!, 1, 0.02, "row 0 looks down, at a floor that gives back all the red it gets");
  close(texel(4, 0)[1]!, 0, 0.02, "and gives back none of the green");

  // +x is u = 0.5, so the emissive patch 1.5 units along +x is straight ahead in the middle column
  const [aheadR, , aheadB] = texel(8, 2);
  close(aheadB!, 3, 0.02, "the middle column of row 2 looks at the patch, which emits 3");
  close(aheadR!, 0, 0.02, "and the patch is black in red, so nothing but its emission is there");
  const behind = texel(0, 2);
  close(behind[2]!, 0, 0.02, "the opposite column looks at bare floor: no blue anywhere in it");
  close(behind[0]!, 1, 0.02, "which is the same red as straight down");
}

// --- which row of an equirect three reads as "down" ----------------------------------------------------
// The probe writer's whole convention rests on this: a DataTextureLoader (EXR, RGBE) hands back
// `flipY: false`, and three then samples row 0 of the data at v = 0, which `equirectUV` reads as
// straight down. Get it backwards and the metals reflect the floor as sky, which no in-memory check of
// the probe itself can see.
{
  const [w, h] = [16, 8];
  const data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    // row 0 red, last row green — the halves of the image, not of the sphere
    data[i * 4 + (Math.floor(i / w) < h / 2 ? 0 : 1)] = 1;
    data[i * 4 + 3] = 1;
  }
  const map = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  map.flipY = false;
  map.mapping = THREE.EquirectangularReflectionMapping;
  map.minFilter = map.magFilter = THREE.NearestFilter;
  map.generateMipmaps = false;
  map.needsUpdate = true;

  const sky = new THREE.Scene();
  sky.background = map;
  const eye = new THREE.PerspectiveCamera(20, 1, 0.1, 10);
  eye.up.set(0, 0, 1);
  const target = new THREE.RenderTarget(8, 8, { type: THREE.FloatType });
  renderer.setRenderTarget(target);
  const look = async (at: [number, number, number]) => {
    eye.position.set(0, 0, 0);
    eye.lookAt(...at);
    eye.updateMatrixWorld(true);
    renderer.render(sky, eye);
    const px = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, 8, 8)) as unknown as Float32Array;
    let red = 0;
    let green = 0;
    for (let i = 0; i < 64; i++) (red += px[i * 4]!), (green += px[i * 4 + 1]!);
    return { red: red / 64, green: green / 64 };
  };
  const down = await look([0, -1, 0]);
  const up = await look([0, 1, 0]);
  renderer.setRenderTarget(null);
  target.dispose();
  map.dispose();

  assert.ok(down.red > down.green, "looking down reads row 0 of the data — which is where the bake puts v = 0");
  assert.ok(up.green > up.red, "and looking up reads the last row");
}

console.log("bake.check.ts ok");
// the requestAnimationFrame shim keeps a timer alive, so nothing else will end the process
process.exit(0);
