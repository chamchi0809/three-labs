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
| <a id="data"></a> `data` | `Float32Array` | 3 vec4 per triangle: (a.xyz, cumulativeArea) (b.xyz, area) (c.xyz, materialId) |
| <a id="totalarea"></a> `totalArea` | `number` | - |

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
| <a id="height"></a> `height` | `number` | - |
| <a id="utilization"></a> `utilization` | `number` | fraction of the atlas actually covered by charts |
| <a id="uv"></a> `uv` | `Float32Array`[] | per bake mesh, 2 floats per vertex in [0,1] — the `uv1` attribute the runtime needs |
| <a id="width"></a> `width` | `number` | - |

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
  emissive: [number, number, number];
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="albedo"></a> `albedo` | \[`number`, `number`, `number`\] | linear diffuse reflectance, what bounced light is multiplied by |
| <a id="emissive"></a> `emissive` | \[`number`, `number`, `number`\] | linear radiance emitted by this surface (W/sr/m²) — becomes an area light |

***

### BakeMesh

```ts
type BakeMesh = {
  faceMaterial: Uint32Array;
  key: string;
  mesh: THREE.Mesh;
  normals: Float32Array;
  positions: Float32Array;
};
```

One bakeable mesh, de-indexed so every triangle corner owns its own vertex (and its own lightmap uv).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="facematerial"></a> `faceMaterial` | `Uint32Array` | per-triangle material index into BakeScene.materials |
| <a id="key"></a> `key` | `string` | stable path from the bake root — the key both the manifest and applyLightmap() use |
| <a id="mesh"></a> `mesh` | `THREE.Mesh` | - |
| <a id="normals"></a> `normals` | `Float32Array` | - |
| <a id="positions"></a> `positions` | `Float32Array` | world-space, 3 floats per vertex, vertexCount = triCount * 3 |

***

### BakeOptions

```ts
type BakeOptions = UnwrapOptions & Omit<TraceOptions, "onProgress"> & CollectOptions & {
  denoiseRadius?: number;
  dilateRadius?: number;
  onProgress?: (stage, fraction) => void;
  renderer: THREE.WebGPURenderer;
};
```

The baker. Node only — pulls in Dawn, sharp and xatlas. See `tscene/bakery` for the runtime half.

#### Type Declaration

| Name | Type | Description |
| ------ | ------ | ------ |
| `denoiseRadius?` | `number` | 0 disables the edge-aware blur; 1 is a 3x3 kernel |
| `dilateRadius?` | `number` | texels of lit-region growth past the chart edges. Keep >= the atlas padding. |
| `onProgress()?` | (`stage`, `fraction`) => `void` | - |
| `renderer` | `THREE.WebGPURenderer` | an initialized WebGPURenderer. Required — `createHeadlessRenderer()` makes one in Node. |

***

### BakeResult

```ts
type BakeResult = {
  exposure: number;
  height: number;
  image: Float32Array;
  manifest: Omit<LightmapManifest, "texture">;
  utilization: number;
  width: number;
};
```

The baker. Node only — pulls in Dawn, sharp and xatlas. See `tscene/bakery` for the runtime half.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="exposure"></a> `exposure` | `number` | divisor that maps `image` into [0,1] for an 8-bit texture; also the `lightMapIntensity` to use |
| <a id="height-1"></a> `height` | `number` | - |
| <a id="image"></a> `image` | `Float32Array` | linear irradiance, RGBA, `width * height * 4`, bottom row first. Alpha marks covered texels. |
| <a id="manifest"></a> `manifest` | `Omit`\<[`LightmapManifest`](../bakery.md#lightmapmanifest-1), `"texture"`\> | everything the runtime needs except the texture file name, which the writer fills in |
| <a id="utilization-1"></a> `utilization` | `number` | fraction of the atlas the charts cover |
| <a id="width-1"></a> `width` | `number` | - |

***

### BakeScene

```ts
type BakeScene = {
  bounds: THREE.Box3;
  lights: BakeLight[];
  materials: BakeMaterial[];
  meshes: BakeMesh[];
  sky: BakeSky;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="bounds"></a> `bounds` | `THREE.Box3` | world-space bounds of everything collected, for picking a default ray bias |
| <a id="lights"></a> `lights` | [`BakeLight`](#bakelight)[] | - |
| <a id="materials"></a> `materials` | [`BakeMaterial`](#bakematerial)[] | - |
| <a id="meshes"></a> `meshes` | [`BakeMesh`](#bakemesh)[] | - |
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
type BakeStage = "unwrap" | "rasterize" | "trace" | "filter";
```

The baker. Node only — pulls in Dawn, sharp and xatlas. See `tscene/bakery` for the runtime half.

***

### CollectOptions

```ts
type CollectOptions = {
  defaultAlbedo?: number;
  include?: "all" | "none";
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="defaultalbedo"></a> `defaultAlbedo?` | `number` | default albedo for materials without a `color` (linear grey) |
| <a id="include"></a> `include?` | `"all"` \| `"none"` | `all` (the default) bakes every visible mesh except the ones that turn themselves off; `none` bakes only the ones that opt in. Defaults to the root's own `@bakery { include }`. |

***

### Texels

```ts
type Texels = {
  height: number;
  index: Uint32Array;
  mask: Uint8Array;
  normal: Float32Array;
  position: Float32Array;
  width: number;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="height-2"></a> `height` | `number` | - |
| <a id="index"></a> `index` | `Uint32Array` | the covered texel indices, ascending — what the compute shader is dispatched over |
| <a id="mask"></a> `mask` | `Uint8Array` | width*height, 1 where a chart covers the texel |
| <a id="normal"></a> `normal` | `Float32Array` | width*height*4 — world normal xyz, material id in w |
| <a id="position-1"></a> `position` | `Float32Array` | width*height*4 — world position xyz, w unused |
| <a id="width-2"></a> `width` | `number` | - |

***

### TraceOptions

```ts
type TraceOptions = {
  batch?: number;
  bias?: number;
  bounces?: number;
  indirect?: number;
  onProgress?: (fraction) => void;
  samples?: number;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="batch"></a> `batch?` | `number` | paths per dispatch. Lower it if the driver kills long compute passes. |
| <a id="bias"></a> `bias?` | `number` | ray origin offset along the normal. Defaults to 1e-4 of the scene diagonal. |
| <a id="bounces"></a> `bounces?` | `number` | diffuse bounces after the first hit — 4 is plenty indoors, 2 outdoors |
| <a id="indirect"></a> `indirect?` | `number` | gain on everything past the first bounce — 1 is physical, >1 the usual cheat for a flat-looking interior. Direct light and the sky seen straight from a texel are untouched. |
| <a id="onprogress"></a> `onProgress?` | (`fraction`) => `void` | - |
| <a id="samples"></a> `samples?` | `number` | total paths per texel. This is the only real quality knob. |

***

### UnwrapOptions

```ts
type UnwrapOptions = {
  padding?: number;
  size?: number;
  texelsPerUnit?: number;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="padding"></a> `padding?` | `number` | texels of empty space around every chart — must be >= the dilation radius |
| <a id="size"></a> `size?` | `number` | target atlas edge length in texels. xatlas picks the chart scale from this and then packs, so the atlas it returns is around this size rather than exactly it — read `Atlas.width` for the truth. |
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
function bvhProxy(scene): Group;
```

The scene as three-mesh-bvh wants it: one Mesh per bake mesh, already in world space so every
transform in the TLAS is the identity. The per-triangle material id rides along in `normal.w`,
which saves a parallel buffer — BVHComputeData interpolates and uploads normals anyway.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `scene` | [`BakeScene`](#bakescene) |

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
   radius?): Uint8Array;
```

Grows the lit region outward by `radius` texels, averaging whatever is already lit. Without this a
bilinear tap just outside a chart reads black and every chart gets a dark rim.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `image` | `Float32Array` | `undefined` |
| `mask` | `Uint8Array` | `undefined` |
| `width` | `number` | `undefined` |
| `height` | `number` | `undefined` |
| `radius` | `number` | `4` |

#### Returns

`Uint8Array`

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

### rasterize()

```ts
function rasterize(meshes, atlas): Texels;
```

Texture space, not image space: texel row 0 is v = 0. That matches a `DataTexture` directly and
costs the PNG/EXR writers one row flip.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `meshes` | [`BakeMesh`](#bakemesh)[] |
| `atlas` | [`Atlas`](#atlas) |

#### Returns

[`Texels`](#texels)

***

### trace()

```ts
function trace(
   renderer, 
   scene, 
   texels, 
opts?): Promise<Float32Array<ArrayBufferLike>>;
```

Irradiance per covered texel: 4 floats each, (E.rgb, samples).

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

Writes `<dir>/<name>.png` (exposure-scaled sRGB) and `<dir>/<name>.lightmap.json`.

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

### MaterialBakery

Re-exports [MaterialBakery](../index.md#materialbakery)

***

### NodeBakery

Re-exports [NodeBakery](../index.md#nodebakery)

***

### nodeKey

Re-exports [nodeKey](../bakery.md#nodekey)

***

### SceneBakery

Re-exports [SceneBakery](../index.md#scenebakery)
