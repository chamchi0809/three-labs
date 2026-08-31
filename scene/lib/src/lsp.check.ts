// Drives the language server over stdio and asserts every capability it advertises.
// node --experimental-strip-types src/lsp.check.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tscene-lsp-"));
const main = path.join(dir, "main.tscene");
const shared = path.join(dir, "shared.tscene");

fs.writeFileSync(shared, `--warmth: 0.5;\n\n@template mesh.glow {\n  castShadow: true;\n  renderOrder: var(--depth);\n}\n\n@template pointLight.warm {\n  intensity: 3;\n}\n`);
const text = `@import "./shared.tscene";
--height: 2;

group #stage {
  --spin: 0.5;
  mesh.glow #box {
    --depth: 1;
    geometry: boxGeometry(1, 1, 1);
    position: vec3(0, var(--height), 0);
    scale: vec3(var(--spin), 1, 1);
    material: meshStandardMaterial { --hidden: 1; side: DoubleSide; };
    visable: true;
  }
  mesh #floor {
    --spin: 9;
    scale: vec3(var(--spin), 1, 1);
  }
}

@template mesh.shiny {
  receiveShadow: true;
}

@override #stage mesh.glow {
  frustumCulled: false;
}
`;
fs.writeFileSync(main, text);

const server = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", path.join(here, "lsp.ts"), "--stdio"], {
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map<number, (message: any) => void>();
const notifications: Record<string, any[]> = {};
let buffer = Buffer.alloc(0);

server.stdout.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const header = buffer.indexOf("\r\n\r\n");
    if (header < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, header).toString())?.[1]);
    if (buffer.length < header + 4 + length) return;
    const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString());
    buffer = buffer.subarray(header + 4 + length);
    if (message.id !== undefined && pending.has(message.id)) {
      const settle = pending.get(message.id)!;
      pending.delete(message.id);
      settle(message);
    }
    else if (message.method) (notifications[message.method] ??= []).push(message.params);
  }
});

let nextId = 1;
const send = (message: object) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  server.stdin.write(body);
};
const request = (method: string, params: object) =>
  new Promise<any>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
    setTimeout(() => reject(new Error(`${method} timed out`)), 60_000).unref();
    send({ id, method, params });
  });

// a package that ships sheets, so bare `@import "kit/…"` has something to resolve to
const pkg = path.join(dir, "node_modules", "kit");
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "kit", version: "1.0.0", main: "theme.tscene" }));
fs.writeFileSync(path.join(pkg, "theme.tscene"), `--tint: 0.25;\n`);

const uri = pathToFileURL(main).href;
const posIn = (src: string, needle: string, delta = 0) => {
  const offset = src.indexOf(needle) + delta;
  const head = src.slice(0, offset);
  return { line: head.split("\n").length - 1, character: offset - (head.lastIndexOf("\n") + 1) };
};
const at = (needle: string, delta = 0) => posIn(text, needle, delta);
const position = (needle: string, delta = 0) => ({ textDocument: { uri }, position: at(needle, delta) });
const labels = (items: any[]) => items.map((i: any) => i.label);
// results come out in graph order, so compare as sets
const sortRanges = (items: any[]) =>
  items.map((r: any) => r.range.start).sort((a, b) => a.line - b.line || a.character - b.character);

const failures: string[] = [];
const check = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`FAIL ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`);
  }
};

const capabilities = (await request("initialize", { processId: process.pid, rootPath: dir, capabilities: {} })).capabilities;
send({ method: "initialized", params: {} });
send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "scene", version: 1, text } } });

await check("advertises the full language surface", async () => {
  for (const capability of ["completionProvider", "hoverProvider", "signatureHelpProvider", "definitionProvider", "referencesProvider", "renameProvider", "documentSymbolProvider", "documentFormattingProvider", "codeActionProvider", "documentLinkProvider", "colorProvider", "foldingRangeProvider", "semanticTokensProvider"]) {
    assert.ok(capabilities[capability], `missing ${capability}`);
  }
});

await check("publishes diagnostics for the open file", async () => {
  for (let i = 0; i < 100 && !notifications["textDocument/publishDiagnostics"]; i++) await new Promise((r) => setTimeout(r, 100));
  const diagnostics = notifications["textDocument/publishDiagnostics"]!.at(-1)!.diagnostics;
  const messages = diagnostics.map((d: any) => d.message);
  const typo = diagnostics.find((d: any) => /has no property "visable"/.test(d.message));
  assert.ok(typo, `expected the property typo, got ${messages}`);
  assert.deepEqual(typo.range.start, at("visable"));
  // dead declarations in the edited file are warned about; the import's --warmth is not this file's problem
  assert.deepEqual(messages.filter((m: string) => /never/.test(m)).sort(), ["--hidden is never used", ".shiny is never applied"]);
  assert.equal(diagnostics.length, 3);
});

await check("quick-fixes casing through code actions", async () => {
  const doc = text.replace("visable: true;", "CastShadow: true;");
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: doc }] } });
  await new Promise((r) => setTimeout(r, 500));
  const diagnostics = notifications["textDocument/publishDiagnostics"]!.at(-1)!.diagnostics;
  const casing = diagnostics.find((d: any) => /did you mean castShadow/.test(d.message));
  assert.ok(casing, `expected a casing fix, got ${diagnostics.map((d: any) => d.message)}`);
  const actions = await request("textDocument/codeAction", { textDocument: { uri }, range: casing.range, context: { diagnostics: [casing] } });
  assert.equal(actions[0].edit.changes[uri][0].newText, "castShadow");
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 3 }, contentChanges: [{ text }] } });
  await new Promise((r) => setTimeout(r, 300));
});

await check("hover shows the class signature and property type", async () => {
  const node = await request("textDocument/hover", position("boxGeometry", 3));
  assert.match(node.contents.value, /boxGeometry\(width\?: number/);
  assert.match(node.contents.value, /BoxGeometry < BufferGeometry/);
  const prop = await request("textDocument/hover", position("position:", 2));
  assert.match(prop.contents.value, /readonly Mesh\.position: Vector3/);
  assert.match(prop.contents.value, /copy\(\)/);
  // three's own TSDoc rides along with the schema
  assert.match(node.contents.value, /box geometry|geometry class/i);
  assert.match((await request("textDocument/hover", position("receiveShadow", 3))).contents.value, /shadow/i);
});

await check("signature help tracks the active constructor argument", async () => {
  const help = await request("textDocument/signatureHelp", position("boxGeometry(1, 1, 1)", "boxGeometry(1, ".length));
  assert.match(help.signatures[0].label, /^boxGeometry\(width/);
  assert.equal(help.activeParameter, 1);
});

await check("go to definition for templates, variables and imports", async () => {
  const template = await request("textDocument/definition", position("mesh.glow", 6));
  assert.equal(template[0].uri, pathToFileURL(shared).href);
  assert.deepEqual(template[0].range.start, { line: 2, character: "@template mesh".length }); // the `.glow` name itself

  const variable = await request("textDocument/definition", position("var(--height)", 6));
  assert.equal(variable[0].uri, uri);
  assert.deepEqual(variable[0].range.start, at("--height"));

  // declared in an enclosing block, not at the top level
  const nested = await request("textDocument/definition", position("var(--spin)", 6));
  assert.deepEqual(nested[0].range.start, at("--spin"));

  const imported = await request("textDocument/definition", position("./shared.tscene", 3));
  assert.equal(imported[0].uri, pathToFileURL(shared).href);
});

await check("references and rename span every sheet in the workspace", async () => {
  const context = { context: { includeDeclaration: true } };
  const refs = await request("textDocument/references", { ...position("var(--height)", 6), ...context });
  assert.deepEqual(sortRanges(refs), sortRanges([{ range: { start: at("--height") } }, { range: { start: at("var(--height)", 4) } }]));

  const edit = await request("textDocument/rename", { ...position("var(--height)", 6), newName: "lift" });
  assert.deepEqual(edit.changes[uri].map((e: any) => e.newText), ["--lift", "--lift"]);

  // a template is declared in one file and applied in another
  const glow = await request("textDocument/references", { ...position("mesh.glow", 6), ...context });
  assert.deepEqual([...new Set(glow.map((r: any) => r.uri))].sort(), [uri, pathToFileURL(shared).href].sort());
});

await check("rename follows scope, not the name", async () => {
  // #floor has its own --spin; renaming the one on #stage must leave it alone
  const outer = await request("textDocument/rename", { ...position("--spin: 0.5"), newName: "turn" });
  const inner = await request("textDocument/rename", { ...position("--spin: 9"), newName: "turn" });
  const lines = (edit: any) => edit.changes[uri].map((e: any) => e.range.start.line).sort();
  assert.equal(lines(outer).length, 2); // the declaration and #box's var()
  assert.equal(lines(inner).length, 2); // the declaration and #floor's var()
  assert.equal(lines(outer).filter((l: number) => lines(inner).includes(l)).length, 0);
});

await check("rename follows a template parameter into the template body", async () => {
  // --depth is declared on #box and read by .glow, which lives in the other sheet
  const edit = await request("textDocument/rename", { ...position("--depth: 1"), newName: "layer" });
  assert.deepEqual(Object.keys(edit.changes).sort(), [uri, pathToFileURL(shared).href].sort());
});

await check("hover explains variables, templates and constants", async () => {
  const variable = await request("textDocument/hover", position("var(--height)", 6));
  assert.match(variable.contents.value, /--height: 2;/);
  const template = await request("textDocument/hover", position("mesh.glow", 6));
  assert.match(template.contents.value, /@template mesh\.glow/);
  const constant = await request("textDocument/hover", position("DoubleSide", 2));
  assert.match(constant.contents.value, /DoubleSide: (number|Side)/);
});

await check("rename is prepared and validated before it runs", async () => {
  const prepared = await request("textDocument/prepareRename", position("var(--height)", 6));
  assert.equal(prepared.placeholder, "--height");

  // a hex colour is not an id, so nothing there is renameable
  assert.equal(await request("textDocument/prepareRename", position("DoubleSide", 2)), null);

  await assert.rejects(
    () => request("textDocument/rename", { ...position("var(--height)", 6), newName: "1bad name" }),
    /not a valid variable name/,
  );
});

await check("#id references and definitions follow ref()", async () => {
  const doc = text.replace("  mesh #floor {", "  mesh #floor { customDepthMaterial: ref(#box);");
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 6 }, contentChanges: [{ text: doc }] } });
  await new Promise((r) => setTimeout(r, 300));
  const line = doc.slice(0, doc.indexOf("ref(#box)")).split("\n").length - 1;
  const character = doc.slice(0, doc.indexOf("ref(#box)")).length - doc.lastIndexOf("\n", doc.indexOf("ref(#box)")) - 1 + "ref(#".length;
  const refs = await request("textDocument/references", { textDocument: { uri }, position: { line, character }, context: { includeDeclaration: true } });
  assert.equal(refs.length, 2); // the declaration on #box and this use
  const edit = await request("textDocument/rename", { textDocument: { uri }, position: { line, character }, newName: "crate" });
  assert.deepEqual(edit.changes[uri].map((e: any) => e.newText), ["#crate", "#crate"]);
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 7 }, contentChanges: [{ text }] } });
  await new Promise((r) => setTimeout(r, 200));
});

await check("document symbols mirror the scene graph", async () => {
  const symbols = await request("textDocument/documentSymbol", { textDocument: { uri } });
  assert.deepEqual(symbols.map((s: any) => s.name), ["--height", "group #stage", "@template mesh.shiny", "@override #stage mesh.glow"]);
  assert.deepEqual(symbols[1].children.map((s: any) => s.name), ["mesh #box.glow", "mesh #floor"]);
});

await check("completion is context sensitive", async () => {
  const inBody = await request("textDocument/completion", position("    geometry: boxGeometry", 4));
  assert.ok(labels(inBody).includes("castShadow"), "expected Mesh properties");
  assert.ok(labels(inBody).includes("pointLight"), "expected node names");

  const values = await request("textDocument/completion", position("vec3(0, var"));
  assert.ok(labels(values).includes("vec3"), `expected vec3 constructor, got ${labels(values).slice(0, 5)}`);
  assert.ok(!labels(values).includes("castShadow"), "property names should not leak into value position");

  // `side` is `Side`, not a bare number — only its own members may show up
  const constants = await request("textDocument/completion", position("DoubleSide"));
  assert.deepEqual(labels(constants), ["FrontSide", "BackSide", "DoubleSide"]);

  // only templates declared for a Mesh — `pointLight.warm` must not show up here
  const templates = await request("textDocument/completion", position("mesh.glow", 5));
  assert.deepEqual(labels(templates).sort(), ["glow", "shiny"]);

  // inside `var(` — variables, not class names: the import's top level, this file's, the enclosing
  // group's, but neither the one declared deeper in `material` nor anything after the cursor
  const vars = await request("textDocument/completion", position("--height), 0)", 3));
  assert.deepEqual(labels(vars), ["--warmth", "--height", "--spin", "--depth"]);
  assert.equal(vars[0].textEdit.newText, "--warmth");

  // inside a call argument — only values that fit the parameter
  const args = labels(await request("textDocument/completion", position("boxGeometry(1, 1, 1)", "boxGeometry(".length)));
  assert.deepEqual(args, [], `numeric parameter, nothing to suggest, got ${args.slice(0, 5)}`);

  // inside a template body the declared node type drives completion
  const inTemplate = labels(await request("textDocument/completion", position("  receiveShadow", 2)));
  assert.ok(inTemplate.includes("castShadow"), "expected Mesh properties inside @template mesh.shiny");
  assert.ok(!inTemplate.includes("intensity"), "PointLight properties leaked into a Mesh template");
});

await check("@override is resolved through its selector and completed against its type", async () => {
  // the body is checked against the rightmost compound's type, and nothing narrower
  const body = labels(await request("textDocument/completion", position("  frustumCulled", 2)));
  assert.ok(body.includes("castShadow"), "expected Mesh properties inside @override … mesh.glow");
  assert.ok(!body.includes("intensity"), "PointLight properties leaked into a mesh selector");

  // both names a selector picks by resolve to their declaration — the #id here, the template's sheet there
  const id = await request("textDocument/definition", position("#stage mesh.glow", 2));
  assert.equal(id[0].uri, uri);
  assert.deepEqual(id[0].range.start, at("#stage"));
  const template = await request("textDocument/definition", position("#stage mesh.glow", "#stage mesh".length + 2));
  assert.equal(template[0].uri, pathToFileURL(shared).href);

  // …so renaming the node rewrites the selector with it
  const edit = await request("textDocument/rename", { ...position("group #stage", 8), newName: "arena" });
  assert.deepEqual(edit.changes[uri].map((e: any) => e.newText), ["#arena", "#arena"]);

  const hover = await request("textDocument/hover", position("  frustumCulled", 4));
  assert.match(hover.contents.value, /frustumCulled/);
});

await check("completion narrows to the property type while the document is unparseable", async () => {
  // a half-typed property: nothing after the colon, no terminator — the parser rejects this outright
  const typing = text.replace("    visable: true;\n", "    material: ");
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 4 }, contentChanges: [{ text: typing }] } });
  const head = typing.slice(0, typing.indexOf("material: ") + "material: ".length);
  const at = { line: head.split("\n").length - 1, character: head.length - (head.lastIndexOf("\n") + 1) };
  const items = labels(await request("textDocument/completion", { textDocument: { uri }, position: at }));
  assert.ok(items.includes("meshStandardMaterial"), `expected Material subclasses, got ${items.slice(0, 5)}`);
  assert.ok(!items.includes("ambientLight"), "non-Material classes leaked in");
  assert.ok(!items.includes("boxGeometry"), "non-Material classes leaked in");
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 5 }, contentChanges: [{ text }] } });
  await new Promise((r) => setTimeout(r, 200));
});

await check("@import links to its target and completes sibling sheets", async () => {
  const links = await request("textDocument/documentLink", { textDocument: { uri } });
  assert.equal(links.length, 1);
  assert.equal(links[0].target, pathToFileURL(shared).href);
  assert.deepEqual(links[0].range, { start: at("./shared.tscene"), end: at("./shared.tscene", "./shared.tscene".length) });

  const typed = `@import "./sh`;
  const typing = text.replace(`@import "./shared.tscene";`, typed);
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 8 }, contentChanges: [{ text: typing }] } });
  await new Promise((r) => setTimeout(r, 300));
  const items = await request("textDocument/completion", { textDocument: { uri }, position: { line: 0, character: typed.length } });
  assert.deepEqual(labels(items), ["shared.tscene"]); // main.tscene is this file, so it is not offered
  assert.equal(items[0].textEdit.newText, "shared.tscene");
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 9 }, contentChanges: [{ text }] } });
  await new Promise((r) => setTimeout(r, 200));
});

await check("@bakery completes its own keys, never three's names", async () => {
  const doc = `@bakery {\n  \n}\n\nmesh #box {\n  @bakery {\n    \n  }\n  material: meshStandardMaterial {\n    @bakery {\n      \n    }\n  }\n}\n`;
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 10 }, contentChanges: [{ text: doc }] } });
  await new Promise((r) => setTimeout(r, 200));
  // every empty line in `doc` is inside one @bakery block, one per position
  const blank = (n: number) => ({ textDocument: { uri }, position: { line: [1, 6, 10][n]!, character: 6 } });

  const sheet = labels(await request("textDocument/completion", blank(0)));
  assert.ok(sheet.includes("samples") && sheet.includes("include"), `expected sheet settings, got ${sheet.slice(0, 5)}`);
  assert.ok(!sheet.includes("ambientLight"), "three class names leaked into @bakery");
  assert.ok(!sheet.includes("castShadow"), "three properties leaked into @bakery");

  assert.deepEqual(labels(await request("textDocument/completion", blank(1))).sort(), ["density", "enabled", "influence", "probe", "radius"]);
  assert.deepEqual(labels(await request("textDocument/completion", blank(2))), ["albedo"]);

  // after a key, the values that key accepts, and hover reads the same table
  const typed = doc.replace("@bakery {\n  \n}", "@bakery {\n  include: \n}");
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 11 }, contentChanges: [{ text: typed }] } });
  await new Promise((r) => setTimeout(r, 200));
  const values = { textDocument: { uri }, position: { line: 1, character: "  include: ".length } };
  assert.deepEqual(labels(await request("textDocument/completion", values)), ["all", "none"]);

  const hover = await request("textDocument/hover", { textDocument: { uri }, position: { line: 1, character: 4 } });
  assert.match(hover.contents.value, /@bakery include: all \| none/);

  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 12 }, contentChanges: [{ text }] } });
  await new Promise((r) => setTimeout(r, 200));
});

await check("an options bag completes and hovers the fields its slot declares", async () => {
  // `loftGeometry` is a three/addons class, and its second argument is an interface, not a class.
  // The comment on the first line holds an unclosed paren, which is what tells a value block open inside
  // an argument list from a node body — it must not be read as part of the header.
  const doc = `// an unclosed paren ( in a comment\nmesh #box {\n  geometry: loftGeometry([], {\n    \n  });\n  userData: {\n    \n  };\n  \n}\n`;
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 13 }, contentChanges: [{ text: doc }] } });
  await new Promise((r) => setTimeout(r, 200));

  const options = labels(await request("textDocument/completion", { textDocument: { uri }, position: { line: 3, character: 4 } }));
  assert.deepEqual(options, ["closed", "capStart", "capEnd"]);
  // userData is `any`: its keys are the user's own, so there is nothing to offer and nothing to check
  assert.deepEqual(labels(await request("textDocument/completion", { textDocument: { uri }, position: { line: 6, character: 4 } })), []);
  // …and the node's own body is still the node's body
  assert.ok(labels(await request("textDocument/completion", { textDocument: { uri }, position: { line: 8, character: 2 } })).includes("castShadow"));

  const typed = doc.replace("[], {\n    \n  }", "[], {\n    capStart: \n  }");
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 14 }, contentChanges: [{ text: typed }] } });
  await new Promise((r) => setTimeout(r, 200));
  const values = { textDocument: { uri }, position: { line: 3, character: "    capStart: ".length } };
  assert.deepEqual(labels(await request("textDocument/completion", values)), ["true", "false"]);

  const hover = await request("textDocument/hover", { textDocument: { uri }, position: { line: 3, character: 6 } });
  assert.match(hover.contents.value, /LoftGeometryOptions\.capStart\?: boolean/);

  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 15 }, contentChanges: [{ text }] } });
  await new Promise((r) => setTimeout(r, 200));
});

await check("@ completes at-rules, never three's names", async () => {
  const doc = `@\n\nmesh #box {\n  @\n  userData: {\n    \n  };\n}\n`;
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 16 }, contentChanges: [{ text: doc }] } });
  await new Promise((r) => setTimeout(r, 200));

  const sheet = await request("textDocument/completion", { textDocument: { uri }, position: { line: 0, character: 1 } });
  assert.deepEqual(labels(sheet).sort(), ["@bakery", "@broom", "@import", "@locale", "@override", "@template"]);
  assert.equal(sheet[0].textEdit.newText, sheet[0].label); // the typed `@` is replaced, not doubled
  assert.deepEqual(labels(await request("textDocument/completion", { textDocument: { uri }, position: { line: 3, character: 3 } })), ["@bakery", "@broom", "@entity", "@fields"]);
  // a record literal takes any key, so it takes neither three's names nor an at-rule
  assert.deepEqual(labels(await request("textDocument/completion", { textDocument: { uri }, position: { line: 5, character: 4 } })), []);

  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 17 }, contentChanges: [{ text }] } });
  await new Promise((r) => setTimeout(r, 200));
});

let version = 20;
/** swap the open document for `doc` and give the server a moment to settle */
const edit = async (doc: string, wait = 200) => {
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: version++ }, contentChanges: [{ text: doc }] } });
  await new Promise((r) => setTimeout(r, wait));
};

await check("a bare @import resolves, contributes and completes out of node_modules", async () => {
  const doc = `@import "kit/theme.tscene";\n\nmesh #box {\n  scale: vec3(var(--), 1, 1);\n}\n`;
  await edit(doc);
  const vars = await request("textDocument/completion", { textDocument: { uri }, position: posIn(doc, "var(--)", "var(--".length) });
  assert.deepEqual(labels(vars), ["--tint"], "the package's top-level variables are in scope");

  const spec = `@import "k`;
  await edit(`${spec}\n`);
  const packages = await request("textDocument/completion", { textDocument: { uri }, position: { line: 0, character: spec.length } });
  assert.deepEqual(labels(packages), ["kit"]);
  assert.equal(packages[0].textEdit.newText, "kit"); // the whole specifier is replaced, scope included

  await edit(`@import "kit/\n`);
  const inside = await request("textDocument/completion", { textDocument: { uri }, position: { line: 0, character: `@import "kit/`.length } });
  assert.deepEqual(labels(inside), ["theme.tscene"]); // package.json is not a sheet
  await edit(text);
});

await check("semantic tokens classify a document the parser cannot finish", async () => {
  // deliberately unterminated: highlighting is needed most while the sheet is being typed
  const doc = `// hi\nmesh.glow #box {\n  castShadow: true;\n  material: meshStandardMaterial { color: color(#ff8000); };\n  scale: vec3(var(--tint), 1, 1);\n`;
  await edit(doc);
  const legend = capabilities.semanticTokensProvider.legend.tokenTypes;
  const { data } = await request("textDocument/semanticTokens/full", { textDocument: { uri } });
  const decoded: { line: number; character: number; length: number; type: string }[] = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    character = data[i] ? data[i + 1] : character + data[i + 1];
    decoded.push({ line, character, length: data[i + 2], type: legend[data[i + 3]] });
  }
  const typeAt = (needle: string, delta = 0) => {
    const p = posIn(doc, needle, delta);
    return decoded.find((d) => d.line === p.line && d.character === p.character)?.type;
  };
  assert.equal(typeAt("// hi"), "comment");
  assert.equal(typeAt("mesh.glow"), "class");
  assert.equal(typeAt("glow"), "decorator");     // a template name, not a property path
  assert.equal(typeAt("#box"), "decorator");     // an id, even though `box` is not hex
  assert.equal(typeAt("castShadow"), "property");
  assert.equal(typeAt("color(#ff8000)"), "class");
  assert.equal(typeAt("#ff8000"), "number");     // …and here the hash is a literal
  assert.equal(typeAt("vec3"), "class");         // the alias resolves to Vector3
  assert.equal(typeAt("--tint"), "variable");
  assert.equal(typeAt("DoubleSide"), undefined, "the edited document has no DoubleSide left");
});

await check("a brush completes its faces, and a face body its own table", async () => {
  const doc = `brush #pillar {\n  face([0, 0, 0], [0, 0, 1], [1, 0, 0]) {\n    \n  }\n}\n\nmesh #box {\n  @broom {\n    \n  }\n}\n`;
  await edit(doc);

  // a face body is the brush's own table — no three property belongs in it, and no three class either
  const inFace = labels(await request("textDocument/completion", { textDocument: { uri }, position: { line: 2, character: 4 } }));
  assert.deepEqual(inFace.sort(), ["material", "offset", "rotation", "scale", "uv"]);

  const uv = doc.replace("    \n  }\n}", "    uv: \n  }\n}");
  await edit(uv);
  const modes = await request("textDocument/completion", { textDocument: { uri }, position: posIn(uv, "uv: ", "uv: ".length) });
  assert.deepEqual(labels(modes), ["paraxial", "parallel"]);

  await edit(doc);
  // `@broom` reads its own table, exactly as `@bakery` does
  assert.deepEqual(labels(await request("textDocument/completion", { textDocument: { uri }, position: { line: 8, character: 4 } })).sort(),
    ["at", "category", "color", "doc", "hidden", "icon", "kind", "layer", "link", "locked", "protect", "size"]);

  const hover = await request("textDocument/hover", { textDocument: { uri }, position: posIn(doc, "brush", 2) });
  assert.match(hover.contents.value, /convex solid/);
  await edit(text);
});

await check("folding ranges cover blocks and block comments", async () => {
  const doc = `/* two\n   lines */\nmesh #beef {\n  material: meshStandardMaterial {\n    color: color(#fff);\n  };\n}\n`;
  await edit(doc);
  const ranges = await request("textDocument/foldingRange", { textDocument: { uri } });
  assert.deepEqual(ranges.sort((a: any, b: any) => a.startLine - b.startLine), [
    { startLine: 0, endLine: 1, kind: "comment" },
    { startLine: 2, endLine: 5 }, // the closing brace's own line stays visible
    { startLine: 3, endLine: 4 },
  ]);

  const colors = await request("textDocument/documentColor", { textDocument: { uri } });
  assert.equal(colors.length, 1, "#beef is an id, not a colour");
  assert.deepEqual(colors[0].range, { start: posIn(doc, "#fff"), end: posIn(doc, "#fff", 4) });
  assert.deepEqual(colors[0].color, { red: 1, green: 1, blue: 1, alpha: 1 });

  const presented = await request("textDocument/colorPresentation", {
    textDocument: { uri }, color: { red: 1, green: 0.5, blue: 0, alpha: 1 }, range: colors[0].range,
  });
  assert.equal(presented[0].label, "#ff8000");
  assert.deepEqual(presented[0].textEdit.range, colors[0].range);
  await edit(text);
});

await check("a method completes, hovers and signature-helps inside the body it belongs to", async () => {
  const doc = `mesh #box {\n  lookAt(0, 1, 0);\n  \n}\n`;
  await edit(doc);

  const items = await request("textDocument/completion", { textDocument: { uri }, position: { line: 2, character: 2 } });
  const method = items.find((i: any) => i.label === "lookAt");
  assert.ok(method, `a bare method call is part of a body, so it belongs in its completions: ${labels(items).slice(0, 5)}`);
  assert.match(method.detail, /\(vector: Vector3\)/);
  assert.equal(method.insertText, "lookAt(");

  // every overload, the way a class hovers every constructor
  const hover = await request("textDocument/hover", { textDocument: { uri }, position: posIn(doc, "lookAt(0", 2) });
  assert.match(hover.contents.value, /Mesh\.lookAt\(vector: Vector3\)/);
  assert.match(hover.contents.value, /Mesh\.lookAt\(x: number, y: number, z: number\)/);

  const help = await request("textDocument/signatureHelp", { textDocument: { uri }, position: posIn(doc, "lookAt(0, ", "lookAt(0, ".length) });
  assert.match(help.signatures[0].label, /^Mesh\.lookAt\(x: number/, "the overload with a slot for the argument being typed");
  assert.equal(help.activeParameter, 1);
});

await check("a loader documents its own call, not the class it hands back", async () => {
  const doc = `mesh #box {\n  material: meshStandardMaterial { map: texture("/t.png"); };\n}\n`;
  await edit(doc);

  const hover = await request("textDocument/hover", { textDocument: { uri }, position: posIn(doc, "texture(", 2) });
  assert.match(hover.contents.value, /texture\(url: string\) → Texture/);
  assert.match(hover.contents.value, /loads an image/);
  // `Texture(mapping?, wrapS?, …)` is a call no sheet can write
  assert.doesNotMatch(hover.contents.value, /mapping/);

  const help = await request("textDocument/signatureHelp", { textDocument: { uri }, position: posIn(doc, `texture("`, `texture("`.length) });
  assert.match(help.signatures[0].label, /^texture\(url: string\) → Texture$/);
  assert.equal(help.activeParameter, 0);
});

await check("swatches cover named and numeric colours, written back in the form they replace", async () => {
  const doc = `mesh #box {\n  material: meshStandardMaterial {\n    color: color("red");\n    emissive: color(1, 0.5, 0);\n  };\n}\n`;
  await edit(doc);
  // both ways of writing one are constructors three declares, and the hover says so
  const hover = await request("textDocument/hover", { textDocument: { uri }, position: posIn(doc, `color("red")`, 2) });
  assert.match(hover.contents.value, /color\(color\?: /);
  assert.match(hover.contents.value, /color\(r: number, g: number, b: number\)/);

  const [named, numeric] = await request("textDocument/documentColor", { textDocument: { uri } });

  assert.deepEqual(named.range, { start: posIn(doc, `"red"`), end: posIn(doc, `"red"`, 5) });
  assert.deepEqual(named.color, { red: 1, green: 0, blue: 0, alpha: 1 });
  // three numbers are the working (linear) colour space; a picker speaks sRGB
  assert.deepEqual(numeric.range, { start: posIn(doc, "1, 0.5, 0"), end: posIn(doc, "1, 0.5, 0", "1, 0.5, 0".length) });
  assert.ok(Math.abs(numeric.color.green - 0.7354) < 1e-3, `linear 0.5 shows as sRGB 0.735, got ${numeric.color.green}`);

  const presentation = (color: object, range: object) => request("textDocument/colorPresentation", { textDocument: { uri }, color, range });
  const blue = await presentation({ red: 0, green: 0, blue: 1, alpha: 1 }, named.range);
  assert.deepEqual(blue.map((p: any) => p.label), [`"blue"`, `"#0000ff"`], "the quotes stay, and an exact name comes first");

  const orange = await presentation({ red: 1, green: 0.5, blue: 0, alpha: 1 }, numeric.range);
  assert.deepEqual(orange.map((p: any) => p.label), ["1, 0.214, 0"], "…and three numbers stay three numbers, converted back");
  await edit(text);
});

await check("formatting normalises the whole document", async () => {
  const messy = `Mesh#a{CastShadow:true;geometry:boxGeometry(1,1,1)}`;
  const scratch = path.join(dir, "messy.tscene");
  fs.writeFileSync(scratch, messy);
  const messyUri = pathToFileURL(scratch).href;
  send({ method: "textDocument/didOpen", params: { textDocument: { uri: messyUri, languageId: "scene", version: 1, text: messy } } });
  const edits = await request("textDocument/formatting", { textDocument: { uri: messyUri }, options: { tabSize: 2, insertSpaces: true } });
  assert.equal(edits[0].newText, `mesh #a {\n  castShadow: true;\n  geometry: boxGeometry(1, 1, 1);\n}\n`);
});

server.kill();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`${failures.length ? `${failures.length} failed` : "all lsp checks passed"}`);
process.exit(failures.length ? 1 : 0);
