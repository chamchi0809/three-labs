[**tscene**](README.md)

***

[tscene](README.md) / vite

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
     map: {
        file: string;
        mappings: string;
        names: never[];
        sources: string[];
        sourcesContent: string[];
        version: number;
     };
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
     map: {
        file: string;
        mappings: string;
        names: never[];
        sources: string[];
        sourcesContent: string[];
        version: number;
     };
   }
    | null>;
}
```

| Name | Type | Default value |
| ------ | ------ | ------ |
| `name` | `string` | `"tscene"` |
| `configResolved()` | (`config`) => `void` | - |
| `transform()` | (`code`, `id`) => `Promise`\< \| \{ `code`: `string`; `map`: \{ `file`: `string`; `mappings`: `string`; `names`: `never`[]; `sources`: `string`[]; `sourcesContent`: `string`[]; `version`: `number`; \}; \} \| `null`\> | - |
