/**
 * Every name `scenes/loft.tscene` uses that is not three's: the node, the materials and the section
 * tables the demo hands `loadScene` through its `registry`.
 *
 * The checker cannot type what the host injects at runtime, so it is told the names instead — as
 * `declare` for the vite plugin and `--declare` for the CLI. Kept here, free of imports, so the vite
 * config and the check script share one list, and `src/registry.ts` is typed against it: a name added
 * here without a value (or a value without a name) fails `pnpm typecheck`.
 */
export const DECLARED = [
  "barrier",
  // materials
  "floorMaterial", "curtainMaterial", "marbleMaterial", "porcelainMaterial", "liquidMaterial",
  "vaseMaterial", "shellMaterial", "starMaterial", "ribbonMaterial", "toothpasteMaterial",
  "pumpkinMaterial", "pumpkinStemMaterial", "mushroomCapMaterial", "mushroomStemMaterial", "gobletMaterial",
  // cross sections
  "pedestalLargeSections", "pedestalMediumSections", "pedestalSmallSections",
  "cupSections", "saucerSections", "handleSections", "vaseSections", "shellSections", "starSections",
  "ribbonSections", "toothpasteSections", "pumpkinSections", "pumpkinStemSections",
  "mushroomCapSections", "mushroomStemSections", "gobletSections", "curtainSections",
] as const;

export type Declared = (typeof DECLARED)[number];
