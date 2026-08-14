[**tscene**](README.md)

***

[tscene](README.md) / tools

# tools

## Type Aliases

### ClassInfo

```ts
type ClassInfo = {
  abstract: boolean;
  bases: string[];
  copyable: boolean;
  ctor: Param[];
  doc?: string;
  methods: Record<string, Method[]>;
  props: Record<string, PropInfo>;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="abstract"></a> `abstract` | `boolean` | - |
| <a id="bases"></a> `bases` | `string`[] | - |
| <a id="copyable"></a> `copyable` | `boolean` | - |
| <a id="ctor"></a> `ctor` | [`Param`](#param)[] | first construct signature, in order |
| <a id="doc"></a> `doc?` | `string` | - |
| <a id="methods"></a> `methods` | `Record`\<`string`, [`Method`](#method)[]\> | call signatures of each public method — `lookAt(x, y, z);` is checked against these |
| <a id="props"></a> `props` | `Record`\<`string`, [`PropInfo`](#propinfo)\> | - |

***

### Field

```ts
type Field = {
  optional: boolean;
  type: TypeRef;
};
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="optional"></a> `optional` | `boolean` |
| <a id="type"></a> `type` | [`TypeRef`](#typeref) |

***

### Method

```ts
type Method = {
  params: Param[];
  returns: TypeRef;
};
```

one call signature of a method: what it takes, and what a `foo(…).bar(…)` value is worth

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="params"></a> `params` | [`Param`](#param)[] |
| <a id="returns"></a> `returns` | [`TypeRef`](#typeref) |

***

### Param

```ts
type Param = {
  name: string;
  optional: boolean;
  type: TypeRef;
};
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="name"></a> `name` | `string` |
| <a id="optional-1"></a> `optional` | `boolean` |
| <a id="type-1"></a> `type` | [`TypeRef`](#typeref) |

***

### PropInfo

```ts
type PropInfo = {
  doc?: string;
  readonly: boolean;
  type: TypeRef;
};
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="doc-1"></a> `doc?` | `string` |
| <a id="readonly"></a> `readonly` | `boolean` |
| <a id="type-2"></a> `type` | [`TypeRef`](#typeref) |

***

### Schema

```ts
type Schema = {
  classes: Record<string, ClassInfo>;
  constants: Record<string, TypeRef>;
  declared?: string[];
  entry: string;
  modules: string[];
  sources: Record<string, string>;
  version: string;
};
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="classes"></a> `classes` | `Record`\<`string`, [`ClassInfo`](#classinfo)\> | - |
| <a id="constants"></a> `constants` | `Record`\<`string`, [`TypeRef`](#typeref)\> | exported non-class values (DoubleSide, SRGBColorSpace, …) |
| <a id="declared"></a> `declared?` | `string`[] | - |
| <a id="entry"></a> `entry` | `string` | - |
| <a id="modules"></a> `modules` | `string`[] | - |
| <a id="sources"></a> `sources` | `Record`\<`string`, `string`\> | name → the module to import it from, for everything that does *not* come from `entry`. An addon is keyed to its own deep path (`three/addons/geometries/LoftGeometry.js`) rather than to the barrel, so the vite plugin can emit an import a bundler keeps one class of. |
| <a id="version"></a> `version` | `string` | - |

***

### SchemaOptions

```ts
type SchemaOptions = {
  addons?: boolean;
  cache?: boolean;
  cwd?: string;
  declare?: string[];
  entry?: string;
  modules?: string[];
};
```

`modules` are extra packages whose exported classes become usable nodes/values.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="addons"></a> `addons?` | `boolean` | Reflect `three/addons` too, so every addon class (`loftGeometry`, `roomEnvironment`, …) is a node. On by default; a three too old to have the barrel is skipped silently unless this is explicitly true. |
| <a id="cache"></a> `cache?` | `boolean` | - |
| <a id="cwd"></a> `cwd?` | `string` | - |
| <a id="declare"></a> `declare?` | `string`[] | node names the host passes to loadScene's `registry` — accepted by the checker, unchecked |
| <a id="entry-1"></a> `entry?` | `string` | - |
| <a id="modules-1"></a> `modules?` | `string`[] | Extra modules, resolved from `cwd`. A bare specifier is also what the vite plugin will import the class from; one written as a path is left to the runtime `registry`, since the emitted import would be relative to the sheet and not to here. |

***

### TypeRef

```ts
type TypeRef = 
  | {
  kind: "number" | "string" | "boolean" | "any" | "null";
}
  | {
  kind: "enum";
  members: string[];
  name: string;
}
  | {
  kind: "class";
  name: string;
}
  | {
  kind: "array";
  of: TypeRef;
}
  | {
  fields: Record<string, Field>;
  kind: "record";
  name?: string;
}
  | {
  kind: "union";
  of: TypeRef[];
};
```

#### Union Members

##### Type Literal

```ts
{
  kind: "number" | "string" | "boolean" | "any" | "null";
}
```

***

##### Type Literal

```ts
{
  kind: "enum";
  members: string[];
  name: string;
}
```

***

##### Type Literal

```ts
{
  kind: "class";
  name: string;
}
```

***

##### Type Literal

```ts
{
  kind: "array";
  of: TypeRef;
}
```

***

##### Type Literal

```ts
{
  fields: Record<string, Field>;
  kind: "record";
  name?: string;
}
```

an options bag — an interface or type literal of plain data, written as `{ capStart: true }`

***

##### Type Literal

```ts
{
  kind: "union";
  of: TypeRef[];
}
```

## Variables

### ADDONS

```ts
const ADDONS: "three/addons" = "three/addons";
```

the barrel three re-exports every addon from — reflected on its own so `addons` needs no path

***

### fsLoader

```ts
const fsLoader: Loader;
```

## Functions

### buildSchema()

```ts
function buildSchema(opts?): Schema;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`SchemaOptions`](#schemaoptions) |

#### Returns

[`Schema`](#schema)

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
| `nodes` | [`Member`](index.md#member)[] | `undefined` |
| `schema` | [`Schema`](#schema) | `undefined` |
| `templates` | [`Pos`](index.md#pos-1) & \{ `body`: [`Member`](index.md#member)[]; `kind`: `"template"`; `name`: `string`; `namePos`: [`Pos`](index.md#pos-1); `node?`: `string`; \}[] | `[]` |

#### Returns

[`Diagnostic`](index.md#diagnostic)[]

***

### checkSource()

```ts
function checkSource(
   text, 
   file, 
   schema, 
load?): Promise<Diagnostic[]>;
```

Parse + expand + type check one source. The parser recovers, so a typo still yields the rest.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `text` | `string` | `undefined` |
| `file` | `string` | `undefined` |
| `schema` | [`Schema`](#schema) | `undefined` |
| `load` | [`Loader`](index.md#loader) | `fsLoader` |

#### Returns

`Promise`\<[`Diagnostic`](index.md#diagnostic)[]\>

***

### fixSource()

```ts
function fixSource(
   text, 
   file, 
   schema, 
load?): Promise<string>;
```

Autofixer: identifier casing (from the checker) + canonical formatting.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `text` | `string` | `undefined` |
| `file` | `string` | `undefined` |
| `schema` | [`Schema`](#schema) | `undefined` |
| `load` | [`Loader`](index.md#loader) | `fsLoader` |

#### Returns

`Promise`\<`string`\>

***

### formatDiagnostic()

```ts
function formatDiagnostic(d, sources): string;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `d` | [`Diagnostic`](index.md#diagnostic) |
| `sources` | `Map`\<`string`, `string`\> |

#### Returns

`string`

***

### loadSchema()

```ts
function loadSchema(opts?): Schema;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`SchemaOptions`](#schemaoptions) |

#### Returns

[`Schema`](#schema)

***

### resolveSheet()

```ts
function resolveSheet(spec, from): string;
```

`@import "./a.tscene"` is relative to the importing sheet; a bare specifier
(`@import "ui-kit/scenes/a.tscene"`) is resolved out of node_modules.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `spec` | `string` |
| `from` | `string` \| `undefined` |

#### Returns

`string`

## References

### expand

Re-exports [expand](index.md#expand)

***

### parse

Re-exports [parse](index.md#parse)

***

### print

Re-exports [print](index.md#print)
