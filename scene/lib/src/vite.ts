// Vite plugin: `import scene from './main.tscene'` gives a SceneModule, checked at build time.
import path from "node:path";
import { parse } from "./parse.ts";
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

const ABSOLUTE = /^(\w+:|\/|data:)/;
// a loader is also usable as a node, so the call may carry a selector: gltf.hero#robot("./r.glb")
const ASSET_CALL = /\b(?:texture|gltf)(?:\s*[.#][A-Za-z_][\w-]*)*\s*\(\s*("[^"]*"|'[^']*')/g;

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
      const lines = [`import { __sceneRegister, __sceneChanged } from "tscene";`];
      const imports: Record<string, string> = {};
      for (const s of parse(code, file).statements) {
        if (s.kind !== "import" || imports[s.path]) continue;
        const bare = !s.path.startsWith(".") && !path.isAbsolute(s.path);
        const dep = posix(resolveSheet(s.path, file));
        imports[s.path] = dep;
        // registers the dep and gives vite the edge; a bare specifier stays bare so vite resolves it
        lines.push(`import ${JSON.stringify(bare ? s.path : relative(file, dep))};`);
      }

      // let vite resolve/hash the assets instead of guessing urls at runtime
      const assets = new Map<string, string>();
      for (const [, quoted] of code.matchAll(ASSET_CALL)) {
        const url = quoted!.slice(1, -1);
        if (ABSOLUTE.test(url) || assets.has(url)) continue;
        const name = `__asset${assets.size}`;
        lines.push(`import ${name} from ${JSON.stringify(`${url.startsWith(".") ? url : `./${url}`}?url`)};`);
        assets.set(url, name);
      }

      const hot = serve && options.hmr !== false;
      lines.push(
        `const mod = __sceneRegister({ source: ${JSON.stringify(code)}, file: ${JSON.stringify(file)},`,
        `  imports: ${JSON.stringify(imports)}, assets: { ${[...assets].map(([url, name]) => `${JSON.stringify(url)}: ${name}`).join(", ")} } });`,
        `export default mod;`,
      );
      // an edited sheet re-runs this module, re-registers itself, and pokes every listener
      if (hot) lines.push(`if (import.meta.hot) import.meta.hot.accept((m) => m && __sceneChanged(m.default));`);
      return { code: lines.join("\n"), map: null };
    },
  };
}
