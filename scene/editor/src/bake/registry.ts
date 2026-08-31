/**
 * The classes a three-broom map is allowed to name, for the two places that load one through tscene's
 * own runtime rather than through the editor's palette.
 *
 * `threeRegistry` alone is not enough, and the way it is not enough is silent until it is fatal: the
 * demo's walls are `heightMaterial`, which is not part of three at all. `tscene/height` is an opt-in
 * module — a project that never asks for parallax should not pay for its TSL — so a loader handed the
 * plain three registry refuses the sheet with "unknown three class HeightMaterial", and the bake and the
 * preview both stop before they have drawn anything. The editor's own renderer never hits this, because
 * `render/palette.ts` builds the material itself and never asks a registry for it.
 *
 * `addonRegistry` is deliberately not here. It is a barrel over `three/addons`, and reaching it from node
 * ends in "only URLs with a scheme in: file and data are supported" — an addon that pulls its decoder off
 * a CDN. The command-line baker loads with `threeRegistry` alone for the same reason, so a bake from the
 * editor supports exactly what a bake from a terminal supports, plus the one class the editor's own maps
 * are written in.
 *
 * Imported on demand: on the node side that keeps a dev server that never bakes from loading three at all.
 */
export async function sceneRegistry(): Promise<Record<string, unknown>> {
  const [{ threeRegistry }, { HeightMaterial }] = await Promise.all([
    import("tscene/three"),
    import("tscene/height"),
  ]);
  // the sheet says `heightMaterial`; the loader capitalises and looks the class up by name, which is why
  // this is the class under its own name rather than under the keyword
  return { ...threeRegistry, HeightMaterial };
}
