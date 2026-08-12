// Browser-safe entry: parser, printer, name tables, runtime loader.
// The checker (`check`) and schema reflection live in `tscene/tools` (node only) — keeping them out
// of here is what lets a bundler drop them, and typescript with them.
export * from "./parse.ts";
export * from "./names.ts";
export * from "./runtime.ts";
export type { ClassInfo, PropInfo, Schema, TypeRef } from "./schema.ts";
