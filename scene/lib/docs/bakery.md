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
  picked in proportion to triangle area. three has no bakeable area light; this is the substitute.
- **three's own light math, verbatim.** `DirectionalLight`, `PointLight` and `SpotLight` reproduce
  `getDistanceAttenuation`, the distance window and the spot penumbra exactly, so a bake matches what the
  realtime renderer was already showing. `AmbientLight` and `HemisphereLight` collapse into a sky gradient.
- **Soft shadows.** `@bakery { radius }` on a light turns it into a sphere (or, for a directional light,
  an angular cone) and gives a real penumbra.
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
| `lightmap.dispose()` | atlas off the materials, lights back, texture disposed |

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
```

`out` is relative to the sheet; the CLI's `--out` is relative to where it runs. Everything passed to
`bakeSceneFile` (or a CLI flag) wins over the sheet, and the sheet wins over the stage defaults.

Which meshes get baked is `include`, and `enabled` is the per-node say in it:

| | |
| --- | --- |
| `@bakery { include: all }` | the default: every visible mesh but the ones that turn themselves off |
| `@bakery { include: none }` | only the meshes that opt in with `@bakery { enabled: true }` |
| `@bakery { enabled: … }` on a node | applies to its whole subtree; the nearest one wins, so a child can opt back in |

`include` selects meshes, never lights: a light is an input to the bake, so it stays in whatever the mode.
`enabled: false` on a light means "stays live at runtime" instead — `applyLightmap` leaves it alone and it
is not in `lightmap.lights`.

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

`--help` lists the rest (`--out`, `--name`, `--bounces`, `--indirect`, `--batch`, `--padding`,
`--texels-per-unit`, `--denoise`, `--dilate`). Each stage prints its elapsed time, and the trace — the long
one — prints a running estimate of what is left.

`--indirect` is the one knob that is not physical: it is a gain on everything gathered past the first
bounce, so an interior that bakes flat can be pushed without touching the direct light. 1 is the truth.

## Output

`writeBake` produces three files next to each other:

| File | What |
| --- | --- |
| `<name>.png` | irradiance divided by an auto exposure, sRGB encoded. `manifest.intensity` is the divisor, and `applyLightmap` puts it back as `lightMapIntensity` |
| `<name>.lightmap.json` | the manifest: atlas size, exposure, and base64 `uv1` per baked mesh, keyed by node path |
| `<name>.exr` | with `--exr`: the same data as 32-bit float, unclipped |

The manifest carries only uvs, not geometry, because `BufferGeometry.toNonIndexed()` is deterministic —
`applyLightmap` re-derives the same vertex order and refuses the atlas if the counts disagree.

## How it works

| Stage | File | |
| --- | --- | --- |
| collect | [`scene.ts`](../src/bakery/scene.ts) | scene → world-space triangle soup, materials, lights, sky, emissive triangle list |
| unwrap | [`atlas.ts`](../src/bakery/atlas.ts) | lightmap uvs from xatlas (wasm), one atlas for the whole scene |
| rasterize | [`raster.ts`](../src/bakery/raster.ts) | atlas texel → the world position and normal to shade |
| trace | [`tracer.ts`](../src/bakery/tracer.ts) | the estimator, as WGSL, over three-mesh-bvh's `BVHComputeData` |
| filter | [`filter.ts`](../src/bakery/filter.ts) | edge-aware denoise, then dilation past the chart edges so bilinear taps never read black |
| pack | [`io.ts`](../src/bakery/io.ts) | PNG / EXR / manifest |

The estimator is the part worth reading twice. It integrates **irradiance**, so bounces are
cosine-sampled and the π from the estimator cancels the 1/π from the Lambert BRDF — every bounce is just
a multiply by the hit surface's albedo. Direct lighting is next-event estimation only (analytic for delta
lights, area sampling for emissive triangles) and emission is never added on a bounce hit, so nothing is
counted twice and there is no MIS weight to get wrong. Bounce 0 walks a randomized Hammersley set, which
is what keeps the sample counts low.

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

The last one is the colour-bleeding check and the sharpest: any energy the bounce loses or invents shows
up as a deviation from π.

Unlike the rest of the repo, this check needs a working GPU — which is the whole point of the baker.

## Known ceilings

Everything deliberately left simple is marked with a `ponytail:` comment naming the upgrade path. The
ones worth knowing about:

- **Albedo is one colour per material**, the mean of its `map` (and darkened by the mean of its
  `metalnessMap`, since glTF leaves `metalness` at 1 and puts the real value in the texture). Colour
  bleeding gets a texture's hue but not its pattern; use `@bakery { albedo }` where that matters.
- **Shadow rays run a closest-hit query** because three-mesh-bvh has no any-hit shapecast yet, so a
  shadow ray costs a full traversal.
- **The area-light estimator clamps its solid angle**, which slightly darkens the first centimetre around
  an emitter. It is what stops a shading point a millimetre from a panel from returning millions and
  spraying fireflies across the atlas; sampling the triangle by solid angle (Arvo) would remove the
  singularity outright. Texels *on* an emissive surface are still noisy — harmless, since their own
  albedo is what the lightmap gets multiplied by.
- **No seam fixing.** Charts meet exactly, but a bilinear tap across a seam does not solve for
  continuity; dilation hides the worst of it.
- `three-mesh-bvh`'s WebGPU API is documented as unstable, and [one small `.d.ts`](../src/bakery/three-mesh-bvh-webgpu.d.ts)
  declares the exports it ships without types.
