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
  load?: Loader;
  manager?: THREE.LoadingManager;
  registry?: Record<string, (...args) => any>;
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
| <a id="load"></a> `load?` | [`Loader`](#loader) | - |
| <a id="manager"></a> `manager?` | `THREE.LoadingManager` | shared LoadingManager — its onProgress/onLoad see every texture() and gltf() |
| <a id="registry"></a> `registry?` | `Record`\<`string`, (...`args`) => `any`\> | extra constructors, e.g. { water: Water }. Looked up before three's exports. |

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
};
```

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

### SceneModule

```ts
type SceneModule = {
  assets?: Record<string, string>;
  file: string;
  imports?: Record<string, string>;
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

### check()

```ts
function check(
   nodes, 
   schema, 
   templates?): Diagnostic[];
```

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `nodes` | [`Member`](#member)[] | `undefined` |
| `schema` | [`Schema`](tools.md#schema) | `undefined` |
| `templates` | [`Pos`](#pos-1) & \{ `body`: [`Member`](#member)[]; `kind`: `"template"`; `name`: `string`; `namePos`: [`Pos`](#pos-1); `node?`: `string`; \}[] | `[]` |

#### Returns

[`Diagnostic`](#diagnostic)[]

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

### disposeScene()

```ts
function disposeScene(root): void;
```

Frees the GPU resources of a scene built by loadScene — call it before dropping a root,
otherwise every hot reload leaks its geometries, materials and textures.

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
