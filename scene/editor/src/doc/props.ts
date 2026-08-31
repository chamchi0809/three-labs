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
export const bool = (value: boolean): Value => ident(value ? "true" : "false");

/** `ref(#lamp)` — a node named by the `#id` the sheet gave it */
export const ref = (name: string): Value => ({ ...SYNTHETIC, kind: "ref", name, namePos: SYNTHETIC });

/** `var(--wall)` — a `--var` read by name, which is how a face names what it is made of */
export const read = (name: string): Value => ({ ...SYNTHETIC, kind: "var", name, namePos: SYNTHETIC });

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

/** `{ a: 1; b: 2 }` — the one place a sheet keeps names three has no property for, `userData` included */
export const record = (entries: [string, Value][]): Value => ({
  ...SYNTHETIC,
  kind: "record",
  entries: entries.map(([name, value]) => ({ name, namePos: SYNTHETIC, value })),
});

/**
 * `color(#ff8000)` — a colour on a three object, which is the only spelling that survives leaving here.
 *
 * A bare `#ff8000` is a number, and tscene means that literally: the runtime assigns it, so
 * `material.color` stops being a `Color` and becomes `16744448`. Nothing complains — the editor draws its
 * own materials and never asks the runtime for one — but the lightmap baker reads `.r` off it, gets
 * `undefined`, and traces a room lit by NaN. The atlas comes back black.
 *
 * So a colour the editor writes is always the call. `@broom { color: … }` is the exception and stays a
 * bare hex: that block is settings for a tool, where a number is what is wanted and what is read back.
 */
export const colour = (value: number, digits: 6 | 8 = 6): Value => call("color", [hex(value, digits)]);

/** a colour written as `color(#rrggbb)`, `#rrggbb` or a plain number — every spelling that means one */
export function asColour(v: Value | undefined): number | undefined {
  const inner = v?.kind === "object" && (v.name === "color" || v.name === "Color") && v.args.length === 1
    ? v.args[0]
    : v;
  return inner?.kind === "hex" || inner?.kind === "number" ? inner.value : undefined;
}

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
export function asVec3(v: Value | undefined): Vec3 | undefined {
  const args = v?.kind === "object" && v.name === "vec3" ? v.args : v?.kind === "array" ? v.items : undefined;
  if (!args || args.length !== 3) return undefined;
  const n = args.map((a) => (a.kind === "number" ? a.value : NaN));
  return n.some(Number.isNaN) ? undefined : [n[0]!, n[1]!, n[2]!];
}

export const vec3Of = (props: Member[], name: string): Vec3 | undefined => asVec3(valueOf(props, name));

/** every `ref(#name)` inside a value, however deeply it is nested in arrays, records and calls */
export function* refsIn(value: Value): Generator<string> {
  switch (value.kind) {
    case "ref":
      yield value.name;
      return;
    case "array":
      for (const item of value.items) yield* refsIn(item);
      return;
    case "record":
      for (const entry of value.entries) yield* refsIn(entry.value);
      return;
    case "object":
      for (const arg of value.args) yield* refsIn(arg);
      for (const member of value.body) {
        if (member.kind === "prop" || member.kind === "var") yield* refsIn(member.value);
      }
      return;
    case "calc":
      yield* refsIn(value.left);
      yield* refsIn(value.right);
      return;
    case "fn":
      for (const arg of value.args) yield* refsIn(arg);
      return;
    case "each":
      yield* refsIn(value.over);
      yield* refsIn(value.body);
      return;
    case "read":
      yield* refsIn(value.target);
      return;
    case "call":
      yield* refsIn(value.target);
      for (const arg of value.args) yield* refsIn(arg);
      return;
    case "index":
      yield* refsIn(value.target);
      yield* refsIn(value.at);
      return;
    case "var":
      if (value.fallback) yield* refsIn(value.fallback);
      return;
    default:
      return;
  }
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
