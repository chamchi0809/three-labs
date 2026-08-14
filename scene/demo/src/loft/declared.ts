/**
 * Every name `scenes/loft.tscene` uses that is not three's.
 *
 * All of it is shading: these are TSL node materials, which are shader graphs and not something the sheet
 * can describe. The geometry — every cross section of every loft — is in the sheet.
 *
 * The checker cannot type what the host injects at runtime, so it is told the names instead: `declare` for
 * the vite plugin, `--declare` for the CLI. Kept here, free of imports, so the vite config and the check
 * script share one list, and `materials.ts` is typed against it — a name added here without a material
 * (or a material without a name) fails `pnpm typecheck`.
 */
export const DECLARED = [
  "floorMaterial", "curtainMaterial", "marbleMaterial", "porcelainMaterial", "liquidMaterial",
  "vaseMaterial", "shellMaterial", "starMaterial", "ribbonMaterial", "toothpasteMaterial",
  "pumpkinMaterial", "pumpkinStemMaterial", "mushroomCapMaterial", "mushroomStemMaterial",
  "gobletMaterial", "brassMaterial", "ropeMaterial",
] as const;

export type Declared = (typeof DECLARED)[number];
