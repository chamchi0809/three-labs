// Tokenises a sample .tscene file with the real TextMate engine and asserts the scopes.
// node grammar.check.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url); // both packages are CommonJS
const oniguruma = require("vscode-oniguruma");
const textmate = require("vscode-textmate");

const here = path.dirname(fileURLToPath(import.meta.url));
const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

const registry = new textmate.Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
    createOnigString: (s) => new oniguruma.OnigString(s),
  }),
  loadGrammar: async () =>
    textmate.parseRawGrammar(fs.readFileSync(path.join(here, "syntaxes/scene.tmLanguage.json"), "utf8"), "scene.tmLanguage.json"),
});
const grammar = await registry.loadGrammar("source.scene");

const source = `// a comment
@import "./shared.tscene";
@template mesh.glow {
  castShadow: true;
}
--height: 2deg;
mesh.glow #box {
  geometry: boxGeometry(1, 1, 1);
  position: vec3(0, var(--height), 0);
  material: meshStandardMaterial { side: DoubleSide; color: #ff8800; name: "hi"; };
  renderOrder: calc(var(--height) * 2);
  material.opacity: 0.5;
  customDepthMaterial: ref(#box);
  userData: { tags: ["a"]; hp: 3 };
}
gltf #hero("/hero.glb") {
  repeat(3) {
    find#head(mesh, "Head") { castShadow: true; }
  }
  play("Idle") { timeScale: 0.5; }
}
`;

// Tokenise every line, then look up the scope stack at the first offset of a given substring.
const lines = source.split("\n");
let rules = textmate.INITIAL;
const tokens = lines.map((line) => {
  const result = grammar.tokenizeLine(line, rules);
  rules = result.ruleStack;
  return result.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
});

const scopesOf = (needle, only) => {
  for (const [i, line] of tokens.entries()) {
    if (only !== undefined && i !== only) continue;
    const token = line.find((t) => t.text === needle);
    if (token) return token.scopes;
  }
  throw new Error(`no token exactly matching ${JSON.stringify(needle)}${only === undefined ? "" : ` on line ${only}`}`);
};

const failures = [];
const has = (needle, scope, line) => {
  try {
    const scopes = scopesOf(needle, line);
    assert.ok(scopes.some((s) => s.startsWith(scope)), `${needle}: expected ${scope}, got ${scopes.join(" ")}`);
    console.log(`ok   ${needle} → ${scope}`);
  } catch (e) {
    failures.push(needle);
    console.error(`FAIL ${e.message}`);
  }
};

has("// a comment", "comment.line");
has("@import", "keyword.control.import");
has('"./shared.tscene"', "string.quoted");
has("@template", "keyword.control.template");
has(".glow", "entity.name.type.template", 2); // the declaration
has("mesh", "entity.name.tag", 2); // ...and the node type it applies to
has("--height", "variable.other.custom-property");
has("2deg", "constant.numeric");
has("mesh", "entity.name.tag", 6);
has(".glow", "entity.other.attribute-name.class", 6); // the use site
has("#box", "entity.other.attribute-name.id");
has("geometry", "support.type.property-name");
has("boxGeometry", "entity.name.function");
has("var", "support.function.var");
has("DoubleSide", "support.constant.three");
has("#ff8800", "constant.other.color");
has("hi", "string.quoted.double"); // begin/end rule, so the quotes are separate tokens
has("true", "constant.language.boolean");
has("calc", "support.function.calc");
has("*", "keyword.operator.arithmetic");
has("[", "punctuation.section.brackets");
has("material.opacity", "support.type.property-name"); // dotted paths are one property
has("ref", "support.function.ref");
has("#box", "entity.other.attribute-name.id", 12); // the ref target, not a hex colour
for (const builtin of ["repeat", "find", "play"]) has(builtin, "support.function.builtin");
has("#head", "entity.other.attribute-name.id", 17); // the alias find() binds

// every path the manifest contributes must exist, and extension.js must at least parse
const manifest = require("./package.json");
for (const file of [
  manifest.main,
  ...manifest.contributes.languages.flatMap((l) => [l.configuration, l.icon.light]),
  ...manifest.contributes.grammars.map((g) => g.path),
  ...manifest.contributes.snippets.map((s) => s.path),
]) {
  try {
    assert.ok(fs.existsSync(path.join(here, file)), `contributed file ${file} does not exist`);
    console.log(`ok   ${file} exists`);
  } catch (e) {
    failures.push(file);
    console.error(`FAIL ${e.message}`);
  }
}
try {
  new (await import("node:vm")).Script(fs.readFileSync(path.join(here, "extension.js"), "utf8"));
  console.log("ok   extension.js parses");
} catch (e) {
  failures.push("extension.js");
  console.error(`FAIL extension.js: ${e.message}`);
}

console.log(failures.length ? `${failures.length} failed` : "all grammar checks passed");
process.exit(failures.length ? 1 : 0);
