/**
 * The narrow gate between a sheet's values and the editor's numbers.
 *
 * A tscene value can be a `var(--wall)`, a `calc()` over a loop binding, or a method call on a spline —
 * things whose value is only known when the scene is built. The editor reads *literals* and nothing else:
 * `vec3(0, 1, 0)` is a position it can drag, `var(--start)` is not.
 *
 * This is not a limitation being apologised for, it is the round-trip working. A node whose position is
 * an expression keeps that expression through a save, because the editor never claimed to know what it
 * was and so never rewrote it. What the designer cannot drag, they also cannot destroy by accident.
 *
 * Printing goes back out through tscene's own printer rather than a second one written here, because a
 * second printer is a second dialect, and the first `#00000080` it turns into `#000080` is a bug nobody
 * finds until a save.
 */
import { print, type Member, type ObjectValue, type Sheet, type UvMode, type Value, type Vec2, type Vec3 } from "tscene";
import { SYNTHETIC } from "../doc/props.ts";

// ---------------------------------------------------------------- reading

/** a plain number, in radians if it was written with a unit — the same conversion the runtime does */
export function literalNumber(v: Value | undefined): number | undefined {
  if (v?.kind !== "number") return undefined;
  return v.unit === "deg" ? (v.value * Math.PI) / 180 : v.value;
}

export const literalString = (v: Value | undefined): string | undefined => (v?.kind === "string" ? v.value : undefined);

export function literalBool(v: Value | undefined): boolean | undefined {
  return v?.kind === "ident" && (v.name === "true" || v.name === "false") ? v.name === "true" : undefined;
}

/** the numbers of a `vec3(x, y, z)`, a `vec2(u, v)`, or a bare `[…]` of the right length */
function numbers(v: Value | undefined, count: number, call: string): number[] | undefined {
  const items =
    v?.kind === "array" ? v.items
    : v?.kind === "object" && v.name === call ? v.args
    : undefined;
  if (!items || items.length !== count) return undefined;
  const out = items.map(literalNumber);
  return out.every((n): n is number => n !== undefined) ? out : undefined;
}

export const literalVec3 = (v: Value | undefined): Vec3 | undefined => numbers(v, 3, "vec3") as Vec3 | undefined;
export const literalVec2 = (v: Value | undefined): Vec2 | undefined => numbers(v, 2, "vec2") as Vec2 | undefined;

/** `paraxial`, `parallel`, or `parallel(u, v)` — read from the syntax, exactly as the runtime reads it */
export function literalUv(v: Value | undefined): UvMode | undefined {
  if (v?.kind === "ident" && v.name === "paraxial") return { kind: "paraxial" };
  if (v?.kind === "ident" && v.name === "parallel") return { kind: "parallel" };
  if (v?.kind === "object" && v.name === "parallel" && v.args.length === 2) {
    const u = literalVec3(v.args[0]);
    const w = literalVec3(v.args[1]);
    return u && w ? { kind: "parallel", u, v: w } : undefined;
  }
  return undefined;
}

/** the `--var` a `material:` names, which is how a face says what it is made of */
export const literalVar = (v: Value | undefined): string | undefined => (v?.kind === "var" ? v.name : undefined);

// ---------------------------------------------------------------- writing

const sheetOf = (statements: Member[]): Sheet => ({ statements, comments: [], text: "", errors: [] });

/** one member as a sheet would write it, with no trailing newline */
export const printMember = (m: Member): string => print(sheetOf([m])).trimEnd();

/**
 * One value as a sheet would write it. Printed as the right-hand side of a property and then cut back
 * out of it, so that every case the printer knows — hex widths, `calc()` parentheses, nested objects —
 * comes out here too rather than being re-derived and got subtly wrong.
 */
export function printValue(v: Value): string {
  const line = printMember({ ...SYNTHETIC, kind: "prop", name: "x", value: v });
  return line.slice("x: ".length, -1);
}

/** the members a node's body would be written with, one per line, at no indentation */
export const printMembers = (list: Member[]): string => list.map(printMember).join("\n");

export const printNode = (o: ObjectValue): string => printMember({ ...SYNTHETIC, kind: "node", object: o });

/** what two values mean, compared — the test for "did this property actually change" */
export const sameValue = (a: Value | undefined, b: Value | undefined): boolean =>
  a === b || (!!a && !!b && printValue(a) === printValue(b));

/**
 * Rounded to something a person would have typed. Floating point turns a 45° rotation into
 * 0.7853981633974483 metres of offset and back, and a file full of those is a file nobody can read or
 * diff — but rounding what the designer never touched would be a change they did not make, so this is
 * only ever applied to numbers the editor itself computed.
 */
export const tidy = (n: number, places = 6): number => {
  const r = Number(n.toFixed(places));
  return Object.is(r, -0) ? 0 : r;
};
