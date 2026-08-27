// Vite plugin: `import scene from './main.tscene'` gives a SceneModule, checked at build time.
import path from "node:path";
import { lineCol, parse, type Member, type ObjectValue, type Statement, type Value } from "./parse.ts";
import { BUILTINS, className, LOADERS } from "./names.ts";
import { checkSource, formatDiagnostic, fsLoader, loadSchema, resolveSheet } from "./tools.ts";
import type { Schema, SchemaOptions } from "./schema.ts";

export type PluginOptions = Pick<SchemaOptions, "entry" | "modules" | "addons" | "cache" | "declare"> & { check?: boolean; hmr?: boolean };

// vite ids are always forward-slash, and the sheet registry is keyed by id — a win32
// backslash path from path.resolve() would never match the module that registered itself
const posix = (p: string) => p.split(path.sep).join("/");

const relative = (from: string, to: string) => {
  const r = posix(path.relative(path.dirname(from), to));
  return r.startsWith(".") ? r : `./${r}`;
};

// ---------------------------------------------------------------- three registry
//
// The runtime used to look classes up as three[name], which forces every bundler to keep the whole
// namespace — about a megabyte of three nobody asked for. Instead the plugin reads the names out of
// the sheet and emits a plain named import for each, so the bundler sees `Mesh` and `BoxGeometry`
// and drops the rest.

const LITERALS = new Set(["true", "false", "null"]);

/** Every three export the sheet mentions: node names, value calls (`vec3`, `color`) and bare constants. */
function threeNames(statements: Statement[]): Set<string> {
  const out = new Set<string>();
  const value = (v: Value): void => {
    switch (v.kind) {
      case "object": return object(v);
      case "ident": if (!LITERALS.has(v.name)) out.add(className(v.name)); return;
      case "array": return v.items.forEach(value);
      case "record": return v.entries.forEach((e) => value(e.value));
      case "calc": value(v.left); return value(v.right);
      case "var": if (v.fallback) value(v.fallback); return;
      // the language's own forms: nothing here is a three name, but their operands are
      case "fn": return v.args.forEach(value);
      case "each": value(v.over); return value(v.body);
      case "read": return value(v.target);
      case "index": value(v.target); return value(v.at);
      case "call": value(v.target); return v.args.forEach(value);
    }
  };
  // a builtin is the language's own, never a class — but its body still names plenty of three
  const object = (o: ObjectValue): void => {
    if (!BUILTINS[o.name]) out.add(className(o.name));
    o.args.forEach(value);
    o.body.forEach(member);
  };
  const member = (m: Member): void => (m.kind === "node" ? object(m.object) : value(m.value));
  for (const s of statements) {
    // a @template or @override body is expanded into whichever node it lands on, so its names count too
    if (s.kind === "template" || s.kind === "override") s.body.forEach(member);
    else if (s.kind !== "import") member(s);
  }
  return out;
}

const exports = new Map<string, Promise<Set<string>>>();
/** a module's real exports — the truth an emitted `import { X }` has to survive. */
function moduleExports(spec: string): Promise<Set<string>> {
  let found = exports.get(spec);
  if (!found) {
    exports.set(spec, (found = import(/* @vite-ignore */ spec).then(
      (m: object) => new Set(Object.keys(m).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))),
      (e: Error) => {
        console.warn(`tscene: cannot read the exports of ${spec} (${e.message}) — sheets will need an explicit \`registry\``);
        return new Set<string>();
      },
    )));
  }
  return found;
}

/**
 * Where each name the sheet mentions has to be imported from: the entry for three's own exports, and its
 * own deep module for everything else — importing `three/addons` for one class would pin all 270 of them.
 * The schema is what knows that mapping, so a sheet naming an addon needs it even with `check: false`.
 */
async function byModule(names: string[], entry: string, sources: () => Record<string, string>): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const known = await moduleExports(entry);
  // asked for lazily: a sheet that only names three's own classes must not pay for reflecting the typings
  const foreign = names.some((name) => !known.has(name)) ? sources() : {};
  for (const name of [...names].sort()) {
    // a module the user added wins over the entry, exactly as the reflection order does
    const spec = foreign[name] ?? (known.has(name) ? entry : undefined);
    if (spec === undefined) continue; // not three's — a registry class, or a typo the checker already has
    // a `modules` entry written as a path is relative to the config, and the import would be relative to
    // the sheet. Those keep the old deal: name them in `registry` and the runtime finds them.
    if (spec.startsWith(".") || path.isAbsolute(spec)) continue;
    (out.get(spec) ?? out.set(spec, []).get(spec)!).push(name);
  }
  return out;
}

const ABSOLUTE = /^(\w+:|\/|data:)/;

/** A url and the sheet the string was written in — which is what a relative url is relative to. */
type Declared = { url: string; from: string };
/** {@link Declared} plus the offset, in *this* sheet, of the loader argument that wants it. */
type Asset = Declared & { start: number };

/** Every value in a sheet, each object handed to `visit`, collecting `--name: "string"` on the way. */
function walkSheet(statements: Statement[], visit: (o: ObjectValue) => void, vars?: Map<string, string[]>): void {
  const value = (v: Value): void => {
    switch (v.kind) {
      case "object": visit(v); v.args.forEach(value); return v.body.forEach(member);
      case "array": return v.items.forEach(value);
      case "record": return v.entries.forEach((e) => value(e.value));
      case "calc": value(v.left); return value(v.right);
      case "var": return void (v.fallback && value(v.fallback));
      case "fn": return v.args.forEach(value);
      case "each": value(v.over); return value(v.body);
      case "read": return value(v.target);
      case "index": value(v.target); return value(v.at);
      case "call": value(v.target); return v.args.forEach(value);
    }
  };
  const member = (m: Member): void => {
    if (m.kind === "node") return value(m.object);
    if (vars && m.kind === "var" && m.value.kind === "string") vars.set(m.name, [...(vars.get(m.name) ?? []), m.value.value]);
    value(m.value);
  };
  for (const s of statements) {
    if (s.kind === "import") continue;
    if (s.kind === "template" || s.kind === "override") s.body.forEach(member);
    else member(s);
  }
}

/** Every `--name: "…"` a sheet declares, at any depth. A name declared in several scopes keeps all of them. */
function stringVars(statements: Statement[]): Map<string, string[]> {
  const vars = new Map<string, string[]>();
  walkSheet(statements, () => {}, vars);
  return vars;
}

/**
 * The same, for the sheets this one `@import`s, transitively — each url with the file that declared it.
 * `texture(var(--wall))` here and `--wall: "./w.png"` in an imported theme is the case that needs it:
 * the url used to stay runtime-resolved, so vite never hashed the file and a production build 404'd.
 */
async function importedVars(statements: Statement[], file: string): Promise<Map<string, Declared[]>> {
  const out = new Map<string, Declared[]>();
  const seen = new Set([file]);
  const walk = async (stmts: Statement[], from: string): Promise<void> => {
    for (const s of stmts) {
      if (s.kind !== "import") continue;
      let dep: { text: string; file: string };
      try {
        dep = await fsLoader(s.path, from);
      } catch {
        continue; // an unreadable import is the checker's to report; the bundle keeps the runtime url
      }
      if (seen.has(dep.file)) continue;
      seen.add(dep.file);
      const sheet = parse(dep.text, dep.file);
      for (const [name, urls] of stringVars(sheet.statements)) {
        out.set(name, [...(out.get(name) ?? []), ...urls.map((url) => ({ url, from: dep.file }))]);
      }
      await walk(sheet.statements, dep.file);
    }
  };
  await walk(statements, file);
  return out;
}

/**
 * Every url a `texture()` or `gltf()` in this sheet could be handed, so vite can resolve and hash the
 * file instead of the runtime guessing a url at load time. Variables are followed — this sheet's own
 * first, then the ones its imports declare — and a var declared in several scopes contributes all of
 * its values: a spare import costs a hash, a missing one costs the texture.
 */
function assetUrls(statements: Statement[], file: string, inherited: Map<string, Declared[]>): Asset[] {
  // the declaration may come after the use, so the variables are collected in a pass of their own first
  const vars = stringVars(statements);
  const urls: Asset[] = [];
  walkSheet(statements, (o) => {
    if (!LOADERS[o.name]) return;
    for (const a of o.args) {
      if (a.kind === "string") urls.push({ url: a.value, from: file, start: a.start });
      else if (a.kind === "var") {
        // this sheet's own declaration wins over an imported one, the same order the runtime resolves in
        const own = vars.get(a.name);
        const found = own ? own.map((url) => ({ url, from: file })) : (inherited.get(a.name) ?? []);
        urls.push(...found.map((d) => ({ ...d, start: a.start })));
      }
    }
  });
  return urls;
}

// ---------------------------------------------------------------- source map
//
// Most of the generated module is not a transform of the sheet's syntax: `__sceneRegister` is handed the
// source as a string, and the runtime reports its own failures with real sheet positions already. Two
// kinds of line *are* transforms, and they are exactly the two that fail in the bundler rather than at
// runtime — the `import` an `@import` becomes and the `import … ?url` a `texture()` becomes. Mapping
// those turns "cannot resolve ./w.png" into the line of the sheet that asked for it. Every other line
// stays unmapped, which is the truth, and is why `map: null` is still wrong: null makes vite treat the
// generated module as its own source and point a stack frame at whatever sheet line shares the number.
//
// The encoder is inline rather than a dependency: base64 VLQ is frozen by the source map v3 spec, this
// only ever emits one segment per line, and the alternative is shipping a package to every consumer of
// tscene for a plugin most of them never load.

/** A zero-based position in the sheet — what a source map segment points at. */
type Mark = { line: number; column: number };

const mark = (text: string, offset: number): Mark => {
  const { line, col } = lineCol(text, offset);
  return { line: line - 1, column: col - 1 };
};

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(value: number): string {
  let bits = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    const digit = bits & 31;
    bits >>>= 5;
    out += BASE64[bits > 0 ? digit | 32 : digit];
  } while (bits > 0);
  return out;
}

/** One segment per mapped generated line, always at column 0 of source 0. Unmapped lines stay empty. */
function mappings(marks: (Mark | undefined)[]): string {
  let line = 0;
  let column = 0;
  return marks
    .map((at) => {
      if (!at) return "";
      const segment = vlq(0) + vlq(0) + vlq(at.line - line) + vlq(at.column - column);
      ({ line, column } = at);
      return segment;
    })
    .join(";");
}

export default function threeScene(options: PluginOptions = {}) {
  let schema: Schema | undefined;
  let failed = false;
  let serve = false;
  /** the name → module map, reflected on demand: `check: false` still needs it to place an addon */
  const sources = (): Record<string, string> => {
    if (!schema && !failed) {
      try {
        schema = loadSchema(options);
      } catch (e) {
        failed = true;
        console.warn(`tscene: cannot reflect three's typings (${(e as Error).message}) — a sheet naming an addon will need an explicit \`registry\``);
      }
    }
    return schema?.sources ?? {};
  };
  return {
    name: "tscene",
    configResolved(config: { command: string }) {
      serve = config.command === "serve";
    },
    async transform(code: string, id: string) {
      const file = id.split("?")[0]!;
      if (!file.endsWith(".tscene")) return null;

      if (options.check !== false) {
        schema ??= loadSchema(options);
        const diagnostics = await checkSource(code, file, schema);
        if (diagnostics.some((d) => d.severity === "error")) {
          const sources = new Map([[file, code]]);
          throw new Error(diagnostics.map((d) => formatDiagnostic(d, sources)).join("\n"));
        }
      }

      // one module per sheet: positions, relative asset paths and per-file HMR all stay honest
      const sheet = parse(code, file);
      const lines: string[] = [];
      const marks: (Mark | undefined)[] = [];
      /** one generated line, with the sheet offset it is a transform of when it is one */
      const emit = (text: string, at?: number) => {
        lines.push(text);
        marks.push(at === undefined ? undefined : mark(code, at));
      };
      emit(`import { __sceneRegister, __sceneChanged } from "tscene";`);

      // the sheet's slice of three, named so the bundler can keep exactly it
      const modules = await byModule([...threeNames(sheet.statements)], options.entry ?? "three/webgpu", sources);
      const registry = [...modules.values()].flat();
      for (const [spec, names] of modules) emit(`import { ${names.join(", ")} } from ${JSON.stringify(spec)};`);

      const imports: Record<string, string> = {};
      for (const s of sheet.statements) {
        if (s.kind !== "import" || imports[s.path]) continue;
        const bare = !s.path.startsWith(".") && !path.isAbsolute(s.path);
        const dep = posix(resolveSheet(s.path, file));
        imports[s.path] = dep;
        // registers the dep and gives vite the edge; a bare specifier stays bare so vite resolves it
        emit(`import ${JSON.stringify(bare ? s.path : relative(file, dep))};`, s.start);
      }

      // let vite resolve/hash the assets instead of guessing urls at runtime
      const assets = new Map<string, string>();
      const inherited: Map<string, Declared[]> = Object.keys(imports).length
        ? await importedVars(sheet.statements, file)
        : new Map();
      for (const { url, from, start } of assetUrls(sheet.statements, file, inherited)) {
        // the runtime looks an asset up by the raw string, so two sheets declaring the same relative url
        // cannot both be kept — the first the sheet reaches wins, which is its own declaration if it has one
        if (ABSOLUTE.test(url) || assets.has(url)) continue;
        // relative to the sheet that declared the string, but written relative to this one: the import
        // lands in *this* sheet's generated module, and vite resolves it against that
        const spec =
          from === file ? (url.startsWith(".") ? url : `./${url}`) : relative(file, path.resolve(path.dirname(from), url));
        const name = `__asset${assets.size}`;
        emit(`import ${name} from ${JSON.stringify(`${spec}?url`)};`, start);
        assets.set(url, name);
      }

      const hot = serve && options.hmr !== false;
      emit(`const mod = __sceneRegister({ source: ${JSON.stringify(code)}, file: ${JSON.stringify(file)},`);
      emit(`  imports: ${JSON.stringify(imports)}, assets: { ${[...assets].map(([url, name]) => `${JSON.stringify(url)}: ${name}`).join(", ")} },`);
      emit(`  registry: { ${registry.join(", ")} } });`);
      emit(`export default mod;`);
      // an edited sheet re-runs this module, re-registers itself, and pokes every listener
      if (hot) emit(`if (import.meta.hot) import.meta.hot.accept((m) => m && __sceneChanged(m.default));`);
      return {
        code: lines.join("\n"),
        map: { version: 3, file, sources: [file], sourcesContent: [code], names: [], mappings: mappings(marks) },
      };
    },
  };
}
