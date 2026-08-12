[**tscene**](README.md)

***

[tscene](README.md) / bakery

# bakery

## Type Aliases

### Lightmap

```ts
type Lightmap = {
  enabled: boolean;
  height: number;
  intensity: number;
  lights: ReadonlyMap<THREE.Light, number>;
  manifest: LightmapManifest;
  meshes: number;
  texture: THREE.Texture;
  width: number;
  dispose: void;
};
```

A bake that is on a scene. Handed back by [applyLightmap](#applylightmap); there is nothing to construct.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="enabled"></a> `enabled` | `public` | `boolean` | `false` puts the scene back on its own lights: the atlas goes to zero and every light the bake accounted for gets the intensity it had when this handle was made. |
| <a id="height"></a> `height` | `readonly` | `number` | - |
| <a id="intensity"></a> `intensity` | `public` | `number` | Gain on the exposure the bake wrote into the manifest, so 1 is "as baked". An 8-bit atlas of a scene whose bright end sits far above what matters wants this above 1. |
| <a id="lights"></a> `lights` | `readonly` | `ReadonlyMap`\<`THREE.Light`, `number`\> | The lights the bake already contains → the intensity each had when the atlas was applied. A realtime pass scales these instead of snapshotting its own. |
| <a id="manifest"></a> `manifest` | `readonly` | [`LightmapManifest`](#lightmapmanifest-1) | - |
| <a id="meshes"></a> `meshes` | `readonly` | `number` | how many meshes the atlas reached |
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
  height: number;
  intensity: number;
  meshes: {
     key: string;
     uv: string;
     vertices: number;
  }[];
  texture: string;
  version: 1;
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
| <a id="height-1"></a> `height` | `number` | - |
| <a id="intensity-1"></a> `intensity` | `number` | `lightMapIntensity` that undoes the exposure baked into an 8-bit texture |
| <a id="meshes-1"></a> `meshes` | \{ `key`: `string`; `uv`: `string`; `vertices`: `number`; \}[] | - |
| <a id="texture-1"></a> `texture` | `string` | texture file name, relative to the manifest |
| <a id="version"></a> `version` | `1` | - |
| <a id="width-1"></a> `width` | `number` | - |

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
| `source` | \| `string` \| \{ `manifest`: [`LightmapManifest`](#lightmapmanifest-1); `texture`: `Texture`; \} |
| `opts` | \{ `manager?`: `LoadingManager`; \} |
| `opts.manager?` | `LoadingManager` |

#### Returns

`Promise`\<[`Lightmap`](#lightmap)\>

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
function loadLightmap(url, manager?): Promise<{
  manifest: LightmapManifest;
  texture: Texture;
}>;
```

Fetches a manifest plus its texture. `url` is the manifest; the texture is resolved next to it.
Browser-side convenience — the baker writes both files with matching names.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `url` | `string` |
| `manager?` | `LoadingManager` |

#### Returns

`Promise`\<\{
  `manifest`: [`LightmapManifest`](#lightmapmanifest-1);
  `texture`: `Texture`;
\}\>

***

### nodeKey()

```ts
function nodeKey(root, o): string;
```

Path from `root` to `o`, using node names where there are any. Stable across reloads of the same sheet.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `root` | `Object3D` |
| `o` | `Object3D` |

#### Returns

`string`
