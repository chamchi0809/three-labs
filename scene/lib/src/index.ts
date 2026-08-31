// Browser-safe entry: parser, printer, name tables, runtime loader.
// The checker (`check`) and schema reflection live in `tscene/tools` (node only) — keeping them out
// of here is what lets a bundler drop them, and typescript with them.
export * from "./parse.ts";
export * from "./names.ts";
export * from "./brush.ts";
export * from "./entity.ts";
// `Vec2` and `Vec3` are the same two aliases the brush module declares, and re-exporting them twice is
// an ambiguous name rather than a duplicate — so the patch module contributes everything except those
export {
  bevelPatch, buildPatch, conePatch, cylinderPatch, domePatch, flipPatch, gridProblems, insertColumn,
  insertRow, MAX_SUBDIVISIONS, normalOn, patchBounds, patchOfShape, PATCH_SHAPES, planePatch, pointOn,
  removeColumn, removeRow, spansIn, subdivisionsFor, transformPatch,
  type Patch, type PatchGrid, type PatchMesh, type PatchProblem, type PatchResult, type PatchShape,
} from "./patch.ts";
export * from "./runtime.ts";
export type { ClassInfo, PropInfo, Schema, TypeRef } from "./schema.ts";
