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
  /** where to write, relative to the sheet */
  out?: string;
  name?: string;
  exr?: boolean;
};

/** A node's own `@bakery { … }`. `enabled` is inherited by the whole subtree unless a child overrides it. */
export type NodeBakery = {
  /** `false` keeps the node out of the bake — as an occluder *and* a receiver. On a light: stays live at runtime */
  enabled?: boolean;
  /** soft shadows: the light becomes a sphere of this world radius (a directional light reads radians) */
  radius?: number;
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
    out: { type: "string" },
    name: { type: "string" },
    exr: { type: "boolean" },
  },
  node: {
    enabled: { type: "boolean" },
    radius: { type: "number" },
  },
  material: {
    albedo: { type: "numbers", length: 3 },
  },
};

export const className = (name: string) => ALIASES[name] ?? name[0]!.toUpperCase() + name.slice(1);
export const nodeName = (cls: string) => cls[0]!.toLowerCase() + cls.slice(1);
