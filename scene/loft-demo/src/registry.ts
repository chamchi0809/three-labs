// What the sheet gets handed that three cannot supply: the procedural node, the TSL materials, and the
// cross-section tables. `Record<Declared, unknown>` ties this to `declared.ts`, so the list the checker
// is given and the values the runtime is given cannot drift apart.
import type { Declared } from "../declared.ts";
import { Barrier } from "./barrier.ts";
import * as materials from "./materials.ts";
import * as sections from "./sections.ts";

export const registry: Record<Declared, unknown> = {
  barrier: Barrier,

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

  // one profile at three sizes: the coffee set stands on the wide one, the corner pieces on the flat one
  pedestalLargeSections: sections.pedestalSections(3.6, 2.2),
  pedestalMediumSections: sections.pedestalSections(3.6, 1.1),
  pedestalSmallSections: sections.pedestalSections(2, 1.6),

  cupSections: sections.cupSections,
  saucerSections: sections.saucerSections,
  handleSections: sections.handleSections,
  vaseSections: sections.vaseSections,
  shellSections: sections.shellSections,
  starSections: sections.starSections,
  ribbonSections: sections.ribbonSections,
  toothpasteSections: sections.toothpasteSections,
  pumpkinSections: sections.pumpkinSections,
  pumpkinStemSections: sections.pumpkinStemSections,
  mushroomCapSections: sections.mushroomCapSections,
  mushroomStemSections: sections.mushroomStemSections,
  gobletSections: sections.gobletSections,
  curtainSections: sections.curtainSections,
};
