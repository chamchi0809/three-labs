// Keeps the docs from drifting away from the implementation:
//   1. every example in README.md / docs/*.md is compiled by the real parser + checker
//   2. every builtin, alias and loader the implementation knows must be documented
//   3. docs/api is regenerated with typedoc and must match what is committed
// node --experimental-strip-types src/docs.check.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALIASES, BUILTINS, LOADERS, MATH } from "./names.ts";
import { checkSource, loadSchema } from "./tools.ts";
import type { Loader } from "./parse.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const failures: string[] = [];
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${name}`))
    .catch((e: Error) => {
      failures.push(name);
      console.error(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`);
    });

// ---------------------------------------------------------------- examples

/** ```css / ```scene blocks are scene source; `error` marks one that is supposed to fail, `error: text` pins the message */
type Example = { file: string; line: number; flags: string; source: string };
function examples(file: string): Example[] {
  const text = read(file);
  const out: Example[] = [];
  for (const m of text.matchAll(/^```(css|scene)([^\n]*)\n([\s\S]*?)^```/gm)) {
    out.push({ file, line: text.slice(0, m.index).split("\n").length, flags: m[2]!.trim(), source: m[3]! });
  }
  return out;
}

// docs are read as standalone sheets: an @import brings in nothing, so every example is self-contained
const noImports: Loader = async (spec, from) => ({ text: "", file: path.resolve(path.dirname(from ?? "."), spec) });

const schema = loadSchema();
const docs = ["README.md", "docs/language.md", "docs/bakery.md"];

for (const doc of docs) {
  for (const example of examples(doc)) {
    const where = `${example.file}:${example.line}`;
    await check(`${where} compiles`, async () => {
      const diagnostics = await checkSource(example.source, `${where}.tscene`, schema, noImports);
      const errors = diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
      const expected = /^error\b/.test(example.flags) ? example.flags.replace(/^error:?\s*/, "") : undefined;
      if (expected === undefined) return assert.deepEqual(errors, [], `example should compile clean`);
      assert.ok(errors.length, "example is marked `error` but compiles clean");
      if (expected) assert.ok(errors.some((e) => e.includes(expected)), `expected an error containing ${JSON.stringify(expected)}, got ${errors.join(" / ")}`);
    });
  }
}

// ---------------------------------------------------------------- coverage

/** how a name is actually written, so the reference is searched for the real thing: `brush {`, not `brush(` */
const written = (name: string) => (BUILTINS[name]?.signature.startsWith(`${name} {`) ? `${name} {` : `${name}(`);

await check("the language reference covers every builtin, alias and loader", () => {
  const text = read("docs/language.md");
  const missing = [...Object.keys(BUILTINS), ...Object.keys(ALIASES), ...Object.keys(LOADERS)].filter((name) => !text.includes(written(name)));
  assert.deepEqual(missing, [], `undocumented in docs/language.md: ${missing.join(", ")}`);
});

await check("the language reference covers every calc() function", () => {
  const text = read("docs/language.md");
  // `pi` takes no parens, so the table is what has to name it
  const missing = Object.keys(MATH).filter((name) => !new RegExp(`\\b${name}\\b`).test(text));
  assert.deepEqual(missing, [], `undocumented in docs/language.md: ${missing.join(", ")}`);
});

await check("every doc links to a file that exists", () => {
  for (const doc of [...docs, "docs/api/index.md"]) {
    for (const m of read(doc).matchAll(/]\((\.[^)#]*)(#[^)]*)?\)/g)) {
      const target = path.resolve(path.dirname(path.join(root, doc)), m[1]!);
      assert.ok(fs.existsSync(target), `${doc} links to ${m[1]}, which does not exist`);
    }
  }
});

// ---------------------------------------------------------------- generated api

await check("docs/api is what typedoc generates from the current source", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "tscene-api-"));
  const { Application } = await import("typedoc");
  // `options: root` so the package's typedoc.json is found no matter where this is run from
  const app = await Application.bootstrapWithPlugins({ options: root, out });
  const project = await app.convert();
  assert.ok(project, "typedoc could not convert the sources");
  await app.generateOutputs(project);

  const committed = path.join(root, "docs/api");
  // a subpath entry point (bakery/node) lands in a subdirectory, so this has to walk
  const tree = (dir: string) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
  assert.deepEqual(tree(out), tree(committed));
  for (const file of tree(out)) {
    if (fs.statSync(path.join(out, file)).isDirectory()) continue;
    assert.equal(
      fs.readFileSync(path.join(out, file), "utf8"),
      fs.readFileSync(path.join(committed, file), "utf8"),
      `docs/api/${file} is stale — run \`pnpm --filter tscene docs\``,
    );
  }
  fs.rmSync(out, { recursive: true, force: true });
});

console.log(failures.length ? `${failures.length} failed` : "all doc checks passed");
process.exit(failures.length ? 1 : 0);
