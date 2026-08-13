// Vite plugin: `import scene from './main.tscene'` gives a SceneModule, checked at build time.
import path from "node:path";
import { parse, type Member, type ObjectValue, type Statement, type Value } from "./parse.ts";
import { BUILTINS, className, LOADERS } from "./names.ts";
import { checkSource, formatDiagnostic, loadSchema, resolveSheet } from "./tools.ts";
import type { Schema, SchemaOptions } from "./schema.ts";

export type PluginOptions = Pick<SchemaOptions, "entry" | "modules" | "cache" | "declare"> & { check?: boolean; hmr?: boolean };

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
    // a @template body is expanded into whichever node applies it, so its names count too
    if (s.kind === "template") s.body.forEach(member);
    else if (s.kind !== "import") member(s);
  }
  return out;
}

let exports: Promise<Set<string>> | undefined;
/** three's real exports — the truth an emitted `import { X }` has to survive. */
function threeExports(): Promise<Set<string>> {
  return (exports ??= import("three/webgpu").then(
    (m) => new Set(Object.keys(m).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))),
    (e: Error) => {
      console.warn(`tscene: cannot read three's exports (${e.message}) — sheets will need an explicit \`registry\``);
      return new Set<string>();
    },
  ));
}

const ABSOLUTE = /^(\w+:|\/|data:)/;

/**
 * Every url a `texture()` or `gltf()` in this sheet could be handed, so vite can resolve and hash the
 * file instead of the runtime guessing a url at load time. Variables are followed: `--wall: "./w.png"`
 * with `texture(var(--wall))` has to bundle `w.png` too, and a var declared in several scopes
 * contributes all of its values — a spare import costs a hash, a missing one costs the texture.
 * ponytail: this sheet's own variables only. A var an `@import`ed sheet declares stays runtime-resolved,
 * which works when the asset is already a url; expand() the imports here if that stops being enough.
 */
function assetUrls(statements: Statement[]): string[] {
  const vars = new Map<string, string[]>();
  const urls: string[] = [];

  const value = (v: Value, visit: (o: ObjectValue) => void): void => {
    switch (v.kind) {
      case "object": visit(v); v.args.forEach((a) => value(a, visit)); return v.body.forEach((m) => member(m, visit));
      case "array": return v.items.forEach((i) => value(i, visit));
      case "record": return v.entries.forEach((e) => value(e.value, visit));
      case "calc": value(v.left, visit); return value(v.right, visit);
      case "var": return void (v.fallback && value(v.fallback, visit));
    }
  };
  const member = (m: Member, visit: (o: ObjectValue) => void): void => {
    if (m.kind === "node") return value(m.object, visit);
    if (m.kind === "var" && m.value.kind === "string") vars.set(m.name, [...(vars.get(m.name) ?? []), m.value.value]);
    value(m.value, visit);
  };
  const sheet = (visit: (o: ObjectValue) => void) => {
    for (const s of statements) {
      if (s.kind === "import") continue;
      if (s.kind === "template") s.body.forEach((m) => member(m, visit));
      else member(s, visit);
    }
  };

  sheet(() => {}); // the declaration may come after the use, so the variables are collected first
  sheet((o) => {
    if (!LOADERS[o.name]) return;
    for (const a of o.args) {
      if (a.kind === "string") urls.push(a.value);
      else if (a.kind === "var") urls.push(...(vars.get(a.name) ?? []));
    }
  });
  return urls;
}

export default function threeScene(options: PluginOptions = {}) {
  let schema: Schema | undefined;
  let serve = false;
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
      const lines = [`import { __sceneRegister, __sceneChanged } from "tscene";`];

      // the sheet's slice of three, named so the bundler can keep exactly it
      const known = await threeExports();
      const registry = [...threeNames(sheet.statements)].filter((name) => known.has(name)).sort();
      if (registry.length) lines.push(`import { ${registry.join(", ")} } from "three/webgpu";`);

      const imports: Record<string, string> = {};
      for (const s of sheet.statements) {
        if (s.kind !== "import" || imports[s.path]) continue;
        const bare = !s.path.startsWith(".") && !path.isAbsolute(s.path);
        const dep = posix(resolveSheet(s.path, file));
        imports[s.path] = dep;
        // registers the dep and gives vite the edge; a bare specifier stays bare so vite resolves it
        lines.push(`import ${JSON.stringify(bare ? s.path : relative(file, dep))};`);
      }

      // let vite resolve/hash the assets instead of guessing urls at runtime
      const assets = new Map<string, string>();
      for (const url of assetUrls(sheet.statements)) {
        if (ABSOLUTE.test(url) || assets.has(url)) continue;
        const name = `__asset${assets.size}`;
        lines.push(`import ${name} from ${JSON.stringify(`${url.startsWith(".") ? url : `./${url}`}?url`)};`);
        assets.set(url, name);
      }

      const hot = serve && options.hmr !== false;
      lines.push(
        `const mod = __sceneRegister({ source: ${JSON.stringify(code)}, file: ${JSON.stringify(file)},`,
        `  imports: ${JSON.stringify(imports)}, assets: { ${[...assets].map(([url, name]) => `${JSON.stringify(url)}: ${name}`).join(", ")} },`,
        `  registry: { ${registry.join(", ")} } });`,
        `export default mod;`,
      );
      // an edited sheet re-runs this module, re-registers itself, and pokes every listener
      if (hot) lines.push(`if (import.meta.hot) import.meta.hot.accept((m) => m && __sceneChanged(m.default));`);
      return { code: lines.join("\n"), map: null };
    },
  };
}
