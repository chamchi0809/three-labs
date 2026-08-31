/**
 * A node the editor made, turned back into tscene syntax.
 *
 * This is the *other* half of the round trip, and the smaller one. A node that came from a file is
 * written by patching the ranges that changed, and never goes through here; this is for the solid the
 * designer just drew, which has no ranges at all and has to be printed out in full.
 *
 * Nothing here decides formatting. It builds the AST the parser would have produced and hands it to
 * tscene's own printer, so that a brush the editor wrote and a brush a person wrote come out of `print`
 * looking the same — which is the only way a generated file stays a file anyone is willing to edit.
 */
import type { Member, ObjectValue, UvMode, Value, Vec2, Vec3 } from "tscene";
import { brushToFaces, type Brush } from "../brush/brush.ts";
import type { Patch } from "../patch/patch.ts";
import { childrenOf, DEFAULT_LAYER, type GroupNode, type LayerNode, type Node, type World } from "../doc/document.ts";
import { call, ident, num, setProp, str, SYNTHETIC, vec3 } from "../doc/props.ts";
import { tidy } from "./literal.ts";

// ---------------------------------------------------------------- pieces

const record = (entries: [string, Value][]): Extract<Value, { kind: "record" }> => ({
  ...SYNTHETIC,
  kind: "record",
  entries: entries.map(([name, value]) => ({ name, namePos: SYNTHETIC, value })),
});

const at = (name: string, entries: [string, Value][]): Member => ({
  ...SYNTHETIC, kind: "at", name, value: record(entries),
});

const prop = (name: string, value: Value): Member => ({ ...SYNTHETIC, kind: "prop", name, value });
const child = (object: ObjectValue): Member => ({ ...SYNTHETIC, kind: "node", object });

/** `var(--wall)` — how a face says what it is made of, and the only value the editor ever writes by name */
export const varOf = (name: string): Value => ({ ...SYNTHETIC, kind: "var", name, namePos: SYNTHETIC });

/** degrees, because a sheet full of 0.7853981633974483 is a sheet nobody can read */
const angle = (radians: number): Value => num(tidy((radians * 180) / Math.PI), "deg");

const body = (o: ObjectValue, members: Member[]): ObjectValue => ({ ...o, body: members, hasBody: true });

/** a `#id` is only written when the name is one the lexer would hand back whole */
const isIdent = (name: string): boolean => /^[A-Za-z_][\w-]*$/.test(name);

// ---------------------------------------------------------------- @broom

/**
 * The editor's own annotation on a node. Only the keys that are set are written: `@broom {}` on every
 * node would be forty lines of nothing, and a key left out means the same as the default anyway.
 */
export function broomMember(broom: Node["broom"]): Member | undefined {
  const entries: [string, Value][] = [];
  // a bare word, not a string: an enumerated knob is written the way `@bakery { include: none }` is, and
  // the checker rejects the quoted form outright
  if (broom.kind) entries.push(["kind", ident(broom.kind)]);
  if (broom.icon !== undefined) entries.push(["icon", str(broom.icon)]);
  if (broom.category !== undefined) entries.push(["category", str(broom.category)]);
  if (broom.doc !== undefined) entries.push(["doc", str(broom.doc)]);
  if (broom.color !== undefined) {
    entries.push(["color", { ...SYNTHETIC, kind: "hex", value: broom.color, digits: 6 }]);
  }
  if (broom.layer !== undefined) entries.push(["layer", str(broom.layer)]);
  // `false` is written out rather than dropped: a sheet that says `locked: false` said it on purpose, and
  // a save that quietly deletes the line is a save that edits sentences nobody asked it to
  if (broom.locked !== undefined) entries.push(["locked", ident(String(broom.locked))]);
  if (broom.hidden !== undefined) entries.push(["hidden", ident(String(broom.hidden))]);
  if (broom.size?.length === 6) {
    entries.push(["size", { ...SYNTHETIC, kind: "array", items: broom.size.map((n) => num(tidy(n))) }]);
  }
  return entries.length ? at("broom", entries) : undefined;
}

/**
 * The world's `@broom { grid, scale }`, which is a statement rather than a member of anything.
 *
 * `said` is the statement the sheet already has, if it has one. `scale` is written when the designer has
 * moved off one metre per unit, or when the sheet was already saying it — adding `scale: 1` to a file that
 * never mentioned it would make every save of every map rewrite a line nobody touched.
 */
export const worldBroom = (world: World, said?: Member): Member => {
  const entries: [string, Value][] = [["grid", num(world.broom.grid)]];
  if (world.broom.scale !== 1 || mentions(said, "scale")) {
    entries.push(["scale", num(tidy(world.broom.scale))]);
  }
  return at("broom", entries);
};

const mentions = (member: Member | undefined, name: string): boolean =>
  member?.kind === "at" && member.value.kind === "record" && member.value.entries.some((e) => e.name === name);

// ---------------------------------------------------------------- solids

/**
 * The `face(…)` nodes of a solid. Three points and, in the body, only what differs from the default —
 * an untouched face is one line, which is what keeps a forty-brush room readable.
 */
export function faceMembers(brush: Brush): Member[] {
  return brushToFaces(brush).map((f, i) => {
    const inner: Member[] = [];
    const material = brush.faces[i]?.material;
    if (material) inner.push(prop("material", varOf(material)));
    if (f.uv) inner.push(prop("uv", uvValue(f.uv)));
    if (f.offset) inner.push(prop("offset", vec2Of(f.offset)));
    if (f.scale) inner.push(prop("scale", vec2Of(f.scale)));
    if (f.rotation) inner.push(prop("rotation", angle(f.rotation)));

    const head = call("face", f.points.map((p) => vec3([tidy(p[0]), tidy(p[1]), tidy(p[2])])));
    return child(inner.length ? body(head, inner) : head);
  });
}

const tidyVec3 = (v: Vec3): Vec3 => [tidy(v[0]), tidy(v[1]), tidy(v[2])];

// ---------------------------------------------------------------- patches

/**
 * What the surface is made of: the material, the subdivision count, and the layout.
 *
 * The layout keys go in a `uv: { … }` record rather than at the top level the way a face writes them,
 * because a patch *is* a `Mesh` and `scale`, `offset` and `rotation` on a `Mesh` are its transform. Only
 * what has been moved off the default is written, so a patch nobody has textured says nothing at all here.
 */
export function patchSettings(patch: Patch): Member[] {
  const out: Member[] = [];
  if (patch.material) out.push(prop("material", varOf(patch.material)));
  if (patch.subdivisions !== undefined) out.push(prop("subdivisions", num(patch.subdivisions)));

  const uv: [string, Value][] = [];
  const { offset, scale, rotation } = patch.uv;
  if (scale[0] !== 1 || scale[1] !== 1) uv.push(["scale", vec2Of(scale)]);
  if (offset[0] || offset[1]) uv.push(["offset", vec2Of(offset)]);
  if (rotation) uv.push(["rotation", angle(rotation)]);
  if (uv.length) out.push(prop("uv", record(uv)));
  return out;
}

/**
 * The `row(…)` grid — one row per line, because a grid wrapped by column count is a grid nobody can read,
 * and the rows are the thing a person hand-editing a patch actually reaches for.
 */
export const rowMembers = (patch: Patch): Member[] =>
  patch.grid.map((line) => child(call("row", line.map((p) => vec3(tidyVec3(p))))));

const vec2Of = (v: Vec2): Value => call("vec2", [num(tidy(v[0])), num(tidy(v[1]))]);

const uvValue = (uv: UvMode): Value =>
  uv.kind === "parallel" && uv.u && uv.v
    ? call("parallel", [vec3(tidyVec3(uv.u)), vec3(tidyVec3(uv.v))])
    : ident(uv.kind);

// ---------------------------------------------------------------- naming a group

/**
 * Where a group's name is written.
 *
 * tscene has two ways to say it — `group #Hall` and `group { name: "Hall" }` — and which one a sheet used
 * is the author's choice, not the editor's. Changing it would mean a file that reformats itself the first
 * time it is opened, so the rule is: keep saying it the way it was already said, and only choose when
 * nobody has chosen yet. A name with a space in it has to be a string whatever the sheet did.
 */
export type NameAt = "head" | "prop" | "nowhere";

export function nameAt(node: GroupNode | LayerNode): NameAt {
  const was = node.origin?.was;
  if (was?.body.some((m) => m.kind === "prop" && m.name === "name")) return "prop";
  if (was?.id !== undefined && was.id === node.name) return "head";
  // the sheet named it nothing and the designer has not renamed it: the name is the reader's default
  if (node.origin && was?.id === undefined && node.name === (node.kind === "layer" ? DEFAULT_LAYER : "Group")) {
    return "nowhere";
  }
  return isIdent(node.name) ? "head" : "prop";
}

// ---------------------------------------------------------------- nodes

/**
 * A node's own members: everything in its body that is not a child node.
 *
 * The writer and the printer both go through here, so that "what this node says" has one definition. For
 * a solid that includes its `face(…)` list, which is part of the solid rather than part of the tree.
 */
export function ownMembers(node: Node): Member[] {
  const broom = broomMember(node.broom);
  const head = broom ? [broom] : [];
  if (node.kind === "group" || node.kind === "layer") {
    const props = nameAt(node) === "prop" ? setProp(node.props, "name", str(node.name)) : node.props;
    return [...head, ...props];
  }
  // a patch's three surface keys are settings, not geometry: they are diffed by name like any other
  // property, which is what lets a `uv` that went back to the default be dropped rather than blanked
  if (node.kind === "patch") return [...head, ...patchSettings(node.patch), ...node.props];
  return [...head, ...node.props];
}

/** the head a node would be written with, and nothing else — the thing a save compares to decide */
export function headOf(node: Node): ObjectValue {
  const name =
    node.kind === "brush" ? "brush"
    : node.kind === "patch" ? "patch"
    : node.kind === "object" ? node.type
    : "group";
  // a group whose name lives in a `name:` property still keeps whatever `#id` the sheet gave it: the two
  // are different things to three, and only one of them is the editor's to rewrite
  const id =
    node.kind === "group" || node.kind === "layer"
      ? nameAt(node) === "head" ? node.name : node.sheetId
      : node.sheetId;
  return {
    ...call(name, node.kind === "object" ? node.args : []),
    classes: [...node.classes],
    classSpans: node.classes.map(() => SYNTHETIC),
    ...(id !== undefined ? { id } : {}),
  };
}

/**
 * A whole node as the parser would have produced it. Children come last, after the node's own settings,
 * because that is how a sheet reads: what this thing is, then what is inside it.
 */
export function toObject(node: Node): ObjectValue {
  const head = headOf(node);
  const inside =
    node.kind === "brush" ? faceMembers(node.brush)
    : node.kind === "patch" ? rowMembers(node.patch)
    : childrenOf(node).map((k) => child(toObject(k)));
  const members = [...ownMembers(node), ...inside];
  // a node with nothing inside it is written as a call, which is how `pointLight(#fff, 2)` stays one line
  return members.length ? body(head, members) : head;
}
