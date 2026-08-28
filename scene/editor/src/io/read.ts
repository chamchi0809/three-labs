/**
 * A sheet, read into the tree the editor edits.
 *
 * The sheet is read **unexpanded**. `expand()` is what the runtime wants — every `@import` spliced,
 * every `var()` substituted, every `.class` merged in — and it is exactly wrong here, because after it
 * there is no longer a file for anything to be written back to. So this walks the statements as written:
 * an `@import` is followed, but the nodes it brings keep their own file; a `--var` is left standing in
 * the value that reads it; a `@template` is collected as a definition rather than pasted in.
 *
 * What the editor cannot model, it carries. A property whose value is an expression stays the `Value` the
 * parser produced, in `props`, and comes back out of a save unchanged. That is the whole reason the
 * inspector shows a greyed expression instead of a number for those: the editor is a tool that edits this
 * file, not the tool that owns it.
 */
import type {
  BrushFace, Compound, Diagnostic, Member, NodeBroom, ObjectValue, Override, Pos, Sheet, Statement,
  Template, Value,
} from "tscene";
import { brushFromFaces, faceAttributes, type Brush, type FaceAttributes } from "../brush/brush.ts";
import {
  brushNode, DEFAULT_LAYER, entityNode, groupNode, layerNode, type LayerNode, type Node, type World,
} from "../doc/document.ts";
import { literalBool, literalNumber, literalString, literalUv, literalVar, literalVec2, literalVec3 } from "./literal.ts";
import { fileOrigin, originOf, type Origin } from "./origin.ts";
import { findBraces } from "./scan.ts";

/** every file the map is made of, parsed, keyed by the path an `@import` resolved to */
export type Sheets = Map<string, Sheet>;

export type ReadResult = {
  world: World;
  /** the `@template` declarations, in the order they were seen — the editor's entity definitions */
  templates: { file: string; statement: Template }[];
  /** the `@override` rules, in source order, which is the order the last-one-wins rule needs */
  overrides: { file: string; statement: Override }[];
  diagnostics: Diagnostic[];
};

/** a statement, and which file wrote it — what following an `@import` has to keep hold of */
type Placed = { file: string; statement: Statement };

export function readWorld(root: string, sheets: Sheets): ReadResult {
  const diagnostics: Diagnostic[] = [];
  const templates: ReadResult["templates"] = [];
  const overrides: ReadResult["overrides"] = [];
  const placed = flatten(root, sheets, diagnostics);

  const broom = { grid: -2, scale: 1 };
  const layers: LayerNode[] = [];
  /** top-level nodes that are not `group`s: a plain three.js scene has a home in the editor too */
  const loose: Node[] = [];

  for (const { file, statement } of placed) {
    const text = sheets.get(file)?.text ?? "";
    if (statement.kind === "template") templates.push({ file, statement });
    else if (statement.kind === "override") overrides.push({ file, statement });
    else if (statement.kind === "at" && statement.name === "broom") {
      const grid = literalNumber(entryOf(statement.value, "grid"));
      const scale = literalNumber(entryOf(statement.value, "scale"));
      if (grid !== undefined) broom.grid = grid;
      if (scale !== undefined) broom.scale = scale;
    } else if (statement.kind === "node") {
      const node = readNode(statement.object, file, text, true);
      if (node.kind === "layer") layers.push(node);
      else loose.push(node);
    }
    // `--var`, `@import` and `@bakery` are not the editor's; they stay in the text and are never rewritten
  }

  // the loose nodes need a layer to live on, and the layer they get is the file itself
  if (loose.length || !layers.length) {
    layers.unshift(layerNode(DEFAULT_LAYER, loose, { origin: fileOrigin(root, sheets.get(root)?.text ?? "") }));
  }

  const world: World = { layers, broom };
  return { world, templates, overrides, diagnostics };
}

// ---------------------------------------------------------------- following @import

/**
 * The statements of the root sheet and everything it imports, in the order the runtime would see them.
 * A file already spliced in is skipped rather than repeated — `@import` is idempotent — and a cycle is
 * reported once instead of being followed.
 */
function flatten(root: string, sheets: Sheets, diagnostics: Diagnostic[]): Placed[] {
  const out: Placed[] = [];
  const done = new Set<string>();
  const visit = (file: string, chain: string[]) => {
    const sheet = sheets.get(file);
    if (!sheet) return;
    done.add(file);
    for (const statement of sheet.statements) {
      if (statement.kind !== "import") {
        out.push({ file, statement });
        continue;
      }
      const target = resolve(statement.path, file);
      if (chain.includes(target)) {
        diagnostics.push({ ...statement, severity: "error", message: `circular @import of ${statement.path}` });
        continue;
      }
      if (done.has(target)) continue;
      if (!sheets.has(target)) {
        diagnostics.push({ ...statement, severity: "error", message: `cannot import ${statement.path}` });
        continue;
      }
      visit(target, [...chain, target]);
    }
  };
  visit(root, [root]);
  for (const sheet of sheets.values()) diagnostics.push(...sheet.errors);
  return out;
}

/** an `@import` path against the file that wrote it — posix, because a sheet's paths are the sheet's */
export function resolve(path: string, from: string): string {
  if (!path.startsWith(".")) return path;
  const parts = from.split("/").slice(0, -1).concat(path.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (from.startsWith("/") ? "/" : "") + out.join("/");
}

// ---------------------------------------------------------------- nodes

export function readNode(o: ObjectValue, file: string, text: string, top = false): Node {
  const origin = originAt(o, file, text);
  const { broom, props, children } = readBody(o.body, file, text);
  const shared = { sheetId: o.id, origin, broom, classes: [...o.classes] };

  if (o.name === "brush") {
    const brush = readBrush(o);
    // a solid's faces are the solid; anything else in its body — a `position`, a child node hung off the
    // mesh — is carried verbatim in source order, because the editor has a tree for solids, not for what
    // somebody parented to one
    if (brush) return brushNode(brush, { ...shared, props: o.body.filter((m) => !isOwn(m)) });
  }
  if (o.name === "group") {
    const name = literalString(valueOfProp(props, "name")) ?? o.id ?? (top ? DEFAULT_LAYER : "Group");
    const rest = props.filter((m) => !(m.kind === "prop" && m.name === "name"));
    return top
      ? layerNode(name, children, { ...shared, props: rest })
      : groupNode(name, children, { ...shared, props: rest });
  }
  return entityNode(o.name, { ...shared, args: o.args, props, children });
}

/** the members of a solid's body that the editor has taken over: its `@broom` and its `face(…)` list */
const isOwn = (m: Member): boolean =>
  (m.kind === "at" && m.name === "broom") || (m.kind === "node" && m.object.name === "face");

function originAt(o: ObjectValue, file: string, text: string): Origin {
  const span: Pos = { start: o.start, end: o.end, file };
  const body = o.hasBody ? findBraces(text, o.start, o.end) : undefined;
  return originOf(file, span, o, body ? { body } : {});
}

/**
 * A node's body split three ways: the `@broom` block the editor owns, the children it lifts into the
 * tree, and everything else, which it keeps exactly as parsed.
 */
function readBody(body: Member[], file: string, text: string) {
  const props: Member[] = [];
  const children: Node[] = [];
  let broom: NodeBroom = {};
  for (const m of body) {
    if (m.kind === "node") children.push(readNode(m.object, file, text));
    else if (m.kind === "at" && m.name === "broom") broom = readBroom(m.value);
    else props.push(m);
  }
  return { broom, props, children };
}

const entryOf = (record: Value | undefined, name: string): Value | undefined =>
  record?.kind === "record" ? record.entries.find((e) => e.name === name)?.value : undefined;

const valueOfProp = (props: Member[], name: string): Value | undefined =>
  props.find((m): m is Member & { kind: "prop" } => m.kind === "prop" && m.name === name)?.value;

/** the `@broom { … }` of a node, read against the same table the checker validates it with */
export function readBroom(record: Value): NodeBroom {
  const out: NodeBroom = {};
  const kind = literalString(entryOf(record, "kind"));
  if (kind === "point" || kind === "brush") out.kind = kind;
  const icon = literalString(entryOf(record, "icon"));
  if (icon !== undefined) out.icon = icon;
  const color = literalNumber(entryOf(record, "color")) ?? hexOf(entryOf(record, "color"));
  if (color !== undefined) out.color = color;
  const layer = literalString(entryOf(record, "layer"));
  if (layer !== undefined) out.layer = layer;
  const locked = literalBool(entryOf(record, "locked"));
  if (locked !== undefined) out.locked = locked;
  const hidden = literalBool(entryOf(record, "hidden"));
  if (hidden !== undefined) out.hidden = hidden;
  const size = entryOf(record, "size");
  if (size?.kind === "array" && size.items.length === 6) {
    const numbers = size.items.map(literalNumber);
    if (numbers.every((n): n is number => n !== undefined)) out.size = numbers;
  }
  return out;
}

const hexOf = (v: Value | undefined): number | undefined => (v?.kind === "hex" ? v.value : undefined);

// ---------------------------------------------------------------- solids

/**
 * The solid a `brush { face(…) … }` describes, or nothing when any part of it is an expression the
 * editor cannot evaluate. Nothing is the right answer there rather than a guess: the node stays an
 * entity, is drawn as whatever the runtime makes of it, and survives a save untouched.
 */
export function readBrush(o: ObjectValue): Brush | undefined {
  const faces: BrushFace[] = [];
  const attributes: FaceAttributes[] = [];
  for (const m of o.body) {
    if (m.kind !== "node" || m.object.name !== "face") continue;
    const f = m.object;
    if (f.args.length !== 3) return undefined;
    const points = f.args.map(literalVec3);
    if (!points.every((p): p is NonNullable<typeof p> => !!p)) return undefined;

    const a = faceAttributes();
    for (const inner of f.body) {
      if (inner.kind !== "prop") continue;
      switch (inner.name) {
        case "uv": {
          const uv = literalUv(inner.value);
          if (!uv) return undefined;
          a.uv = uv;
          break;
        }
        case "offset": case "scale": {
          const pair = literalVec2(inner.value);
          if (!pair) return undefined;
          a[inner.name] = pair;
          break;
        }
        case "rotation": {
          const angle = literalNumber(inner.value);
          if (angle === undefined) return undefined;
          a.rotation = angle;
          break;
        }
        case "material": {
          const name = literalVar(inner.value);
          if (!name) return undefined;
          a.material = name;
          break;
        }
        // a face may carry properties the editor has no model for; they are not what makes it a solid
      }
    }
    faces.push({ points: [points[0]!, points[1]!, points[2]!], uv: a.uv, offset: a.offset, scale: a.scale, rotation: a.rotation });
    attributes.push(a);
  }
  if (faces.length < 4) return undefined;

  const built = brushFromFaces(faces);
  if (!built.brush) return undefined;
  // the geometry attributes came through the kernel with the faces; `material` is the editor's own
  // column and has to be put back on whichever face each written one turned into
  const from = built.from ?? built.brush.poly.faces.map((_, i) => i);
  return {
    poly: built.brush.poly,
    faces: built.brush.faces.map((f, i) => {
      const material = attributes[from[i] ?? -1]?.material;
      return material ? { ...f, material } : f;
    }),
  };
}

// ---------------------------------------------------------------- selectors, for @override

/** one compound against one node, the same three things a node head is written with */
export const fits = (c: Compound, node: { type: string; sheetId?: string; classes: string[] }): boolean =>
  (!c.type || c.type === node.type) &&
  (!c.id || c.id === node.sheetId) &&
  c.classes.every((cls) => node.classes.includes(cls));
