/**
 * Reading and writing the values in a node's body.
 *
 * The document keeps a node's settings as the `Member[]` the parser produced rather than as a decoded
 * object, because most of what a sheet says is none of the editor's business — a curve, a `calc()`, an
 * `each()` — and anything the editor decodes and re-encodes is something it can quietly reformat. So the
 * rule is: touch the one property a tool is actually changing, leave every other byte alone.
 *
 * A value the editor makes up has no place in the source yet, and says so with a zero span. That is the
 * signal the round-trip engine reads to decide between patching the range a value came from and printing
 * a new one.
 */
import type { Member, ObjectValue, Pos, Value, Vec3 } from "tscene";

/** the span of a value that was never in the source */
export const SYNTHETIC: Pos = { start: 0, end: 0 };

/** whether a value came from a sheet or from a tool */
export const isSynthetic = (v: Pos): boolean => v.start === 0 && v.end === 0;

export const num = (value: number, unit: "" | "deg" | "rad" = ""): Value => ({ ...SYNTHETIC, kind: "number", value, unit });
export const str = (value: string): Value => ({ ...SYNTHETIC, kind: "string", value });
export const ident = (name: string): Value => ({ ...SYNTHETIC, kind: "ident", name });
export const hex = (value: number, digits: 6 | 8 = 6): Value => ({ ...SYNTHETIC, kind: "hex", value, digits });

/** `name(a, b, …)` — how every compound value is written in a sheet, `vec3(0, 1, 0)` included */
export const call = (name: string, args: Value[]): ObjectValue => ({
  ...SYNTHETIC,
  kind: "object",
  name,
  classes: [],
  classSpans: [],
  args,
  body: [],
  hasBody: false,
});

export const vec3 = (v: Vec3): Value => call("vec3", [num(v[0]), num(v[1]), num(v[2])]);

// ---------------------------------------------------------------- reading

export const propOf = (props: Member[], name: string): Extract<Member, { kind: "prop" }> | undefined =>
  props.find((m): m is Extract<Member, { kind: "prop" }> => m.kind === "prop" && m.name === name);

export const valueOf = (props: Member[], name: string): Value | undefined => propOf(props, name)?.value;

/** a literal number, or nothing — a `var()` or a `calc()` is a number the editor is not entitled to guess */
export function numberOf(props: Member[], name: string): number | undefined {
  const v = valueOf(props, name);
  return v?.kind === "number" ? v.value : undefined;
}

export function stringOf(props: Member[], name: string): string | undefined {
  const v = valueOf(props, name);
  return v?.kind === "string" ? v.value : undefined;
}

/** `vec3(x, y, z)` or `[x, y, z]`, whichever the sheet wrote; anything else is not a place */
export function vec3Of(props: Member[], name: string): Vec3 | undefined {
  const v = valueOf(props, name);
  const args = v?.kind === "object" && v.name === "vec3" ? v.args : v?.kind === "array" ? v.items : undefined;
  if (!args || args.length !== 3) return undefined;
  const n = args.map((a) => (a.kind === "number" ? a.value : NaN));
  return n.some(Number.isNaN) ? undefined : [n[0]!, n[1]!, n[2]!];
}

// ---------------------------------------------------------------- writing

/**
 * One property set, in place if it was already there and appended if it was not. Appended rather than
 * inserted in any clever order, because the order a sheet lists its properties in is the author's, and
 * an editor that sorts them is an editor whose diffs are unreadable.
 */
export function setProp(props: Member[], name: string, value: Value): Member[] {
  const at = props.findIndex((m) => m.kind === "prop" && m.name === name);
  const prop: Member = { ...SYNTHETIC, kind: "prop", name, value };
  if (at < 0) return [...props, prop];
  // the property keeps the span it had, so the round trip patches its value and leaves its name alone
  const was = props[at]!;
  return props.map((m, i) => (i === at ? { ...prop, start: was.start, end: was.end } : m));
}

export const removeProp = (props: Member[], name: string): Member[] =>
  props.filter((m) => !(m.kind === "prop" && m.name === name));

export const setVec3 = (props: Member[], name: string, v: Vec3): Member[] => setProp(props, name, vec3(v));
export const setNumber = (props: Member[], name: string, v: number): Member[] => setProp(props, name, num(v));
export const setString = (props: Member[], name: string, v: string): Member[] => setProp(props, name, str(v));
