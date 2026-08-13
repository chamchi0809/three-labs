// Type checks an expanded .tscene AST against a reflected three schema.
// Pure (no typescript / no three import) so it runs in the browser too.
import type { Diagnostic, Member, ObjectValue, Pos, Template, Value } from "./parse.ts";
import type { ClassInfo, Param, Schema, TypeRef } from "./schema.ts";
import { ALIASES, BAKERY, BUILTINS, LOADERS, className, nodeName, type Knob } from "./names.ts";

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

export function check(nodes: Member[], schema: Schema, templates: Template[] = []): Diagnostic[] {
  const out: Diagnostic[] = [];
  const templateOf = new Map(templates.map((t) => [t.name, t]));
  const err = (message: string, pos: Pos, fix?: Diagnostic["fix"]) =>
    out.push({ message, severity: "error", start: pos.start, end: pos.end, file: pos.file, ...(fix ? { fix } : {}) });

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

  function valueType(v: Value): TypeRef {
    switch (v.kind) {
      case "number": return { kind: "number" };
      case "hex": return { kind: "number" };
      case "string": return { kind: "string" };
      case "var": return { kind: "any" };
      case "ref": {
        const cls = v.node && className(v.node);
        return cls && info(cls) ? { kind: "class", name: cls } : { kind: "any" };
      }
      case "calc": return { kind: "number" };
      // ponytail: a record only ever lands in an `any` slot (userData), so it needs no type of its own
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
    return from.kind === to.kind;
  }

  const show = (t: TypeRef): string =>
    t.kind === "class" || t.kind === "enum" ? t.name : t.kind === "union" ? t.of.map(show).join(" | ") : t.kind === "array" ? `${show(t.of)}[]` : t.kind;

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

  function checkValue(v: Value, expect: { type: TypeRef; what: string }) {
    const mismatch = () => err(`${expect.what} expects ${show(expect.type)}, got ${show(valueType(v))}`, v);
    if (v.kind === "object") return checkObject(v, expect);
    if (v.kind === "array") {
      const el = elementType(expect.type);
      if (!el) return mismatch();
      for (const item of v.items) checkValue(item, { type: el, what: `${expect.what} item` });
      return;
    }
    if (v.kind === "record") {
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

  /** positional arguments against a constructor or method signature */
  function checkArgs(params: { name: string; type: TypeRef; optional: boolean }[], args: Value[], what: string, at: Pos) {
    if (args.length > params.length) {
      err(`${what} takes at most ${params.length} argument(s), got ${args.length}`, args[params.length] ?? at);
    }
    args.forEach((a, i) => {
      const p = params[i];
      if (p) checkValue(a, { type: p.type, what: `argument ${p.name} of ${what}` });
    });
  }

  /** an overloaded method (`lookAt(v)` / `lookAt(x, y, z)`) passes if any signature does; else the closest one reports */
  function checkOverloads(signatures: Param[][], args: Value[], what: string, at: Pos) {
    let best: { distance: number; produced: Diagnostic[] } | undefined;
    for (const params of signatures) {
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

    // constructor arguments
    const loader = LOADERS[o.name];
    const params = loader ? loader.args.map((type, i) => ({ name: `arg${i}`, type, optional: false })) : info(cls)!.ctor;
    checkArgs(params, o.args, `${nodeName(cls)}()`, o);
    if (loader && o.args.length !== 1) err(`${o.name}() takes a single url string`, o);

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
   * `@bakery { … }` — settings for the baker, not for three, so the reflected schema has nothing to say
   * about them. They are typed by the table in names.ts instead, per position.
   */
  function checkBakery(m: Member & { kind: "at" }, position: "scene" | "node" | "material" | undefined) {
    if (!position) return err(`@${m.name} belongs on the sheet, a node or a material`, m);
    const table = BAKERY[position];
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
    if (knob.type === "number" && v.kind !== "number" && v.kind !== "hex") wrong("a number");
    if (knob.type === "string" && v.kind !== "string") wrong("a string");
    if (knob.type === "boolean" && !(v.kind === "ident" && (v.name === "true" || v.name === "false"))) wrong("true or false");
    if (knob.type === "numbers") {
      if (v.kind !== "array" || v.items.some((i) => i.kind !== "number")) wrong("an array of numbers");
      else if (knob.length !== undefined && v.items.length !== knob.length) wrong(`${knob.length} numbers`);
    }
  }

  function checkBody(cls: string, body: Member[]) {
    for (const m of body) {
      if (m.kind === "var") continue;
      if (m.kind === "at") {
        checkBakery(m, isA(cls, "Object3D") ? "node" : isA(cls, "Material") ? "material" : undefined);
        continue;
      }
      if (m.kind === "node") {
        const childCls = className(m.object.name);
        if (m.object.name === "find") { checkFind(m.object); continue; }
        if (m.object.name === "play") { checkPlay(m.object); continue; }
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
        // an unknown bare call is a mistyped method far more often than a mistyped class
        if (!info(childCls) && !declared(m.object.name) && plain && info(cls)) {
          const alt = suggest(m.object.name, Object.keys(info(cls)!.methods));
          if (alt) {
            const range = { start: m.object.start, end: m.object.start + m.object.name.length, file: m.object.file };
            err(`${cls} has no method ${JSON.stringify(m.object.name)}; did you mean ${alt}?`, range, { ...range, text: alt });
            continue;
          }
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
        owner = into.name;
      }
      if (!reached) continue;
      const range = { start: m.start + m.name.length - leaf.length, end: m.start + m.name.length, file: m.file };

      const prop = propOf(owner, leaf);
      if (!prop) {
        const ctorArg = info(owner)?.ctor.find((p) => p.name === leaf);
        if (ctorArg) {
          const order = info(owner)!.ctor.map((p) => p.name).join(", ");
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

  for (const m of nodes) {
    if (m.kind === "node") {
      if (BUILTINS[m.object.name]?.topLevel === false) {
        err(`${m.object.name}() only works inside a node`, m.object);
        continue;
      }
      const cls = className(m.object.name);
      if (info(cls) && !isA(cls, "Object3D")) err(`top-level ${cls} is not an Object3D`, m.object);
      checkObject(m.object);
    } else if (m.kind === "prop") {
      err(`property ${JSON.stringify(m.name)} must be inside a node`, m);
    } else if (m.kind === "at") {
      checkBakery(m, "scene");
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
