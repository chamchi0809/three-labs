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

export const className = (name: string) => ALIASES[name] ?? name[0]!.toUpperCase() + name.slice(1);
export const nodeName = (cls: string) => cls[0]!.toLowerCase() + cls.slice(1);
