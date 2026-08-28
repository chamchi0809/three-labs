// Type checks an expanded .tscene AST against a reflected three schema.
// Pure (no typescript / no three import) so it runs in the browser too.
import type { Diagnostic, Member, ObjectValue, Override, Pos, Template, Value } from "./parse.ts";
import type { ClassInfo, Param, Schema, TypeRef } from "./schema.ts";
import { ALIASES, BAKERY, BROOM, BUILTINS, FACE_PROPS, LOADERS, MATH, className, concrete, nodeName, type Knob } from "./names.ts";
import { buildBrush, type BrushFace, type UvMode, type Vec3 } from "./brush.ts";

/** Levenshtein distance, two rows at a time */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]!;
}

export function check(nodes: Member[], schema: Schema, templates: Template[] = [], overrides: Override[] = []): Diagnostic[] {
  const out: Diagnostic[] = [];
  const templateOf = new Map(templates.map((t) => [t.name, t]));
  const err = (message: string, pos: Pos, fix?: Diagnostic["fix"]): void => {
    out.push({ message, severity: "error", start: pos.start, end: pos.end, file: pos.file, ...(fix ? { fix } : {}) });
  };

  const info = (cls: string): ClassInfo | undefined => schema.classes[cls];

  /** walks the base chain; `Mesh` isA `Object3D` */
  function isA(cls: string, base: string): boolean {
    if (cls === base) return true;
    const seen = new Set<string>();
    const stack = [cls];
    while (stack.length) {
      const c = stack.pop()!;
      if (c === base) return true;
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(...(info(c)?.bases ?? []));
    }
    return false;
  }

  function propOf(cls: string, name: string) {
    return info(cls)?.props[name];
  }

  /** node names the host registers at runtime — the schema cannot see them, so they are unchecked */
  const declared = (name: string) => schema.declared?.includes(name) ?? false;

  /** what an enclosing `each()` binds its name to, so `var(--p).x` resolves */
  const loop = new Map<string, TypeRef>();

  /** the type of `target.name`, or of what `target.name(…)` returns */
  function memberType(v: Value & { kind: "read" | "call" }): TypeRef {
    const target = valueType(v.target);
    if (target.kind !== "class") return { kind: "any" };
    const cls = concrete(target.name);
    if (v.kind === "read") return propOf(cls, v.name)?.type ?? { kind: "any" };
    // an overload set: every signature of a three method returns the same thing in practice
    return info(cls)?.methods[v.name]?.[0]?.returns ?? { kind: "any" };
  }

  function valueType(v: Value): TypeRef {
    switch (v.kind) {
      case "number": return { kind: "number" };
      case "hex": return { kind: "number" };
      case "string": return { kind: "string" };
      case "fn": return { kind: "number" };
      case "each": return { kind: "array", of: elementBound(v, () => valueType(v.body)) };
      case "read": case "call": return memberType(v);
      case "index": {
        const t = valueType(v.target);
        return t.kind === "array" ? t.of : { kind: "any" };
      }
      case "var": return loop.get(v.name) ?? { kind: "any" };
      case "ref": {
        const cls = v.node && className(v.node);
        return cls && info(cls) ? { kind: "class", name: cls } : { kind: "any" };
      }
      case "calc": return { kind: "number" };
      // a record's keys are checked against the slot's own fields, so it never needs a type of its own
      case "record": return { kind: "any" };
      case "array": {
        const of: TypeRef[] = [];
        for (const item of v.items) {
          const t = valueType(item);
          if (!of.some((o) => JSON.stringify(o) === JSON.stringify(t))) of.push(t);
        }
        return { kind: "array", of: of.length === 0 ? { kind: "any" } : of.length === 1 ? of[0]! : { kind: "union", of } };
      }
      case "ident": {
        if (v.name === "true" || v.name === "false") return { kind: "boolean" };
        if (v.name === "null") return { kind: "null" };
        const c = schema.constants[v.name];
        if (!c) return { kind: "any" };
        // numeric constants keep their name so `side: NormalBlending` still fails; string ones
        // (SRGBColorSpace, …) are typed as plain strings by three, so they pass as strings
        return c.kind === "number" ? { kind: "enum", name: v.name, members: [v.name] } : c;
      }
      case "object": {
        const cls = className(v.name);
        return info(cls) ? { kind: "class", name: cls } : { kind: "any" };
      }
    }
  }

  function assignable(from: TypeRef, to: TypeRef): boolean {
    if (to.kind === "any" || from.kind === "any") return true;
    if (to.kind === "union") return to.of.some((t) => assignable(from, t));
    if (from.kind === "union") return from.of.every((t) => assignable(t, to));
    // ponytail: a raw number passes for an enum — three accepts it and the schema keeps names, not values
    if (to.kind === "enum") return from.kind === "number" || (from.kind === "enum" && from.members.every((m) => to.members.includes(m)));
    if (from.kind === "enum") return to.kind === "number";
    if (to.kind === "array") return from.kind === "array" && assignable(from.of, to.of);
    if (from.kind === "array") return false;
    if (to.kind === "class") return from.kind === "class" && isA(from.name, to.name);
    if (to.kind === "record" || from.kind === "record") return from.kind === to.kind;
    return from.kind === to.kind;
  }

  const show = (t: TypeRef): string =>
    t.kind === "class" || t.kind === "enum" ? t.name
      : t.kind === "record" ? (t.name ?? `{ ${Object.keys(t.fields).join(", ")} }`)
        : t.kind === "union" ? t.of.map(show).join(" | ") : t.kind === "array" ? `${show(t.of)}[]` : t.kind;

  /** closest candidate by edit distance, case-insensitively — `positon` finds `position` */
  function suggest(name: string, candidates: string[]): string | undefined {
    const lower = name.toLowerCase();
    const exact = candidates.find((c) => c.toLowerCase() === lower && c !== name);
    if (exact) return exact;
    let best: string | undefined;
    let bestScore = name.length <= 4 ? 2 : name.length <= 8 ? 3 : 4; // beyond this it is a different word
    for (const c of candidates) {
      const d = distance(lower, c.toLowerCase());
      if (d < bestScore) { best = c; bestScore = d; }
    }
    return best;
  }

  /** the array element type `t` accepts, or undefined if `t` takes no array at all */
  function elementType(t: TypeRef): TypeRef | undefined {
    if (t.kind === "array") return t.of;
    if (t.kind === "any") return t;
    if (t.kind === "union") for (const part of t.of) { const el = elementType(part); if (el) return el; }
    return undefined;
  }

  /**
   * Runs `fn` with the `each()` bindings in scope: the named one gets the item type, and `--index` and
   * `--count` are numbers, exactly as in `repeat()`.
   */
  function elementBound<T>(v: Value & { kind: "each" }, fn: () => T): T {
    const over = valueType(v.over);
    const item: TypeRef = over.kind === "array" ? over.of : { kind: "number" };
    const saved = [v.name, "index", "count"].map((name) => [name, loop.get(name)] as const);
    loop.set(v.name, item);
    loop.set("index", { kind: "number" });
    loop.set("count", { kind: "number" });
    try {
      return fn();
    } finally {
      for (const [name, was] of saved) was === undefined ? loop.delete(name) : loop.set(name, was);
    }
  }

  /** the options bag `t` accepts, or undefined if `t` takes no record at all */
  function recordType(t: TypeRef): Extract<TypeRef, { kind: "record" }> | undefined {
    if (t.kind === "record") return t;
    if (t.kind === "union") for (const part of t.of) { const r = recordType(part); if (r) return r; }
    return undefined;
  }

  /** `{ capStart: true }` against the fields the slot declares — keys, their types, and what is missing */
  function checkRecord(v: Value & { kind: "record" }, shape: Extract<TypeRef, { kind: "record" }>, slot: string) {
    const table = shape.fields;
    // a named bag reads better as itself than as the slot it sits in: `LoftGeometryOptions.capStart`
    const what = shape.name ?? slot;
    for (const e of v.entries) {
      const field = table[e.name];
      if (!field) {
        const alt = suggest(e.name, Object.keys(table));
        err(
          `${show(shape)} has no setting ${JSON.stringify(e.name)}` + (alt ? `; did you mean ${alt}?` : ""),
          e.namePos,
          alt ? { start: e.namePos.start, end: e.namePos.end, text: alt } : undefined,
        );
        continue;
      }
      checkValue(e.value, { type: field.type, what: `${what}.${e.name}` });
    }
    const missing = Object.entries(table).filter(([name, f]) => !f.optional && !v.entries.some((e) => e.name === name));
    if (missing.length) err(`${what} is missing ${missing.map(([name]) => name).join(", ")}`, v);
  }

  function checkValue(v: Value, expect: { type: TypeRef; what: string }): void {
    const mismatch = () => err(`${expect.what} expects ${show(expect.type)}, got ${show(valueType(v))}`, v);
    if (v.kind === "object") return checkObject(v, expect);
    if (v.kind === "calc" || v.kind === "fn") {
      checkArith(v);
      if (!assignable({ kind: "number" }, expect.type)) mismatch();
      return;
    }
    if (v.kind === "read" || v.kind === "call" || v.kind === "index") {
      checkChain(v);
      if (!assignable(valueType(v), expect.type)) mismatch();
      return;
    }
    if (v.kind === "each") {
      const el = elementType(expect.type);
      if (!el) return mismatch();
      const over = valueType(v.over);
      if (!assignable(over, { kind: "union", of: [{ kind: "number" }, { kind: "array", of: { kind: "any" } }] })) {
        err(`each() counts to a number or walks an array, got ${show(over)}`, v.over);
      }
      checkValue(v.over, { type: { kind: "any" }, what: `each() over` });
      return elementBound(v, () => checkValue(v.body, { type: el, what: `each() item` }));
    }
    if (v.kind === "array") {
      const el = elementType(expect.type);
      if (!el) return mismatch();
      for (const item of v.items) checkValue(item, { type: el, what: `${expect.what} item` });
      return;
    }
    if (v.kind === "record") {
      const shape = recordType(expect.type);
      if (shape) return checkRecord(v, shape, expect.what);
      if (expect.type.kind !== "any") return mismatch();
      for (const e of v.entries) checkValue(e.value, { type: { kind: "any" }, what: `${expect.what}.${e.name}` });
      return;
    }
    // an ident is either a three constant or a typo — `side: DubleSide` used to slip through as `any`
    if (v.kind === "ident" && !["true", "false", "null"].includes(v.name) && !schema.constants[v.name] && !declared(v.name)) {
      const alt = suggest(v.name, Object.keys(schema.constants));
      err(
        `unknown constant ${JSON.stringify(v.name)}` + (alt ? `; did you mean ${alt}?` : ""),
        v,
        alt ? { start: v.start, end: v.end, text: alt } : undefined,
      );
      return;
    }
    if (!assignable(valueType(v), expect.type)) mismatch();
  }

  /** `calc(…)` and the functions in it: numbers all the way down, and the right number of arguments */
  function checkArith(v: Value) {
    if (v.kind === "calc") { checkArith(v.left); checkArith(v.right); return; }
    if (v.kind === "fn") {
      const knob = MATH[v.name]!;
      if (v.args.length !== knob.arity) err(`${v.name}() takes ${knob.arity} argument(s), got ${v.args.length}`, v);
      for (const a of v.args) checkArith(a);
      return;
    }
    if (v.kind === "read" || v.kind === "call" || v.kind === "index") checkChain(v);
    if (v.kind === "number" || v.kind === "hex") return;
    if (!assignable(valueType(v), { kind: "number" })) err(`calc() works on numbers, got ${show(valueType(v))}`, v);
  }

  /** `var(--p).x`, `splineCurve(…).getPoints(120)`, `var(--points)[0]` — each link against the schema */
  function checkChain(v: Value) {
    if (v.kind === "index") {
      checkChain(v.target);
      const t = valueType(v.target);
      if (t.kind !== "array" && t.kind !== "any") err(`${show(t)} is not a list, so it cannot be indexed`, v);
      checkValue(v.at, { type: { kind: "number" }, what: "an index" });
      return;
    }
    if (v.kind !== "read" && v.kind !== "call") return checkValue(v, { type: { kind: "any" }, what: "a value" });
    checkChain(v.target);
    const target = valueType(v.target);
    if (target.kind !== "class") return; // `any` — a loop binding over a list the schema cannot type
    const cls = concrete(target.name);
    if (!info(cls)) return;
    const method = info(cls)!.methods[v.name];
    if (v.kind === "call") {
      if (!method) {
        const alt = suggest(v.name, Object.keys(info(cls)!.methods));
        err(`${cls} has no method ${JSON.stringify(v.name)}` + (alt ? `; did you mean ${alt}?` : ""), v.namePos,
          alt ? { start: v.namePos.start, end: v.namePos.end, text: alt } : undefined);
        return;
      }
      checkOverloads(method, v.args, `${cls}.${v.name}()`, v);
      return;
    }
    if (propOf(cls, v.name)) return;
    if (method) {
      err(`${cls}.${v.name} is a method — call it as .${v.name}(…)`, v.namePos);
      return;
    }
    const alt = suggest(v.name, Object.keys(info(cls)!.props));
    err(`${cls} has no property ${JSON.stringify(v.name)}` + (alt ? `; did you mean ${alt}?` : ""), v.namePos,
      alt ? { start: v.namePos.start, end: v.namePos.end, text: alt } : undefined);
  }

  /**
   * How many of `params` have to be passed. TypeScript only ever writes optionals at the tail, so the
   * first optional ends the required prefix — reading it that way can never over-report on a signature
   * the reflection typed oddly.
   */
  function required(params: { optional: boolean }[]): number {
    const first = params.findIndex((p) => p.optional);
    return first === -1 ? params.length : first;
  }

  /** positional arguments against a constructor or method signature */
  function checkArgs(params: { name: string; type: TypeRef; optional: boolean }[], args: Value[], what: string, at: Pos) {
    if (args.length > params.length) {
      err(`${what} takes at most ${params.length} argument(s), got ${args.length}`, args[params.length] ?? at);
    }
    // three defaults most arguments and the typings say so, so what is left is genuinely required:
    // `textGeometry()` used to check clean and throw inside three with no line to point at
    const need = required(params);
    if (args.length < need) {
      const list = params.slice(0, need).map((p) => `${p.name}: ${show(p.type)}`).join(", ");
      err(`${what} needs ${need} argument(s) (${list}), got ${args.length}`, at);
    }
    args.forEach((a, i) => {
      const p = params[i];
      if (p) checkValue(a, { type: p.type, what: `argument ${p.name} of ${what}` });
    });
  }

  /**
   * An overloaded call — a method (`lookAt(v)` / `lookAt(x, y, z)`) or a constructor (`color(#fff)` /
   * `color(1, .5, 0)`) — passes if any signature does; else the closest one reports.
   */
  function checkOverloads(signatures: { params: Param[] }[], args: Value[], what: string, at: Pos) {
    let best: { distance: number; produced: Diagnostic[] } | undefined;
    for (const { params } of signatures) {
      const mark = out.length;
      checkArgs(params, args, what, at);
      const produced = out.splice(mark);
      if (!produced.length) return;
      const distance = Math.abs(params.length - args.length);
      if (!best || distance < best.distance) best = { distance, produced };
    }
    if (best) out.push(...best.produced);
  }

  function checkObject(o: ObjectValue, expect?: { type: TypeRef; what: string }) {
    const cls = className(o.name);
    if (declared(o.name)) return; // a registry class: no typings to check it against
    if (!info(cls)) {
      const alt = suggest(cls, Object.keys(schema.classes));
      err(
        `unknown three class ${JSON.stringify(cls)}` + (alt ? `; did you mean ${nodeName(alt)}?` : ""),
        { start: o.start, end: o.start + o.name.length, file: o.file },
        alt ? { start: o.start, end: o.start + o.name.length, text: nodeName(alt) } : undefined,
      );
      return;
    }
    if (info(cls)!.abstract) err(`${cls} is abstract and cannot be constructed`, o);

    const canonical = ALIASES[o.name] ? o.name : nodeName(cls);
    if (o.name !== canonical) {
      const range = { start: o.start, end: o.start + o.name.length, file: o.file };
      out.push({
        message: `write ${canonical} — node and value names are three class names with a lowercase first letter`,
        severity: "warning",
        ...range,
        fix: { ...range, text: canonical },
      });
    }

    // `.glow` must be a template declared for this node type
    for (const [i, name] of o.classes.entries()) {
      const range = o.classSpans[i] ?? o;
      const want = templateOf.get(name)?.node;
      if (want && info(className(want)) && !isA(cls, className(want))) {
        err(`.${name} is a ${className(want)} template, but ${cls} is not a ${className(want)}`, range);
      }
    }

    // constructor arguments. A loader's are its own — `gltf()` takes a url, and reporting it as the
    // `Group()` it returns names a constructor the sheet never wrote.
    const loader = LOADERS[o.name];
    const overloads = loader
      ? [loader.args.map((type) => ({ name: "url", type, optional: false }))]
      : info(cls)!.ctors;
    checkOverloads(overloads.map((params) => ({ params })), o.args, `${loader ? o.name : nodeName(cls)}()`, o);

    if (expect && !assignable({ kind: "class", name: cls }, expect.type)) {
      err(`${expect.what} expects ${show(expect.type)}, got ${cls}`, o);
    }
    if (o.id && !propOf(cls, "name")) err(`${cls} has no name property, so #${o.id} cannot be applied`, o);

    checkBody(cls, o.body);
  }

  /** `find(mesh, "Body") { … }` — reaches into a subtree that already exists (a loaded gltf, usually) */
  function checkFind(o: ObjectValue) {
    const [first, second] = o.args;
    const nameArg = o.args.length === 2 ? second : first;
    let target = "Object3D";
    if (o.args.length < 1 || o.args.length > 2 || nameArg?.kind !== "string") {
      err(`find() takes an optional node type and a name: find(mesh, "Body")`, o);
    } else if (o.args.length === 2) {
      if (first!.kind !== "ident") err(`the first argument of find() is a node type, e.g. find(mesh, "Body")`, first!);
      else {
        const cls = className(first.name);
        if (!info(cls)) err(`unknown three class ${JSON.stringify(cls)}`, first);
        else if (!isA(cls, "Object3D")) err(`${cls} is not an Object3D, so find() cannot return one`, first);
        else target = cls;
      }
    }
    checkBody(target, o.body);
  }

  /** `play("Idle") { timeScale: 2; }` — a clip of the gltf it sits in, plus AnimationAction settings */
  function checkPlay(o: ObjectValue) {
    if (o.args.length !== 1 || o.args[0]!.kind !== "string") err(`play() takes a clip name: play("Idle")`, o);
    if (info("AnimationAction")) checkBody("AnimationAction", o.body);
  }

  /**
   * `@bakery { … }` and `@broom { … }` — settings for a tool, not for three, so the reflected schema has
   * nothing to say about them. They are typed by the tables in names.ts instead, per position: the baker
   * reads a sheet, a node and a material, the editor only a sheet and a node.
   */
  function checkAtRule(m: Member & { kind: "at" }, position: "scene" | "node" | "material" | undefined) {
    const table =
      m.name === "broom"
        ? position === "scene" || position === "node" ? BROOM[position] : undefined
        : position ? BAKERY[position] : undefined;
    if (!table) {
      return err(`@${m.name} belongs on ${m.name === "broom" ? "the sheet or a node" : "the sheet, a node or a material"}`, m);
    }
    for (const e of m.value.entries) {
      const knob = table[e.name];
      if (!knob) {
        const alt = suggest(e.name, Object.keys(table));
        err(
          `@${m.name} has no ${position} setting ${JSON.stringify(e.name)}` + (alt ? `; did you mean ${alt}?` : ""),
          e.namePos,
          alt ? { start: e.namePos.start, end: e.namePos.end, text: alt } : undefined,
        );
        continue;
      }
      checkKnob(e.value, knob, `@${m.name} ${e.name}`);
    }
  }

  // ---------------------------------------------------------------- brush

  /** a literal `vec3(1, 2, 3)` or `[1, 2, 3]` — undefined for anything the checker cannot fold to numbers */
  function literalVec3(v: Value | undefined): Vec3 | undefined {
    if (!v) return undefined;
    const items =
      v.kind === "array" ? v.items
        : v.kind === "object" && (v.name === "vec3" || v.name === "vector3") ? v.args
          : undefined;
    if (!items || items.length !== 3) return undefined;
    const out: number[] = [];
    for (const i of items) {
      if (i.kind !== "number") return undefined;
      out.push(i.value);
    }
    return out as Vec3;
  }

  function literalVec2(v: Value): [number, number] | undefined {
    const items =
      v.kind === "array" ? v.items
        : v.kind === "object" && (v.name === "vec2" || v.name === "vector2") ? v.args
          : undefined;
    if (!items || items.length !== 2) return undefined;
    return items.every((i) => i.kind === "number") ? [(items[0] as Value & { kind: "number" }).value, (items[1] as Value & { kind: "number" }).value] : undefined;
  }

  /** a coordinate: `vec3(…)` or the three-number array that reads the same */
  const POINT: TypeRef = { kind: "union", of: [{ kind: "class", name: "Vector3" }, { kind: "array", of: { kind: "number" } }] };
  const PAIR: TypeRef = { kind: "union", of: [{ kind: "class", name: "Vector2" }, { kind: "array", of: { kind: "number" } }] };

  /** `uv: paraxial` / `uv: parallel` / `uv: parallel(vec3(…), vec3(…))` */
  function checkUv(v: Value): UvMode | undefined {
    if (v.kind === "ident" && (v.name === "paraxial" || v.name === "parallel")) {
      return v.name === "paraxial" ? { kind: "paraxial" } : { kind: "parallel" };
    }
    if (v.kind === "object" && v.name === "parallel") {
      if (v.args.length !== 2) {
        err("parallel() takes a u axis and a v axis: parallel(vec3(1, 0, 0), vec3(0, 1, 0))", v);
        return undefined;
      }
      for (const a of v.args) checkValue(a, { type: POINT, what: "a parallel() axis" });
      const u = literalVec3(v.args[0]);
      const w = literalVec3(v.args[1]);
      return u && w ? { kind: "parallel", u, v: w } : { kind: "parallel" };
    }
    err("uv expects paraxial, parallel, or parallel(u, v)", v);
    return undefined;
  }

  /** `face(p1, p2, p3) { material: …; uv: …; }` — one half-space of a brush */
  function checkFace(o: ObjectValue): BrushFace | undefined {
    if (o.args.length !== 3) {
      err("face() takes three points, counter-clockwise seen from outside: face(vec3(…), vec3(…), vec3(…))", o);
    }
    for (const a of o.args) checkValue(a, { type: POINT, what: "a face() point" });

    const face: BrushFace = { points: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] };
    for (const m of o.body) {
      if (m.kind === "var") continue;
      if (m.kind === "at") { err(`@${m.name} does not apply to a face`, m); continue; }
      if (m.kind === "node") { err("a face has no children — it is one plane of the solid it sits in", m.object); continue; }
      const knob = FACE_PROPS[m.name];
      if (!knob) {
        const alt = suggest(m.name, Object.keys(FACE_PROPS));
        const range = { start: m.start, end: m.start + m.name.length, file: m.file };
        err(`a face has no setting ${JSON.stringify(m.name)}` + (alt ? `; did you mean ${alt}?` : ""), range, alt ? { ...range, text: alt } : undefined);
        continue;
      }
      if (knob.type === "material") checkValue(m.value, { type: { kind: "class", name: "Material" }, what: "face material" });
      else if (knob.type === "angle") checkValue(m.value, { type: { kind: "number" }, what: "face rotation" });
      else if (knob.type === "vec2") checkValue(m.value, { type: PAIR, what: `face ${m.name}` });
      else face.uv = checkUv(m.value);

      // the same reading every other angle in a sheet gets: `30deg` is degrees, a bare number is radians
      if (knob.type === "angle" && m.value.kind === "number") face.rotation = m.value.unit === "deg" ? (m.value.value * Math.PI) / 180 : m.value.value;
      if (knob.type === "vec2") {
        const pair = literalVec2(m.value);
        if (pair) face[m.name === "offset" ? "offset" : "scale"] = pair;
      }
    }

    const points = o.args.map(literalVec3);
    if (o.args.length !== 3 || points.some((p) => !p)) return undefined; // nothing to judge geometrically
    face.points = points as [Vec3, Vec3, Vec3];
    return face;
  }

  /**
   * `brush { face(…) … }` — a convex solid. The faces are checked as a set, not one at a time: "these
   * planes bound no volume" and "this face bounds nothing" are both statements about the whole solid,
   * and they are exactly the mistakes a hand-written brush makes.
   */
  function checkBrush(o: ObjectValue) {
    if (o.args.length) err("brush takes no arguments — its shape is its faces", o.args[0]!);
    const faces: BrushFace[] = [];
    const where: Pos[] = [];
    const rest: Member[] = [];
    let opaque = false;
    for (const m of o.body) {
      if (m.kind === "node" && m.object.name === "face") {
        const face = checkFace(m.object);
        if (face) { faces.push(face); where.push(m.object); }
        else opaque = true;
        continue;
      }
      rest.push(m);
    }
    // everything that is not a face is the Mesh's own: position, castShadow, a child node, @broom
    checkBody("Mesh", rest);
    // a coordinate the checker could not fold means the face set is incomplete, and every geometric
    // verdict below would be about a solid the sheet never wrote
    if (opaque) return;
    for (const p of buildBrush(faces).problems) err(p.message, p.face === -1 ? o : where[p.face] ?? o);
  }

  function checkKnob(v: Value, knob: Knob, what: string) {
    // a raw template body is checked before expansion, so var() and calc() are still unresolved here
    if (v.kind === "var" || v.kind === "calc") return;
    const wrong = (expected: string) => err(`${what} expects ${expected}`, v);
    if (knob.values) {
      if (v.kind !== "ident" || !knob.values.includes(v.name)) {
        const alt = v.kind === "ident" ? suggest(v.name, knob.values) : undefined;
        err(`${what} expects ${knob.values.join(" | ")}`, v, alt ? { start: v.start, end: v.end, text: alt } : undefined);
      }
      return;
    }
    if (knob.type === "number") {
      if (v.kind !== "number" && v.kind !== "hex") return wrong("a number");
      return inRange(v.value, v, knob, what);
    }
    if (knob.type === "string" && v.kind !== "string") wrong("a string");
    if (knob.type === "boolean" && !(v.kind === "ident" && (v.name === "true" || v.name === "false"))) wrong("true or false");
    if (knob.type === "numbers") {
      if (v.kind !== "array" || v.items.some((i) => i.kind !== "number")) wrong("an array of numbers");
      else if (knob.length !== undefined && v.items.length !== knob.length) wrong(`${knob.length} numbers`);
      else for (const item of v.items) inRange((item as Value & { kind: "number" }).value, item, knob, what);
    }
  }

  /**
   * A knob outside the range the bake is defined over. The baker either warns and drops it hours later
   * or clamps it into something else, and neither reads as "this line is wrong" — so it is said here.
   */
  function inRange(n: number, at: Pos, knob: Knob, what: string): void {
    if (knob.int && !Number.isInteger(n)) return err(`${what} expects a whole number, got ${n}`, at);
    const low = knob.min !== undefined && n < knob.min;
    const high = knob.max !== undefined && n > knob.max;
    if (!low && !high) return;
    const bound =
      knob.min !== undefined && knob.max !== undefined ? `from ${knob.min} to ${knob.max}`
        : knob.min !== undefined ? `of at least ${knob.min}` : `of at most ${knob.max}`;
    err(`${what} expects a number ${bound}, got ${n}`, at);
  }

  function checkBody(cls: string, body: Member[]) {
    for (const m of body) {
      if (m.kind === "var") continue;
      if (m.kind === "at") {
        checkAtRule(m, isA(cls, "Object3D") ? "node" : isA(cls, "Material") ? "material" : undefined);
        continue;
      }
      if (m.kind === "node") {
        const childCls = className(m.object.name);
        if (m.object.name === "find") { checkFind(m.object); continue; }
        if (m.object.name === "play") { checkPlay(m.object); continue; }
        if (m.object.name === "brush") {
          if (info(cls) && !isA(cls, "Object3D")) err(`${cls} cannot have children`, m.object);
          checkBrush(m.object);
          continue;
        }
        if (m.object.name === "face") { err("face() is one plane of a brush, so it only works inside one", m.object); continue; }
        // repeat() is unrolled by expand(); this only runs for template bodies, which are checked raw
        if (m.object.name === "repeat") { checkBody(cls, m.object.body); continue; }
        // `lookAt(0, 1, 0);` — a name that is a method of this class and not a class of its own
        const method = info(cls)?.methods[m.object.name];
        const plain = !m.object.hasBody && !m.object.id && !m.object.classes.length;
        if (method && !info(childCls) && !declared(m.object.name)) {
          if (plain) { checkOverloads(method, m.object.args, `${cls}.${m.object.name}()`, m.object); continue; }
          err(`${cls}.${m.object.name}() is a method — call it as ${m.object.name}(…); without a block`, m.object);
          continue;
        }
        // an unknown bare call is a mistyped method far more often than a mistyped class. Saying
        // `unknown three class "LookAtTheThing"` to someone who wrote `lookAtTheThing(0, 1, 0);` names
        // a thing they never mentioned, so report it as the method it reads as either way — with the
        // nearest class named too, for the rarer case where a bodyless child node is what was meant.
        if (!info(childCls) && !declared(m.object.name) && plain && info(cls)) {
          const range = { start: m.object.start, end: m.object.start + m.object.name.length, file: m.object.file };
          const alt = suggest(m.object.name, Object.keys(info(cls)!.methods));
          if (alt) {
            err(`${cls} has no method ${JSON.stringify(m.object.name)}; did you mean ${alt}?`, range, { ...range, text: alt });
            continue;
          }
          const node = suggest(childCls, Object.keys(schema.classes));
          err(
            `${cls} has no method ${JSON.stringify(m.object.name)}` + (node ? `; did you mean the node ${nodeName(node)}?` : ""),
            range,
            node ? { ...range, text: nodeName(node) } : undefined,
          );
          continue;
        }
        if (info(childCls) && !isA(childCls, "Object3D")) {
          err(`${childCls} is not an Object3D, so it cannot be a child; use it as a property value instead`, m.object);
        }
        if (info(cls) && !isA(cls, "Object3D")) err(`${cls} cannot have children`, m.object);
        checkObject(m.object);
        continue;
      }
      // `material.color: color(#fff)` — walk to the owner of the last segment
      const path = m.name.split(".");
      const leaf = path.at(-1)!;
      let owner = cls;
      let reached = true;
      let prefix = "";
      for (const [i, seg] of path.slice(0, -1).entries()) {
        const p = propOf(owner, seg);
        // `material: meshStandardMaterial { }` in the same block tells us more than the declared type does
        prefix = prefix ? `${prefix}.${seg}` : seg;
        const assigned = assignedClass(body, prefix);
        // `Mesh.material` is `Material | Material[]` — walk into the one class the union offers
        const parts = p ? (p.type.kind === "union" ? p.type.of : [p.type]) : [];
        const into = assigned ? ({ kind: "class", name: assigned } as const) : parts.find((t) => t.kind === "class" && info(t.name));
        if (!p || into?.kind !== "class") {
          err(p ? `${owner}.${seg} is not an object, so ${m.name} cannot be set` : `${owner} has no property ${JSON.stringify(seg)}`, {
            start: m.start,
            end: m.start + path.slice(0, i + 1).join(".").length,
            file: m.file,
          });
          reached = false;
          break;
        }
        owner = concrete(into.name);
      }
      if (!reached) continue;
      const range = { start: m.start + m.name.length - leaf.length, end: m.start + m.name.length, file: m.file };

      const prop = propOf(owner, leaf);
      if (!prop) {
        // any overload's argument list: `color { r: 1 }` is the same mistake whichever `Color()` it meant
        const ctorArg = info(owner)?.ctors.some((params) => params.some((p) => p.name === leaf));
        if (ctorArg) {
          const order = info(owner)!.ctors[0]!.map((p) => p.name).join(", ");
          err(`${leaf} is a constructor argument of ${owner}, not a property — pass it positionally: ${nodeName(owner)}(${order})`, m);
          continue;
        }
        const alt = suggest(leaf, Object.keys(info(owner)!.props));
        err(
          `${owner} has no property ${JSON.stringify(leaf)}` + (alt ? `; did you mean ${alt}?` : ""),
          range,
          alt ? { ...range, text: alt } : undefined,
        );
        continue;
      }
      if (prop.readonly && !(prop.type.kind === "class" && info(prop.type.name)?.copyable)) {
        err(`${owner}.${leaf} is read-only`, m);
        continue;
      }
      checkValue(m.value, { type: prop.type, what: `${owner}.${leaf}` });
    }
  }

  /** the class a sibling literally assigned to `path` in this block, if any */
  function assignedClass(body: Member[], path: string): string | undefined {
    for (const m of body) {
      if (m.kind !== "prop" || m.name !== path || m.value.kind !== "object") continue;
      const cls = className(m.value.name);
      if (info(cls)) return cls;
    }
    return undefined;
  }

  // template bodies are checked where they are declared, so an unused template still gets checked
  for (const t of templates) {
    const cls = className(t.node ?? "object3D");
    if (!info(cls)) {
      const alt = suggest(cls, Object.keys(schema.classes));
      err(`unknown three class ${JSON.stringify(cls)}` + (alt ? `; did you mean ${nodeName(alt)}?` : ""), t);
    } else if (!isA(cls, "Object3D")) {
      err(`${cls} is not an Object3D, so it cannot be a template type`, t);
    } else {
      checkBody(cls, t.body);
    }
  }

  // an @override body is checked where it is written, against the type its rightmost compound names —
  // so a rule that currently matches nothing is still checked, exactly as an unapplied template is
  for (const o of overrides) {
    const last = o.selector[o.selector.length - 1]!;
    for (const c of o.selector) {
      if (!c.type) continue;
      const cls = className(c.type);
      const range = c.typeSpan ?? c;
      if (!info(cls)) {
        const alt = suggest(cls, Object.keys(schema.classes));
        err(
          `unknown three class ${JSON.stringify(cls)}` + (alt ? `; did you mean ${nodeName(alt)}?` : ""),
          range,
          alt ? { start: range.start, end: range.end, text: nodeName(alt) } : undefined,
        );
      } else if (!isA(cls, "Object3D")) {
        err(`${cls} is not an Object3D, so no node in the tree can be one`, range);
      }
    }
    const cls = className(last.type ?? "object3D");
    if (info(cls) && isA(cls, "Object3D")) checkBody(cls, o.body);
  }

  for (const m of nodes) {
    if (m.kind === "node") {
      if (BUILTINS[m.object.name]?.topLevel === false) {
        err(`${m.object.name}() only works inside a node`, m.object);
        continue;
      }
      if (m.object.name === "brush") { checkBrush(m.object); continue; }
      const cls = className(m.object.name);
      if (info(cls) && !isA(cls, "Object3D")) err(`top-level ${cls} is not an Object3D`, m.object);
      checkObject(m.object);
    } else if (m.kind === "prop") {
      err(`property ${JSON.stringify(m.name)} must be inside a node`, m);
    } else if (m.kind === "at") {
      checkAtRule(m, "scene");
    }
  }

  // a used template is checked once where it is declared and again in every node it was inlined into
  const seen = new Set<string>();
  return out.filter((d) => {
    const key = `${d.file}:${d.start}:${d.end}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
