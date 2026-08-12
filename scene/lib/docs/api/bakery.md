[**tscene**](README.md)

***

[tscene](README.md) / bakery

# bakery

## Type Aliases

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
const { manifest, texture } = await loadLightmap("/lightmaps/room.lightmap.json");
applyLightmap(scene, manifest, texture);
muteBakedLights(scene);
```

The atlas holds irradiance, which is exactly what three's `lightMap` slot expects, so this is a
texture assignment and a `uv1` attribute — no custom material.

The baker itself pulls in sharp, xatlas and Dawn, so it lives behind `tscene/bakery/node`:

```ts
import { bake, createHeadlessRenderer, loadSceneFile, writeBake } from "tscene/bakery/node";

const renderer = await createHeadlessRenderer();
const result = await bake(await loadSceneFile("room.tscene"), { renderer, samples: 1024 });
await writeBake(result, "public/lightmaps", "room");
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="height"></a> `height` | `number` | - |
| <a id="intensity"></a> `intensity` | `number` | `lightMapIntensity` that undoes the exposure baked into an 8-bit texture |
| <a id="meshes"></a> `meshes` | \{ `key`: `string`; `uv`: `string`; `vertices`: `number`; \}[] | - |
| <a id="texture"></a> `texture` | `string` | texture file name, relative to the manifest |
| <a id="version"></a> `version` | `1` | - |
| <a id="width"></a> `width` | `number` | - |

## Functions

### applyLightmap()

```ts
function applyLightmap(
   root, 
   manifest, 
   texture): number;
```

De-indexes every baked mesh, attaches its `uv1`, and points the materials at the lightmap.

The uvs are per triangle corner, which is why the geometry has to be non-indexed — two triangles
sharing a vertex almost never share a lightmap texel. `bakeGeometry()` produced the same layout
during the bake, and `toNonIndexed()` is deterministic, so the vertex counts lining up is a real
check that the manifest belongs to this scene.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `root` | `Object3D` |
| `manifest` | [`LightmapManifest`](#lightmapmanifest) |
| `texture` | `Texture` |

#### Returns

`number`

the number of meshes that got a lightmap.

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
const { manifest, texture } = await loadLightmap("/lightmaps/room.lightmap.json");
applyLightmap(scene, manifest, texture);
muteBakedLights(scene);
```

The atlas holds irradiance, which is exactly what three's `lightMap` slot expects, so this is a
texture assignment and a `uv1` attribute — no custom material.

The baker itself pulls in sharp, xatlas and Dawn, so it lives behind `tscene/bakery/node`:

```ts
import { bake, createHeadlessRenderer, loadSceneFile, writeBake } from "tscene/bakery/node";

const renderer = await createHeadlessRenderer();
const result = await bake(await loadSceneFile("room.tscene"), { renderer, samples: 1024 });
await writeBake(result, "public/lightmaps", "room");
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
const { manifest, texture } = await loadLightmap("/lightmaps/room.lightmap.json");
applyLightmap(scene, manifest, texture);
muteBakedLights(scene);
```

The atlas holds irradiance, which is exactly what three's `lightMap` slot expects, so this is a
texture assignment and a `uv1` attribute — no custom material.

The baker itself pulls in sharp, xatlas and Dawn, so it lives behind `tscene/bakery/node`:

```ts
import { bake, createHeadlessRenderer, loadSceneFile, writeBake } from "tscene/bakery/node";

const renderer = await createHeadlessRenderer();
const result = await bake(await loadSceneFile("room.tscene"), { renderer, samples: 1024 });
await writeBake(result, "public/lightmaps", "room");
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
  `manifest`: [`LightmapManifest`](#lightmapmanifest);
  `texture`: `Texture`;
\}\>

***

### muteBakedLights()

```ts
function muteBakedLights(root): void;
```

Zeroes the lights a bake already accounted for. Leaving them on double counts every direct
contribution; call this right after `applyLightmap`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `root` | `Object3D` |

#### Returns

`void`

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
