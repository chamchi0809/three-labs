// Browser-safe entry: parser, printer, checker, runtime loader.
// Schema reflection and tooling live in `tscene/tools` (node only).
export * from "./parse.ts";
export * from "./check.ts";
export * from "./runtime.ts";
export type { ClassInfo, PropInfo, Schema, TypeRef } from "./schema.ts";
