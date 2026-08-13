[**tscene**](README.md)

***

[tscene](README.md) / index

# index

## Classes

### SceneSyntaxError

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new SceneSyntaxError(message, pos): SceneSyntaxError;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `pos` | [`Pos`](#pos-1) |

###### Returns

[`SceneSyntaxError`](#scenesyntaxerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="pos"></a> `pos` | [`Pos`](#pos-1) |

## Type Aliases

### Binding

```ts
type Binding = {
  decl: Pos;
  use: Pos;
};
```

a resolved use site and the declaration it resolved to — what "find references" and "rename" run on

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="decl"></a> `decl` | [`Pos`](#pos-1) |
| <a id="use"></a> `use` | [`Pos`](#pos-1) |

***

### Comment

```ts
type Comment = Pos & {
  text: string;
};
```

#### Type Declaration

| Name | Type |
| ------ | ------ |
| `text` | `string` |

***

### Diagnostic

```ts
type Diagnostic = Pos & {
  fix?: {
     end: number;
     start: number;
     text: string;
  };
  message: string;
  severity: "error" | "warning";
};
```

#### Type Declaration

| Name | Type | Description |
| ------ | ------ | ------ |
| `fix?` | \{ `end`: `number`; `start`: `number`; `text`: `string`; \} | single-range text replacement the autofixer may apply |
| `fix.end` | `number` | - |
| `fix.start` | `number` | - |
| `fix.text` | `string` | - |
| `message` | `string` | - |
| `severity` | `"error"` \| `"warning"` | - |

***

### Expanded

```ts
type Expanded = {
  bindings: Binding[];
  diagnostics: Diagnostic[];
  ids: Map<string, ObjectValue>;
  nodes: Member[];
  templates: Template[];
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="bindings"></a> `bindings` | [`Binding`](#binding)[] | - |
| <a id="diagnostics"></a> `diagnostics` | [`Diagnostic`](#diagnostic)[] | - |
| <a id="ids"></a> `ids` | `Map`\<`string`, [`ObjectValue`](#objectvalue)\> | `#id` → the node that declared it, in document order |
| <a id="nodes"></a> `nodes` | [`Member`](#member)[] | - |
| <a id="templates"></a> `templates` | [`Template`](#template)[] | - |

***

### HotListener

```ts
type HotListener = (mod) => void;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `mod` | [`SceneModule`](#scenemodule) |

#### Returns

`void`

***

### Knob

```ts
type Knob = {
  length?: number;
  type: "number" | "string" | "boolean" | "numbers";
  values?: string[];
};
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="length"></a> `length?` | `number` |
| <a id="type"></a> `type` | `"number"` \| `"string"` \| `"boolean"` \| `"numbers"` |
| <a id="values"></a> `values?` | `string`[] |

***

### Loader

```ts
type Loader = (path, from) => Promise<{
  file: string;
  text: string;
}>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `string` |
| `from` | `string` \| `undefined` |

#### Returns

`Promise`\<\{
  `file`: `string`;
  `text`: `string`;
\}\>

***

### LoadOptions

```ts
type LoadOptions = {
  base?: string;
  draco?: string;
  ktx2?: {
     path: string;
     renderer: unknown;
  };
  lightmap?: boolean;
  load?: Loader;
  manager?: LoadingManager;
  registry?: Record<string, any>;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="base"></a> `base?` | `string` | - |
| <a id="draco"></a> `draco?` | `string` | path to three's draco decoder, for gltf() files that use it |
| <a id="ktx2"></a> `ktx2?` | \{ `path`: `string`; `renderer`: `unknown`; \} | transcoder path + the renderer whose support is probed, for gltf() files with ktx2 textures |
| `ktx2.path` | `string` | - |
| `ktx2.renderer` | `unknown` | - |
| <a id="lightmap"></a> `lightmap?` | `boolean` | `false` ignores the sheet's own `@bakery { lightmap }`. What the baker passes — it is the thing producing the atlas, and applying one mid-bake would zero the lights it is about to trace. |
| <a id="load"></a> `load?` | [`Loader`](#loader) | - |
| <a id="manager"></a> `manager?` | `LoadingManager` | shared LoadingManager — its onProgress/onLoad see every texture() and gltf() |
| <a id="registry"></a> `registry?` | `Record`\<`string`, `any`\> | Constructors and constants by name, e.g. `{ water: Water }` — looked up before the sheet's own build-time imports. A sheet loaded from a string has none of those, so it needs the whole set: `import { threeRegistry } from "tscene/three"`. |

***

### MaterialBakery

```ts
type MaterialBakery = {
  albedo?: [number, number, number];
};
```

A material's own `@bakery { … }`.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="albedo"></a> `albedo?` | \[`number`, `number`, `number`\] | the linear reflectance the tracer bounces off this material, overriding the guess from `map`/`color` |

***

### Member

```ts
type Member = 
  | Pos & {
  kind: "prop";
  name: string;
  value: Value;
}
  | Pos & {
  kind: "node";
  object: ObjectValue;
}
  | Pos & {
  kind: "var";
  name: string;
  namePos: Pos;
  value: Value;
}
  | Pos & {
  kind: "at";
  name: string;
  value: RecordValue;
};
```

***

### Mount

```ts
type Mount = {
  root: Group | undefined;
  dispose: void;
  reload: Promise<void>;
  update: void;
};
```

A sheet that is on screen. Handed back by [mountScene](#mountscene).

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="root"></a> `root` | `readonly` | `Group` \| `undefined` | what is in the parent right now — `undefined` only if the very first build failed |

#### Methods

##### dispose()

```ts
dispose(): void;
```

Stops listening for hot updates and disposes the current root.

###### Returns

`void`

##### reload()

```ts
reload(): Promise<void>;
```

Rebuilds from the sheet's current source. A hot update does this for you.

###### Returns

`Promise`\<`void`\>

##### update()

```ts
update(delta?): void;
```

Advances the clips `play()` started. Call it once per frame; without an argument the mount times
the frames itself.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `delta?` | `number` |

###### Returns

`void`

***

### MountOptions

```ts
type MountOptions = LoadOptions & {
  hmr?: boolean;
  onError?: (error) => void;
  onLoad?: (root) => void;
};
```

#### Type Declaration

| Name | Type | Description |
| ------ | ------ | ------ |
| `hmr?` | `boolean` | rebuild whenever the vite plugin hot-replaces a sheet (default true) |
| `onError()?` | (`error`) => `void` | Where a failed build goes. With this set nothing throws and the previous root stays up, which is what an on-screen error message wants; without it the first build rejects and a failed reload lands on the console. |
| `onLoad()?` | (`root`) => `void` | after every successful build, hot updates included — where to grab nodes or apply a lightmap |

***

### NodeBakery

```ts
type NodeBakery = {
  density?: number;
  enabled?: boolean | "occluder";
  probe?: number;
  radius?: number;
};
```

A node's own `@bakery { … }`. Both keys are inherited by the subtree unless a child overrides them.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="density"></a> `density?` | `number` | lightmap texels per world unit, relative to the rest of the scene. 2 gives this node twice the resolution in each direction — so four times the atlas area — and 0.5 a quarter of it. |
| <a id="enabled"></a> `enabled?` | `boolean` \| `"occluder"` | `false` keeps the node out of the bake entirely — as an occluder *and* a receiver — and on a light means it stays live at runtime. `occluder` keeps it in the ray tracing but gives it no lightmap of its own, which is what a proxy or a mesh too big to unwrap wants. |
| <a id="probe"></a> `probe?` | `number` | Bake a reflection probe at this node's world position: an equirectangular map of the radiance leaving every direction, `probe` texels wide and half that tall. A metal has no diffuse lobe for the atlas to light, so this is what it reflects instead. 256 is plenty for anything but a mirror. |
| <a id="radius"></a> `radius?` | `number` | soft shadows: the light becomes a sphere of this world radius (a directional light reads radians) |

***

### ObjectValue

```ts
type ObjectValue = Pos & {
  args: Value[];
  body: Member[];
  classes: string[];
  classSpans: Pos[];
  hasBody: boolean;
  id?: string;
  idSpan?: Pos;
  kind: "object";
  name: string;
};
```

#### Type Declaration

| Name | Type | Description |
| ------ | ------ | ------ |
| `args` | [`Value`](#value)[] | - |
| `body` | [`Member`](#member)[] | - |
| `classes` | `string`[] | - |
| `classSpans` | [`Pos`](#pos-1)[] | source range of each `.cls` including the dot, index-aligned with `classes` |
| `hasBody` | `boolean` | - |
| `id?` | `string` | - |
| `idSpan?` | [`Pos`](#pos-1) | source range of `#id` including the hash |
| `kind` | `"object"` | - |
| `name` | `string` | - |

***

### Pos

```ts
type Pos = {
  end: number;
  file?: string;
  start: number;
};
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="end"></a> `end` | `number` |
| <a id="file"></a> `file?` | `string` |
| <a id="start"></a> `start` | `number` |

***

### RecordValue

```ts
type RecordValue = Extract<Value, {
  kind: "record";
}>;
```

***

### SceneBakery

```ts
type SceneBakery = {
  ao?: boolean;
  aoDistance?: number;
  batch?: number;
  bias?: number;
  bounces?: number;
  defaultAlbedo?: number;
  denoiseRadius?: number;
  dilateRadius?: number;
  exposure?: number;
  exr?: boolean;
  include?: "all" | "none";
  indirect?: number;
  lightmap?: string;
  name?: string;
  out?: string;
  padding?: number;
  samples?: number;
  size?: number;
  texelsPerUnit?: number;
};
```

What a sheet's own `@bakery { … }` block sets: every knob of `bakeSceneFile()` except the renderer.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="ao"></a> `ao?` | `boolean` | also write `<name>.ao.png` and point the materials' `aoMap` at it |
| <a id="aodistance"></a> `aoDistance?` | `number` | how far an occlusion ray looks for a blocker; 0 (the default) picks 5% of the scene diagonal |
| <a id="batch"></a> `batch?` | `number` | - |
| <a id="bias"></a> `bias?` | `number` | ray origin offset along the normal; 0 (the default) picks 1e-4 of the scene diagonal |
| <a id="bounces"></a> `bounces?` | `number` | - |
| <a id="defaultalbedo"></a> `defaultAlbedo?` | `number` | reflectance of a material with no `color` at all |
| <a id="denoiseradius"></a> `denoiseRadius?` | `number` | - |
| <a id="dilateradius"></a> `dilateRadius?` | `number` | - |
| <a id="exposure"></a> `exposure?` | `number` | The divisor that packs the atlas into the 8-bit PNG, undone at runtime by `lightMapIntensity`, so it decides quantization and not brightness. Absent, the bake picks the 95th percentile of the atlas — which moves a little between bakes of a noisy scene. Set it to make that reproducible. |
| <a id="exr"></a> `exr?` | `boolean` | - |
| <a id="include"></a> `include?` | `"all"` \| `"none"` | `all` bakes every mesh but the ones that turn themselves off; `none` bakes only the ones that opt in |
| <a id="indirect"></a> `indirect?` | `number` | - |
| <a id="lightmap-1"></a> `lightmap?` | `string` | Runtime, not bake: the manifest `loadScene` applies to this sheet once it is built — what `tscene-bake` wrote with the settings above. The handle lands on `root.userData.lightmap`. Resolved against the sheet's url, and against the document for a sheet a bundler inlined (it has a file path, not a url). The manifest's own siblings — the png and the exr — are never bundled either, so a built app wants all three in `public/` and a path like `/lightmaps/room.lightmap.json`. |
| <a id="name"></a> `name?` | `string` | - |
| <a id="out"></a> `out?` | `string` | where to write, relative to the sheet |
| <a id="padding"></a> `padding?` | `number` | - |
| <a id="samples"></a> `samples?` | `number` | - |
| <a id="size"></a> `size?` | `number` | - |
| <a id="texelsperunit"></a> `texelsPerUnit?` | `number` | - |

***

### SceneModule

```ts
type SceneModule = {
  assets?: Record<string, string>;
  file: string;
  imports?: Record<string, string>;
  registry?: Record<string, unknown>;
  source: string;
};
```

What the vite plugin's `import scene from "./main.tscene"` gives you: one sheet, one module.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="assets"></a> `assets?` | `Record`\<`string`, `string`\> | `texture("./t.png")` → the url the bundler resolved it to |
| <a id="file-1"></a> `file` | `string` | - |
| <a id="imports"></a> `imports?` | `Record`\<`string`, `string`\> | - |
| <a id="registry-1"></a> `registry?` | `Record`\<`string`, `unknown`\> | the three exports this sheet names, imported by the plugin so the bundler sees them one by one |
| <a id="source"></a> `source` | `string` | - |

***

### Sheet

```ts
type Sheet = {
  comments: Comment[];
  errors: Diagnostic[];
  file?: string;
  statements: Statement[];
  text: string;
};
```

`errors` is what the parser could not make sense of; `statements` is everything it could.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="comments"></a> `comments` | [`Comment`](#comment)[] |
| <a id="errors"></a> `errors` | [`Diagnostic`](#diagnostic)[] |
| <a id="file-2"></a> `file?` | `string` |
| <a id="statements"></a> `statements` | [`Statement`](#statement)[] |
| <a id="text"></a> `text` | `string` |

***

### Statement

```ts
type Statement = 
  | Member
  | Pos & {
  kind: "import";
  path: string;
}
  | Pos & {
  body: Member[];
  kind: "template";
  name: string;
  namePos: Pos;
  node?: string;
};
```

***

### Template

```ts
type Template = Extract<Statement, {
  kind: "template";
}>;
```

***

### Tok

```ts
type Tok = Pos & {
  type: TokType;
  unit?: string;
  value: string;
};
```

#### Type Declaration

| Name | Type |
| ------ | ------ |
| `type` | [`TokType`](#toktype) |
| `unit?` | `string` |
| `value` | `string` |

***

### TokType

```ts
type TokType = "ident" | "number" | "string" | "hash" | "at" | "var" | "punc" | "eof";
```

***

### Value

```ts
type Value = 
  | Pos & {
  kind: "number";
  unit: "" | "deg" | "rad";
  value: number;
}
  | Pos & {
  kind: "string";
  value: string;
}
  | Pos & {
  kind: "hex";
  value: number;
}
  | Pos & {
  kind: "ident";
  name: string;
}
  | Pos & {
  fallback?: Value;
  kind: "var";
  name: string;
  namePos: Pos;
}
  | Pos & {
  kind: "ref";
  name: string;
  namePos: Pos;
  node?: string;
}
  | Pos & {
  items: Value[];
  kind: "array";
}
  | Pos & {
  entries: {
     name: string;
     namePos: Pos;
     value: Value;
  }[];
  kind: "record";
}
  | Pos & {
  kind: "calc";
  left: Value;
  op: "+" | "-" | "*" | "/";
  right: Value;
}
  | ObjectValue;
```

## Variables

### ALIASES

```ts
const ALIASES: Record<string, string>;
```

call-name → three class. `texture`/`gltf` are loader-backed.

***

### BAKERY

```ts
const BAKERY: Record<"scene" | "node" | "material", Record<string, Knob>>;
```

`@bakery { … }` is settings for the baker, not for three, so the schema cannot type it — this table
is what the checker validates against, per position. Adding a knob to [SceneBakery](#scenebakery) and friends
without a row here means the checker rejects it.

***

### BUILTINS

```ts
const BUILTINS: Record<string, {
  signature: string;
  summary: string;
  topLevel: boolean;
}>;
```

Names that look like nodes but are handled by the language itself, never looked up in three.
The checker dispatches on this table and `docs/language.md` is checked against it, so a new
builtin cannot be added without a section in the docs.

***

### LOADERS

```ts
const LOADERS: Record<string, {
  args: TypeRef[];
  class: string;
}>;
```

## Functions

### applyFixes()

```ts
function applyFixes(text, diagnostics): string;
```

Apply non-overlapping single-range fixes to source text.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `text` | `string` |
| `diagnostics` | [`Diagnostic`](#diagnostic)[] |

#### Returns

`string`

***

### className()

```ts
function className(name): string;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |

#### Returns

`string`

***

### concrete()

```ts
function concrete(cls): string;
```

The class to resolve `a.b` against when `a`'s declared type is an abstract base. `Mesh.material` is
declared `Material`, so `material.emissive: …` on a mesh inside a loaded glTF would not type-check
even though every material a loader produces has it.

ponytail: a table of one, and it widens rather than narrows — `material.emissive` on a mesh whose
material really is a `MeshBasicMaterial` type-checks and then does nothing at runtime. Add entries
as other abstract classes turn up in paths; a per-object check would need the loaded scene.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `cls` | `string` |

#### Returns

`string`

***

### disposeScene()

```ts
function disposeScene(root): void;
```

Frees the GPU resources of a scene built by loadScene — call it before dropping a root,
otherwise every hot reload leaks its geometries, materials and textures. What came out of the
asset cache is left alone: it is shared with every other use of the same url.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `root` | `Object3D` |

#### Returns

`void`

***

### expand()

```ts
function expand(sheet, load?): Promise<Expanded>;
```

Resolves @import, substitutes var(--x) and applies .class templates.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `sheet` | [`Sheet`](#sheet) |
| `load?` | [`Loader`](#loader) |

#### Returns

`Promise`\<[`Expanded`](#expanded)\>

***

### lineCol()

```ts
function lineCol(text, offset): {
  col: number;
  line: number;
};
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `text` | `string` |
| `offset` | `number` |

#### Returns

```ts
{
  col: number;
  line: number;
}
```

| Name | Type |
| ------ | ------ |
| `col` | `number` |
| `line` | `number` |

***

### loadScene()

```ts
function loadScene(src, opts?): Promise<Group<Object3DEventMap>>;
```

Parses `src` and builds the scene graph. Top-level nodes become children of the returned group.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `src` | `string` \| [`SceneModule`](#scenemodule) |
| `opts` | [`LoadOptions`](#loadoptions) |

#### Returns

`Promise`\<`Group`\<`Object3DEventMap`\>\>

***

### loadSceneFromURL()

```ts
function loadSceneFromURL(url, opts?): Promise<Group<Object3DEventMap>>;
```

Convenience: fetch a .tscene file and build it.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `url` | `string` |
| `opts` | [`LoadOptions`](#loadoptions) |

#### Returns

`Promise`\<`Group`\<`Object3DEventMap`\>\>

***

### mountScene()

```ts
function mountScene(
   parent, 
   src, 
opts?): Promise<Mount>;
```

Builds a sheet into `parent` and keeps it there: hot updates rebuild it, the old root is disposed
once the new one is up, and `update()` drives the clips.

```ts
const mount = await mountScene(scene, sheet, { onError: (e) => (msg.textContent = String(e)) });
renderer.setAnimationLoop(() => { mount.update(); renderer.render(scene, camera); });
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `parent` | `Object3D` |
| `src` | `string` \| [`SceneModule`](#scenemodule) |
| `opts` | [`MountOptions`](#mountoptions) |

#### Returns

`Promise`\<[`Mount`](#mount)\>

***

### nodeName()

```ts
function nodeName(cls): string;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `cls` | `string` |

#### Returns

`string`

***

### onSceneChange()

```ts
function onSceneChange(fn): () => void;
```

Called when the vite plugin hot-replaces a `.tscene` file. Returns an unsubscribe.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fn` | [`HotListener`](#hotlistener) |

#### Returns

() => `void`

***

### parse()

```ts
function parse(text, file?): Sheet;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `text` | `string` |
| `file?` | `string` |

#### Returns

[`Sheet`](#sheet)

***

### print()

```ts
function print(sheet): string;
```

Re-print a sheet with canonical formatting. Comments are kept but always land on their own line.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `sheet` | [`Sheet`](#sheet) |

#### Returns

`string`

***

### updateScene()

```ts
function updateScene(root, delta): void;
```

Advances every clip play() started. Call it once per frame with the frame time in seconds.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `root` | `Object3D` |
| `delta` | `number` |

#### Returns

`void`

## References

### ClassInfo

Re-exports [ClassInfo](tools.md#classinfo)

***

### PropInfo

Re-exports [PropInfo](tools.md#propinfo)

***

### Schema

Re-exports [Schema](tools.md#schema)

***

### TypeRef

Re-exports [TypeRef](tools.md#typeref)
