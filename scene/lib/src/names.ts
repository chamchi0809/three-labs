// The name tables. Split out of check.ts because the runtime needs them and the checker — Levenshtein
// suggestions, schema walking — has no business in a browser bundle.
import type { TypeRef } from "./schema.ts";

/** call-name → three class. `texture`/`gltf` are loader-backed. */
export const ALIASES: Record<string, string> = {
  vec2: "Vector2", vec3: "Vector3", vec4: "Vector4",
  color: "Color", euler: "Euler", quat: "Quaternion", matrix4: "Matrix4",
  texture: "Texture", gltf: "Group", hdr: "DataTexture", exr: "DataTexture", ktx2: "CompressedTexture",
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

/**
 * Calls that fetch something instead of constructing it. `args` is the call's own signature — a
 * loader's arguments are nothing like the constructor of the class it hands back, and both the
 * checker and the editor have to say so.
 */
export const LOADERS: Record<string, { class: string; args: TypeRef[]; summary: string }> = {
  texture: { class: "Texture", args: [{ kind: "string" }], summary: "loads an image as a Texture" },
  gltf: { class: "Group", args: [{ kind: "string" }], summary: "loads a .gltf/.glb; the body configures the Group it arrives in" },
  hdr: { class: "DataTexture", args: [{ kind: "string" }], summary: "loads a Radiance .hdr as a float DataTexture, mapped equirectangular — an environment, not a colour map" },
  exr: { class: "DataTexture", args: [{ kind: "string" }], summary: "loads an OpenEXR .exr the same way hdr() does" },
  ktx2: { class: "CompressedTexture", args: [{ kind: "string" }], summary: "loads a .ktx2, transcoded to whatever the GPU compresses; needs loadScene's `ktx2` option" },
};

/**
 * What `calc()` can call. Numbers in, one number out — enough to write a parametric surface, and
 * deliberately not enough to be a scripting language. `docs/language.md` is checked against this table,
 * so a new function cannot be added without documenting it.
 */
export const MATH: Record<string, { arity: number; summary: string }> = {
  pi: { arity: 0, summary: "3.141592653589793" },
  abs: { arity: 1, summary: "absolute value" },
  sign: { arity: 1, summary: "-1, 0 or 1" },
  sqrt: { arity: 1, summary: "square root" },
  exp: { arity: 1, summary: "e to the power of x" },
  log: { arity: 1, summary: "natural logarithm" },
  sin: { arity: 1, summary: "sine, in radians" },
  cos: { arity: 1, summary: "cosine, in radians" },
  tan: { arity: 1, summary: "tangent, in radians" },
  asin: { arity: 1, summary: "arcsine, in radians" },
  acos: { arity: 1, summary: "arccosine, in radians" },
  atan: { arity: 1, summary: "arctangent, in radians" },
  floor: { arity: 1, summary: "round down" },
  ceil: { arity: 1, summary: "round up" },
  round: { arity: 1, summary: "round to the nearest integer" },
  atan2: { arity: 2, summary: "atan2(y, x) — the angle of a vector, in radians" },
  pow: { arity: 2, summary: "pow(x, e) — x to the power of e" },
  min: { arity: 2, summary: "the smaller of two numbers" },
  max: { arity: 2, summary: "the larger of two numbers" },
  mod: { arity: 2, summary: "mod(a, b) — the remainder, always with b's sign" },
  clamp: { arity: 3, summary: "clamp(x, low, high)" },
  smoothstep: { arity: 3, summary: "smoothstep(x, edge0, edge1) — 0 below edge0, 1 above edge1, an S curve between" },
};

/**
 * The one implementation of {@link MATH}, shared by the constant folder and the runtime. Positional rather
 * than variadic: the runtime calls this millions of times over an `each()`, and an array per call is a
 * measurable part of building a sheet's geometry.
 */
export const math = (name: string, a = 0, b = 0, c = 0): number => {
  switch (name) {
    case "pi": return Math.PI;
    case "abs": return Math.abs(a);
    case "sign": return Math.sign(a);
    case "sqrt": return Math.sqrt(a);
    case "exp": return Math.exp(a);
    case "log": return Math.log(a);
    case "sin": return Math.sin(a);
    case "cos": return Math.cos(a);
    case "tan": return Math.tan(a);
    case "asin": return Math.asin(a);
    case "acos": return Math.acos(a);
    case "atan": return Math.atan(a);
    case "floor": return Math.floor(a);
    case "ceil": return Math.ceil(a);
    case "round": return Math.round(a);
    case "atan2": return Math.atan2(a, b);
    case "pow": return Math.pow(a, b);
    case "min": return Math.min(a, b);
    case "max": return Math.max(a, b);
    // JS `%` keeps the dividend's sign, which is never what a periodic pattern wants
    case "mod": return ((a % b) + b) % b;
    case "clamp": return Math.min(Math.max(a, b), c);
    case "smoothstep": {
      const t = Math.min(Math.max((a - b) / (c - b), 0), 1);
      return t * t * (3 - 2 * t);
    }
    default: throw new Error(`unknown calc() function ${JSON.stringify(name)}`);
  }
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
  /**
   * How many times its neighbours' median a texel may be before the bake clamps it back to that —
   * the stray bright dots a path tracer leaves. 0 keeps them.
   */
  fireflyThreshold?: number;
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
  /**
   * How far this probe reaches, in world units. A mesh outside every probe's influence reflects none
   * of them; inside two, it reflects a blend that fades to nothing at each one's edge. 0 — the default
   * — is unbounded, and a scene of unbounded probes is the plain "nearest two, by distance" it was.
   */
  influence?: number;
};

/** A material's own `@bakery { … }`. */
export type MaterialBakery = {
  /** the linear reflectance the tracer bounces off this material, overriding the guess from `map`/`color` */
  albedo?: [number, number, number];
};

export type Knob = {
  type: "number" | "string" | "boolean" | "numbers";
  length?: number;
  values?: string[];
  /** inclusive bounds for a number knob, or for every entry of a `numbers` one */
  min?: number;
  max?: number;
  /** a count, not a measurement — `size: 1024.5` is a typo and `probe: 2` bakes nothing */
  int?: boolean;
};

/**
 * `@bakery { … }` is settings for the baker, not for three, so the schema cannot type it — this table
 * is what the checker validates against, per position. Adding a knob to {@link SceneBakery} and friends
 * without a row here means the checker rejects it.
 *
 * The bounds are the range the bake is actually defined over, not taste: outside them a knob is either
 * dropped with a warning (`probe: 2`), clamped to something else entirely (`indirect: -1`), or asks for
 * an allocation no machine has (`size: 65536`). The checker says so in the editor rather than the baker
 * saying so an hour in.
 */
export const BAKERY: Record<"scene" | "node" | "material", Record<string, Knob>> = {
  scene: {
    include: { type: "string", values: ["all", "none"] },
    // xatlas packs into a square of about this edge; 8192² of RGBA float is already 1 GB of rasterizer
    size: { type: "number", int: true, min: 8, max: 16384 },
    samples: { type: "number", int: true, min: 1, max: 1_000_000 },
    bounces: { type: "number", int: true, min: 0, max: 64 },
    // a gain, not a count: 0 kills the bounce, 1 is physical
    indirect: { type: "number", min: 0, max: 100 },
    batch: { type: "number", int: true, min: 1, max: 1_000_000 },
    padding: { type: "number", int: true, min: 0, max: 256 },
    // 0 means "let xatlas pick the scale that fills `size`"
    texelsPerUnit: { type: "number", min: 0, max: 4096 },
    denoiseRadius: { type: "number", int: true, min: 0, max: 16 },
    dilateRadius: { type: "number", int: true, min: 0, max: 256 },
    // a multiple of the neighbourhood median, so 1 clamps every texel above it and 0 disables the pass
    fireflyThreshold: { type: "number", min: 0, max: 1000 },
    // 0 means "1e-4 of the scene diagonal"
    bias: { type: "number", min: 0 },
    defaultAlbedo: { type: "number", min: 0, max: 1 },
    ao: { type: "boolean" },
    // 0 means "5% of the scene diagonal"
    aoDistance: { type: "number", min: 0 },
    // 0 means "the 95th percentile of the atlas"
    exposure: { type: "number", min: 0 },
    out: { type: "string" },
    name: { type: "string" },
    exr: { type: "boolean" },
    lightmap: { type: "string" },
  },
  node: {
    enabled: { type: "boolean", values: ["true", "false", "occluder"] },
    radius: { type: "number", min: 0 },
    // 0 means "the scene's own texel density"
    density: { type: "number", min: 0 },
    // an equirect narrower than 4 texels is smaller than a mip and the scene walk drops it
    probe: { type: "number", int: true, min: 4, max: 8192 },
    // 0 means "no limit" — the probe reaches wherever it is one of the two nearest
    influence: { type: "number", min: 0 },
  },
  material: {
    // a linear reflectance: above 1 a surface returns more light than it received and the bake diverges
    albedo: { type: "numbers", length: 3, min: 0, max: 1 },
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
