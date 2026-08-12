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
  methods: Record<string, Param[][]>;
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
| <a id="methods"></a> `methods` | `Record`\<`string`, [`Param`](#param)[][]\> | call signatures of each public method — `lookAt(x, y, z);` is checked against these |
| <a id="props"></a> `props` | `Record`\<`string`, [`PropInfo`](#propinfo)\> | - |

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
| <a id="optional"></a> `optional` | `boolean` |
| <a id="type"></a> `type` | [`TypeRef`](#typeref) |

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
| <a id="type-1"></a> `type` | [`TypeRef`](#typeref) |

***

### Schema

```ts
type Schema = {
  classes: Record<string, ClassInfo>;
  constants: Record<string, TypeRef>;
  declared?: string[];
  entry: string;
  modules: string[];
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
| <a id="version"></a> `version` | `string` | - |

***

### SchemaOptions

```ts
type SchemaOptions = {
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
| <a id="cache"></a> `cache?` | `boolean` | - |
| <a id="cwd"></a> `cwd?` | `string` | - |
| <a id="declare"></a> `declare?` | `string`[] | node names the host passes to loadScene's `registry` — accepted by the checker, unchecked |
| <a id="entry-1"></a> `entry?` | `string` | - |
| <a id="modules-1"></a> `modules?` | `string`[] | - |

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
  kind: "union";
  of: TypeRef[];
};
```

## Variables

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

### check

Re-exports [check](index.md#check)

***

### expand

Re-exports [expand](index.md#expand)

***

### parse

Re-exports [parse](index.md#parse)

***

### print

Re-exports [print](index.md#print)
