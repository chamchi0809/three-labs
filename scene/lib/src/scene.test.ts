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
  const { nodes, diagnostics, templates } = await expand(parse(text, "t.tscene"), noImports);
  return [...diagnostics, ...check(nodes, schema, templates)].map((d) => d.message);
};

test("schema reflects the installed three typings", () => {
  assert.ok(Object.keys(schema.classes).length > 100);
  assert.deepEqual(schema.classes.Mesh!.bases, ["Object3D"]);
  assert.equal(schema.classes.Mesh!.props.geometry!.type.kind, "class");
  assert.equal((schema.classes.Mesh!.props.geometry!.type as any).name, "BufferGeometry");
  assert.equal(schema.classes.Mesh!.props.position!.readonly, true);
  assert.equal(schema.constants.DoubleSide!.kind, "number");
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
  assert.match((await checkText(`mesh { material.opacty: 0.5; }`))[0]!, /Material has no property "opacty"/);
  assert.match((await checkText(`mesh { visible.x: 1; }`))[0]!, /Mesh\.visible is not an object/);
  assert.deepEqual(await checkText(`mesh { lookAt(0, 1, 0); }`), []);
  assert.match((await checkText(`mesh { lookAt("x"); }`))[0]!, /argument .* expects/);
  assert.deepEqual(await checkText(`mesh #a { }\ndirectionalLight { target: ref(#a); }`), []);
  // a ref is typed by the node it points at
  assert.match((await checkText(`mesh #a { }\nmesh { material: ref(#a); }`))[0]!, /expects Material.*got Mesh/);
});

test("registry names declared by the host are accepted unchecked", async () => {
  const withWater = { ...schema, declared: ["water"] };
  const run = async (text: string) => {
    const { nodes, templates } = await expand(parse(text, "t.tscene"), noImports);
    return check(nodes, withWater, templates).map((d) => d.message);
  };
  assert.deepEqual(await run(`group { water(1, 2) { visible: true; } }`), []);
  assert.match((await checkText(`group { water { } }`))[0]!, /unknown three class "Water"/);
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
  const src = `@import "./lib/mats.tscene";\nmesh { material: meshStandardMaterial { map: texture("./t.png"); }; }\ngltf #hero("./m.glb") { }\ngltf("https://cdn/m.glb")\n`;
  const { code } = await plugin.transform(src, `${dir}/main.tscene`);
  assert.match(code, /import "\.\/lib\/mats\.tscene";/);            // the dep registers itself and vite watches it
  assert.match(code, /import __asset0 from "\.\/t\.png\?url";/);     // the bundler resolves the asset, not the runtime
  assert.match(code, /import __asset1 from "\.\/m\.glb\?url";/);     // a loader used as a node carries a selector
  assert.doesNotMatch(code, /import __asset2/);                      // …but remote urls are left to the runtime
  // the registry is keyed by id, so the dep must be spelled the way vite will spell it
  assert.deepEqual(JSON.parse(/imports: (\{.*?\}),/.exec(code)![1]!), { "./lib/mats.tscene": `${dir}/lib/mats.tscene` });
  assert.match(code, /import\.meta\.hot\.accept/);
  assert.equal(JSON.parse(/source: (".*?"), file:/.exec(code)![1]!), src); // source is verbatim, so positions hold
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
