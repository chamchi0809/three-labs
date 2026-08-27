[**tscene**](../README.md)

***

[tscene](../README.md) / bakery/node

# bakery/node

## Type Aliases

### AreaLights

```ts
type AreaLights = {
  count: number;
  data: Float32Array;
  totalArea: number;
};
```

Emissive triangles, flattened into an area-light list the tracer can importance-sample.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="count"></a> `count` | `number` | - |
| <a id="data"></a> `data` | `Float32Array` | 4 vec4 per triangle: (a.xyz, aliasProbability) (b.xyz, aliasIndex) (c.xyz, oneSided) (radiance.xyz, 1/pdf). The first two slots are Vose's alias table, so the shader picks an emitter in two reads; the last is what the estimator divides that pick's probability out by. |
| <a id="totalarea"></a> `totalArea` | `number` | the emitters' total surface area. Nothing on the GPU reads it — it is the set's size in one number. |

***

### Atlas

```ts
type Atlas = {
  height: number;
  utilization: number;
  uv: Float32Array[];
  width: number;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="height"></a> `height` | `number` | a multiple of the packed size: xatlas' sub-atlases are stacked into one tall texture |
| <a id="utilization"></a> `utilization` | `number` | fraction of the atlas actually covered by charts |
| <a id="uv"></a> `uv` | `Float32Array`[] | per bake mesh, 2 floats per vertex in [0,1] — the `uv1` attribute the runtime needs |
| <a id="width"></a> `width` | `number` | - |

***

### BakeEmitter

```ts
type BakeEmitter = {
  faceMaterial: Uint32Array;
  normals: Float32Array;
  positions: Float32Array;
  uv?: Float32Array;
};
```

Triangle soup in world space. What the BVH and the area-light list need, and nothing else.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="facematerial"></a> `faceMaterial` | `Uint32Array` | per-triangle material index into BakeScene.materials |
| <a id="normals"></a> `normals` | `Float32Array` | - |
| <a id="positions"></a> `positions` | `Float32Array` | world-space, 3 floats per vertex, vertexCount = triCount * 3 |
| <a id="uv-1"></a> `uv?` | `Float32Array` | the mesh's own uv0, 2 floats per vertex — what an albedo or emissive map is sampled with. |

***

### BakeFileOptions

```ts
type BakeFileOptions = Omit<BakeOptions, "renderer"> & WriteOptions & {
  name?: string;
  out?: string;
  renderer?: THREE.WebGPURenderer;
};
```

#### Type Declaration

| Name | Type | Description |
| ------ | ------ | ------ |
| `name?` | `string` | output base name (default: the sheet's file name) |
| `out?` | `string` | where to write (default: next to the sheet) |
| `renderer?` | `THREE.WebGPURenderer` | an initialized WebGPURenderer. One is created — and disposed again — when this is left out. |

***

### BakeFileResult

```ts
type BakeFileResult = BakeResult & {
  files: string[];
};
```

#### Type Declaration

| Name | Type | Description |
| ------ | ------ | ------ |
| `files` | `string`[] | the paths `writeBake` produced |

***

### BakeLight

```ts
type BakeLight = {
  color: [number, number, number];
  cosInner: number;
  cosOuter: number;
  decay: number;
  direction: [number, number, number];
  distance: number;
  kind: 0 | 1 | 2;
  position: [number, number, number];
  radius: number;
};
```

0 = directional, 1 = point, 2 = spot. Matches the `kind` the shader switches on.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="color"></a> `color` | \[`number`, `number`, `number`\] | color * intensity, linear |
| <a id="cosinner"></a> `cosInner` | `number` | - |
| <a id="cosouter"></a> `cosOuter` | `number` | - |
| <a id="decay"></a> `decay` | `number` | - |
| <a id="direction"></a> `direction` | \[`number`, `number`, `number`\] | light -> target, normalized (directional + spot) |
| <a id="distance"></a> `distance` | `number` | three's PointLight/SpotLight.distance cutoff, 0 = none |
| <a id="kind"></a> `kind` | `0` \| `1` \| `2` | - |
| <a id="position"></a> `position` | \[`number`, `number`, `number`\] | - |
| <a id="radius"></a> `radius` | `number` | world radius the light is jittered inside — 0 gives hard shadows |

***

### BakeMaterial

```ts
type BakeMaterial = {
  albedo: [number, number, number];
  coverage?: number;
  emissive: [number, number, number];
  emissiveMap?: THREE.Texture;
  emissiveScale?: [number, number, number];
  map?: THREE.Texture;
  mapScale?: [number, number, number];
  normalMap?: THREE.Texture;
  normalScale?: [number, number];
  oneSided?: boolean;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="albedo"></a> `albedo` | \[`number`, `number`, `number`\] | linear diffuse reflectance, what bounced light is multiplied by |
| <a id="coverage"></a> `coverage?` | `number` | how much of a shadow ray this surface stops: 1 opaque, 0 invisible to light. Read from `opacity`/`transparent` and from the mean alpha of an `alphaMap`/cutout `map`. |
| <a id="emissive"></a> `emissive` | \[`number`, `number`, `number`\] | linear radiance emitted by this surface (W/sr/m²) — becomes an area light |
| <a id="emissivemap"></a> `emissiveMap?` | `THREE.Texture` | the emissive map, sampled per triangle so a textured panel is not one flat colour |
| <a id="emissivescale"></a> `emissiveScale?` | \[`number`, `number`, `number`\] | what one texel of [emissiveMap](#emissivemap) is multiplied by. `emissive` already holds its mean. |
| <a id="map"></a> `map?` | `THREE.Texture` | the albedo map, sampled per texel when the bake builds an albedo atlas |
| <a id="mapscale"></a> `mapScale?` | \[`number`, `number`, `number`\] | what one texel of [map](#map) is multiplied by — colour × (1 - metalness). `albedo` is its mean. |
| <a id="normalmap"></a> `normalMap?` | `THREE.Texture` | the tangent-space normal map, sampled per texel so the trace sees the bumps the shader does. Object-space maps are left out — a texel knows no object it belongs to by the time this is read. |
| <a id="normalscale"></a> `normalScale?` | \[`number`, `number`\] | `normalScale`, what the map's x and y are multiplied by before the frame is rebuilt |
| <a id="onesided"></a> `oneSided?` | `boolean` | emits from the +normal side only (a RectAreaLight quad). A mesh material emits both ways. |

***

### BakeMesh

```ts
type BakeMesh = BakeEmitter & {
  density?: number;
  key: string;
  mesh: THREE.Mesh;
};
```

One bakeable mesh, de-indexed so every triangle corner owns its own vertex (and its own lightmap uv).

#### Type Declaration

| Name | Type | Description |
| ------ | ------ | ------ |
| `density?` | `number` | `@bakery { density }` — texel density relative to the rest of the scene. 1 (or absent) is the default. |
| `key` | `string` | stable path from the bake root — the key both the manifest and applyLightmap() use |
| `mesh` | `THREE.Mesh` | - |

***

### BakeOptions

```ts
type BakeOptions = Omit<UnwrapOptions, "onProgress"> & Omit<TraceOptions, "onProgress"> & CollectOptions & {
  ao?: boolean;
  denoiseRadius?: number;
  dilateRadius?: number;
  exposure?: number;
  fireflyThreshold?: number;
  jobs?: number;
  only?: string[];
  onProgress?: (stage, fraction) => void;
  previous?: {
     ao?: Float32Array;
     image: Float32Array;
     manifest: LightmapManifest;
  };
  renderer: THREE.WebGPURenderer;
};
```

The baker. Node only — pulls in Dawn, sharp and xatlas. See `tscene/bakery` for the runtime half.

#### Type Declaration

| Name | Type | Description |
| ------ | ------ | ------ |
| `ao?` | `boolean` | also build an ambient-occlusion atlas — [BakeResult.ao](#ao), and `<name>.ao.png` on disk |
| `denoiseRadius?` | `number` | 0 disables the edge-aware blur; 1 is a 3x3 kernel |
| `dilateRadius?` | `number` | texels of lit-region growth past the chart edges. The atlas padding follows this by default. |
| `exposure?` | `number` | The divisor that maps irradiance into the 8-bit PNG, and the `lightMapIntensity` that undoes it. Absent, it is the atlas' 95th percentile. Fixing it makes two bakes of one scene quantize alike. |
| `fireflyThreshold?` | `number` | How far above the median of its neighbours a texel may sit before it is clamped back to it. Runs before the blur, which would otherwise smear the spike rather than remove it. 0 disables. |
| `jobs?` | `number` | worker threads to rasterize with (Node only). 1 keeps the rasterizer on the calling thread. |
| `only?` | `string`[] | with [previous](#bakeoptions), the `nodeKey()`s to re-trace. Everything else is copied over. |
| `onProgress()?` | (`stage`, `fraction`) => `void` | - |
| `previous?` | \{ `ao?`: `Float32Array`; `image`: `Float32Array`; `manifest`: [`LightmapManifest`](../bakery.md#lightmapmanifest-1); \} | A finished bake to rebake on top of: its uv layout is reused (no unwrap), and every texel outside [only](#bakeoptions) keeps the irradiance (and occlusion) it already had. |
| `previous.ao?` | `Float32Array` | - |
| `previous.image` | `Float32Array` | - |
| `previous.manifest` | [`LightmapManifest`](../bakery.md#lightmapmanifest-1) | - |
| `renderer` | `THREE.WebGPURenderer` | an initialized WebGPURenderer. Required — `createHeadlessRenderer()` makes one in Node. |

***

### BakeProbe

```ts
type BakeProbe = {
  influence: number;
  key: string;
  position: [number, number, number];
  size: number;
};
```

`@bakery { probe }` on a node — a point the bake captures the radiance around.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="influence"></a> `influence` | `number` | world-space radius the probe reaches; 0 is "everywhere". See `probeWeights()`. |
| <a id="key"></a> `key` | `string` | `nodeKey()` of the node that declared it |
| <a id="position-1"></a> `position` | \[`number`, `number`, `number`\] | - |
| <a id="size"></a> `size` | `number` | equirect width in texels; the height is half of it |

***

### BakeResult

```ts
type BakeResult = {
  ao?: Float32Array;
  exposure: number;
  height: number;
  image: Float32Array;
  manifest: Omit<LightmapManifest, "texture">;
  probes: ProbeImage[];
  utilization: number;
  width: number;
};
```

The baker. Node only — pulls in Dawn, sharp and xatlas. See `tscene/bakery` for the runtime half.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="ao"></a> `ao?` | `Float32Array` | with `ao`, cosine-weighted openness in all three colour channels — 1 unoccluded, 0 fully closed, which is what three's `aoMap` reads. Same layout as [BakeResult.image](#image). |
| <a id="exposure"></a> `exposure` | `number` | divisor that maps `image` into [0,1] for an 8-bit texture; also the `lightMapIntensity` to use |
| <a id="height-1"></a> `height` | `number` | - |
| <a id="image"></a> `image` | `Float32Array` | linear irradiance, RGBA, `width * height * 4`, bottom row first. Alpha marks covered texels. |
| <a id="manifest"></a> `manifest` | `Omit`\<[`LightmapManifest`](../bakery.md#lightmapmanifest-1), `"texture"`\> | everything the runtime needs except the texture file name, which the writer fills in |
| <a id="probes"></a> `probes` | [`ProbeImage`](#probeimage)[] | one equirect per `@bakery { probe }` node, in the order the scene walk found them |
| <a id="utilization-1"></a> `utilization` | `number` | fraction of the atlas the charts cover |
| <a id="width-1"></a> `width` | `number` | - |

***

### BakeScene

```ts
type BakeScene = {
  bounds: THREE.Box3;
  emitters: BakeEmitter[];
  lights: BakeLight[];
  materials: BakeMaterial[];
  meshes: BakeMesh[];
  probes: BakeProbe[];
  sky: BakeSky;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="bounds"></a> `bounds` | `THREE.Box3` | world-space bounds of everything collected, for picking a default ray bias |
| <a id="emitters"></a> `emitters` | [`BakeEmitter`](#bakeemitter)[] | geometry that lights the bake without receiving any — a RectAreaLight, turned into a quad |
| <a id="lights"></a> `lights` | [`BakeLight`](#bakelight)[] | - |
| <a id="materials"></a> `materials` | [`BakeMaterial`](#bakematerial)[] | - |
| <a id="meshes"></a> `meshes` | [`BakeMesh`](#bakemesh)[] | - |
| <a id="probes-1"></a> `probes` | [`BakeProbe`](#bakeprobe)[] | the reflection probes the sheet placed, in the order they were walked |
| <a id="sky"></a> `sky` | [`BakeSky`](#bakesky) | - |

***

### BakeSky

```ts
type BakeSky = {
  axis: [number, number, number];
  down: [number, number, number];
  up: [number, number, number];
};
```

Ambient + hemisphere lights collapse into a two-colour gradient that rays see when they escape.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="axis"></a> `axis` | \[`number`, `number`, `number`\] | - |
| <a id="down"></a> `down` | \[`number`, `number`, `number`\] | - |
| <a id="up"></a> `up` | \[`number`, `number`, `number`\] | radiance looking along +axis |

***

### BakeStage

```ts
type BakeStage = 
  | "load"
  | "collect"
  | "unwrap"
  | "rasterize"
  | "prepare"
  | "trace"
  | "probe"
  | "filter"
  | "write";
```

Every stage announces itself when it starts, and the one after it is what marks it finished — so the
list covers the whole bake with no gaps. `load` and `write` belong to [bakeSceneFile](#bakescenefile); a caller
that hands `bake()` a scene it already has never sees them.

***

### Bases

```ts
type Bases = {
  emissive: number;
  light: number;
  material: number;
};
```

where each record kind starts in [TraceContext.records](#records), in vec4s

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="emissive-1"></a> `emissive` | `number` |
| <a id="light"></a> `light` | `number` |
| <a id="material"></a> `material` | `number` |

***

### CollectOptions

```ts
type CollectOptions = {
  defaultAlbedo?: number;
  include?: "all" | "none";
  onWarn?: (message) => void;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="defaultalbedo"></a> `defaultAlbedo?` | `number` | default albedo for materials without a `color` (linear grey) |
| <a id="include"></a> `include?` | `"all"` \| `"none"` | `all` (the default) bakes every visible mesh except the ones that turn themselves off; `none` bakes only the ones that opt in. Defaults to the root's own `@bakery { include }`. |
| <a id="onwarn"></a> `onWarn?` | (`message`) => `void` | where "this mesh cannot be baked" goes. Defaults to `console.warn`. |

***

### PrepareOptions

```ts
type PrepareOptions = Pick<TraceOptions, "lightmapUV" | "albedo"> & {
  height?: number;
  width?: number;
};
```

#### Type Declaration

| Name | Type | Description |
| ------ | ------ | ------ |
| `height?` | `number` | - |
| `width?` | `number` | the atlas [TraceOptions.albedo](#albedo-2) is packed in. Required with it, ignored without. |

***

### ProbeImage

```ts
type ProbeImage = {
  height: number;
  image: Float32Array;
  influence: number;
  key: string;
  position: [number, number, number];
  width: number;
};
```

One baked reflection probe: radiance in every direction, equirect, bottom row first like the atlas.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="height-2"></a> `height` | `number` | - |
| <a id="image-1"></a> `image` | `Float32Array` | linear radiance, RGBA, `width * height * 4`. Alpha is 1 — every texel of a probe is covered. |
| <a id="influence-1"></a> `influence` | `number` | the placing node's `@bakery { influence }`, carried through to the manifest. 0 is unbounded. |
| <a id="key-1"></a> `key` | `string` | - |
| <a id="position-2"></a> `position` | \[`number`, `number`, `number`\] | - |
| <a id="width-2"></a> `width` | `number` | - |

***

### RasterOptions

```ts
type RasterOptions = {
  jobs?: number;
  onProgress?: (fraction) => void;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="jobs"></a> `jobs?` | `number` | worker threads to rasterize with. 1 stays on the calling thread, 0 or absent asks for one per core. Node only; everywhere else the rasterizer is single-threaded. |
| <a id="onprogress"></a> `onProgress?` | (`fraction`) => `void` | - |

***

### Texels

```ts
type Texels = {
  height: number;
  index: Uint32Array;
  mask: Uint8Array;
  mesh: Int32Array;
  normal: Float32Array;
  position: Float32Array;
  uv: Float32Array;
  width: number;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="height-3"></a> `height` | `number` | - |
| <a id="index"></a> `index` | `Uint32Array` | the covered texel indices, ascending — what the compute shader is dispatched over |
| <a id="mask"></a> `mask` | `Uint8Array` | width*height, 1 where a chart covers the texel |
| <a id="mesh"></a> `mesh` | `Int32Array` | width*height — index into the mesh list, -1 where nothing covers the texel |
| <a id="normal"></a> `normal` | `Float32Array` | width*height*4 — world normal xyz, material id in w |
| <a id="position-3"></a> `position` | `Float32Array` | width*height*4 — world position xyz, w unused |
| <a id="uv-2"></a> `uv` | `Float32Array` | width*height*2 — the surface's own uv0, for sampling its albedo map. 0 where the mesh has none. |
| <a id="width-3"></a> `width` | `number` | - |

***

### TraceContext

```ts
type TraceContext = {
  albedo?: {
     data: unknown;
     height: number;
     width: number;
  };
  bases: Bases;
  bvh: BVHComputeData;
  emissiveCount: number;
  proxy: THREE.Group;
  records: unknown;
  dispose: void;
};
```

The BVH, the record buffer and the albedo atlas: everything about a scene that neither the atlas
trace nor the probes change. Building one walks every triangle of the scene and uploads it, so a bake
builds a single context and hands it to both stages rather than paying for it twice.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="albedo-1"></a> `albedo?` | \{ `data`: `unknown`; `height`: `number`; `width`: `number`; \} | the atlas a bounce reads the hit texel's own albedo out of, when the bake built one |
| `albedo.data` | `unknown` | - |
| `albedo.height` | `number` | - |
| `albedo.width` | `number` | - |
| <a id="bases-1"></a> `bases` | [`Bases`](#bases) | - |
| <a id="bvh"></a> `bvh` | `BVHComputeData` | - |
| <a id="emissivecount"></a> `emissiveCount` | `number` | emissive triangles in `records`. 0 turns next-event estimation off entirely. |
| <a id="proxy"></a> `proxy` | `THREE.Group` | the proxy meshes the BVH was built from — world space, the bake meshes and then the emitter quads |
| <a id="records"></a> `records` | `unknown` | materials, then lights, then emissive triangles, in one read-only storage buffer |

#### Methods

##### dispose()

```ts
dispose(): void;
```

frees the BVH and the proxy geometries. Whoever built the context calls it.

###### Returns

`void`

***

### TraceOptions

```ts
type TraceOptions = {
  albedo?: Uint32Array;
  aoDistance?: number;
  batch?: number;
  bias?: number;
  bounces?: number;
  context?: TraceContext;
  indirect?: number;
  lightmapUV?: Float32Array[];
  onProgress?: (fraction) => void;
  samples?: number;
  signal?: AbortSignal;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="albedo-2"></a> `albedo?` | `Uint32Array` | albedo per atlas texel, packed RGBA8, alpha = covered. Without it every bounce uses the material's mean. |
| <a id="aodistance"></a> `aoDistance?` | `number` | how far an ambient-occlusion ray looks for a blocker. Defaults to 5% of the scene diagonal — a room-sized default; raise it for a landscape, lower it for a prop. |
| <a id="batch"></a> `batch?` | `number` | paths per dispatch. Lower it if the driver kills long compute passes. |
| <a id="bias"></a> `bias?` | `number` | ray origin offset along the normal. Defaults to 1e-4 of the scene diagonal. |
| <a id="bounces"></a> `bounces?` | `number` | diffuse bounces after the first hit — 4 is plenty indoors, 2 outdoors |
| <a id="context"></a> `context?` | [`TraceContext`](#tracecontext) | a [TraceContext](#tracecontext) to trace against instead of building one. A bake builds a single context and hands it to both the atlas trace and the probes; called on their own, each builds and frees its own. |
| <a id="indirect"></a> `indirect?` | `number` | gain on everything past the first bounce — 1 is physical, >1 the usual cheat for a flat-looking interior. Direct light and the sky seen straight from a texel are untouched. |
| <a id="lightmapuv"></a> `lightmapUV?` | `Float32Array`[] | per bake mesh, the atlas uv the unwrap produced — what a bounce is looked up in `albedo` with |
| <a id="onprogress-1"></a> `onProgress?` | (`fraction`) => `void` | - |
| <a id="samples"></a> `samples?` | `number` | total paths per texel. This is the only real quality knob. |
| <a id="signal"></a> `signal?` | `AbortSignal` | aborts between dispatches. The GPU work already queued still finishes. |

***

### UnwrapOptions

```ts
type UnwrapOptions = {
  onProgress?: (fraction) => void;
  padding?: number;
  size?: number;
  texelsPerUnit?: number;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="onprogress-2"></a> `onProgress?` | (`fraction`) => `void` | 0..1 — how far the unwrap has got, straight out of xatlas' own phases |
| <a id="padding"></a> `padding?` | `number` | texels of empty space around every chart. Keep it at or above the bake's `dilateRadius`: dilation grows the lit region outwards, and anything it grows past the padding bleeds into the next chart. |
| <a id="size-1"></a> `size?` | `number` | target atlas edge length in texels. xatlas picks the chart scale from this and then packs, so the atlas it returns is around this size rather than exactly it — read `Atlas.width` for the truth. |
| <a id="texelsperunit"></a> `texelsPerUnit?` | `number` | texels per world unit. 0 (the default) lets xatlas pick the scale that fills `size`, which is what you want unless you are baking several scenes to a shared density. |

***

### WriteOptions

```ts
type WriteOptions = {
  exr?: boolean;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="exr"></a> `exr?` | `boolean` | also write a 32-bit float EXR of the unexposed irradiance next to the PNG |

## Functions

### areaLights()

```ts
function areaLights(scene): AreaLights;
```

Emissive triangles, ready to importance-sample: the geometry, the radiance, and an alias table over
the set weighted by **power** — area times luminance, not area alone. A dim emitter the same size as
a bright one used to be picked as often and contribute a fraction as much, which is variance the
bake paid for in samples.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `scene` | [`BakeScene`](#bakescene) |

#### Returns

[`AreaLights`](#arealights)

***

### bake()

```ts
function bake(root, opts): Promise<BakeResult>;
```

The baker. Node only — pulls in Dawn, sharp and xatlas. See `tscene/bakery` for the runtime half.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `root` | `Object3D` |
| `opts` | [`BakeOptions`](#bakeoptions) |

#### Returns

`Promise`\<[`BakeResult`](#bakeresult)\>

***

### bakeSceneFile()

```ts
function bakeSceneFile(file, opts?): Promise<BakeFileResult>;
```

Loads a `.tscene` file, bakes it, and writes the atlas and its manifest.

```ts
const { files, width, exposure } = await bakeSceneFile("scenes/room.tscene", {
  out: "public/lightmaps",
  size: 512,
  samples: 1024,
});
```

Every knob of [bake](#bake) and [writeBake](#writebake) passes straight through, and every one of them can
also live in the sheet's own `@bakery { … }` block — what is passed here wins. Reach for the pieces
themselves when the scene is not a sheet on disk, or when one renderer bakes several scenes.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `file` | `string` |
| `opts` | [`BakeFileOptions`](#bakefileoptions) |

#### Returns

`Promise`\<[`BakeFileResult`](#bakefileresult)\>

***

### bvhProxy()

```ts
function bvhProxy(scene, lightmapUV?): Group;
```

The scene as three-mesh-bvh wants it: one Mesh per bake mesh, already in world space so every
transform in the TLAS is the identity. The per-triangle material id rides along in `normal.w`,
which saves a parallel buffer — BVHComputeData interpolates and uploads normals anyway.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `scene` | [`BakeScene`](#bakescene) |
| `lightmapUV?` | `Float32Array`\<`ArrayBufferLike`\>[] |

#### Returns

`Group`

***

### collectScene()

```ts
function collectScene(root, opts?): BakeScene;
```

Walks the scene once and flattens everything the path tracer needs. Does not mutate `root`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `root` | `Object3D` |
| `opts` | [`CollectOptions`](#collectoptions) |

#### Returns

[`BakeScene`](#bakescene)

***

### createHeadlessRenderer()

```ts
function createHeadlessRenderer(): Promise<WebGPURenderer>;
```

A `WebGPURenderer` that runs compute in Node. Only `computeAsync` / `getArrayBufferAsync` are usable.

#### Returns

`Promise`\<`WebGPURenderer`\>

***

### denoise()

```ts
function denoise(
   image, 
   texels, 
   radius?, 
   normalThreshold?): void;
```

Edge-aware box blur. Neighbours only contribute when they sit on the same surface — same normal,
within a texel or so in world space — so shadow terminators and creases survive.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `image` | `Float32Array` | `undefined` |
| `texels` | [`Texels`](#texels) | `undefined` |
| `radius` | `number` | `1` |
| `normalThreshold` | `number` | `0.9` |

#### Returns

`void`

***

### dilate()

```ts
function dilate(
   image, 
   mask, 
   width, 
   height, 
   radius?): void;
```

Grows the lit region outward by `radius` texels, averaging whatever is already lit. Without this a
bilinear tap just outside a chart reads black and every chart gets a dark rim.

A grown texel is given alpha 1 like any other: alpha in the written atlas means "this texel holds a
colour worth reading", and the rim is exactly that — it is there to be sampled. It is not the chart
coverage the rasterizer produced, and the manifest's uv layout is where that lives.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `image` | `Float32Array` | `undefined` |
| `mask` | `Uint8Array` | `undefined` |
| `width` | `number` | `undefined` |
| `height` | `number` | `undefined` |
| `radius` | `number` | `4` |

#### Returns

`void`

***

### hasWebGPU()

```ts
function hasWebGPU(): Promise<boolean>;
```

Whether this machine can actually run a bake. A CI runner has Dawn but no driver behind it, so the
binding loads and then hands back no adapter — which is a skip, not a failure.

#### Returns

`Promise`\<`boolean`\>

***

### installNodeLoaders()

```ts
function installNodeLoaders(): void;
```

Teaches `fetch` about `file:` urls and swaps three's ImageLoader for sharp. Idempotent.

#### Returns

`void`

***

### installWebGPU()

```ts
function installWebGPU(): void;
```

Puts Dawn's WebGPU behind `navigator.gpu` and stubs what three's backend touches. Idempotent.

#### Returns

`void`

***

### loadSceneFile()

```ts
function loadSceneFile(file, opts?): Promise<Group<Object3DEventMap>>;
```

Reads a `.tscene` file from disk, `@import`s and all, and returns the built scene.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `file` | `string` |
| `opts` | [`LoadOptions`](../index.md#loadoptions) |

#### Returns

`Promise`\<`Group`\<`Object3DEventMap`\>\>

***

### prepareTrace()

```ts
function prepareTrace(scene, opts?): TraceContext;
```

Builds a [TraceContext](#tracecontext). Call `dispose()` on the result when the last stage using it is done.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `scene` | [`BakeScene`](#bakescene) |
| `opts` | [`PrepareOptions`](#prepareoptions) |

#### Returns

[`TraceContext`](#tracecontext)

***

### rasterize()

```ts
function rasterize(
   meshes, 
   atlas, 
   onProgress?): Texels;
```

Texture space, not image space: texel row 0 is v = 0. That matches a `DataTexture` directly and
costs the PNG/EXR writers one row flip.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `meshes` | [`BakeMesh`](#bakemesh)[] |
| `atlas` | [`Atlas`](#atlas) |
| `onProgress?` | (`fraction`) => `void` |

#### Returns

[`Texels`](#texels)

***

### rasterizeParallel()

```ts
function rasterizeParallel(
   meshes, 
   atlas, 
opts?): Promise<Texels>;
```

The same rasterization, spread over worker threads. A wall of 200k triangles is a second of one
core per mesh and there is nothing to share between meshes, so this is close to linear.
Node only: no `worker_threads`, one mesh, or `jobs: 1` all fall through to [rasterize](#rasterize).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `meshes` | [`BakeMesh`](#bakemesh)[] |
| `atlas` | [`Atlas`](#atlas) |
| `opts` | [`RasterOptions`](#rasteroptions) |

#### Returns

`Promise`\<[`Texels`](#texels)\>

***

### trace()

```ts
function trace(
   renderer, 
   scene, 
   texels, 
opts?): Promise<Float32Array<ArrayBufferLike>>;
```

Irradiance per covered texel: 4 floats each, (E.rgb summed over `samples`, occlusion summed the same).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `renderer` | `WebGPURenderer` |
| `scene` | [`BakeScene`](#bakescene) |
| `texels` | [`Texels`](#texels) |
| `opts` | [`TraceOptions`](#traceoptions) |

#### Returns

`Promise`\<`Float32Array`\<`ArrayBufferLike`\>\>

***

### traceProbes()

```ts
function traceProbes(
   renderer, 
   scene, 
opts?): Promise<ProbeImage[]>;
```

The radiance around each of `scene.probes`, as an equirect per probe. Same estimator as the atlas —
the difference is only where a path starts: a probe shoots one ray per texel and gathers what the
surface it lands on sends back, which is radiance rather than irradiance and includes the emission
the lightmap deliberately leaves out.

Every probe goes in one dispatch. The origin rides in the surface buffer beside the direction rather
than being interpolated into the shader, so the kernel is compiled once instead of once per probe:
pica's fifteen used to spend three quarters of a minute in the driver before casting a single ray,
and 120k texels in flight saturate a GPU that 8k left mostly idle.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `renderer` | `WebGPURenderer` |
| `scene` | [`BakeScene`](#bakescene) |
| `opts` | [`TraceOptions`](#traceoptions) |

#### Returns

`Promise`\<[`ProbeImage`](#probeimage)[]\>

***

### uninstallNodeLoaders()

```ts
function uninstallNodeLoaders(): void;
```

Puts `fetch` and `ImageLoader` back the way [installNodeLoaders](#installnodeloaders) found them — for a process
that bakes and then goes on to do something else with a `fetch` it expects to be its own. Idempotent,
and a no-op if the shims were never installed.

`self` and `ProgressEvent` stay. Both are `??=` additions that nothing can tell apart from the real
thing, and a loader still in flight reads them.

#### Returns

`void`

***

### unwrap()

```ts
function unwrap(meshes, opts?): Promise<Atlas>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `meshes` | [`BakeMesh`](#bakemesh)[] |
| `opts` | [`UnwrapOptions`](#unwrapoptions) |

#### Returns

`Promise`\<[`Atlas`](#atlas)\>

***

### writeBake()

```ts
function writeBake(
   result, 
   dir, 
   name, 
opts?): Promise<string[]>;
```

Writes `<dir>/<name>.png` (exposure-scaled sRGB), `<dir>/<name>.ao.png` if the bake produced one,
`<dir>/<name>.probeN.exr` per reflection probe, and `<dir>/<name>.lightmap.json`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `result` | [`BakeResult`](#bakeresult) |
| `dir` | `string` |
| `name` | `string` |
| `opts` | [`WriteOptions`](#writeoptions) |

#### Returns

`Promise`\<`string`[]\>

the paths written.

## References

### applyLightmap

Re-exports [applyLightmap](../bakery.md#applylightmap)

***

### bakeEnabled

Re-exports [bakeEnabled](../bakery.md#bakeenabled)

***

### bakeGeometry

Re-exports [bakeGeometry](../bakery.md#bakegeometry)

***

### bakerySettings

Re-exports [bakerySettings](../bakery.md#bakerysettings)

***

### decodeFloats

Re-exports [decodeFloats](../bakery.md#decodefloats)

***

### encodeFloats

Re-exports [encodeFloats](../bakery.md#encodefloats)

***

### Lightmap

Re-exports [Lightmap](../bakery.md#lightmap)

***

### LightmapManifest

Re-exports [LightmapManifest](../bakery.md#lightmapmanifest-1)

***

### loadLightmap

Re-exports [loadLightmap](../bakery.md#loadlightmap)

***

### MANIFEST\_VERSION

Re-exports [MANIFEST_VERSION](../bakery.md#manifest_version)

***

### MaterialBakery

Re-exports [MaterialBakery](../index.md#materialbakery)

***

### NodeBakery

Re-exports [NodeBakery](../index.md#nodebakery)

***

### nodeKey

Re-exports [nodeKey](../bakery.md#nodekey)

***

### PlacedProbe

Re-exports [PlacedProbe](../bakery.md#placedprobe)

***

### probeDirection

Re-exports [probeDirection](../bakery.md#probedirection)

***

### ProbeWeight

Re-exports [ProbeWeight](../bakery.md#probeweight)

***

### probeWeights

Re-exports [probeWeights](../bakery.md#probeweights)

***

### SceneBakery

Re-exports [SceneBakery](../index.md#scenebakery)
