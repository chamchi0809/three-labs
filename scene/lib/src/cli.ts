#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import fs from "node:fs";
import path from "node:path";
import { checkSource, fixSource, formatDiagnostic, loadSchema } from "./tools.ts";
import { lineCol } from "./parse.ts";

const argv = process.argv.slice(2);
const cmd = argv[0] === "check" || argv[0] === "fix" ? argv.shift()! : "check";

const VALUED = new Set(["entry", "module", "format", "declare"]);
const values: Record<string, string[]> = {};
const flags = new Set<string>();
const globs: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (!a.startsWith("--")) globs.push(a);
  else if (VALUED.has(a.slice(2))) (values[a.slice(2)] ??= []).push(argv[++i] ?? "");
  else flags.add(a.slice(2));
}
const opt = (name: string) => values[name]?.at(-1);

if (flags.has("help")) {
  console.log(`three-scene check|fix [globs…]

  --fix            rewrite files (same as the fix command)
  --entry <mod>    three entry point to reflect (default three/webgpu)
  --module <mod>   extra module whose exports become usable nodes (repeatable)
  --declare <name> node name the host registers at runtime, accepted unchecked (repeatable)
  --watch          re-check whenever a .tscene file changes
  --format <fmt>   text (default) or json
  --no-cache       ignore the cached schema`);
  process.exit(0);
}

function match(arg: string): string[] {
  if (fs.existsSync(arg)) {
    const stat = fs.statSync(arg);
    if (stat.isFile()) return [arg];
    if (stat.isDirectory()) arg = path.join(arg, "**/*.tscene");
  }
  return fs.globSync(arg, { exclude: (p) => p.includes("node_modules") }).filter((f) => f.endsWith(".tscene"));
}

const patterns = globs.length ? globs : ["**/*.tscene"];
const schema = loadSchema({
  entry: opt("entry"),
  modules: values["module"],
  declare: values["declare"],
  cache: !flags.has("no-cache"),
});
const write = cmd === "fix" || flags.has("fix");
const json = opt("format") === "json";

async function run(): Promise<number> {
  const files = [...new Set(patterns.flatMap(match))].map((f) => path.resolve(f));
  if (!files.length) {
    console.error("no .tscene files matched");
    return 1;
  }
  const sources = new Map<string, string>();
  const found: unknown[] = [];
  // a sheet imported by three others would otherwise report its problems three times
  const reported = new Set<string>();
  let errors = 0;

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    sources.set(file, text);
    if (write) {
      try {
        const fixed = await fixSource(text, file, schema);
        if (fixed !== text) {
          fs.writeFileSync(file, fixed);
          sources.set(file, fixed);
          if (!json) console.log(`fixed ${path.relative(process.cwd(), file)}`);
        }
      } catch (e) {
        console.error(`${file}: cannot fix: ${(e as Error).message}`);
      }
    }
    for (const d of await checkSource(sources.get(file)!, file, schema)) {
      const at = d.file ?? file;
      if (reported.has(`${at}:${d.start}:${d.end}:${d.message}`)) continue;
      reported.add(`${at}:${d.start}:${d.end}:${d.message}`);
      if (!sources.has(at)) sources.set(at, fs.readFileSync(at, "utf8"));
      if (json) found.push({ ...d, file: at, ...lineCol(sources.get(at)!, d.start) });
      else console.error(formatDiagnostic(d, sources));
      if (d.severity === "error") errors++;
    }
  }

  if (json) console.log(JSON.stringify(found, null, 2));
  else console.log(`${files.length} file(s), ${errors} error(s)`);
  return errors ? 1 : 0;
}

const status = await run();

if (!flags.has("watch")) process.exit(status);

// ponytail: one recursive watch on cwd re-checks everything; per-file watching would miss new @imports
let pending: NodeJS.Timeout | undefined;
fs.watch(process.cwd(), { recursive: true }, (_event, name) => {
  if (!name?.endsWith(".tscene")) return;
  clearTimeout(pending);
  pending = setTimeout(() => void run(), 50);
});
console.log("watching for changes…");
