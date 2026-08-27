// node --experimental-strip-types src/scene.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyFixes, expand, parse, print, type Loader } from "./parse.ts";
import { check } from "./check.ts";
import { loadSchema } from "./schema.ts";
import { fixSource } from "./tools.ts";

const tests: [string, () => unknown][] = [];
const test = (name: string, fn: () => unknown) => tests.push([name, fn]);

const SRC = `
@import "./lib.tscene";
--h: 2;
@template mesh.glow { material: meshStandardMaterial { color: color(#ff8000); }; }

group #stage {
  mesh.glow #box {
    geometry: boxGeometry(1, 1, 1);
    position: vec3(0, var(--h), 0);
    rotation: euler(45deg, 0, 0);
    castShadow: true;
  }
  pointLight(#ffffff, 5) { position: vec3(1, 2, 3); }
}
`;

const noImports: Loader = async () => ({ text: "", file: "<none>" });

test("parses nodes, ids, classes, args and blocks", () => {
  const sheet = parse(SRC, "a.tscene");
  assert.equal(sheet.statements.length, 4);
  const group = sheet.statements[3];
  assert.equal(group?.kind, "node");
  assert.equal(group.object.id, "stage");
  const box = group.object.body[0];
  assert.equal(box?.kind, "node");
  assert.deepEqual(box.object.classes, ["glow"]);
  assert.equal(box.object.body.length, 4);
  const geometry = box.object.body[0];
  assert.equal(geometry?.kind === "prop" && geometry.value.kind === "object" && geometry.value.args.length, 3);
});

test("number units, hex colors and strings", () => {
  const sheet = parse(`mesh { rotation: euler(45deg, 1rad, 0); name: "hi"; visible: false; }`);
  const props = sheet.statements[0]!.kind === "node" ? sheet.statements[0]!.object.body : [];
  const args = props[0]!.kind === "prop" && props[0]!.value.kind === "object" ? props[0]!.value.args : [];
  assert.equal(args[0]!.kind === "number" && args[0]!.unit, "deg");
  assert.equal(args[1]!.kind === "number" && args[1]!.unit, "rad");
  assert.equal(props[1]!.kind === "prop" && props[1]!.value.kind === "string" && props[1]!.value.value, "hi");
  assert.equal(parse(`mesh { x: color(#f80); }`).statements.length, 1);
});

test("print is stable and re-parses to the same tree", () => {
  const once = print(parse(SRC, "a.tscene"));
  const twice = print(parse(once, "a.tscene"));
  assert.equal(once, twice, `not idempotent:\n${once}\n---\n${twice}`);
  assert.match(once, /^ {4}geometry: boxGeometry\(1, 1, 1\);$/m);
  assert.match(once, /#ff8000/);
});

test("print keeps comments", () => {
  const out = print(parse(`// hello\nmesh { /* inner */ visible: true; }`));
  assert.match(out, /\/\/ hello/);
  assert.match(out, /\/\* inner \*\//);
});

test("expand substitutes vars and applies templates", async () => {
  const { nodes, diagnostics } = await expand(parse(SRC.replace(/@import[^\n]*\n/, ""), "a.tscene"), noImports);
  assert.deepEqual(diagnostics, []);
  const box = nodes[0]!.kind === "node" ? nodes[0]!.object.body[0] : undefined;
  assert.equal(box?.kind, "node");
  // template body is prepended, then the node's own members
  assert.equal(box.object.body[0]!.kind === "prop" && box.object.body[0]!.name, "material");
  assert.equal(box.object.body.length, 5);
  const pos = box.object.body.find((m) => m.kind === "prop" && m.name === "position");
  assert.ok(pos && pos.kind === "prop" && pos.value.kind === "object");
  const y = pos.value.args[1];
  assert.ok(y && y.kind === "number" && y.value === 2);
});

test("expand resolves @import and reports cycles", async () => {
  const files: Record<string, string> = {
    "/a.tscene": `@import "/b.tscene";\nmesh { material: meshBasicMaterial { color: var(--c); }; }`,
    "/b.tscene": `--c: color(#00ff00);`,
  };
  const load: Loader = async (p) => ({ text: files[p]!, file: p });
  const { nodes, diagnostics } = await expand(parse(files["/a.tscene"]!, "/a.tscene"), load);
  assert.deepEqual(diagnostics, []);
  assert.equal(nodes.length, 1);

  const cyclic: Loader = async (p) => ({ text: `@import "/c.tscene";`, file: p });
  const cycle = await expand(parse(`@import "/c.tscene";`, "/c.tscene"), cyclic);
  assert.equal(cycle.diagnostics.length, 1);
  assert.match(cycle.diagnostics[0]!.message, /circular/);
});

test("expand reports unknown vars and templates", async () => {
  const { diagnostics } = await expand(parse(`mesh.nope { visible: var(--gone); }`), noImports);
  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics.map((d) => d.message).join("|"), /unknown template \.nope/);
  assert.match(diagnostics.map((d) => d.message).join("|"), /unknown variable --gone/);
});

test("arrays, records and calc() round-trip through the printer", () => {
  const src = `mesh {\n  userData: { tags: ["a", "b"]; hp: 3 };\n  position: vec3(0, calc(var(--h) * 2 - 1), 0);\n}\n`;
  const once = print(parse(src, "a.tscene"));
  assert.equal(print(parse(once, "a.tscene")), once);
  assert.match(once, /userData: \{ tags: \["a", "b"\]; hp: 3 \};/);
  // nested arithmetic is parenthesised so precedence survives the round trip
  assert.match(once, /calc\(\(var\(--h\) \* 2\) - 1\)/);
});

test("each(), calc() functions and value chains round-trip through the printer", () => {
  const src = `--pts: splineCurve([vec2(0, 0), vec2(1, 1)]).getPoints(8);\n\nmesh {\n  morphTargetInfluences: each(--i, var(--pts), calc(sin(var(--index) / var(--count) * 2 * pi) * var(--i).x));\n}\n`;
  const once = print(parse(src, "a.tscene"));
  assert.equal(print(parse(once, "a.tscene")), once, `not idempotent:\n${once}`);
  assert.match(once, /splineCurve\(\[vec2\(0, 0\), vec2\(1, 1\)\]\)\.getPoints\(8\)/);
  assert.match(once, /each\(--i, var\(--pts\), calc\(/);
  assert.match(once, /sin\(/);
  assert.match(once, /\bpi\b/); // no parens on a nullary function
  assert.match(print(parse(`mesh { renderOrder: calc(var(--a, 1)[0].x); }`)), /var\(--a, 1\)\[0\]\.x/);
});

test("calc() folds its functions, and leaves the loop's arithmetic to the runtime", async () => {
  const value = async (text: string) => {
    const { nodes } = await expand(parse(`mesh { renderOrder: ${text}; }`), noImports);
    const m = nodes[0]!.kind === "node" ? nodes[0]!.object.body[0] : undefined;
    return m?.kind === "prop" ? m.value : undefined;
  };
  const folded = async (text: string) => {
    const v = await value(text);
    return v?.kind === "number" ? v.value : `unfolded ${v?.kind}`;
  };
  assert.equal(await folded(`calc(pow(2, 10))`), 1024);
  assert.equal(await folded(`calc(pi)`), Math.PI);
  assert.equal(await folded(`calc(abs(0 - 2) + sign(3) + floor(1.7))`), 4);
  assert.equal(await folded(`calc(smoothstep(0.5, 0, 1))`), 0.5);
  assert.equal(await folded(`calc(mod(0 - 1, 4))`), 3); // the divisor's sign, not the dividend's
  assert.equal(await folded(`calc(sin(90deg))`), 1);    // a unit is applied before the function
  // a method call is not a constant, so the folder hands the whole expression on
  assert.equal(await folded(`calc(splineCurve([vec2(0, 0)]).getPoints(2)[0].x * 2)`), "unfolded calc");
  const bad = async (text: string) => (await expand(parse(`mesh { renderOrder: ${text}; }`), noImports)).diagnostics.map((d) => d.message);
  assert.match((await bad(`calc(sin("x"))`))[0]!, /sin\(\) works on numbers only/);
  assert.match((await bad(`calc(pow(2))`))[0]!, /pow\(\) takes 2 argument/);
});

test("@bakery round-trips at the top level and inside a node", () => {
  const src = `@bakery { size: 512; include: none };\n\npointLight #lamp {\n  @bakery { radius: 0.35 };\n}\n`;
  const once = print(parse(src, "a.tscene"));
  assert.equal(print(parse(once, "a.tscene")), once);
  assert.match(once, /@bakery \{ size: 512; include: none \};/);
  assert.match(once, /  @bakery \{ radius: 0\.35 \};/);
});

test("calc() folds once the variables are known", async () => {
  const value = async (text: string) => {
    const { nodes } = await expand(parse(`--h: 2;\nmesh { renderOrder: ${text}; }`), noImports);
    const m = nodes[0]!.kind === "node" ? nodes[0]!.object.body[0] : undefined;
    return m?.kind === "prop" && m.value.kind === "number" ? m.value.value : undefined;
  };
  assert.equal(await value(`calc(var(--h) * 2 - 1)`), 3);
  assert.equal(await value(`calc(2 + 3 * 4)`), 14); // * binds tighter than +
  assert.equal(await value(`calc((2 + 3) * 4)`), 20);
  assert.equal(await value(`calc(6 / 2)`), 3);
  const bad = async (text: string) => (await expand(parse(`mesh { renderOrder: ${text}; }`), noImports)).diagnostics.map((d) => d.message);
  assert.match((await bad(`calc(1 / 0)`))[0]!, /divides by zero/);
  assert.match((await bad(`calc(1deg + 1rad)`))[0]!, /cannot mix deg and rad/);
  assert.match((await bad(`calc("a" + 1)`))[0]!, /works on numbers only/);
});

test("var() falls back and templates take parameters", async () => {
  const { nodes, diagnostics } = await expand(parse(`
    @template mesh.tinted { material: meshStandardMaterial { color: var(--tint, color(#000000)); }; }
    mesh.tinted #a { --tint: color(#ff8800); }
    mesh.tinted #b { }
  `), noImports);
  assert.deepEqual(diagnostics, []);
  const color = (i: number) => {
    const material = (nodes[i]!.kind === "node" ? nodes[i]!.object.body : []).find((m) => m.kind === "prop");
    const arg = material?.kind === "prop" && material.value.kind === "object" ? material.value.body[0] : undefined;
    const call = arg?.kind === "prop" && arg.value.kind === "object" ? arg.value.args[0] : undefined;
    return call?.kind === "hex" ? call.value : undefined;
  };
  assert.equal(color(0), 0xff8800);
  assert.equal(color(1), 0x000000);
});

test("bindings link each use to the declaration scope actually picked", async () => {
  const src = `--spin: 1;
@template mesh.glow { renderOrder: var(--depth); }
group {
  mesh #a { --spin: 2; renderOrder: var(--spin); }
  mesh.glow #b { --depth: 3; scale: vec3(var(--spin), 1, 1); }
}`;
  const { bindings, diagnostics } = await expand(parse(src, "/s.tscene"), noImports);
  assert.deepEqual(diagnostics, []);
  const span = (b: { start: number; end: number }) => src.slice(b.start, b.end);
  const pairs = bindings.map((b) => [span(b.use), b.decl.start] as const);

  // #a shadows --spin, #b sees the top-level one
  const shadowed = pairs.filter(([use]) => use === "--spin");
  assert.equal(shadowed.length, 2);
  assert.notEqual(shadowed[0]![1], shadowed[1]![1]);
  assert.ok(shadowed.some(([, decl]) => decl === src.indexOf("--spin: 2")));
  assert.ok(shadowed.some(([, decl]) => decl === 0));

  // the template's var(--depth) binds to the applying node's declaration, and .glow to its @template
  assert.deepEqual(pairs.find(([use]) => use === "--depth"), ["--depth", src.indexOf("--depth: 3")]);
  assert.deepEqual(pairs.find(([use]) => use === ".glow"), [".glow", src.indexOf("mesh.glow") + 4]);
});

test("a file imported twice is spliced once, not reported as a cycle", async () => {
  const files: Record<string, string> = {
    "/a.tscene": `@import "/b.tscene";\n@import "/c.tscene";\nmesh { renderOrder: var(--n); }`,
    "/b.tscene": `@import "/shared.tscene";`,
    "/c.tscene": `@import "/shared.tscene";`,
    "/shared.tscene": `--n: 1;`,
  };
  const load: Loader = async (p) => ({ text: files[p]!, file: p });
  const { diagnostics } = await expand(parse(files["/a.tscene"]!, "/a.tscene"), load);
  assert.deepEqual(diagnostics, []);
});

test("warns about duplicates and dead declarations", async () => {
  const messages = async (text: string) => (await expand(parse(text, "t.tscene"), noImports)).diagnostics.map((d) => d.message);
  assert.deepEqual(await messages(`mesh { visible: true; visible: false; }`), ["visible is set twice in this block"]);
  assert.deepEqual(await messages(`mesh #a { }\nmesh #a { }`), ["#a is already used; getObjectByName finds only the first"]);
  assert.deepEqual(await messages(`--x: 1;\n--x: 2;\nmesh { renderOrder: var(--x); }`), ["--x is set twice in this file"]);
  assert.deepEqual(await messages(`--x: 1;\n@template mesh.glow { }\nmesh { }`), ["--x is never used", ".glow is never applied"]);
  // a sheet with no nodes is a library: its declarations are meant for whoever imports it
  assert.deepEqual(await messages(`--x: 1;\n@template mesh.glow { }`), []);
});

test("dead-code warnings are per declaration, not per name", async () => {
  const messages = async (text: string) => (await expand(parse(text, "t.tscene"), noImports)).diagnostics.map((d) => d.message);
  // the outer --x is read; the shadowing one inside the block is not
  assert.deepEqual(await messages(`--x: 1;\nmesh { renderOrder: var(--x); mesh { --x: 2; visible: true; } }`), ["--x is never used"]);
  // …and the other way round: only the inner declaration is read
  assert.deepEqual(await messages(`--x: 1;\nmesh { --x: 2; renderOrder: var(--x); }`), ["--x is never used"]);
  assert.deepEqual(await messages(`--x: 1;\nmesh { --x: 2; renderOrder: var(--x); mesh { renderOrder: var(--x); } }`), ["--x is never used"]);
});

test("ref(#id) binds to the node it names", async () => {
  const { nodes, bindings, diagnostics } = await expand(parse(`mesh #a { }\ndirectionalLight { target: ref(#a); }`, "t.tscene"), noImports);
  assert.deepEqual(diagnostics.map((d) => d.message), []);
  const prop = (nodes[1] as any).object.body[0];
  assert.equal(prop.value.kind, "ref");
  assert.equal(prop.value.node, "mesh"); // resolved, so the checker can type it
  assert.equal(bindings.length, 1); // #a use ↔ #a declaration, which is what rename walks
  const bad = await expand(parse(`mesh { customDepthMaterial: ref(#nope); }`, "t.tscene"), noImports);
  assert.match(bad.diagnostics[0]!.message, /unknown node #nope/);
});

test("@override appends its body to every node its selector reaches", async () => {
  const src = `
@template mesh.enemy { castShadow: true; }
group #arena {
  mesh.enemy #a { visible: true; }
  group { mesh.enemy #b { } }
  mesh #c { }
}
mesh.enemy #outside { }
@override #arena .enemy { visible: false; renderOrder: 1; }
`;
  const { nodes, diagnostics } = await expand(parse(src, "t.tscene"), noImports);
  assert.deepEqual(diagnostics.map((d) => d.message), []);
  const arena = (nodes[0] as any).object;
  const named = (o: any, id: string): any => (o.id === id ? o : o.body.filter((m: any) => m.kind === "node").map((m: any) => named(m.object, id)).find(Boolean));
  const props = (o: any) => o.body.filter((m: any) => m.kind === "prop").map((m: any) => `${m.name}=${m.value.name ?? m.value.value}`);
  // the rule's members land after the node's own, which is what makes the override win
  assert.deepEqual(props(named(arena, "a")), ["castShadow=true", "visible=true", "visible=false", "renderOrder=1"]);
  // a descendant, not just a child
  assert.deepEqual(props(named(arena, "b")), ["castShadow=true", "visible=false", "renderOrder=1"]);
  assert.deepEqual(props(named(arena, "c")), []); // no .enemy
  assert.deepEqual(props((nodes[1] as any).object), ["castShadow=true"]); // outside #arena
});

test("@override selects by type, id and class, and says so when it selects nothing", async () => {
  const one = async (selector: string) => {
    const { nodes, diagnostics } = await expand(
      parse(`@template pointLight.warm { }\ngroup #s { mesh #box { } pointLight.warm #key { } }\n@override ${selector} { renderOrder: 7; }`, "t.tscene"),
      noImports,
    );
    const hit: string[] = [];
    const walk = (list: any[]) => {
      for (const m of list) {
        if (m.kind !== "node") continue;
        if (m.object.body.some((x: any) => x.kind === "prop" && x.name === "renderOrder")) hit.push(m.object.id ?? m.object.name);
        walk(m.object.body);
      }
    };
    walk(nodes);
    return { hit, messages: diagnostics.map((d) => d.message) };
  };
  assert.deepEqual((await one("mesh")).hit, ["box"]);
  assert.deepEqual((await one("#key")).hit, ["key"]);
  assert.deepEqual((await one(".warm")).hit, ["key"]);
  assert.deepEqual((await one("pointLight#key.warm")).hit, ["key"]);
  assert.deepEqual((await one("group mesh")).hit, ["box"]);
  assert.deepEqual((await one("group")).hit, ["s"]);
  // a compound that does not fit the same node matches nothing, and the warning names the selector
  const none = await one("mesh.warm");
  assert.deepEqual(none.hit, []);
  assert.deepEqual(none.messages, ["this @override matches no node"]);
  // the names a selector picks by are resolved, so a typo is an error and not a silent no-match
  assert.deepEqual((await one("#nope")).messages, ["unknown node #nope"]);
  assert.deepEqual((await one(".nope")).messages, ["unknown template .nope"]);
});

test("@override reaches into repeat() and prints back the way it was written", async () => {
  const src = `@override group mesh.hot#x {\n  renderOrder: 1;\n}\n`;
  assert.equal(print(parse(src, "t.tscene")), src);
  const { nodes, diagnostics } = await expand(parse(`group { repeat(3) { mesh #m { } } }\n@override mesh { renderOrder: 1; }`, "t.tscene"), noImports);
  // three copies, three overrides — and each gets its own AST node, not one shared between them
  const kids = (nodes[0] as any).object.body;
  assert.equal(kids.length, 3);
  assert.deepEqual(diagnostics.map((d) => d.message), []); // repeat() copies share the id on purpose
  const orders = kids.map((m: any) => m.object.body.filter((x: any) => x.kind === "prop" && x.name === "renderOrder"));
  assert.deepEqual(orders.map((o: any[]) => o.length), [1, 1, 1]);
  assert.equal(new Set(orders.map((o: any[]) => o[0])).size, 3);
});

test("dotted property paths parse down to the leaf", () => {
  const sheet = parse(`mesh { material.color: color(#fff); position.x: 1; }`);
  const body = sheet.statements[0]!.kind === "node" ? sheet.statements[0]!.object.body : [];
  assert.deepEqual(body.map((m) => (m.kind === "prop" ? m.name : m.kind)), ["material.color", "position.x"]);
  assert.equal(print(sheet), `mesh {\n  material.color: color(#ffffff);\n  position.x: 1;\n}\n`);
});

test("syntax errors carry a position and the rest of the file still parses", () => {
  assert.match(parse(`mesh { visible: }`).errors[0]!.message, /expected a value/);
  assert.match(parse(`mesh { visible: true;`).errors[0]!.message, /expected }/);
  assert.match(parse(`mesh { visible: true; $ }`).errors[0]!.message, /unexpected character/);
  assert.ok(parse(`mesh { visible: ; }`).errors[0]!.start > 0);

  // one broken property must not cost the diagnostics of everything after it
  const sheet = parse(`mesh { visible: ; castShadow: true; }\ngroup #b { }`);
  assert.equal(sheet.errors.length, 1);
  const body = sheet.statements[0]!.kind === "node" ? sheet.statements[0]!.object.body : [];
  assert.deepEqual(body.map((m) => (m.kind === "prop" ? m.name : m.kind)), ["castShadow"]);
  assert.equal(sheet.statements.length, 2);
});

// ---------------------------------------------------------------- schema-backed checks

const schema = loadSchema();

const checkText = async (text: string) => {
  const { nodes, diagnostics, templates, overrides } = await expand(parse(text, "t.tscene"), noImports);
  return [...diagnostics, ...check(nodes, schema, templates, overrides)].map((d) => d.message);
};

test("schema reflects the installed three typings", () => {
  assert.ok(Object.keys(schema.classes).length > 100);
  assert.deepEqual(schema.classes.Mesh!.bases, ["Object3D"]);
  assert.equal(schema.classes.Mesh!.props.geometry!.type.kind, "class");
  assert.equal((schema.classes.Mesh!.props.geometry!.type as any).name, "BufferGeometry");
  assert.equal(schema.classes.Mesh!.props.position!.readonly, true);
  assert.equal(schema.constants.DoubleSide!.kind, "number");
});

test("three/addons is reflected too, each name keyed to the module it lives in", () => {
  assert.ok(schema.classes.LoftGeometry, "an addon geometry should be a class like any other");
  assert.deepEqual(schema.classes.LoftGeometry!.bases, ["BufferGeometry"]);
  // the barrel re-exports 270 modules, so what the plugin needs is the one file the class is declared in
  assert.equal(schema.sources.LoftGeometry, "three/addons/geometries/LoftGeometry.js");
  assert.equal(schema.sources.RoomEnvironment, "three/addons/environments/RoomEnvironment.js");
  assert.equal(schema.sources.Mesh, undefined); // three's own — the entry is the plugin's default
});

test("an options bag is checked against the fields the slot declares", async () => {
  const loft = (options: string) => checkText(`mesh { geometry: loftGeometry([], ${options}); }`);
  assert.deepEqual(await loft(`{ capStart: true, capEnd: true, closed: false }`), []);
  assert.match((await loft(`{ capStrat: true }`))[0]!, /LoftGeometryOptions has no setting "capStrat"; did you mean capStart\?/);
  assert.match((await loft(`{ capStart: 1 }`))[0]!, /LoftGeometryOptions.capStart expects boolean, got number/);
  // a required field left out is the one thing an optional-only bag cannot show
  assert.match((await checkText(`mesh { geometry: textGeometry("hi", { size: 1 }); }`))[0]!, /TextGeometryParameters is missing font/);
  // userData is `any`, so its keys stay the user's own
  assert.deepEqual(await checkText(`mesh { userData: { anything: 1; nested: { deeper: true } }; }`), []);
});

test("accepts a valid scene", async () => {
  assert.deepEqual(
    await checkText(`
      group #stage {
        mesh #box {
          geometry: boxGeometry(1, 1, 1, 2, 2, 2);
          material: meshStandardMaterial { color: color(#ff8000); side: DoubleSide; roughness: 0.4; };
          position: vec3(0, 1, 0);
          rotation: euler(45deg, 0, 0);
          castShadow: true;
        }
        pointLight(#ffffff, 5, 20) { position: vec3(1, 2, 3); }
      }`),
    [],
  );
});

test("rejects unknown classes and properties, with a casing fix", async () => {
  assert.match((await checkText(`meshx { }`))[0]!, /unknown three class "Meshx"/);
  assert.match((await checkText(`Mesh { }`))[0]!, /write mesh —/);
  assert.match((await checkText(`mesh { visable: true; }`))[0]!, /has no property "visable"/);
  assert.match((await checkText(`mesh { CastShadow: true; }`))[0]!, /did you mean castShadow\?/);
});

test("explains constructor-only parameters", async () => {
  const [msg] = await checkText(`mesh { geometry: boxGeometry(1,1,1) { widthSegments: 2; }; }`);
  assert.match(msg!, /widthSegments is a constructor argument of BoxGeometry/);
  assert.match(msg!, /boxGeometry\(width, height, depth, widthSegments/);
});

test("checks value types, argument types and arity", async () => {
  assert.match((await checkText(`mesh { visible: 3; }`))[0]!, /expects boolean, got number/);
  assert.match((await checkText(`mesh { material: boxGeometry(); }`))[0]!, /expects Material.*got BoxGeometry/);
  assert.match((await checkText(`mesh { position: color(#fff); }`))[0]!, /expects Vector3, got Color/);
  assert.match((await checkText(`mesh { geometry: boxGeometry(1,1,1,1,1,1,1); }`))[0]!, /at most 6 argument/);
  assert.match((await checkText(`mesh { geometry: boxGeometry("x"); }`))[0]!, /argument width .* expects number, got string/);
  assert.match((await checkText(`mesh { position: vec3(0, 1, 0); id: 4; }`))[0]!, /read-only/);
});

test("a constructor is checked against every overload three declares", async () => {
  const colour = (args: string) => checkText(`mesh { material: meshStandardMaterial { color: color(${args}); }; }`);
  assert.deepEqual(await colour(`#ff8000`), []); // Color(color?: ColorRepresentation)
  assert.deepEqual(await colour(`"red"`), []);
  assert.deepEqual(await colour(`1, 0.5, 0`), []); // Color(r, g, b) — the second signature
  // no overload fits, so the closest one reports: three arguments is nearer (r, g, b) than (color)
  assert.match((await colour(`1, 0.5, 0, 2`))[0]!, /color\(\) takes at most 3 argument\(s\), got 4/);
  assert.match((await colour(`1, "x", 0`))[0]!, /argument g of color\(\) expects number, got string/);
});

test("constants are checked against the enum the property declares", async () => {
  const material = (body: string) => checkText(`mesh { material: meshStandardMaterial { ${body} }; }`);
  assert.deepEqual(await material(`side: DoubleSide;`), []);
  assert.deepEqual(await material(`side: 2;`), []); // three takes the raw number too
  assert.match((await material(`side: NormalBlending;`))[0]!, /expects Side, got NormalBlending/);
  assert.match((await material(`blending: DoubleSide;`))[0]!, /expects Blending, got DoubleSide/);
});

test("unknown constants are caught, with a suggestion", async () => {
  const [msg] = await checkText(`mesh { material: meshStandardMaterial { side: DubleSide; }; }`);
  assert.match(msg!, /unknown constant "DubleSide"; did you mean DoubleSide\?/);
});

test("arrays and records are checked against the declared type", async () => {
  assert.deepEqual(await checkText(`mesh { morphTargetInfluences: [0, 1]; userData: { hp: 3; tags: ["a"] }; }`), []);
  assert.match((await checkText(`mesh { morphTargetInfluences: ["a"]; }`))[0]!, /item expects number, got string/);
  assert.match((await checkText(`mesh { visible: [true]; }`))[0]!, /expects boolean, got boolean\[\]/);
  assert.match((await checkText(`mesh { visible: { a: 1 }; }`))[0]!, /expects boolean, got any/);
});

test("each(), value chains and calc() functions are checked against the typings", async () => {
  const loft = (sections: string) => checkText(`mesh { geometry: loftGeometry(${sections}); }`);
  // the shape the whole loft demo is written in: a spline sampled into rings of sin/cos
  assert.deepEqual(
    await loft(`each(--p, splineCurve([vec2(0, 0), vec2(1, 1)]).getPoints(40), each(--j, 24, vec3(
      calc(sin(var(--j) / var(--count) * 2 * pi) * var(--p).x), var(--p).y, 0)))`),
    [],
  );
  // `--p` is a Vector2, so the schema knows what it does and does not have
  assert.match((await loft(`each(--p, splineCurve([vec2(0, 0)]).getPoints(4), var(--p).z)`))[0]!, /Vector2 has no property "z"; did you mean x\?/);
  assert.match((await loft(`each(--p, splineCurve([vec2(0, 0)]).getPionts(4), 0)`))[0]!, /SplineCurve has no method "getPionts"; did you mean getPoints\?/);
  assert.match((await checkText(`mesh { renderOrder: vec3(1, 2, 3).normalize; }`))[0]!, /Vector3\.normalize is a method — call it as \.normalize\(…\)/);
  assert.match((await checkText(`mesh { renderOrder: vec3(1, 2, 3)[0]; }`))[0]!, /Vector3 is not a list, so it cannot be indexed/);
  // an each() is a list, so it does not fit a scalar, and its body has to fit the element type
  assert.match((await checkText(`mesh { renderOrder: each(--i, 3, var(--i)); }`))[0]!, /expects number, got number\[\]/);
  assert.match((await checkText(`mesh { morphTargetInfluences: each(--i, 3, "s"); }`))[0]!, /each\(\) item expects number, got string/);
  assert.match((await checkText(`mesh { morphTargetInfluences: each(--i, "x", 0); }`))[0]!, /each\(\) counts to a number or walks an array, got string/);
  assert.match((await checkText(`mesh { renderOrder: calc(vec3(1, 2, 3) * 2); }`))[0]!, /calc\(\) works on numbers, got Vector3/);
});

test("@bakery keys are checked per position", async () => {
  assert.deepEqual(
    await checkText(`@bakery { size: 512; out: "maps"; exr: true; include: none }
      pointLight { @bakery { enabled: false; radius: 0.35 }; }
      mesh { material: meshStandardMaterial { @bakery { albedo: [0.5, 0.5, 0.5] }; }; }`),
    [],
  );
  assert.match((await checkText(`@bakery { sise: 512 }`))[0]!, /no scene setting "sise"; did you mean size\?/);
  assert.match((await checkText(`mesh { @bakery { size: 512 }; }`))[0]!, /no node setting "size"/);
  assert.match((await checkText(`@bakery { size: "big" }`))[0]!, /@bakery size expects a number/);
  assert.match((await checkText(`mesh { @bakery { enabled: 1 }; }`))[0]!, /@bakery enabled expects true \| false \| occluder/);
  // `occluder` is a third value of a boolean knob, and `density` the newest number one
  assert.deepEqual(await checkText(`mesh { @bakery { enabled: occluder; density: 2 }; }`), []);
  assert.match((await checkText(`@bakery { include: some }`))[0]!, /@bakery include expects all \| none/);
  assert.match(
    (await checkText(`mesh { material: meshStandardMaterial { @bakery { albedo: [1, 1] }; }; }`))[0]!,
    /@bakery albedo expects 3 numbers/,
  );
  assert.match(parse(`@bakry { size: 512 }`).errors[0]!.message, /unknown at-rule @bakry/);
  assert.match(parse(`mesh { @bakery; }`).errors[0]!.message, /@bakery takes a block/);
});

test("templates are typed by the node they apply to", async () => {
  assert.deepEqual(await checkText(`@template mesh.glow { castShadow: true; }\nmesh.glow { }`), []);
  assert.deepEqual(await checkText(`@template .hidden { visible: false; }\npointLight.hidden { }`), []);
  assert.match((await checkText(`@template mesh.glow { }\npointLight.glow { }`))[0]!, /\.glow is a Mesh template, but PointLight is not a Mesh/);
  // declared-but-unused templates are checked too, and only reported once when they are used
  assert.deepEqual(await checkText(`@template mesh.glow { visable: true; }`), ['Mesh has no property "visable"; did you mean visible?']);
  assert.deepEqual(await checkText(`@template mesh.glow { visable: true; }\nmesh.glow { }`), ['Mesh has no property "visable"; did you mean visible?']);
  assert.match((await checkText(`@template meshx.glow { }`))[0]!, /unknown three class "Meshx"/);
  assert.match((await checkText(`@template boxGeometry.glow { }`))[0]!, /BoxGeometry is not an Object3D/);
});

test("checks the scene graph shape", async () => {
  assert.match((await checkText(`boxGeometry(1,1,1) { }`))[0]!, /not an Object3D/);
  assert.match((await checkText(`mesh { meshBasicMaterial { } }`))[0]!, /cannot be a child/);
  assert.deepEqual(await checkText(`mesh { mesh { mesh { } } }`), []);
});

test("texture() and gltf() are loader-backed values", async () => {
  assert.deepEqual(await checkText(`mesh { material: meshStandardMaterial { map: texture("./t.png"); }; }`), []);
  assert.match((await checkText(`mesh { material: meshStandardMaterial { map: texture(3); }; }`))[0]!, /expects string/);
  assert.deepEqual(await checkText(`group { gltf("./m.glb") { position: vec3(0,0,0); } }`), []);
});

test("checks dotted paths, method calls and ref()", async () => {
  assert.deepEqual(await checkText(`mesh { material: meshStandardMaterial { }; material.opacity: 0.5; position.x: 1; }`), []);
  assert.match((await checkText(`mesh { material.opacty: 0.5; }`))[0]!, /has no property "opacty"/);
  // `Mesh.material` is declared as the abstract base, but a loaded mesh's material is a concrete one
  assert.deepEqual(await checkText(`mesh { material.emissive: color(#fff); material.emissiveIntensity: 2; }`), []);
  assert.deepEqual(await checkText(`gltf("./m.glb") { find(mesh, "x") { material.emissive: color(#fff); } }`), []);
  assert.match((await checkText(`mesh { visible.x: 1; }`))[0]!, /Mesh\.visible is not an object/);
  assert.deepEqual(await checkText(`mesh { lookAt(0, 1, 0); }`), []);
  assert.match((await checkText(`mesh { lookAt("x"); }`))[0]!, /argument .* expects/);
  assert.deepEqual(await checkText(`mesh #a { }\ndirectionalLight { target: ref(#a); }`), []);
  // a ref is typed by the node it points at
  assert.match((await checkText(`mesh #a { }\nmesh { material: ref(#a); }`))[0]!, /expects Material.*got Mesh/);
});

test("registry names declared by the host are accepted unchecked", async () => {
  const withProxy = { ...schema, declared: ["proxyMesh"] };
  const run = async (text: string) => {
    const { nodes, templates } = await expand(parse(text, "t.tscene"), noImports);
    return check(nodes, withProxy, templates).map((d) => d.message);
  };
  assert.deepEqual(await run(`group { proxyMesh(1, 2) { visible: true; } }`), []);
  // a declared name is also a value: the registry may hold a material or a section table, not just a node
  assert.deepEqual(await run(`mesh { material: proxyMesh; geometry: proxyMesh(); }`), []);
  assert.match((await run(`mesh { material: proxyMaterial; }`))[0]!, /unknown constant "proxyMaterial"/);
  assert.match((await checkText(`group { proxyMesh { } }`))[0]!, /unknown three class "ProxyMesh"/);
});

test("autofixer fixes casing and formatting only", async () => {
  const out = await fixSource(`Mesh{CastShadow:true;geometry:boxGeometry(1,1,1)}`, "t.tscene", schema, noImports);
  assert.equal(out, `mesh {\n  castShadow: true;\n  geometry: boxGeometry(1, 1, 1);\n}\n`);
  assert.deepEqual(await checkText(out), []);
});

test("applyFixes skips overlapping ranges (last range wins)", () => {
  const text = "abcdef";
  const at = (start: number, end: number, s: string) => ({ message: "", severity: "error" as const, start, end, fix: { start, end, text: s } });
  assert.equal(applyFixes(text, [at(0, 2, "X"), at(4, 6, "Y")]), "XcdY");
  assert.equal(applyFixes(text, [at(0, 3, "X"), at(2, 5, "Y")]), "abYf");
});

test("checker covers repeat(), find() and play()", async () => {
  assert.deepEqual(await checkText(`group { repeat(2) { mesh { castShadow: true; } } }`), []);
  assert.deepEqual(await checkText(`gltf("./m.glb") { find(mesh, "Body") { castShadow: true; } play("Idle") { timeScale: 2; } }`), []);
  assert.match((await checkText(`group { find(mesh, "Body") { colour: 1; } }`))[0]!, /Mesh has no property "colour"/);
  assert.match((await checkText(`group { find(material, "Body") { } }`))[0]!, /not an Object3D/);
  assert.match((await checkText(`group { play(1) { } }`))[0]!, /play\(\) takes a clip name/);
  assert.match((await checkText(`group { play("Idle") { speed: 2; } }`))[0]!, /AnimationAction has no property "speed"/);
  assert.match((await checkText(`find("Body") { }`))[0]!, /only works inside a node/);
});

test("@import resolves bare specifiers out of node_modules", async () => {
  const { resolveSheet } = await import("./tools.ts");
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tscene-"));
  fs.mkdirSync(path.join(dir, "node_modules", "ui-kit", "scenes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "ui-kit", "scenes", "a.tscene"), "");
  const from = path.join(dir, "app", "main.tscene");
  assert.equal(resolveSheet("ui-kit/scenes/a.tscene", from), path.join(dir, "node_modules", "ui-kit", "scenes", "a.tscene"));
  assert.equal(resolveSheet("./b.tscene", from), path.join(dir, "app", "b.tscene"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the vite plugin emits one module per sheet, with its imports and assets", async () => {
  const plugin = (await import("./vite.ts")).default({ check: false }) as any;
  plugin.configResolved({ command: "serve" });
  // a vite id is absolute and forward-slash on every platform — on win32 that means a drive letter
  const dir = path.resolve("/p/scenes").split(path.sep).join("/");
  const src = `@import "./lib/mats.tscene";\nmesh { material: meshStandardMaterial { map: texture("./t.png"); }; }\ngltf #hero("./m.glb") { }\ngltf("https://cdn/m.glb")\nmesh { material: meshBasicMaterial { map: texture(var(--wall)); }; }\n--wall: "./w.png";\n`;
  const { code } = await plugin.transform(src, `${dir}/main.tscene`);
  assert.match(code, /import "\.\/lib\/mats\.tscene";/);            // the dep registers itself and vite watches it
  assert.match(code, /import __asset0 from "\.\/t\.png\?url";/);     // the bundler resolves the asset, not the runtime
  assert.match(code, /import __asset1 from "\.\/m\.glb\?url";/);     // a loader used as a node carries a selector
  assert.match(code, /import __asset2 from "\.\/w\.png\?url";/);     // a url behind a var is bundled too, declared after its use
  assert.doesNotMatch(code, /import __asset\d+ from "[^"]*cdn/);     // …but remote urls are left to the runtime
  // the registry is keyed by id, so the dep must be spelled the way vite will spell it
  assert.deepEqual(JSON.parse(/imports: (\{.*?\}),/.exec(code)![1]!), { "./lib/mats.tscene": `${dir}/lib/mats.tscene` });
  assert.match(code, /import\.meta\.hot\.accept/);
  assert.equal(JSON.parse(/source: (".*?"), file:/.exec(code)![1]!), src); // source is verbatim, so positions hold
});

test("the vite plugin follows a var into the sheet that declared it, and maps the lines that can fail", async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tscene-vite-"));
  const id = (p: string) => path.join(dir, p).split(path.sep).join("/");
  fs.mkdirSync(path.join(dir, "theme"));
  // the theme's urls are relative to the theme, which sits a directory away from the sheet that uses them
  fs.writeFileSync(path.join(dir, "theme", "vars.tscene"), `--wall: "./w.png";\n--floor: "../f.png";\n`);

  const plugin = (await import("./vite.ts")).default({ check: false }) as any;
  plugin.configResolved({ command: "build" });
  const src =
    `@import "./theme/vars.tscene";\n` +
    `mesh { material: meshBasicMaterial { map: texture(var(--wall)); }; }\n` +
    `mesh { material: meshBasicMaterial { map: texture(var(--floor)); }; }\n`;
  const { code, map } = await plugin.transform(src, id("main.tscene"));

  assert.match(code, /import __asset0 from "\.\/theme\/w\.png\?url";/, "the theme's own directory is what ./ meant");
  assert.match(code, /import __asset1 from "\.\/f\.png\?url";/, "and ../ climbs out of it, not out of this sheet");
  // the runtime looks an asset up by the raw string it read, so that is what the map is keyed by
  assert.match(code, /assets: \{ "\.\/w\.png": __asset0, "\.\.\/f\.png": __asset1 \}/);

  // a var this sheet declares itself wins, exactly as it does at runtime
  const own = await plugin.transform(`${src}--wall: "./mine.png";\n`, id("main.tscene"));
  assert.match(own.code, /import __asset0 from "\.\/mine\.png\?url";/);
  assert.doesNotMatch(own.code, /theme\/w\.png/);

  // --- the source map: one segment on the lines that are transforms of the sheet, nothing on the rest
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const unvlq = (s: string): number[] => {
    const out: number[] = [];
    let value = 0;
    let shift = 0;
    for (const c of s) {
      const d = B64.indexOf(c);
      value |= (d & 31) << shift;
      if (d & 32) { shift += 5; continue; }
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = shift = 0;
    }
    return out;
  };
  assert.deepEqual(map.sources, [id("main.tscene")]);
  assert.deepEqual(map.sourcesContent, [src]);
  const groups = map.mappings.split(";");
  const lines = code.split("\n");
  assert.equal(groups.length, lines.length, "one group per generated line, mapped or not");

  let line = 0;
  let column = 0;
  const at = new Map<string, [number, number]>();
  groups.forEach((group: string, i: number) => {
    if (!group) return;
    const [genColumn, source, dLine, dColumn] = unvlq(group);
    assert.equal(genColumn, 0, "a whole generated line stands for the construct, so the segment starts at 0");
    assert.equal(source, 0, "there is only ever the one source");
    line += dLine!;
    column += dColumn!;
    at.set(lines[i]!, [line, column]);
  });

  assert.deepEqual(at.get(`import "./theme/vars.tscene";`), [0, 0], "the @import it came from");
  assert.deepEqual(
    at.get(`import __asset0 from "./theme/w.png?url";`),
    [1, src.split("\n")[1]!.indexOf("var(--wall)")],
    "the loader argument that asked for it",
  );
  assert.equal(at.size, 3, "and nothing else is claimed to be a transform of the sheet");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("every loader is a texture the checker knows the class of, and its url is bundled", async () => {
  // the class each one arrives as is what makes it assignable — an environment is a Texture like any other
  assert.deepEqual(
    await checkText(`scene { environment: hdr("./e.hdr"); background: exr("./b.exr");
      mesh { material: meshStandardMaterial { map: ktx2("./m.ktx2"); normalMap: texture("./n.png"); }; } }`),
    [],
  );
  assert.match((await checkText(`mesh { material: meshBasicMaterial { map: hdr(); }; }`))[0]!, /hdr\(\) needs 1 argument/);
  assert.match((await checkText(`mesh { material: meshBasicMaterial { map: ktx2(3); }; }`))[0]!, /expects string, got number/);
  // a texture is not an Object3D, so it can never stand in for a node
  assert.match((await checkText(`hdr("./e.hdr") { }`))[0]!, /DataTexture/);

  const plugin = (await import("./vite.ts")).default({ check: false }) as any;
  plugin.configResolved({ command: "build" });
  const src = `scene { environment: hdr("./e.hdr"); background: exr("./b.exr");\n  mesh { material: meshBasicMaterial { map: ktx2("./m.ktx2"); }; }\n}\n`;
  const { code } = await plugin.transform(src, path.resolve("/p/main.tscene").split(path.sep).join("/"));
  for (const [i, asset] of ["./e.hdr", "./b.exr", "./m.ktx2"].entries()) {
    assert.match(code, new RegExp(`import __asset${i} from "${asset.replace(".", "\\.")}\\?url";`));
  }
});

test("the vite plugin imports the three classes a sheet names, and only those", async () => {
  const plugin = (await import("./vite.ts")).default({ check: false }) as any;
  plugin.configResolved({ command: "build" });
  const src = `@template meshStandardMaterial.glow { emissive: color(#fff); side: DoubleSide; }
mesh { geometry: boxGeometry(1, 1, 1); material: meshStandardMaterial.glow { }; lookAt(0, 1, 0); }
repeat(2) { pointLight(#fff, 1); }
gltf("./m.glb") { find(mesh, "body") { } play("Idle") { } }`;
  const { code } = await plugin.transform(src, path.resolve("/p/main.tscene").split(path.sep).join("/"));
  const named = /^import \{ (.*) \} from "three\/webgpu";$/m.exec(code)![1]!.split(", ");
  // template bodies count, aliases resolve, and constants are values like any other
  assert.deepEqual(named, ["BoxGeometry", "Color", "Group", "DoubleSide", "Mesh", "MeshStandardMaterial", "PointLight"].sort());
  // repeat/find/play are the language's own, and `lookAt` is a method — none of them is a three export
  for (const absent of ["Repeat", "Find", "Play", "LookAt", "Scene", "WebGPURenderer"]) assert.ok(!named.includes(absent), absent);
  assert.match(code, /registry: \{ BoxGeometry, Color, DoubleSide, Group, Mesh, MeshStandardMaterial, PointLight \}/);
});

test("the vite plugin imports an addon from its own module, never from the barrel", async () => {
  // the checker is on, because the schema is the thing that knows which module a name lives in
  const plugin = (await import("./vite.ts")).default() as any;
  plugin.configResolved({ command: "build" });
  const src = `mesh { geometry: loftGeometry([], { capStart: true }); material: meshStandardMaterial(); }`;
  const { code } = await plugin.transform(src, path.resolve("/p/main.tscene").split(path.sep).join("/"));
  assert.match(code, /^import \{ LoftGeometry \} from "three\/addons\/geometries\/LoftGeometry\.js";$/m);
  assert.match(code, /^import \{ Mesh, MeshStandardMaterial \} from "three\/webgpu";$/m);
  assert.doesNotMatch(code, /from "three\/addons";/); // the barrel would pin all 270 addon modules
  assert.match(code, /registry: \{ LoftGeometry, Mesh, MeshStandardMaterial \}/);
});

// ---------------------------------------------------------------- runtime

// A sheet parsed from a string was never seen by the vite plugin, so nothing imported three on its
// behalf — which is exactly the case `tscene/three` exists for.
const load = async (src: string, opts: Record<string, unknown> = {}) => {
  const { loadScene } = await import("./runtime.ts");
  const { threeRegistry } = await import("./three.ts");
  return loadScene(src, { registry: threeRegistry, ...opts });
};

test("loadScene builds real three objects", async () => {
  const root = await load(`
    --h: 1.5;
    group #stage {
      mesh #box {
        geometry: boxGeometry(2, 1, 1);
        material: meshStandardMaterial { color: color(#ff8000); side: DoubleSide; };
        position: vec3(0, calc(var(--h) * 2), 0);
        rotation: euler(90deg, 0, 0);
        userData: { hp: 3; tags: ["a", "b"] };
      }
      pointLight #lamp(#ffffff, 5);
    }`);
  const box = root.getObjectByName("box") as any;
  assert.equal(box.geometry.type, "BoxGeometry");
  assert.equal(box.geometry.parameters.width, 2);
  assert.equal(box.material.color.getHex(), 0xff8000);
  assert.equal(box.material.side, 2);
  assert.equal(box.position.y, 3);
  assert.deepEqual(box.userData, { hp: 3, tags: ["a", "b"] });
  assert.ok(Math.abs(box.position.constructor.name === "Vector3" ? 0 : 1) === 0);
  assert.ok(Math.abs(box.rotation.x - Math.PI / 2) < 1e-9);
  const lamp = root.getObjectByName("lamp") as any;
  assert.equal(lamp.intensity, 5);
  assert.equal(root.getObjectByName("stage")!.children.length, 2);
});

test("@bakery lands on .bakery, merged key by key", async () => {
  const root = await load(`
    @bakery { size: 512; include: none };
    @template mesh.baked { @bakery { enabled: true; radius: 2 }; }
    mesh.baked #box {
      @bakery { radius: 0.5 };
      material: meshStandardMaterial { @bakery { albedo: [0.5, 0.25, 0.125] }; };
    }`);
  assert.deepEqual((root as any).bakery, { size: 512, include: "none" });
  const box = root.getObjectByName("box") as any;
  assert.deepEqual(box.bakery, { enabled: true, radius: 0.5 }, "the node's own block wins key by key");
  assert.deepEqual(box.material.bakery, { albedo: [0.5, 0.25, 0.125] });
});

test("one AST node is one instance, so a shared --var is a shared material", async () => {
  const root = await load(`
    --mat: meshStandardMaterial { color: color(#00ff00); };
    group { mesh #a { material: var(--mat); } mesh #b { material: var(--mat); } }`);
  const [a, b] = [root.getObjectByName("a") as any, root.getObjectByName("b") as any];
  assert.equal(a.material, b.material);
  assert.equal(a.material.color.getHex(), 0x00ff00);
});

test("runtime handles ref(), method calls and dotted paths, and ignores warnings", async () => {
  // `--dead` is never read: a warning, and warnings must not stop the build
  const root = await load(`
    --dead: 1;
    group {
      mesh #a { material: meshStandardMaterial { }; material.opacity: 0.25; position.x: 3; lookAt(0, 1, 0); }
      directionalLight #b { target: ref(#a); }
    }`);
  const a = root.getObjectByName("a") as any;
  assert.equal(a.material.opacity, 0.25);
  assert.equal(a.position.x, 3);
  assert.ok(Math.abs(a.rotation.x) > 0); // lookAt actually ran
  assert.equal((root.getObjectByName("b") as any).target, a);
});

test("each() evaluates its body per iteration, and shares only what does not vary", async () => {
  const root = await load(`
    --profile: splineCurve([vec2(0.2, 0), vec2(1.2, 0.4), vec2(0.2, 1.7)]);
    --shared: meshStandardMaterial { roughness: 0.4; };
    group #stage {
      mesh #pot {
        material: var(--shared);
        /* 8 rings of 4 points, out of a spline sampled at 8 divisions */
        userData: {
          rings: each(--p, var(--profile).getPoints(7), each(--j, 4, vec3(
            calc(sin(var(--j) / var(--count) * 2 * pi) * var(--p).x),
            var(--p).y,
            calc(cos(var(--j) / var(--count) * 2 * pi) * var(--p).x)
          )));
          walk: each(--n, [10, 20, 30], calc(var(--n) + var(--index) * 100));
        };
      }
      mesh #other { material: var(--shared); }
    }
  `);
  const pot = root.getObjectByName("pot")!;
  const rings = pot.userData.rings as { x: number; y: number; z: number }[][];
  assert.equal(rings.length, 8);
  assert.equal(rings[0]!.length, 4);
  // a quarter turn round the first profile point: sin = 1, cos = 0, at radius 0.2
  assert.ok(Math.abs(rings[0]![1]!.x - 0.2) < 1e-9, `${rings[0]![1]!.x}`);
  assert.ok(Math.abs(rings[0]![1]!.z) < 1e-9);
  // every point is its own Vector3 — the AST node is one, the instances are not
  assert.equal(new Set(rings.flat()).size, 32);
  // walking a list binds the item, and --index comes along
  assert.deepEqual(pot.userData.walk, [10, 120, 230]);
  // …while a node that reads no binding is still one instance, shared by both meshes
  assert.equal((pot as { material?: unknown }).material, (root.getObjectByName("other") as { material?: unknown }).material);
});

test("each() falls back to the awaiting path for a body that cannot be built synchronously", async () => {
  // a node with a body is exactly what the synchronous evaluator hands over, so this walks the other path
  const root = await load(`
    mesh #box {
      userData: {
        mats: each(--i, 3, meshStandardMaterial { roughness: calc(var(--i) / 4); });
        nested: each(--i, 2, each(--j, 2, calc(var(--i) * 10 + var(--j))));
      };
    }
  `);
  const mats = root.getObjectByName("box")!.userData.mats as { roughness: number }[];
  assert.deepEqual(mats.map((m) => m.roughness), [0, 0.25, 0.5]);
  assert.equal(new Set(mats).size, 3); // one instance per iteration, not one shared three times
  assert.deepEqual(root.getObjectByName("box")!.userData.nested, [[0, 1], [10, 11]]);
});

test("repeat() unrolls with --index and --count", async () => {
  const root = await load(`group #row { repeat(3) { mesh #tile { position.x: calc(var(--index) * 2); renderOrder: var(--count); } } }`);
  const row = root.getObjectByName("row")!;
  assert.deepEqual(row.children.map((c) => c.position.x), [0, 2, 4]);
  assert.deepEqual(row.children.map((c) => c.renderOrder), [3, 3, 3]);
  // repeat copies deliberately share their #id, so the duplicate warning must stay quiet
  const { diagnostics } = await expand(parse(`repeat(2) { mesh #t { } }`, "t.tscene"), noImports);
  assert.deepEqual(diagnostics, []);
  const bad = await expand(parse(`repeat(mesh) { }`, "t.tscene"), noImports);
  assert.match(bad.diagnostics[0]!.message, /repeat\(\) takes one whole number/);
});

test("find() reaches into an already-built subtree", async () => {
  const root = await load(`
    group #rig {
      mesh #body { }
      find(mesh, "body") { castShadow: true; }
      find#alias("body") { renderOrder: 2; }
      directionalLight { target: ref(#alias); }
    }`);
  const body = root.getObjectByName("body") as any;
  assert.equal(body.castShadow, true);
  assert.equal(body.renderOrder, 2);
  assert.equal(body.name, "body"); // an #id on find() aliases, it does not rename
  await assert.rejects(load(`group { find("nope") { } }`), /no descendant named "nope"/);
  await assert.rejects(load(`group { mesh #a { } find(pointLight, "a") { } }`), /is not a PointLight/);
});

test("ref() resolves nodes declared later in the sheet", async () => {
  const root = await load(`directionalLight #sun { target: ref(#ground); }
mesh #ground { }`);
  assert.equal((root.getObjectByName("sun") as any).target, root.getObjectByName("ground"));
  await assert.rejects(load(`directionalLight { target: ref(#nope); }`), /unknown node #nope/);
});

test("runtime errors point at file:line:col", async () => {
  await assert.rejects(load(`group {\n  mesh { position.x: ; }\n}`, { base: "/p/main.tscene" }), /\/p\/main\.tscene:2:22/);
  // a property value can wait for a later node, a constructor argument cannot — and says so
  await assert.rejects(load(`group { mesh(ref(#later)) { } mesh #later { } }`), /constructor argument/);
  await load(`group { directionalLight { target: ref(#later); } mesh #later { } }`);
});

test("disposeScene frees geometries, materials and their textures", async () => {
  const { disposeScene } = await import("./runtime.ts");
  const root = await load(`group { mesh { geometry: boxGeometry(1,1,1); material: meshStandardMaterial { }; } }`);
  const mesh = root.children[0]!.children[0] as any;
  const disposed: string[] = [];
  mesh.geometry.addEventListener("dispose", () => disposed.push("geometry"));
  mesh.material.addEventListener("dispose", () => disposed.push("material"));
  disposeScene(root);
  assert.deepEqual(disposed.sort(), ["geometry", "material"]);
});

test("mountScene keeps one root in the parent, hot update after hot update", async () => {
  const { mountScene, __sceneRegister, __sceneChanged } = await import("./runtime.ts");
  const { threeRegistry } = await import("./three.ts");
  const { Group } = await import("three/webgpu");

  const sheet = (source: string) => __sceneRegister({ source, file: "/p/main.tscene", registry: threeRegistry });
  const mod = sheet(`mesh #box { geometry: boxGeometry(1,1,1); }`);
  const parent = new Group();

  const loaded: string[] = [];
  const mount = await mountScene(parent, mod, { onLoad: (root) => loaded.push(root.children[0]!.name) });
  assert.equal(parent.children.length, 1);
  assert.deepEqual(loaded, ["box"]);

  // the module object the caller imported goes stale on reload; the registry has the current source
  const first = mount.root;
  sheet(`mesh #sphere { geometry: sphereGeometry(1); }`);
  __sceneChanged(mod);
  await mount.reload(); // the hot listener queued one too — both go through the same chain
  assert.equal(parent.children.length, 1, "the old root is disposed once the new one is up");
  assert.equal(mount.root?.children[0]?.name, "sphere");
  assert.equal(first?.parent, null);
  assert.deepEqual(loaded, ["box", "sphere", "sphere"]);

  // a broken sheet is reported instead of thrown, and nothing goes up
  const errors: string[] = [];
  const target = new Group();
  const guarded = await mountScene(target, sheet(`mesh { position.x: ; }`), { onError: (e) => errors.push(String(e)) });
  assert.equal(target.children.length, 0);
  assert.equal(errors.length, 1);
  sheet(`mesh #ok { }`);
  await guarded.reload();
  assert.equal(target.children[0]?.children[0]?.name, "ok");
  assert.equal(errors.length, 1, "a failed build must not poison the rebuilds queued behind it");

  mount.dispose();
  assert.equal(parent.children.length, 0);
  __sceneChanged(mod); // no longer listening
  assert.equal(mount.root, undefined);
});

test("mount.update advances the clips play() started", async () => {
  const { mountScene, __sceneRegister } = await import("./runtime.ts");
  const { threeRegistry } = await import("./three.ts");
  const { Group } = await import("three/webgpu");

  const mod = __sceneRegister({ source: `mesh #box { }`, file: "/p/clock.tscene", registry: threeRegistry });
  const mount = await mountScene(new Group(), mod);
  const deltas: number[] = [];
  mount.root!.userData.mixers = [{ update: (dt: number) => deltas.push(dt) }];

  mount.update(0.5);
  mount.update(); // the first untimed frame has no previous timestamp to subtract
  mount.update();
  assert.equal(deltas.length, 3);
  assert.equal(deltas[0], 0.5);
  assert.ok(deltas[2]! >= 0 && deltas[2]! < 1, `an untimed frame is a real delta, got ${deltas[2]}`);
});

test("disposeScene frees what the sheet built and never what the asset cache owns", async () => {
  const { disposeScene, shareAssets } = await import("./runtime.ts");
  const { Group, Mesh, BoxGeometry, MeshStandardMaterial, Texture } = await import("three/webgpu");

  // a gltf() node is a clone(), so its geometry and material are the cached scene's own objects
  const asset = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map: new Texture() }));
  shareAssets(new Group().add(asset));

  const root = new Group();
  const own = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map: new Texture() }));
  root.add(own, asset.clone());

  const disposed: string[] = [];
  const watch = (r: any, name: string) => r.addEventListener("dispose", () => disposed.push(name));
  watch(own.geometry, "own.geometry");
  watch(own.material, "own.material");
  watch(own.material.map!, "own.map");
  watch(asset.geometry, "asset.geometry");
  watch(asset.material, "asset.material");
  watch((asset.material as InstanceType<typeof MeshStandardMaterial>).map!, "asset.map");

  // a scene()'s own sky, and a slot holding a list of textures: neither is reached by `material.map`
  const sky = new Texture();
  const layers = [new Texture(), new Texture()];
  Object.assign(root, { background: sky });
  Object.assign(own.material, { layers });
  watch(sky, "sky");
  layers.forEach((t, i) => watch(t, `layer${i}`));

  disposeScene(root);
  assert.deepEqual(disposed.sort(), ["layer0", "layer1", "own.geometry", "own.map", "own.material", "sky"]);
});

/** three's ImageLoader wants a DOM; every texture in these tests is this 1x1 white pixel instead. */
async function stubImages(load?: (url: string) => { fail?: boolean }): Promise<() => void> {
  const THREE = await import("three/webgpu");
  const original = THREE.ImageLoader.prototype.load;
  THREE.ImageLoader.prototype.load = function (url: string, onLoad?: any, _p?: unknown, onError?: any) {
    if (load?.(url)?.fail) onError?.(new Error(`cannot load ${url}`));
    else onLoad?.({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) });
    return {} as any;
  } as typeof THREE.ImageLoader.prototype.load;
  return () => void (THREE.ImageLoader.prototype.load = original);
}

test("texture() is sRGB in a colour slot and raw everywhere else", async () => {
  const restore = await stubImages();
  try {
    const root = await load(`mesh { material: meshStandardMaterial {
      map: texture("./albedo.png");
      roughnessMap: texture("./rough.png");
      emissiveMap: texture("./glow.png") { colorSpace: "srgb-linear"; };
    }; }`);
    const material = (root.children[0] as any).material;
    assert.equal(material.map.colorSpace, "srgb", "a colour map three would read washed out gets decoded");
    assert.equal(material.roughnessMap.colorSpace, "", "data stays linear");
    assert.equal(material.emissiveMap.colorSpace, "srgb-linear", "and a sheet that states one is left alone");
  } finally {
    restore();
  }
});

test("a failed texture is not cached forever", async () => {
  let attempts = 0;
  const restore = await stubImages(() => ({ fail: ++attempts === 1 }));
  try {
    const sheet = `mesh { material: meshBasicMaterial { map: texture("./flaky.png"); }; }`;
    await assert.rejects(load(sheet), /cannot load/);
    const root = await load(sheet);
    assert.equal(attempts, 2, "the second try must reach the loader, not the cached rejection");
    assert.ok((root.children[0] as any).material.map.image);
  } finally {
    restore();
  }
});

test("a mount disposed mid-build never puts its root on screen", async () => {
  const { mountScene, __sceneRegister } = await import("./runtime.ts");
  const { threeRegistry } = await import("./three.ts");
  const { Group } = await import("three/webgpu");

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const mod = __sceneRegister({
    source: `@import "./slow.tscene";\nmesh #box { }`,
    file: "/p/race.tscene",
    registry: threeRegistry,
  });
  const parent = new Group();
  const mount = await mountScene(parent, mod, {
    hmr: false,
    // the second build is the slow one — a gltf still downloading is the real version of this
    load: async () => {
      if (++calls === 2) await gate;
      return { text: `mesh #dep { }`, file: "/p/slow.tscene" };
    },
  });
  assert.equal(parent.children.length, 1);

  const reloading = mount.reload();
  mount.dispose();
  release();
  await reloading;
  assert.equal(parent.children.length, 0, "the build that landed after dispose() must not be added");
  assert.equal(mount.root, undefined);
});

test("@bakery { lightmap } is applied to the sheet it names", async () => {
  const { encodeFloats, MANIFEST_VERSION } = await import("./bakery/apply.ts");
  const manifest = {
    version: MANIFEST_VERSION,
    width: 1,
    height: 1,
    intensity: 2,
    texture: "atlas.png",
    meshes: [{ key: "floor", vertices: 6, uv: encodeFloats(new Float32Array(12)) }],
  };
  const upstream = globalThis.fetch;
  const restore = await stubImages();
  globalThis.fetch = (async () => new Response(JSON.stringify(manifest))) as typeof fetch;
  try {
    // an absolute url, because node has no document for a root-relative one to resolve against
    const sheet = `@bakery { lightmap: "https://cdn.test/maps/room.lightmap.json" }
      mesh #floor { geometry: planeGeometry(1, 1); material: meshStandardMaterial { }; }`;
    const root = await load(sheet);
    const lightmap = root.userData.lightmap as { texture: unknown } | undefined;
    const material = (root.getObjectByName("floor") as any).material;
    assert.ok(lightmap, "the bake the sheet names is applied, and the handle is where a demo can reach it");
    assert.equal(material.lightMap, lightmap!.texture);
    assert.equal(material.lightMapIntensity, 2, "the manifest's exposure comes along");

    // the baker loads the same sheet, and applying its own output mid-bake would zero the lights
    assert.equal((await load(sheet, { lightmap: false })).userData.lightmap, undefined);
  } finally {
    globalThis.fetch = upstream;
    restore();
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
