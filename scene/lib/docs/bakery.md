# tscene/bakery

Path-traced lightmaps for [`tscene`](../README.md) / three.js scenes, baked on a **headless WebGPU device in
Node**. No browser, no window, no display server — `webgpu` (Dawn) supplies the adapter, three's
`WebGPURenderer` runs the compute pass, and [`three-mesh-bvh`](https://github.com/gkjohnson/three-mesh-bvh)'s
WebGPU API owns the acceleration structure.

```sh
pnpm bake:bakery   # bakes scene/bakery-demo/scenes/room.tscene
pnpm dev:bakery    # the demo, press G to A/B baked GI against realtime direct light
```

<!-- the atlas the demo ships with: charts for the room, the two blocks and the ceiling panel -->
![the baked atlas](../../bakery-demo/public/lightmaps/room.png)

## What it does

- **GPU path tracing.** One compute dispatch per batch of paths, one thread per lightmap texel. A
  1024-sample bake of the demo room takes a few seconds.
- **Full global illumination.** Diffuse interreflection to any bounce depth, so colour bleeding is not a
  trick — the red and green walls tint the floor because photons actually went that way.
- **Emissive meshes are area lights.** Any material with a non-black `emissive` becomes a sampled emitter,
  picked in proportion to triangle area — and with an `emissiveMap`, each triangle carries the radiance of
  the texels it covers, so a strip light on a texture emits only where the texture is bright. A
  `RectAreaLight` joins the same estimator as two triangles.
- **three's own light math, verbatim.** `DirectionalLight`, `PointLight` and `SpotLight` reproduce
  `getDistanceAttenuation`, the distance window and the spot penumbra exactly, so a bake matches what the
  realtime renderer was already showing. `AmbientLight` and `HemisphereLight` collapse into a sky gradient.
- **Soft shadows.** `@bakery { radius }` on a light turns it into a sphere (or, for a directional light,
  an angular cone) and gives a real penumbra.
- **Transmissive shadows.** A shadow ray through a transparent material is attenuated by its coverage
  (`opacity`, `transmission`, the mean alpha of an `alphaMap` or cutout `map`) instead of being stopped, so
  glass and foliage cast the shadow they should.
- **Ambient occlusion in the same trace.** `@bakery { ao }` rides the first bounce ray, so a second atlas
  costs no extra dispatch.
- **Reflection probes for the metals.** A metal has no diffuse lobe for an atlas to light, so
  `@bakery { probe: 256 }` on a node bakes what a point in the scene sees in every direction, and
  `applyLightmap` puts the nearest one on each metallic material's `envMap`.
- **Settings live in the sheet.** `@bakery { … }` holds the bake's own knobs and picks which nodes are in
  it, so baking a scene is `tscene-bake scenes/room.tscene` and nothing else.
- **Irradiance, not colour.** The atlas holds `E`, which is exactly what three's `lightMap` slot wants,
  so applying a bake is a texture assignment — no custom material, no patched shader.

## Using it

Two entry points. `tscene/bakery` is browser safe and does nothing but apply a bake;
`tscene/bakery/node` is the baker and pulls in Dawn, sharp and xatlas.

```ts
// bake, in Node
import { bakeSceneFile } from "tscene/bakery/node";

// with no options at all, the sheet's own `@bakery { … }` block decides everything
const { files } = await bakeSceneFile("scenes/room.tscene", { size: 512, samples: 1024 });
```

```ts
// apply, in the browser
import { applyLightmap } from "tscene/bakery";

const lightmap = await applyLightmap(scene, "lightmaps/room.lightmap.json");
```

Applying a bake also zeroes the lights it already contains — leaving them on counts every direct
contribution twice. The handle owns that trade, so a baked/realtime A/B is one assignment:

| | |
|---|---|
| `lightmap.enabled = false` | atlas off, and every muted light back at the intensity the sheet declared |
| `lightmap.intensity = 4` | gain on the exposure the manifest carries, so 1 is "as baked" |
| `lightmap.lights` | `Map<Light, number>`: the bake's lights → the intensity each had. Scale a realtime pass through this rather than snapshotting your own |
| `lightmap.meshes` `.width` `.height` | what the atlas reached, and how big it is |
| `lightmap.ao` | the occlusion atlas, when the bake wrote one; already on the materials' `aoMap` |
| `lightmap.environment = 0` | gain on the reflection probes, independent of `enabled`. `lightmap.probes` is the textures |
| `lightmap.dispose()` | atlas off the materials, lights back, texture disposed |

A sheet that names its own bake applies it on load, so a scene arrives lit and there is nothing to wire up:

```scene
@bakery { lightmap: "/lightmaps/room.lightmap.json" }
```

`loadScene` resolves the url against the sheet (against the document, for a sheet the vite plugin bundled)
and leaves the handle on `root.userData.lightmap`. `loadScene(…, { lightmap: false })` ignores it — which is
what the baker itself passes, since applying an atlas mid-bake would zero the lights about to be traced.
The manifest's sibling `.png`/`.exr` cannot be bundled from inside the JSON, so keep all three in `public/`.

`bakeSceneFile` is `loadSceneFile` + `bake` + `writeBake`, and makes a headless renderer when it is not
handed one. Reach for the pieces when the scene is not a sheet on disk — `bake()` takes any
`THREE.Object3D` — or when one renderer bakes several scenes:

```ts
import { bake, createHeadlessRenderer, loadSceneFile, writeBake } from "tscene/bakery/node";

const renderer = await createHeadlessRenderer();
const result = await bake(await loadSceneFile("scenes/room.tscene"), { renderer, size: 512, samples: 1024 });
await writeBake(result, "public/lightmaps", "room");
```

`loadLightmap(url)` is the other half of `applyLightmap`: it returns `{ manifest, texture }`, which is
also what `applyLightmap` accepts in place of a url when two roots share one atlas.

### `@bakery` in the sheet

A scene's bake settings belong with the scene, not in the command that bakes it. `@bakery { … }` is
valid in three places: the sheet itself, a node, and a material.

```scene
/* the sheet's own block: every option of bakeSceneFile(), plus who is in the bake */
@bakery {
  out: "../public/lightmaps";
  size: 512;
  samples: 1024;
}

mesh #floor {
  geometry: planeGeometry(4, 4);
  material: meshStandardMaterial {
    /* the tracer guesses reflectance from map/color; this overrides the guess */
    @bakery { albedo: [0.5, 0.5, 0.5] };
  };
}

/* soft shadows: a sphere light of world radius 0.35 (a directional light reads radians) */
pointLight #lamp(#fff2d8, 6) {
  @bakery { radius: 0.35 };
}

/* out of the bake entirely — as an occluder and as a receiver, this node and its children */
group #props {
  @bakery { enabled: false };
}

/* casts and bounces light, but gets no atlas texels of its own */
mesh #railing {
  @bakery { enabled: occluder };
}

/* twice the atlas density this mesh would otherwise get */
mesh #detail {
  @bakery { density: 2 };
}

/* a reflection probe: 256x128 of radiance, captured at this node's world position */
object3D #probe {
  position: vec3(0, 1.2, 0);
  @bakery { probe: 256 };
}
```

`out` is relative to the sheet; the CLI's `--out` is relative to where it runs. Everything passed to
`bakeSceneFile` (or a CLI flag) wins over the sheet, and the sheet wins over the stage defaults.

Which meshes get baked is `include`, and `enabled` is the per-node say in it:

| | |
| --- | --- |
| `@bakery { include: all }` | the default: every visible mesh but the ones that turn themselves off |
| `@bakery { include: none }` | only the meshes that opt in with `@bakery { enabled: true }` |
| `@bakery { enabled: … }` on a node | applies to its whole subtree; the nearest one wins, so a child can opt back in |
| `@bakery { enabled: occluder }` | in the trace as geometry, out of the atlas: it shadows and bounces light but carries no texels. What a floor a camera never sees, or a mesh whose own shading stays realtime, wants |

`include` selects meshes, never lights: a light is an input to the bake, so it stays in whatever the mode.
`enabled: false` on a light means "stays live at runtime" instead — `applyLightmap` leaves it alone and it
is not in `lightmap.lights`.

`@bakery { density }` on a node scales the atlas density its subtree is unwrapped at — 2 for the mesh a
camera stands next to, 0.5 for a wall nobody reads. `texelsPerUnit` (or the automatic fit) sets the base.

A mesh the bake cannot represent — skinned, instanced, batched — warns and is skipped rather than baked
from a pose or a transform it will not be drawn with: a lightmap is one `uv1` per vertex of one geometry,
which none of the three has. `@bakery { enabled: false }` is how to say the omission is intended and take
the warning with it.

### Reflection probes

`@bakery { probe: <width> }` on any node — an `object3D` placed for the purpose is the usual one — bakes an
equirectangular map of the radiance leaving every direction around that node's world position, `width`
texels across and half that tall. The trace is the same estimator the atlas uses, started from the probe
instead of from a texel, so a probe agrees with the lightmap about the lighting and adds the one thing the
atlas leaves out: the emission of what it is looking at, because a reflection of a lamp has to show a lamp.

That is the specular half of a bake, and it exists because the diffuse half cannot cover a metal: three's
diffuse colour is `albedo * (1 - metalness)`, so a `metalness: 1` material renders the atlas as black no
matter how good the trace was. `applyLightmap` gives each mesh the probe whose position is nearest its
centre and puts it on that material's `envMap`, scaled by `metalness` — a dielectric's diffuse response to
the same light is already in the atlas, and an env map would add it twice. Place probes the way every other
baker's are placed: in the open space a viewer moves through, one per room or per visually distinct volume,
never inside geometry.

```scene
object3D #probe { position: vec3(0, 1.2, 0); @bakery { probe: 256 }; }
```

`lightmap.environment` is the gain on them at runtime, independent of `lightmap.enabled` — a metal reflects
whether or not the diffuse atlas is showing.

A node built by a loader is reached the same way anything else about it is, through `find()`:

```scene
gltf #level("/level.glb") {
  find("Glass") { @bakery { enabled: false }; }
}
```

### CLI

```sh
tscene-bake scenes/room.tscene            # settings come from the sheet's @bakery
tscene-bake scenes/room.tscene --size 512 --samples 1024 --exr
```

`--help` lists the rest (`--out`, `--name`, `--bounces`, `--indirect`, `--batch`, `--bias`, `--padding`,
`--texels-per-unit`, `--denoise`, `--dilate`, `--default-albedo`, `--include`, `--jobs`, `--only`). Unwrap,
rasterize and trace each print a percentage and a running estimate of what is left.

Three worth knowing:

| | |
| --- | --- |
| `--indirect <gain>` | the one knob that is not physical: a gain on everything gathered past the first bounce, so an interior that bakes flat can be pushed without touching the direct light. 1 is the truth |
| `--ao` `--ao-distance` | also write `<name>.ao.png` and put it on the materials' `aoMap`. The occlusion rides the first bounce ray, so it is free; `--ao-distance 0` picks 5% of the scene diagonal, which is a room-scale guess and the thing to set when the scene is not room-scale |
| `--bias <units>` | ray origin offset along the normal, against self-intersection. 0 picks 1e-4 of the scene diagonal; raise it if the atlas shows shadow acne, lower it if contact shadows detach |
| `--exposure <n>` | the divisor that packs the atlas into the 8-bit png, undone at runtime by `lightMapIntensity` — so it decides quantization, not brightness. Left alone it is the atlas' 95th percentile, which wanders a little between bakes of a noisy scene; fix it to get the same png twice |

`--jobs` is the rasterizer's worker count (one per core by default) — `--jobs 1` to rasterize on the main
thread. It only moves the rasterize stage; the trace is already on the GPU.

## Output

`writeBake` produces these next to each other:

| File | What |
| --- | --- |
| `<name>.png` | irradiance divided by an exposure — the atlas' 95th percentile, or `--exposure` — and sRGB encoded. `manifest.intensity` is the divisor, and `applyLightmap` puts it back as `lightMapIntensity` |
| `<name>.lightmap.json` | the manifest: version, atlas size, exposure, and base64 `uv1` per baked mesh, keyed by node path |
| `<name>.ao.png` | with `--ao`: cosine-weighted openness, 1 = unoccluded. `applyLightmap` puts it on `aoMap` |
| `<name>.exr` | with `--exr`: the same irradiance as 32-bit float, unclipped. Also what `--only` re-traces from |
| `<name>.probeN.exr` | one per `@bakery { probe }`, in sheet order: equirectangular radiance, always 32-bit float — a reflection of a lamp is the one thing an 8-bit range cannot hold |

The manifest carries only uvs, not geometry, because `BufferGeometry.toNonIndexed()` is deterministic —
`applyLightmap` re-derives the same vertex order and refuses the atlas if the counts disagree. It also
carries a `version`, and `applyLightmap` refuses a manifest from a different one instead of decoding a
layout it no longer speaks: the fix is always a re-bake.

## How it works

| Stage | File | |
| --- | --- | --- |
| collect | [`scene.ts`](../src/bakery/scene.ts) | scene → world-space triangle soup, materials, lights, sky, emissive triangle list |
| unwrap | [`atlas.ts`](../src/bakery/atlas.ts) | lightmap uvs from xatlas (wasm), one atlas for the whole scene |
| rasterize | [`raster.ts`](../src/bakery/raster.ts) | atlas texel → the world position and normal to shade, across `--jobs` worker threads writing into one `SharedArrayBuffer` |
| prepare | [`tracer.ts`](../src/bakery/tracer.ts) | the BVH, the record buffer and the albedo atlas — one `TraceContext` both GPU stages run off |
| trace | [`tracer.ts`](../src/bakery/tracer.ts) | the estimator, as WGSL, over three-mesh-bvh's `BVHComputeData` |
| probe | [`probe.ts`](../src/bakery/probe.ts) + `tracer.ts` | one equirect of radiance per placed probe, from the same estimator and the same context |
| filter | [`filter.ts`](../src/bakery/filter.ts) | edge-aware denoise, then dilation past the chart edges so bilinear taps never read black |
| pack | [`io.ts`](../src/bakery/io.ts) | PNG / EXR / manifest |

The CLI prints one line per stage, and a stage is timed from its own first report to the next one's —
so the lines add up to the bake time with nothing unattributed. They used to be timed from the *last*
progress report instead, which let xatlas' `generate()` run for half a minute inside a stage that had
already reported itself finished and printed `0s`.

The estimator is the part worth reading twice. It integrates **irradiance**, so bounces are
cosine-sampled and the π from the estimator cancels the 1/π from the Lambert BRDF — every bounce is just
a multiply by the hit surface's albedo. Direct lighting is next-event estimation only (analytic for delta
lights, area sampling for emissive triangles) and emission is never added on a bounce hit, so nothing is
counted twice and there is no MIS weight to get wrong.

**Every** bounce walks the same stratified Hammersley set, each from its own Cranley-Patterson rotation —
a padded replication — and that is what keeps the sample counts low. Only bounce 0 used to be stratified,
which is backwards for a scene lit by bounces: sponza's arcades see no sun at all, so every photon they
get arrived through two or more of the unstratified ones. Stratifying the rest costs nothing measurable
and takes the shadowed three quarters of sponza's atlas from 34.2% to 30.2% rms against a 8192-sample
reference, with the energy bias down from +1.24% to +0.24%.

Five things keep it fast, and each one is a constant factor rather than a heuristic:

- **Emitters are picked from an alias table**, built on the CPU with weight `area × luminance` — two
  loads whatever the emitter count, where a cumulative-area scan averaged half of them, and a dim square
  metre no longer gets the same share of the samples as a bright one.
- **Shadow rays are distance-bounded.** Seeding the intersection result with the distance to the light
  makes the traversal cull everything past it, which turns three-mesh-bvh's closest-hit query into an
  any-hit test: it stops at the first blocker instead of walking the scene behind it.
- **Paths end by Russian roulette** from the third bounce on, with probability `1 - q` and a `1/q` scale
  on the survivors, so a dark surface stops paying for the full bounce depth to add a percent. It waits
  two bounces and never rolls `q` below `0.25`, because the textbook policy — roll from the first bounce
  at `q = throughput` — is a bad trade on a real scene and measurably so; see the table below.
- **The last gather ray is skipped when the sky is black.** The ray leaving the last shading point has
  exactly two jobs: carry the occlusion test on the first bounce, and collect the sky when it escapes. A
  scene with no ambient, no hemisphere and no sky gradient owes it neither, and what it hits is never
  read — sponza's four bounces used to cast five gather rays for four bounces' worth of light.
- **The whole bake shares one `TraceContext`** — the BVH, the record buffer and the albedo atlas — and
  every probe in the scene runs in a single dispatch of a single compiled kernel, with its origin in the
  surface buffer beside the texel's direction.

### Why the roulette waits

Sponza's interior is lit by nothing but bounces, and stone at albedo ~0.5 makes the textbook policy a
coin flip at every one of them. Doubling every surviving path's weight four times over is not a saving,
it is noise — and the edge-aware denoise then smears that noise into round blotches. The policies that
were measured, same scene and samples throughout, scored as relative rms against a 4096-sample reference
over the darkest three quarters of the atlas (where the demo's tone curve lives):

| first bounce it rolls at | floor on `q` | rms | bias | trace |
| --- | --- | --- | --- | --- |
| never | — | 30.2% | +0.16% | 30s |
| 1 | none | 74.8% | +0.13% | 19s |
| 1 | 0.5 | 34.1% | +0.24% | 25s |
| 1 | 0.75 | 31.7% | +0.23% | 28s |
| 2 | none | 43.1% | +0.30% | 25s |
| **2** | **0.25** | **30.8%** | +0.23% | 27s |
| 2 | 0.5 | 30.4% | +0.19% | 29s |
| 3 | 0.25 | 30.0% | +0.18% | 30s |

Every one of them is unbiased, which is the point of the `1/q` — the bias column stays inside a quarter
of a percent throughout, and what moves is the variance. The metric that decides it is noise per second,
`rms² × time`: 25,610 for `(2, 0.25)` against 27,360 for rolling nothing and 106,300 for the textbook
policy. Waiting two bounces and never rolling below a quarter gives back 40% of the roulette's speedup
and buys all of the quality back — still 13% faster than casting every path to full depth.

### What it is worth

Two scenes, each at the settings its own sheet asks for, each baked twice on one machine — the same
atlas, the same auto-exposure, only the estimator between them.

| | pica (2061x2369, 15 probes, 3,864 emitters) | sponza (1341x2260, one sun, no emitters, no probes) |
| --- | --- | --- |
| unwrap | 12s → 12s | 34s → 34s |
| trace | 3m18s → **1m12s** | 21s → 21s |
| probe | 2m58s → **13s** | — |
| **bake** | **6m53s → 1m42s** | 1m04s → 1m04s |
| rms in the shadowed three quarters | — | 34.2% → **30.2%** |

Pica is where the emitters, the probes and the shared context land, and it is four times faster for
them. Sponza is the other end of the range and worth being plain about: one directional light, nothing
emissive and no probes means the alias table, the distance-bounded shadow ray and the single-dispatch
probe stage have nothing to bite on, and its trace comes out the same 21s it always took. What it gets
instead is 1.28x less variance for those 21 seconds — equal quality at 200 samples where it needed 256 —
and its 34 seconds of unwrap now printed against the stage that actually spends them.

The two agree on the answer as well as on the picture: pica's fifteen probes come back within 0.43% of
HEAD's in mean radiance, thirteen of them within 0.1%, and both bakes pick the same auto-exposure to
four significant figures.

## Checks

```sh
pnpm --filter tscene test     # CPU: rasterization, light conventions, manifest round trip
pnpm --filter tscene check    # GPU: the radiometry, against closed forms
```

The GPU check is the interesting one — every configuration in it has an irradiance you can write down,
so a shader that is merely plausible still fails:

| Setup | Expected |
| --- | --- |
| unshadowed directional light, normal on | `E = color * intensity` |
| the same light behind an occluder | `E = 0` |
| a uniform sky of radiance `L` | `E = π L` |
| a square emitter of radiance `L` overhead | `E = π L F`, the parallel-square view factor |
| a perfectly red floor under that sky | `E.r = π` exactly (albedo 1 is a furnace), `E.g = π (1 - F)` |
| `--ao` under a square lid | openness `= 1 - F`, the same view factor from the other side |

The last one is the colour-bleeding check and the sharpest: any energy the bounce loses or invents shows
up as a deviation from π.

Unlike the rest of the repo, this check needs a working GPU — which is the whole point of the baker.

## Known ceilings

Everything deliberately left simple is marked with a `ponytail:` comment naming the upgrade path. The
ones worth knowing about:

- **Albedo is per texel where a lightmapped surface has a `map`**, sampled through the same UVs the
  atlas uses, so a bounce off a checkerboard bleeds the square it actually hit. Everything else — a
  surface the ray hits that owns no lightmap texel, a material with no decodable map — falls back to one
  colour per material: the mean of its `map` (sampled on a stride, not every texel), darkened by the mean of
  its `metalnessMap` (glTF leaves `metalness` at 1 and puts the real value in the texture). A material with
  no colour at all gets `defaultAlbedo`. `@bakery { albedo }` overrides all of it.
- **Coverage is one number per material**, from `opacity`/`transmission` and the mean alpha of the map, so a
  shadow through a stained-glass window is grey rather than coloured and a cutout leaf shadows as a uniform
  haze. Per-texel alpha in the shadow ray is the upgrade.
- **AO is a single distance-limited openness term**, not a directional bent normal: it multiplies what the
  material already gets from three's `aoMap`, and stacking it on a bake that already contains the
  occlusion is double-darkening by taste rather than by physics.
- **Reflection probes are points, with no volume and no blending.** A mesh reflects the probe nearest its
  centre, which partitions the scene into Voronoi cells: the reflection changes in one step across a
  boundary, and a mesh spanning two cells picks the one its centre is in. Influence volumes (Unity's box,
  Unreal's sphere) and a blend between the two nearest are the upgrade, and both are a field in the
  manifest rather than a different shape. There is no parallax correction either — a probe is sampled as
  if infinitely far away, so a box-projected room reflects at the wrong angle up close. The bake warns
  when a scene has metals and no probe at all.
- **A probe reaches baked meshes only**, and its gain is scaled by `metalness`, so a partial metal
  (`metalness: 0.5`) double counts half of the environment's diffuse contribution — the atlas already has
  that half. Splitting the probe into its specular and diffuse parts is the fix, which means two textures
  per probe.
- **A probe fires one ray per texel, down its centre, with no jitter inside it**, so the primary hit
  aliases where a silhouette crosses a texel. Everything a probe is read through — PMREM, then a
  roughness lobe — blurs far wider than one texel, so it has never shown.
- **The area-light estimator clamps its solid angle**, and it is the largest error in the bake. It is
  what stops a shading point a millimetre from a panel from returning millions and spraying fireflies
  across the atlas, but it only ever removes energy: measured against a 2048-sample reference, pica's
  near-emitter texels come out 9% dark, and its brightest 0.1% come out 55% dark. That is bias, not
  noise — four times the samples does not move it. Two further things ride on it. The product it bounds
  is only "the emitter set's solid angle" when the pick is area-proportional; weighted by power, a dim
  emitter carries a larger `1/pdf`, meets the ceiling sooner and bakes darker for it — which is why
  power weighting *raised* pica's mean by 2.9%, all of it in the texels the clamp had been eating. And
  bounding the picked triangle's own solid angle instead, which is the physically right quantity, is far
  too loose a bound: it was tried, and pica came back with texels at 300 against a peak of 7. Sampling
  the triangle by solid angle (Arvo) removes the singularity outright and is the only real fix. Texels
  *on* an emissive surface are still noisy — harmless, since their own albedo is what the lightmap gets
  multiplied by.
- **No seam fixing.** Charts meet exactly, but a bilinear tap across a seam does not solve for
  continuity; dilation hides the worst of it.
- `three-mesh-bvh`'s WebGPU API is documented as unstable, and [one small `.d.ts`](../src/bakery/three-mesh-bvh-webgpu.d.ts)
  declares the exports it ships without types.
