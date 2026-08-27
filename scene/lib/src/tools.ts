// Node-side tooling entry: schema reflection + check/fix over files.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { applyFixes, expand, lineCol, parse, print, SceneSyntaxError, type Diagnostic, type Loader } from "./parse.ts";
import { check } from "./check.ts";
import { type Schema } from "./schema.ts";

export * from "./schema.ts";
export { check } from "./check.ts";

/**
 * `@import "./a.tscene"` is relative to the importing sheet; a bare specifier
 * (`@import "ui-kit/scenes/a.tscene"`) is resolved out of node_modules.
 */
export function resolveSheet(spec: string, from: string | undefined): string {
  const dir = from ? path.dirname(from) : process.cwd();
  if (spec.startsWith(".") || path.isAbsolute(spec)) return path.resolve(dir, spec);
  try {
    return createRequire(path.join(dir, "noop.js")).resolve(spec);
  } catch {
    // a package with an "exports" map refuses arbitrary subpaths — the file is still right there
    for (let at = dir; ; at = path.dirname(at)) {
      const candidate = path.join(at, "node_modules", spec);
      if (fs.existsSync(candidate)) return candidate;
      if (at === path.dirname(at)) throw new Error(`cannot resolve ${spec}`);
    }
  }
}

export const fsLoader: Loader = async (p, from) => {
  const file = resolveSheet(p, from);
  return { text: await fs.promises.readFile(file, "utf8"), file };
};

/** Parse + expand + type check one source. The parser recovers, so a typo still yields the rest. */
export async function checkSource(text: string, file: string, schema: Schema, load: Loader = fsLoader): Promise<Diagnostic[]> {
  const sheet = parse(text, file);
  const { nodes, diagnostics, templates, overrides } = await expand(sheet, load);
  return [...sheet.errors, ...diagnostics, ...check(nodes, schema, templates, overrides)];
}

/** Autofixer: identifier casing (from the checker) + canonical formatting. */
export async function fixSource(text: string, file: string, schema: Schema, load: Loader = fsLoader): Promise<string> {
  const sheet = parse(text, file);
  // re-printing a half-parsed sheet would silently delete whatever the parser skipped
  if (sheet.errors.length) throw new SceneSyntaxError(sheet.errors[0]!.message, sheet.errors[0]!);
  // the sheet already in hand, not checkSource(), which would parse the same text over again — and
  // `tscene fix` runs this across every file it matched before checking any of them
  const { nodes, diagnostics, templates, overrides } = await expand(sheet, load);
  const fixes = [...diagnostics, ...check(nodes, schema, templates, overrides)].filter((d) => d.fix && (d.file ?? file) === file);
  return print(parse(applyFixes(text, fixes), file));
}

export function formatDiagnostic(d: Diagnostic, sources: Map<string, string>): string {
  const file = d.file ?? "<input>";
  const text = sources.get(file) ?? "";
  const { line, col } = lineCol(text, d.start);
  return `${file}:${line}:${col}: ${d.severity}: ${d.message}`;
}

export { parse, print, expand };
