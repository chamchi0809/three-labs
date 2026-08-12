[**three-scene**](README.md)

***

[three-scene](README.md) / vite

# vite

## Type Aliases

### PluginOptions

```ts
type PluginOptions = Pick<SchemaOptions, "entry" | "modules" | "cache" | "declare"> & {
  check?: boolean;
  hmr?: boolean;
};
```

#### Type Declaration

| Name | Type |
| ------ | ------ |
| `check?` | `boolean` |
| `hmr?` | `boolean` |

## Functions

### default()

```ts
function default(options?): {
  name: string;
  configResolved: void;
  transform: Promise<
     | {
     code: string;
     map: null;
   }
    | null>;
};
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`PluginOptions`](#pluginoptions) |

#### Returns

```ts
{
  name: string;
  configResolved: void;
  transform: Promise<
     | {
     code: string;
     map: null;
   }
    | null>;
}
```

| Name | Type | Default value |
| ------ | ------ | ------ |
| `name` | `string` | `"three-scene"` |
| `configResolved()` | (`config`) => `void` | - |
| `transform()` | (`code`, `id`) => `Promise`\< \| \{ `code`: `string`; `map`: `null`; \} \| `null`\> | - |
