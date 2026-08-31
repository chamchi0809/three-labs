[**tscene**](README.md)

***

[tscene](README.md) / bakery

# bakery

## Type Aliases

### Lightmap

```ts
type Lightmap = {
  ao?: THREE.Texture;
  enabled: boolean;
  environment: number;
  height: number;
  intensity: number;
  lights: ReadonlyMap<THREE.Light, number>;
  manifest: LightmapManifest;
  meshes: number;
  probes: readonly THREE.Texture[];
  texture: THREE.Texture;
  width: number;
  dispose: void;
};
```

A bake that is on a scene. Handed back by [applyLightmap](#applylightmap); there is nothing to construct.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="ao"></a> `ao?` | `readonly` | `THREE.Texture` | the occlusion atlas, when the bake wrote one and it is on the materials' `aoMap` |
| <a id="enabled"></a> `enabled` | `public` | `boolean` | `false` puts the scene back on its own lights: the atlas goes to zero and every light the bake accounted for gets the intensity it had when this handle was made. |
| <a id="environment"></a> `environment` | `public` | `number` | Gain on the reflection probes, independent of [Lightmap.enabled](#enabled) — a metal reflects whether or not the diffuse atlas is showing. 1 is "as baked", 0 takes the probes off visually. |
| <a id="height"></a> `height` | `readonly` | `number` | - |
| <a id="intensity"></a> `intensity` | `public` | `number` | Gain on the exposure the bake wrote into the manifest, so 1 is "as baked". An 8-bit atlas of a scene whose bright end sits far above what matters wants this above 1. |
| <a id="lights"></a> `lights` | `readonly` | `ReadonlyMap`\<`THREE.Light`, `number`\> | The lights the bake already contains → the intensity each had when the atlas was applied. A realtime pass scales these instead of snapshotting its own. |
| <a id="manifest"></a> `manifest` | `readonly` | [`LightmapManifest`](#lightmapmanifest-1) | - |
| <a id="meshes"></a> `meshes` | `readonly` | `number` | how many meshes the atlas reached |
| <a id="probes"></a> `probes` | `readonly` | readonly `THREE.Texture`[] | the baked probes, in manifest order — on the `envMap` of every metallic material they reach |
| <a id="texture"></a> `texture` | `readonly` | `THREE.Texture` | - |
| <a id="width"></a> `width` | `readonly` | `number` | - |

#### Methods

##### dispose()

```ts
dispose(): void;
```

Drops the atlas off the materials, restores the lights, and disposes a texture this call loaded.

###### Returns

`void`

***

### LightmapManifest

```ts
type LightmapManifest = {
  ao?: string;
  hdr?: string;
  height: number;
  intensity: number;
  meshes: {
     key: string;
     uv: string;
     vertices: number;
  }[];
  probes?: {
     influence?: number;
     key: string;
     position: [number, number, number];
     texture: string;
  }[];
  texture: string;
  version: number;
  width: number;
};
```

tscene/bakery — path-traced lightmaps for tscene / three.js scenes, baked on a headless WebGPU
device in Node.

This entry point is the browser half: it applies a bake to a live scene and nothing more.

```ts
const lightmap = await applyLightmap(scene, "/lightmaps/room.lightmap.json");
lightmap.enabled = false;   // and the scene is back on its own lights
```

The atlas holds irradiance, which is exactly what three's `lightMap` slot expects, so this is a
texture assignment and a `uv1` attribute — no custom material.

The baker itself pulls in sharp, xatlas and Dawn, so it lives behind `tscene/bakery/node`:

```ts
import { bakeSceneFile } from "tscene/bakery/node";

const { files } = await bakeSceneFile("room.tscene", { out: "public/lightmaps", samples: 1024 });
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="ao-1"></a> `ao?` | `string` | the ambient-occlusion PNG next to it, when the bake made one. Goes on `aoMap`. |
| <a id="hdr"></a> `hdr?` | `string` | the float EXR next to it, when one was written — loaded instead of the PNG where support exists |
| <a id="height-1"></a> `height` | `number` | - |
| <a id="intensity-1"></a> `intensity` | `number` | `lightMapIntensity` that undoes the exposure baked into an 8-bit texture |
| <a id="meshes-1"></a> `meshes` | \{ `key`: `string`; `uv`: `string`; `vertices`: `number`; \}[] | - |
| <a id="probes-1"></a> `probes?` | \{ `influence?`: `number`; `key`: `string`; `position`: \[`number`, `number`, `number`\]; `texture`: `string`; \}[] | The reflection probes, in the order the bake walked them: an equirect EXR each, plus the world position it was captured at, which is what picks the one a mesh reflects. |
| <a id="texture-1"></a> `texture` | `string` | texture file name, relative to the manifest |
| <a id="version"></a> `version` | `number` | manifest format. This build writes and reads [MANIFEST\_VERSION](#manifest_version). |
| <a id="width-1"></a> `width` | `number` | - |

***

### PlacedProbe

```ts
type PlacedProbe = {
  influence?: number;
  position: readonly number[];
};
```

A placed probe as [probeWeights](#probeweights) needs it. `influence` 0 or absent means unbounded.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="influence"></a> `influence?` | `number` |
| <a id="position"></a> `position` | readonly `number`[] |

***

### ProbeWeight

```ts
type ProbeWeight = {
  index: number;
  weight: number;
};
```

A probe and how much of `position`'s reflection is its. The weights of a blend sum to 1.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="index"></a> `index` | `number` |
| <a id="weight"></a> `weight` | `number` |

## Variables

### MANIFEST\_VERSION

```ts
const MANIFEST_VERSION: 2 = 2;
```

The manifest format this build produces. A stale `*.lightmap.json` on disk is the most likely thing
a project has lying around, and it used to be read as if it were current.

## Functions

### applyLightmap()

```ts
function applyLightmap(
   root, 
   source, 
opts?): Promise<Lightmap>;
```

Puts a bake on a scene: de-indexes every baked mesh, attaches its `uv1`, points the materials at the
atlas, and zeroes the lights the bake already contains (leaving them on counts every direct
contribution twice).

`source` is either a manifest url — the texture is resolved next to it — or an already loaded pair
from [loadLightmap](#loadlightmap), which is how two roots share one atlas.

```ts
const lightmap = await applyLightmap(root, "lightmaps/room.lightmap.json");
lightmap.enabled = false;   // back to the sheet's own lights
lightmap.intensity = 4;     // brighter than baked
```

The uvs are per triangle corner, which is why the geometry has to be non-indexed — two triangles
sharing a vertex almost never share a lightmap texel. `bakeGeometry()` produced the same layout
during the bake, and `toNonIndexed()` is deterministic, so the vertex counts lining up is a real
check that the manifest belongs to this scene.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `root` | `Object3D` |
| `source` | \| `string` \| \{ `ao?`: `Texture`\<`unknown`, `TextureEventMap`\>; `manifest`: [`LightmapManifest`](#lightmapmanifest-1); `probes?`: `Texture`\<`unknown`, `TextureEventMap`\>[]; `texture`: `Texture`; \} |
| `opts` | \{ `hdr?`: `boolean`; `manager?`: `LoadingManager`; \} |
| `opts.hdr?` | `boolean` |
| `opts.manager?` | `LoadingManager` |

#### Returns

`Promise`\<[`Lightmap`](#lightmap)\>

***

### bakeEnabled()

```ts
function bakeEnabled(o): boolean | "occluder" | undefined;
```

Whether `o` is in the bake: its own `@bakery { enabled }`, or the nearest ancestor that states one.
`undefined` means nobody said, and the sheet's `include` decides. `"occluder"` is in the ray tracing
but gets no lightmap.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `o` | `Object3D` |

#### Returns

`boolean` \| `"occluder"` \| `undefined`

***

### bakeGeometry()

```ts
function bakeGeometry(mesh): BufferGeometry;
```

The geometry the baker unwraps and the runtime must end up with — de-indexed, so a lightmap uv
can differ between two triangles that share a vertex. Deterministic: bake and runtime agree.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `mesh` | `Mesh` |

#### Returns

`BufferGeometry`

***

### bakerySettings()

```ts
function bakerySettings<T>(o): T | undefined;
```

What a sheet's `@bakery { … }` block left on the object it was written in.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* \| [`SceneBakery`](index.md#scenebakery) \| [`NodeBakery`](index.md#nodebakery) \| [`MaterialBakery`](index.md#materialbakery) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `o` | `object` \| `undefined` |

#### Returns

`T` \| `undefined`

***

### decodeFloats()

```ts
function decodeFloats(base64): Float32Array;
```

tscene/bakery — path-traced lightmaps for tscene / three.js scenes, baked on a headless WebGPU
device in Node.

This entry point is the browser half: it applies a bake to a live scene and nothing more.

```ts
const lightmap = await applyLightmap(scene, "/lightmaps/room.lightmap.json");
lightmap.enabled = false;   // and the scene is back on its own lights
```

The atlas holds irradiance, which is exactly what three's `lightMap` slot expects, so this is a
texture assignment and a `uv1` attribute — no custom material.

The baker itself pulls in sharp, xatlas and Dawn, so it lives behind `tscene/bakery/node`:

```ts
import { bakeSceneFile } from "tscene/bakery/node";

const { files } = await bakeSceneFile("room.tscene", { out: "public/lightmaps", samples: 1024 });
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `base64` | `string` |

#### Returns

`Float32Array`

***

### encodeFloats()

```ts
function encodeFloats(data): string;
```

tscene/bakery — path-traced lightmaps for tscene / three.js scenes, baked on a headless WebGPU
device in Node.

This entry point is the browser half: it applies a bake to a live scene and nothing more.

```ts
const lightmap = await applyLightmap(scene, "/lightmaps/room.lightmap.json");
lightmap.enabled = false;   // and the scene is back on its own lights
```

The atlas holds irradiance, which is exactly what three's `lightMap` slot expects, so this is a
texture assignment and a `uv1` attribute — no custom material.

The baker itself pulls in sharp, xatlas and Dawn, so it lives behind `tscene/bakery/node`:

```ts
import { bakeSceneFile } from "tscene/bakery/node";

const { files } = await bakeSceneFile("room.tscene", { out: "public/lightmaps", samples: 1024 });
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `data` | `Float32Array` |

#### Returns

`string`

***

### loadLightmap()

```ts
function loadLightmap(url, opts?): Promise<{
  ao?: Texture<unknown, TextureEventMap>;
  manifest: LightmapManifest;
  probes: Texture<unknown, TextureEventMap>[];
  texture: Texture;
}>;
```

Fetches a manifest plus its texture. `url` is the manifest; the texture is resolved next to it.
Browser-side convenience — the baker writes both files with matching names.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `url` | `string` |
| `opts` | \{ `hdr?`: `boolean`; `manager?`: `LoadingManager`; \} |
| `opts.hdr?` | `boolean` |
| `opts.manager?` | `LoadingManager` |

#### Returns

`Promise`\<\{
  `ao?`: `Texture`\<`unknown`, `TextureEventMap`\>;
  `manifest`: [`LightmapManifest`](#lightmapmanifest-1);
  `probes`: `Texture`\<`unknown`, `TextureEventMap`\>[];
  `texture`: `Texture`;
\}\>

***

### nodeKey()

```ts
function nodeKey(root, o): string;
```

Path from `root` to `o`, using node names where there are any. Stable across reloads of the same
sheet. Two siblings sharing a name are told apart by their index, so a key is always unique —
`find()` and a loaded glTF both hand out repeated names.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `root` | `Object3D` |
| `o` | `Object3D` |

#### Returns

`string`

***

### probeDirection()

```ts
function probeDirection(
   x, 
   y, 
   width, 
   height): [number, number, number];
```

The direction texel `(x, y)` of a `width x height` equirect looks along, from its centre.

The inverse of three's `equirectUV` — `u = atan2(z, x) / 2π + 0.5`, `v = asin(y) / π + 0.5` — which is
what `PMREMGenerator.fromEquirectangular` samples the map with, so this is the mapping the runtime
undoes. Row 0 looks straight down, and the writer flips the atlas on the way to the file, so the EXR's
last scanline is the one under the probe.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `x` | `number` |
| `y` | `number` |
| `width` | `number` |
| `height` | `number` |

#### Returns

\[`number`, `number`, `number`\]

***

### probeWeights()

```ts
function probeWeights(position, probes): ProbeWeight[];
```

The probes `position` reflects: the two nearest that reach it, weighted, nearest first. Empty when
every probe's influence volume excludes it — which is what an author who sets `influence` at all is
asking for, and why the default is unbounded.

The weight is inverse distance times a linear falloff to each probe's own edge. Distance alone is
what makes a mesh sitting on a probe reflect that probe and not half of its neighbour; the falloff
is what stops a probe from vanishing abruptly at the boundary of its volume. With no influence set
anywhere the falloffs are all 1, so the two nearest split the reflection as `d1/(d0+d1)` — the
Voronoi cells this used to hand out, with the seam between two cells softened into a gradient.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `position` | readonly `number`[] |
| `probes` | readonly [`PlacedProbe`](#placedprobe)[] |

#### Returns

[`ProbeWeight`](#probeweight)[]

***

### validateBakery()

```ts
function validateBakery(root, where): void;
```

`@bakery { … }` is settings for a tool, so three drops nothing and a typo bakes silently wrong.
The checker catches it in an editor; this is for a bake that loaded the sheet itself. `where` only
names the source in the message.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `root` | `Object3D` |
| `where` | `string` |

#### Returns

`void`

## References

### MaterialBakery

Re-exports [MaterialBakery](index.md#materialbakery)

***

### NodeBakery

Re-exports [NodeBakery](index.md#nodebakery)

***

### SceneBakery

Re-exports [SceneBakery](index.md#scenebakery)
