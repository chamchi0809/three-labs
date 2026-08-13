// The name tables. Split out of check.ts because the runtime needs them and the checker — Levenshtein
// suggestions, schema walking — has no business in a browser bundle.
import type { TypeRef } from "./schema.ts";

/** call-name → three class. `texture`/`gltf` are loader-backed. */
export const ALIASES: Record<string, string> = {
  vec2: "Vector2", vec3: "Vector3", vec4: "Vector4",
  color: "Color", euler: "Euler", quat: "Quaternion", matrix4: "Matrix4",
  texture: "Texture", gltf: "Group",
};

/**
 * Names that look like nodes but are handled by the language itself, never looked up in three.
 * The checker dispatches on this table and `docs/language.md` is checked against it, so a new
 * builtin cannot be added without a section in the docs.
 */
export const BUILTINS: Record<string, { signature: string; summary: string; topLevel: boolean }> = {
  repeat: { signature: "repeat(count) { … }", summary: "unrolls its body `count` times, binding `--index` and `--count` in each copy", topLevel: true },
  find: { signature: 'find(nodeType?, "name") { … }', summary: "reaches into a node built by a loader and applies the body to it", topLevel: false },
  play: { signature: 'play("clip") { … }', summary: "plays an animation clip of the model it sits in; the body configures the AnimationAction", topLevel: false },
};

export const LOADERS: Record<string, { class: string; args: TypeRef[] }> = {
  texture: { class: "Texture", args: [{ kind: "string" }] },
  gltf: { class: "Group", args: [{ kind: "string" }] },
};

// ---------------------------------------------------------------- @bakery

/** What a sheet's own `@bakery { … }` block sets: every knob of `bakeSceneFile()` except the renderer. */
export type SceneBakery = {
  /** `all` bakes every mesh but the ones that turn themselves off; `none` bakes only the ones that opt in */
  include?: "all" | "none";
  size?: number;
  samples?: number;
  bounces?: number;
  indirect?: number;
  batch?: number;
  padding?: number;
  texelsPerUnit?: number;
  denoiseRadius?: number;
  dilateRadius?: number;
  /** ray origin offset along the normal; 0 (the default) picks 1e-4 of the scene diagonal */
  bias?: number;
  /** reflectance of a material with no `color` at all */
  defaultAlbedo?: number;
  /** also write `<name>.ao.png` and point the materials' `aoMap` at it */
  ao?: boolean;
  /** how far an occlusion ray looks for a blocker; 0 (the default) picks 5% of the scene diagonal */
  aoDistance?: number;
  /**
   * The divisor that packs the atlas into the 8-bit PNG, undone at runtime by `lightMapIntensity`, so
   * it decides quantization and not brightness. Absent, the bake picks the 95th percentile of the
   * atlas — which moves a little between bakes of a noisy scene. Set it to make that reproducible.
   */
  exposure?: number;
  /** where to write, relative to the sheet */
  out?: string;
  name?: string;
  exr?: boolean;
  /**
   * Runtime, not bake: the manifest `loadScene` applies to this sheet once it is built — what
   * `tscene-bake` wrote with the settings above. The handle lands on `root.userData.lightmap`.
   *
   * Resolved against the sheet's url, and against the document for a sheet a bundler inlined (it has a
   * file path, not a url). The manifest's own siblings — the png and the exr — are never bundled either,
   * so a built app wants all three in `public/` and a path like `/lightmaps/room.lightmap.json`.
   */
  lightmap?: string;
};

/** A node's own `@bakery { … }`. Both keys are inherited by the subtree unless a child overrides them. */
export type NodeBakery = {
  /**
   * `false` keeps the node out of the bake entirely — as an occluder *and* a receiver — and on a light
   * means it stays live at runtime. `occluder` keeps it in the ray tracing but gives it no lightmap of
   * its own, which is what a proxy or a mesh too big to unwrap wants.
   */
  enabled?: boolean | "occluder";
  /** soft shadows: the light becomes a sphere of this world radius (a directional light reads radians) */
  radius?: number;
  /**
   * lightmap texels per world unit, relative to the rest of the scene. 2 gives this node twice the
   * resolution in each direction — so four times the atlas area — and 0.5 a quarter of it.
   */
  density?: number;
  /**
   * Bake a reflection probe at this node's world position: an equirectangular map of the radiance
   * leaving every direction, `probe` texels wide and half that tall. A metal has no diffuse lobe for
   * the atlas to light, so this is what it reflects instead. 256 is plenty for anything but a mirror.
   */
  probe?: number;
};

/** A material's own `@bakery { … }`. */
export type MaterialBakery = {
  /** the linear reflectance the tracer bounces off this material, overriding the guess from `map`/`color` */
  albedo?: [number, number, number];
};

export type Knob = { type: "number" | "string" | "boolean" | "numbers"; length?: number; values?: string[] };

/**
 * `@bakery { … }` is settings for the baker, not for three, so the schema cannot type it — this table
 * is what the checker validates against, per position. Adding a knob to {@link SceneBakery} and friends
 * without a row here means the checker rejects it.
 */
export const BAKERY: Record<"scene" | "node" | "material", Record<string, Knob>> = {
  scene: {
    include: { type: "string", values: ["all", "none"] },
    size: { type: "number" },
    samples: { type: "number" },
    bounces: { type: "number" },
    indirect: { type: "number" },
    batch: { type: "number" },
    padding: { type: "number" },
    texelsPerUnit: { type: "number" },
    denoiseRadius: { type: "number" },
    dilateRadius: { type: "number" },
    bias: { type: "number" },
    defaultAlbedo: { type: "number" },
    ao: { type: "boolean" },
    aoDistance: { type: "number" },
    exposure: { type: "number" },
    out: { type: "string" },
    name: { type: "string" },
    exr: { type: "boolean" },
    lightmap: { type: "string" },
  },
  node: {
    enabled: { type: "boolean", values: ["true", "false", "occluder"] },
    radius: { type: "number" },
    density: { type: "number" },
    probe: { type: "number" },
  },
  material: {
    albedo: { type: "numbers", length: 3 },
  },
};

export const className = (name: string) => ALIASES[name] ?? name[0]!.toUpperCase() + name.slice(1);
export const nodeName = (cls: string) => cls[0]!.toLowerCase() + cls.slice(1);

/**
 * The class to resolve `a.b` against when `a`'s declared type is an abstract base. `Mesh.material` is
 * declared `Material`, so `material.emissive: …` on a mesh inside a loaded glTF would not type-check
 * even though every material a loader produces has it.
 *
 * ponytail: a table of one, and it widens rather than narrows — `material.emissive` on a mesh whose
 * material really is a `MeshBasicMaterial` type-checks and then does nothing at runtime. Add entries
 * as other abstract classes turn up in paths; a per-object check would need the loaded scene.
 */
export const concrete = (cls: string) => (cls === "Material" ? "MeshPhysicalMaterial" : cls);
