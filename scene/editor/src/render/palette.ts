/**
 * The map's own materials, built from the sheet's declarations.
 *
 * The unshaded look draws every face with one grey material and is one draw call for the whole map. That is
 * useful while editing: geometry reads as shape, not as decoration. The shaded look instead builds what the
 * sheet declared: a `--brick: heightMaterial { … }` becomes a material with brick in it, sampled and marched
 * exactly the way the runtime will sample and march it.
 *
 * Three decisions hold this together.
 *
 * **A slot is a number, and it never moves.** Every distinct `material:` name a face has ever asked for gets
 * an index, assigned once and never reused. The index is written into the batch's face spans, so switching
 * looks changes only which array of materials the mesh is handed — never a single byte of geometry, and
 * never the pick buffer.
 *
 * **The marks are the same marks.** Selection, lock, hover and the on-face grid come from
 * {@link editorInk}, the same function the unshaded material uses. A second implementation of the editor's
 * highlighting would be two implementations to keep in step, and the first frame they disagreed would be a
 * frame where a designer could not tell what was selected.
 *
 * **The parallax is the runtime's parallax.** A wall with relief is a {@link HeightMaterial} from the
 * `tscene/height` module — the same class the runtime instantiates, with the editor's tint handed to the
 * hook it exposes for exactly this. The editor showing a brick half a tile away from where the runtime puts
 * it is the one bug in a level editor that nobody ever tracks down.
 */
import {
  MeshStandardNodeMaterial, SRGBColorSpace, RepeatWrapping, TextureLoader,
  type Material, type Texture,
} from "three/webgpu";
import { color, mix, texture, vec4 } from "three/tsl";
import { HeightMaterial } from "tscene/height";
import { hasRelief, type MapSlot, type MaterialDef } from "../doc/catalogue.ts";
import { COLOURS, editorInk, shadedFallbackMaterial, type GridUniforms } from "./materials.ts";
import { sampleTexture } from "./sample.ts";

/** the same TSL escape hatch the rest of the renderer uses: the typings name node types this file's arithmetic does not care about */
type AnyNode = any;

/**
 * Which of the two the viewport is showing.
 *
 * Not a spectrum and not a set of toggles. "Unshaded" shows the shape with a single material and "shaded"
 * shows the level's own materials and lighting; anything in between is a third thing a designer has to
 * reason about for no gain.
 */
export type Look = "unshaded" | "shaded";

export type Palette = {
  grid: GridUniforms;
  /**
   * Slot index to the material name it stands for. Slot 0 is the unnamed default — a face that never said
   * what it is made of, and a face whose material the catalogue does not have.
   */
  names: (string | undefined)[];
  index: Map<string, number>;
  /** the shaded look's materials, one per slot and in the same order — what `geometry.groups` indexes */
  materials: Material[];
  /** what the catalogue currently says; a slot claimed before its declaration was read is rebuilt later */
  defs: Map<string, MaterialDef>;
};

export function newPalette(grid: GridUniforms): Palette {
  const palette: Palette = { grid, names: [], index: new Map(), materials: [], defs: new Map() };
  // slot 0 exists before anything asks for it, so an unnamed face never has to allocate
  palette.names.push(undefined);
  palette.materials.push(build(palette, undefined));
  return palette;
}

/**
 * The slot a material name draws in, claiming one if this is the first face to ask.
 *
 * Append-only, and independent of which look is showing. That is what makes a look toggle free: the slot a
 * face was written with under the unshaded look is the slot it is still in under the shaded one, so nothing
 * in the batch has to be touched when the two are swapped.
 */
export function slotOf(palette: Palette, name: string | undefined): number {
  if (name === undefined) return 0;
  const found = palette.index.get(name);
  if (found !== undefined) return found;
  const slot = palette.names.length;
  palette.index.set(name, slot);
  palette.names.push(name);
  palette.materials.push(build(palette, palette.defs.get(name)));
  return slot;
}

/**
 * The catalogue's materials taken up, rebuilding every slot already claimed.
 *
 * Rebuilt rather than mutated because a declaration that gained a `heightMap` is a different *class* of
 * material, not a different value on the same one — and because a node material's graph is decided when it
 * is compiled, so editing one in place is the case three has to be told about anyway.
 */
export function setMaterials(palette: Palette, defs: Iterable<MaterialDef>): void {
  palette.defs = new Map([...defs].map((d) => [d.name, d]));
  for (let slot = 0; slot < palette.names.length; slot++) {
    const name = palette.names[slot];
    const was = palette.materials[slot];
    palette.materials[slot] = build(palette, name === undefined ? undefined : palette.defs.get(name));
    was?.dispose();
  }
}

/** every material thrown away. The textures are not: they are shared and cached by url */
export function disposePalette(palette: Palette): void {
  for (const material of palette.materials) material.dispose();
  palette.materials.length = 0;
  palette.names.length = 0;
  palette.index.clear();
}

// ---------------------------------------------------------------- building one

/**
 * The material one declaration comes out as.
 *
 * A declaration the editor has never heard of gets the unshaded grey rather than a guess. A wall drawn in a
 * colour the sheet did not ask for is worse than a wall drawn in no colour at all — the first is a lie
 * about the level, the second is visibly the editor saying it does not know.
 */
function build(palette: Palette, def: MaterialDef | undefined): Material {
  if (!def) return shadedFallbackMaterial(palette.grid);
  const ink = editorInk(palette.grid);
  const material = hasRelief(def) ? relief(def, ink) : plain(def, ink);
  material.name = `broom:material/${def.name}`;
  return material;
}

type Ink = ReturnType<typeof editorInk>;

/** a plain standard material: the sheet's maps on the slots three already knows, and the marks over the top */
function plain(def: MaterialDef, ink: Ink): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  common(material, def);

  // `colorNode` is what the editor has to write, and writing it takes `map` out of the picture entirely —
  // three reads one or the other, never both — so the albedo is folded in here by hand
  const albedo = material.map;
  const own: AnyNode = color(def.colour ?? COLOURS.face);
  const base: AnyNode = albedo ? (texture(albedo) as AnyNode).xyz.mul(own) : own;
  material.colorNode = mix(base, ink.tint, ink.amount) as never;
  return material;
}

/**
 * A material with relief: the runtime's own {@link HeightMaterial}, tinted through the hook it exposes.
 *
 * The tint goes in as `vec4(colour, amount)` and is applied *inside* the march, after the albedo has been
 * sampled at the parallaxed coordinate — which is the only place it can be applied and still be the same
 * picture as the runtime's with one colour mixed over it.
 */
function relief(def: MaterialDef, ink: Ink): HeightMaterial {
  const material = new HeightMaterial();
  common(material as unknown as MeshStandardNodeMaterial, def);
  material.heightMap = mapFor(def, "heightMap") ?? null;
  // the same default the material itself carries: three centimetres, which is a brick's mortar line
  material.depth = def.depth ?? 0.03;
  material.tint = vec4(ink.tint, ink.amount);
  return material;
}

/** everything the two kinds share: the colour, the scalars, and the maps three reads without any help */
function common(material: MeshStandardNodeMaterial, def: MaterialDef): void {
  if (def.colour !== undefined) material.color.setHex(def.colour);
  material.roughness = def.roughness ?? 0.85;
  material.metalness = def.metalness ?? 0;
  material.map = mapFor(def, "map") ?? null;
  material.normalMap = mapFor(def, "normalMap") ?? null;
  material.roughnessMap = mapFor(def, "roughnessMap") ?? null;
  material.metalnessMap = mapFor(def, "metalnessMap") ?? null;
  material.aoMap = mapFor(def, "aoMap") ?? null;
  material.emissiveMap = mapFor(def, "emissiveMap") ?? null;
}

// ---------------------------------------------------------------- textures

const loader = /*@__PURE__*/ new TextureLoader();

/**
 * Every texture the editor has loaded, by url.
 *
 * Cached across rebuilds because rebuilding is common — every look toggle and every catalogue change does
 * it — and re-fetching a wall's four maps each time would make the toggle a stutter instead of a switch.
 */
const textures = new Map<string, Texture>();

const mapFor = (def: MaterialDef, slot: MapSlot): Texture | undefined => {
  const url = def.maps[slot];
  return url === undefined ? undefined : load(url, slot === "map" || slot === "emissiveMap");
};

/**
 * One texture, generated or fetched.
 *
 * `broom:` urls are answered out of arithmetic so the demo has something to show without a byte on disk;
 * everything else goes to the loader. There is no base directory to resolve against yet — the editor has no
 * project-open path — so a relative url is relative to the page, which is what it will be relative to once
 * a project is served from one.
 */
function load(url: string, srgb: boolean): Texture {
  const found = textures.get(url);
  if (found) return found;

  const made = sampleTexture(url) ?? loader.load(url);
  made.colorSpace = srgb ? SRGBColorSpace : made.colorSpace;
  made.wrapS = RepeatWrapping;
  made.wrapT = RepeatWrapping;
  made.anisotropy = 8;
  textures.set(url, made);
  return made;
}
