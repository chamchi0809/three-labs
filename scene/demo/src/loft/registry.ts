// What the sheet gets handed that three cannot supply: the TSL node materials, and nothing else.
// `Record<Declared, unknown>` ties this to `declared.ts`, so the list the checker is given and the values
// the runtime is given cannot drift apart.
import type { Declared } from "./declared.ts";
import * as materials from "./materials.ts";

export const registry: Record<Declared, unknown> = {
  floorMaterial: materials.floorMaterial,
  curtainMaterial: materials.curtainMaterial,
  marbleMaterial: materials.marbleMaterial,
  porcelainMaterial: materials.porcelainMaterial,
  liquidMaterial: materials.liquidMaterial,
  vaseMaterial: materials.vaseMaterial,
  shellMaterial: materials.shellMaterial,
  starMaterial: materials.starMaterial,
  ribbonMaterial: materials.ribbonMaterial,
  toothpasteMaterial: materials.toothpasteMaterial,
  pumpkinMaterial: materials.pumpkinMaterial,
  pumpkinStemMaterial: materials.pumpkinStemMaterial,
  mushroomCapMaterial: materials.mushroomCapMaterial,
  mushroomStemMaterial: materials.mushroomStemMaterial,
  gobletMaterial: materials.gobletMaterial,
  brassMaterial: materials.brassMaterial,
  ropeMaterial: materials.ropeMaterial,
};
