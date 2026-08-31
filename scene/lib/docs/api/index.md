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

### BrushFace

```ts
type BrushFace = {
  offset?: Vec2;
  points: [Vec3, Vec3, Vec3];
  rotation?: number;
  scale?: Vec2;
  uv?: UvMode;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="offset"></a> `offset?` | [`Vec2`](#vec2) | metres along the face's own u and v |
| <a id="points"></a> `points` | \[[`Vec3`](#vec3), [`Vec3`](#vec3), [`Vec3`](#vec3)\] | - |
| <a id="rotation"></a> `rotation?` | `number` | radians, about the uv basis normal — a sheet writes `rotation: 30deg` |
| <a id="scale"></a> `scale?` | [`Vec2`](#vec2) | metres of world per full texture tile — not a multiplier |
| <a id="uv"></a> `uv?` | [`UvMode`](#uvmode) | - |

***

### BrushGroup

```ts
type BrushGroup = {
  count: number;
  face: number;
  start: number;
};
```

one contiguous run of the index-free vertex arrays, and the face it came from

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="count"></a> `count` | `number` |
| <a id="face"></a> `face` | `number` |
| <a id="start"></a> `start` | `number` |

***

### BrushMesh

```ts
type BrushMesh = {
  groups: BrushGroup[];
  normals: Float32Array;
  polygons: (Vec3[] | undefined)[];
  positions: Float32Array;
  uvs: Float32Array;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="groups"></a> `groups` | [`BrushGroup`](#brushgroup)[] | in face order, skipping the faces that bound nothing |
| <a id="normals"></a> `normals` | `Float32Array` | - |
| <a id="polygons"></a> `polygons` | ([`Vec3`](#vec3)[] \| `undefined`)[] | the polygon each face turned into, in winding order — what vertex editing and the uv editor read |
| <a id="positions"></a> `positions` | `Float32Array` | - |
| <a id="uvs"></a> `uvs` | `Float32Array` | - |

***

### BrushProblem

```ts
type BrushProblem = {
  face: number;
  message: string;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="face-1"></a> `face` | `number` | the face this is about, or -1 for the solid as a whole |
| <a id="message"></a> `message` | `string` | - |

***

### BrushResult

```ts
type BrushResult = {
  mesh?: BrushMesh;
  problems: BrushProblem[];
};
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="mesh"></a> `mesh?` | [`BrushMesh`](#brushmesh) |
| <a id="problems"></a> `problems` | [`BrushProblem`](#brushproblem)[] |

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

### Compound

```ts
type Compound = Pos & {
  classes: string[];
  classSpans: Pos[];
  id?: string;
  idSpan?: Pos;
  type?: string;
  typeSpan?: Pos;
};
```

One compound selector of an `@override` — `mesh#hero.glow`, in the order those are written on a node.
At least one of the three parts is present; the spans are what rename and "find references" run on.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| `classes` | `string`[] |
| `classSpans` | [`Pos`](#pos-1)[] |
| `id?` | `string` |
| `idSpan?` | [`Pos`](#pos-1) |
| `type?` | `string` |
| `typeSpan?` | [`Pos`](#pos-1) |

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
  overrides: Override[];
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
| <a id="overrides"></a> `overrides` | [`Override`](#override)[] | the `@override` rules of the sheet and everything it imported, in source order |
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
  int?: boolean;
  length?: number;
  max?: number;
  min?: number;
  type: "number" | "string" | "boolean" | "numbers";
  values?: string[];
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="int"></a> `int?` | `boolean` | a count, not a measurement — `size: 1024.5` is a typo and `probe: 2` bakes nothing |
| <a id="length"></a> `length?` | `number` | - |
| <a id="max"></a> `max?` | `number` | - |
| <a id="min"></a> `min?` | `number` | inclusive bounds for a number knob, or for every entry of a `numbers` one |
| <a id="type"></a> `type` | `"number"` \| `"string"` \| `"boolean"` \| `"numbers"` | - |
| <a id="values"></a> `values?` | `string`[] | - |

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
| <a id="ktx2"></a> `ktx2?` | \{ `path`: `string`; `renderer`: `unknown`; \} | transcoder path + the renderer whose support is probed — required by `ktx2()` and by gltf() files with ktx2 textures |
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
  influence?: number;
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
| <a id="influence"></a> `influence?` | `number` | How far this probe reaches, in world units. A mesh outside every probe's influence reflects none of them; inside two, it reflects a blend that fades to nothing at each one's edge. 0 — the default — is unbounded, and a scene of unbounded probes is the plain "nearest two, by distance" it was. |
| <a id="probe"></a> `probe?` | `number` | Bake a reflection probe at this node's world position: an equirectangular map of the radiance leaving every direction, `probe` texels wide and half that tall. A metal has no diffuse lobe for the atlas to light, so this is what it reflects instead. 256 is plenty for anything but a mirror. |
| <a id="radius"></a> `radius?` | `number` | soft shadows: the light becomes a sphere of this world radius (a directional light reads radians) |

***

### NodeBroom

```ts
type NodeBroom = {
  at?: number[];
  color?: number;
  hidden?: boolean;
  icon?: string;
  kind?: "point" | "brush";
  layer?: string;
  link?: string;
  locked?: boolean;
  protect?: string;
  size?: number[];
};
```

A node's `@broom { … }`. On a `@template` it is the entity definition — what the editor puts in its
browser and how it draws an instance. On a node it is that node's place in the workspace.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="at"></a> `at?` | `number`[] | This copy's place in its link set, as 12 row-major numbers of a 4×3 affine transform. A copy's children are stored in world coordinates like everything else, so this is not what draws them — it is what carries an edit from one copy into the others, and it is written down rather than derived because two copies of the same room can sit at the same place in different orientations. |
| <a id="color"></a> `color?` | `number` | the editor's tint for this entity, as a colour |
| <a id="hidden"></a> `hidden?` | `boolean` | - |
| <a id="icon"></a> `icon?` | `string` | - |
| <a id="kind"></a> `kind?` | `"point"` \| `"brush"` | `point` is placed by clicking, `brush` is applied to a selection of solids |
| <a id="layer"></a> `layer?` | `string` | - |
| <a id="link"></a> `link?` | `string` | The link set this group belongs to: every group carrying the same `link` is the same group, and an edit to one is an edit to all of them. A name rather than a generated id so that a designer can read a diff and see that two copies are the same room. |
| <a id="locked"></a> `locked?` | `boolean` | - |
| <a id="protect"></a> `protect?` | `string` | Property names this copy keeps to itself, space separated: `protect: "name visible"`. TrenchBroom's protected properties, and the reason linked groups are usable at all — two copies of a door are the same door except for the one thing that makes them two doors, which is usually a target name. |
| <a id="size"></a> `size?` | `number`[] | the editor's bounding box: min x y z, then max x y z, in metres |

***

### ObjectValue

```ts
type ObjectValue = Pos & {
  args: Value[];
  body: Member[];
  classes: string[];
  classSpans: Pos[];
  dynamic?: true;
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
| `dynamic?` | `true` | Set by expand() on a node inside an `each()` whose value depends on the loop binding. One AST node is normally one instance — that is what makes a material in a `--var` shared — but a node that reads the loop variable has to be built once per iteration. |
| `hasBody` | `boolean` | - |
| `id?` | `string` | - |
| `idSpan?` | [`Pos`](#pos-1) | source range of `#id` including the hash |
| `kind` | `"object"` | - |
| `name` | `string` | - |

***

### Override

```ts
type Override = Extract<Statement, {
  kind: "override";
}>;
```

***

### Patch

```ts
type Patch = {
  grid: PatchGrid;
  offset?: Vec2;
  rotation?: number;
  scale?: Vec2;
  subdivisions?: number;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="grid"></a> `grid` | [`PatchGrid`](#patchgrid-1) | - |
| <a id="offset-1"></a> `offset?` | [`Vec2`](#vec2) | metres along the surface's own u and v |
| <a id="rotation-1"></a> `rotation?` | `number` | radians, in the material's own plane |
| <a id="scale-1"></a> `scale?` | [`Vec2`](#vec2) | metres of world per full texture tile, along the surface — not a multiplier |
| <a id="subdivisions"></a> `subdivisions?` | `number` | Segments per span. Omitted means "as many as the curvature needs", which is what keeps a barely-bent patch from costing sixteen rows and a tight one from looking like a folded map. |

***

### PatchGrid

```ts
type PatchGrid = Vec3[][];
```

The control points, row-major: `grid[row][column]`. Both counts are odd and at least three, which is
what makes the grid an exact number of spans in each direction.

Rows run along v and columns along u, the same way an image's rows run down and its columns run across.

***

### PatchMesh

```ts
type PatchMesh = {
  columns: number;
  indices: Uint32Array;
  normals: Float32Array;
  positions: Float32Array;
  rows: number;
  uvs: Float32Array;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="columns"></a> `columns` | `number` | - |
| <a id="indices"></a> `indices` | `Uint32Array` | - |
| <a id="normals-1"></a> `normals` | `Float32Array` | - |
| <a id="positions-1"></a> `positions` | `Float32Array` | - |
| <a id="rows"></a> `rows` | `number` | the tessellated grid, which is what a tool walks to find the row under the cursor |
| <a id="uvs-1"></a> `uvs` | `Float32Array` | - |

***

### PatchProblem

```ts
type PatchProblem = {
  message: string;
  row: number;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="message-1"></a> `message` | `string` | - |
| <a id="row"></a> `row` | `number` | the row this is about, or -1 for the grid as a whole |

***

### PatchResult

```ts
type PatchResult = {
  mesh?: PatchMesh;
  problems: PatchProblem[];
};
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="mesh-1"></a> `mesh?` | [`PatchMesh`](#patchmesh) |
| <a id="problems-1"></a> `problems` | [`PatchProblem`](#patchproblem)[] |

***

### PatchShape

```ts
type PatchShape = typeof PATCH_SHAPES[number];
```

***

### Plane

```ts
type Plane = {
  d: number;
  n: Vec3;
};
```

`n · x = d`, `n` unit length and pointing out of the solid

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="d"></a> `d` | `number` |
| <a id="n"></a> `n` | [`Vec3`](#vec3) |

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
| <a id="start-1"></a> `start` | `number` |

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
  fireflyThreshold?: number;
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
| <a id="fireflythreshold"></a> `fireflyThreshold?` | `number` | How many times its neighbours' median a texel may be before the bake clamps it back to that — the stray bright dots a path tracer leaves. 0 keeps them. |
| <a id="include"></a> `include?` | `"all"` \| `"none"` | `all` bakes every mesh but the ones that turn themselves off; `none` bakes only the ones that opt in |
| <a id="indirect"></a> `indirect?` | `number` | - |
| <a id="lightmap-1"></a> `lightmap?` | `string` | Runtime, not bake: the manifest `loadScene` applies to this sheet once it is built — what `tscene-bake` wrote with the settings above. The handle lands on `root.userData.lightmap`. Resolved against the sheet's url, and against the document for a sheet a bundler inlined (it has a file path, not a url). The manifest's own siblings — the png and the exr — are never bundled either, so a built app wants all three in `public/` and a path like `/lightmaps/room.lightmap.json`. |
| <a id="name"></a> `name?` | `string` | - |
| <a id="out"></a> `out?` | `string` | where to write, relative to the sheet |
| <a id="padding"></a> `padding?` | `number` | - |
| <a id="samples"></a> `samples?` | `number` | - |
| <a id="size-1"></a> `size?` | `number` | - |
| <a id="texelsperunit"></a> `texelsPerUnit?` | `number` | - |

***

### SceneBroom

```ts
type SceneBroom = {
  grid?: number;
  scale?: number;
};
```

A sheet's own `@broom { … }`: the editor workspace, not the scene. Kept in the sheet so reopening a
map restores the session without a sidecar file next to it.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="grid-1"></a> `grid?` | `number` | grid size as a power of two in metres — -2 is 25 cm, the default the editor opens on |
| <a id="scale-2"></a> `scale?` | `number` | metres per texture tile a new face is created with |

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
}
  | Pos & {
  body: Member[];
  kind: "override";
  selector: Compound[];
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

### UvMode

```ts
type UvMode = 
  | {
  kind: "paraxial";
}
  | {
  kind: "parallel";
  u?: Vec3;
  v?: Vec3;
};
```

How a face lays its material out.
- `paraxial` — the axis pair of whichever world axis the normal is closest to, so a wall that is
  nudged off-axis keeps the alignment of the wall it was cut from. Quake's system.
- `parallel` — axes that lie in the face's own plane, either given or derived from the normal. Stays
  put under rotation, which is what a non-axial face wants.

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
  digits: 6 | 8;
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
  | Pos & {
  args: Value[];
  kind: "fn";
  name: string;
}
  | Pos & {
  body: Value;
  kind: "each";
  name: string;
  namePos: Pos;
  over: Value;
}
  | Pos & {
  kind: "read";
  name: string;
  namePos: Pos;
  target: Value;
}
  | Pos & {
  args: Value[];
  kind: "call";
  name: string;
  namePos: Pos;
  target: Value;
}
  | Pos & {
  at: Value;
  kind: "index";
  target: Value;
}
  | ObjectValue;
```

***

### Vec2

```ts
type Vec2 = [number, number];
```

***

### Vec3

```ts
type Vec3 = [number, number, number];
```

## Variables

### ALIASES

```ts
const ALIASES: Record<string, string>;
```

call-name → three class. `texture`/`gltf` are loader-backed.

***

### AT\_RULES

```ts
const AT_RULES: readonly ["bakery", "broom"];
```

the at-rules a body may hold, and which table checks each one

***

### BAKERY

```ts
const BAKERY: Record<"scene" | "node" | "material", Record<string, Knob>>;
```

`@bakery { … }` is settings for the baker, not for three, so the schema cannot type it — this table
is what the checker validates against, per position. Adding a knob to [SceneBakery](#scenebakery) and friends
without a row here means the checker rejects it.

The bounds are the range the bake is actually defined over, not taste: outside them a knob is either
dropped with a warning (`probe: 2`), clamped to something else entirely (`indirect: -1`), or asks for
an allocation no machine has (`size: 65536`). The checker says so in the editor rather than the baker
saying so an hour in.

***

### BROOM

```ts
const BROOM: Record<"scene" | "node", Record<string, Knob>>;
```

`@broom { … }` is settings for the editor, not for three, so the schema cannot type it — this table
is what the checker validates against, exactly as [BAKERY](#bakery) does for the baker. A knob added to
[SceneBroom](#scenebroom) or [NodeBroom](#nodebroom) without a row here is rejected.

***

### BRUSH\_CLASSES

```ts
const BRUSH_CLASSES: string[];
```

What the runtime needs to turn a `brush` or a `patch` into a node. A sheet that writes one never names
these, so the vite plugin imports them on its behalf — the same deal every other three name in a sheet
gets, and what keeps a brushless scene from paying for them.

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

### FACE\_PROPS

```ts
const FACE_PROPS: Record<string, {
  summary: string;
  type: "material" | "uv" | "vec2" | "angle";
}>;
```

what a `face()` body may set — the rest of the face is its three points

***

### LOADERS

```ts
const LOADERS: Record<string, {
  args: TypeRef[];
  class: string;
  summary: string;
}>;
```

Calls that fetch something instead of constructing it. `args` is the call's own signature — a
loader's arguments are nothing like the constructor of the class it hands back, and both the
checker and the editor have to say so.

***

### LOOP\_LIMIT

```ts
const LOOP_LIMIT: 1000000 = 1e6;
```

The ceiling `repeat()` and `each()` share. Not a three limit: a count this large is a typo — an
`each(--i, 1e9, …)` builds nothing anyone can see and stops the tab responding first.

***

### MATH

```ts
const MATH: Record<string, {
  arity: number;
  summary: string;
}>;
```

What `calc()` can call. Numbers in, one number out — enough to write a parametric surface, and
deliberately not enough to be a scripting language. `docs/language.md` is checked against this table,
so a new function cannot be added without documenting it.

***

### MAX\_SUBDIVISIONS

```ts
const MAX_SUBDIVISIONS: 16 = 16;
```

the most segments a span is ever cut into, however bent it is — past this nobody can see the difference

***

### PATCH\_PROPS

```ts
const PATCH_PROPS: Record<string, {
  summary: string;
  type: "material" | "number" | "uv";
}>;
```

what a `patch` body may set for the surface itself — the rest of it is the `Mesh`'s own

***

### PATCH\_SHAPES

```ts
const PATCH_SHAPES: readonly ["plane", "cylinder", "cone", "dome", "bevel"];
```

every primitive a patch can be made as, in the order the tool lists them

***

### PATCH\_UV

```ts
const PATCH_UV: Record<string, {
  summary: string;
  type: "vec2" | "angle";
}>;
```

what a patch's `uv: { … }` record may set — a face spells these plainly, a patch cannot

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

### bevelPatch()

```ts
function bevelPatch(min, max): PatchGrid;
```

A quarter-turn that fills the corner of the box — what a wall does when it turns, and the patch a
designer reaches for most often after the plain cylinder.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `min` | [`Vec3`](#vec3) |
| `max` | [`Vec3`](#vec3) |

#### Returns

[`PatchGrid`](#patchgrid-1)

***

### boxFaces()

```ts
function boxFaces(min, max): [Vec3, Vec3, Vec3][];
```

A box brush: six faces, each three points wound counter-clockwise from outside. What the editor's
draw-shape tool emits, and what every example in the docs is.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `min` | [`Vec3`](#vec3) |
| `max` | [`Vec3`](#vec3) |

#### Returns

\[[`Vec3`](#vec3), [`Vec3`](#vec3), [`Vec3`](#vec3)\][]

***

### brushBounds()

```ts
function brushBounds(faces): {
  max: Vec3;
  min: Vec3;
};
```

The axis-aligned box of a brush, from its face points alone — cheap enough to call on every brush of
a level, and the checker's answer to "is this thing anywhere near the rest of the map".

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `faces` | [`BrushFace`](#brushface)[] |

#### Returns

```ts
{
  max: Vec3;
  min: Vec3;
}
```

| Name | Type |
| ------ | ------ |
| `max` | [`Vec3`](#vec3) |
| `min` | [`Vec3`](#vec3) |

***

### buildBrush()

```ts
function buildBrush(faces): BrushResult;
```

Turns a brush's faces into triangles, or into the reasons it is not a solid. Both at once is possible
and deliberate: a brush with one redundant face still has a mesh, and the editor draws it while
saying so.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `faces` | [`BrushFace`](#brushface)[] |

#### Returns

[`BrushResult`](#brushresult)

***

### buildPatch()

```ts
function buildPatch(patch): PatchResult;
```

The patch as a mesh: an indexed grid of quads, two triangles each, wound so the normal of the triangle
agrees with the normal of the surface.

Indexed rather than the loose triples a brush produces, because the whole point of a patch is that it is
smooth — the vertices *are* shared, the normals *are* averaged by sharing them, and a patch tessellated
flat-shaded would be a patch that looks exactly like the low-poly thing it exists to avoid.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `patch` | [`Patch`](#patch) |

#### Returns

[`PatchResult`](#patchresult)

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

### clearAssetCache()

```ts
function clearAssetCache(url?): void;
```

Forgets what `texture()` and `gltf()` downloaded, so the next sheet that asks for a url fetches it
again. Pass a resolved absolute url to drop one entry, or nothing to drop them all.

The cache is keyed by url and lives as long as the module does, which is what makes a hot reload
instant — and also means an asset edited on disk keeps serving its old bytes, and a long-lived page
that walks through a lot of scenes never gives the decoded images back. This is the way out of both.

It only forgets. Whatever is already on screen keeps working: a `gltf()` node is a clone that shares
the cached geometries and materials, and those are freed by [disposeScene](#disposescene) on the last scene
holding them. Clearing while a load is in flight is safe too — that load finishes and hands its
result to the caller that started it, and only the caching of it is dropped.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `url?` | `string` |

#### Returns

`void`

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

### conePatch()

```ts
function conePatch(min, max): PatchGrid;
```

a tube that closes to a point at the top of the box

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `min` | [`Vec3`](#vec3) |
| `max` | [`Vec3`](#vec3) |

#### Returns

[`PatchGrid`](#patchgrid-1)

***

### countable()

```ts
function countable(n): boolean;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `n` | `number` |

#### Returns

`boolean`

***

### cylinderPatch()

```ts
function cylinderPatch(min, max): PatchGrid;
```

an open tube filling the box, nine columns round and three rows tall

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `min` | [`Vec3`](#vec3) |
| `max` | [`Vec3`](#vec3) |

#### Returns

[`PatchGrid`](#patchgrid-1)

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

### domePatch()

```ts
function domePatch(min, max): PatchGrid;
```

the top half of a sphere filling the box: five rows from the equator to a single point

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `min` | [`Vec3`](#vec3) |
| `max` | [`Vec3`](#vec3) |

#### Returns

[`PatchGrid`](#patchgrid-1)

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

### flipPatch()

```ts
function flipPatch(grid): PatchGrid;
```

the grid with its rows reversed, which turns the surface inside out

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `grid` | [`PatchGrid`](#patchgrid-1) |

#### Returns

[`PatchGrid`](#patchgrid-1)

***

### gridProblems()

```ts
function gridProblems(grid): PatchProblem[];
```

What is wrong with a control grid, if anything. Reported as a list rather than thrown, because the
checker wants to name every mistake in a sheet at once and a patch with two short rows has two.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `grid` | [`PatchGrid`](#patchgrid-1) |

#### Returns

[`PatchProblem`](#patchproblem)[]

***

### insertColumn()

```ts
function insertColumn(grid, span): PatchGrid;
```

the same, across: one more span of columns, and the surface it had before

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `grid` | [`PatchGrid`](#patchgrid-1) |
| `span` | `number` |

#### Returns

[`PatchGrid`](#patchgrid-1)

***

### insertRow()

```ts
function insertRow(grid, span): PatchGrid;
```

the grid with one row of spans added after `span`, the surface unchanged — a de Casteljau split

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `grid` | [`PatchGrid`](#patchgrid-1) |
| `span` | `number` |

#### Returns

[`PatchGrid`](#patchgrid-1)

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

### math()

```ts
function math(
   name, 
   a?, 
   b?, 
   c?): number;
```

The one implementation of [MATH](#math), shared by the constant folder and the runtime. Positional rather
than variadic: the runtime calls this millions of times over an `each()`, and an array per call is a
measurable part of building a sheet's geometry.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `name` | `string` | `undefined` |
| `a` | `number` | `0` |
| `b` | `number` | `0` |
| `c` | `number` | `0` |

#### Returns

`number`

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

### normalOn()

```ts
function normalOn(
   grid, 
   u, 
   v): Vec3;
```

The outward normal at `(u, v)`, from the two partial derivatives.

A patch can have a seam where both derivatives vanish — the tip of a cone is the usual one — and there
the cross product is nothing at all. Rather than hand back a zero vector for the renderer to divide by,
the sample is nudged a hair into the patch and taken again, which is the normal of the surface *beside*
the singularity and is what any eye would call the normal of the tip.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `grid` | [`PatchGrid`](#patchgrid-1) |
| `u` | `number` |
| `v` | `number` |

#### Returns

[`Vec3`](#vec3)

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

### patchBounds()

```ts
function patchBounds(grid): {
  max: Vec3;
  min: Vec3;
};
```

The box the patch fits in.

The control points, not the surface: a quadratic Bezier lies inside the convex hull of its control
points, so this never cuts the surface off, and it is what a designer sees when the control hull is
drawn. Tessellating first would give a tighter box that changed every time the subdivision did.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `grid` | [`PatchGrid`](#patchgrid-1) |

#### Returns

```ts
{
  max: Vec3;
  min: Vec3;
}
```

| Name | Type |
| ------ | ------ |
| `max` | [`Vec3`](#vec3) |
| `min` | [`Vec3`](#vec3) |

***

### patchOfShape()

```ts
function patchOfShape(
   shape, 
   min, 
   max): PatchGrid;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `shape` | `"plane"` \| `"cylinder"` \| `"cone"` \| `"dome"` \| `"bevel"` |
| `min` | [`Vec3`](#vec3) |
| `max` | [`Vec3`](#vec3) |

#### Returns

[`PatchGrid`](#patchgrid-1)

***

### planeFromPoints()

```ts
function planeFromPoints(p): Plane | undefined;
```

The plane through three points, wound counter-clockwise seen from outside — so the normal is the
right-hand cross product and points away from the solid.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `p` | \[[`Vec3`](#vec3), [`Vec3`](#vec3), [`Vec3`](#vec3)\] |

#### Returns

[`Plane`](#plane) \| `undefined`

***

### planePatch()

```ts
function planePatch(min, max): PatchGrid;
```

a flat 3 x 3 patch spanning a box's footprint at its floor — the thing to bend into everything else

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `min` | [`Vec3`](#vec3) |
| `max` | [`Vec3`](#vec3) |

#### Returns

[`PatchGrid`](#patchgrid-1)

***

### pointOn()

```ts
function pointOn(
   grid, 
   u, 
   v): Vec3;
```

where the surface is at `(u, v)`, each in `[0, spans]` of its own direction

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `grid` | [`PatchGrid`](#patchgrid-1) |
| `u` | `number` |
| `v` | `number` |

#### Returns

[`Vec3`](#vec3)

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

### removeColumn()

```ts
function removeColumn(grid, span): PatchGrid;
```

the same, across

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `grid` | [`PatchGrid`](#patchgrid-1) |
| `span` | `number` |

#### Returns

[`PatchGrid`](#patchgrid-1)

***

### removeRow()

```ts
function removeRow(grid, span): PatchGrid;
```

the grid with a span of rows dropped, or the grid unchanged when it is down to its last one

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `grid` | [`PatchGrid`](#patchgrid-1) |
| `span` | `number` |

#### Returns

[`PatchGrid`](#patchgrid-1)

***

### spansIn()

```ts
function spansIn(points): number;
```

how many spans a count of control points is; 3 points is one span, 5 is two, and so on

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `points` | `number` |

#### Returns

`number`

***

### subdivisionsFor()

```ts
function subdivisionsFor(patch, tolerance?): number;
```

Segments per span, from the curvature, unless the patch says.

One number for the whole patch rather than one per span, because the tessellation has to stay a regular
grid for the index buffer — and a patch whose spans need wildly different densities is a patch that
wants splitting, not a cleverer tessellator.

The rule is the usual one: halving the segment count quadruples the error, so the count that keeps the
error under a tolerance goes as the square root of the bow. A millimetre of tolerance puts a metre-deep
bend at about the maximum and leaves a nearly flat patch as two triangles.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `patch` | [`Patch`](#patch) | `undefined` |
| `tolerance` | `number` | `0.001` |

#### Returns

`number`

***

### transformPatch()

```ts
function transformPatch(grid, m): PatchGrid;
```

the grid with every control point moved through a 4x4, column-major the way three stores one

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `grid` | [`PatchGrid`](#patchgrid-1) |
| `m` | `number`[] |

#### Returns

[`PatchGrid`](#patchgrid-1)

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

***

### uvAt()

```ts
function uvAt(
   p, 
   basis, 
   face): Vec2;
```

where a world point lands on a face's material, in tiles

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `p` | [`Vec3`](#vec3) |
| `basis` | \{ `u`: [`Vec3`](#vec3); `v`: [`Vec3`](#vec3); \} |
| `basis.u` | [`Vec3`](#vec3) |
| `basis.v` | [`Vec3`](#vec3) |
| `face` | [`BrushFace`](#brushface) |

#### Returns

[`Vec2`](#vec2)

***

### uvBasis()

```ts
function uvBasis(face, n): {
  u: Vec3;
  v: Vec3;
};
```

The u/v axes a face projects world positions onto, with its rotation already applied.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `face` | [`BrushFace`](#brushface) |
| `n` | [`Vec3`](#vec3) |

#### Returns

```ts
{
  u: Vec3;
  v: Vec3;
}
```

| Name | Type |
| ------ | ------ |
| `u` | [`Vec3`](#vec3) |
| `v` | [`Vec3`](#vec3) |

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
