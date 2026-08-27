// Reflects the *installed* three typings into a JSON schema the checker can use.
// Node-only: pulls in the TypeScript compiler. Cached on disk, keyed by three's version.
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

export type TypeRef =
  | { kind: "number" | "string" | "boolean" | "any" | "null" }
  | { kind: "enum"; name: string; members: string[] }
  | { kind: "class"; name: string }
  | { kind: "array"; of: TypeRef }
  /** an options bag — an interface or type literal of plain data, written as `{ capStart: true }` */
  | { kind: "record"; name?: string; fields: Record<string, Field> }
  | { kind: "union"; of: TypeRef[] };

export type Field = { type: TypeRef; optional: boolean };
export type Param = { name: string; type: TypeRef; optional: boolean };
/** one call signature of a method: what it takes, and what a `foo(…).bar(…)` value is worth */
export type Method = { params: Param[]; returns: TypeRef };
export type PropInfo = { type: TypeRef; readonly: boolean; doc?: string };
export type ClassInfo = {
  bases: string[];
  /**
   * Every construct signature, in declaration order — `color(#fff)` and `color(1, .5, 0)` are two
   * different ones, and reflecting only the first made the second an error the language never had.
   * Always at least one entry: a class with no constructor of its own reflects as `[[]]`.
   */
  ctors: Param[][];
  props: Record<string, PropInfo>;
  /** call signatures of each public method — `lookAt(x, y, z);` is checked against these */
  methods: Record<string, Method[]>;
  copyable: boolean;
  abstract: boolean;
  doc?: string;
};

/** the barrel three re-exports every addon from — reflected on its own so `addons` needs no path */
export const ADDONS = "three/addons";

/** `modules` are extra packages whose exported classes become usable nodes/values. */
export type SchemaOptions = {
  entry?: string;
  /**
   * Extra modules, resolved from `cwd`. A bare specifier is also what the vite plugin will import the
   * class from; one written as a path is left to the runtime `registry`, since the emitted import would be
   * relative to the sheet and not to here.
   */
  modules?: string[];
  /**
   * Reflect `three/addons` too, so every addon class (`loftGeometry`, `roomEnvironment`, …) is a node.
   * On by default; a three too old to have the barrel is skipped silently unless this is explicitly true.
   */
  addons?: boolean;
  cwd?: string;
  cache?: boolean;
  /** node names the host passes to loadScene's `registry` — accepted by the checker, unchecked */
  declare?: string[];
};

export type Schema = {
  entry: string;
  modules: string[];
  version: string;
  classes: Record<string, ClassInfo>;
  /** exported non-class values (DoubleSide, SRGBColorSpace, …) */
  constants: Record<string, TypeRef>;
  /**
   * name → the module to import it from, for everything that does *not* come from `entry`. An addon is
   * keyed to its own deep path (`three/addons/geometries/LoftGeometry.js`) rather than to the barrel, so
   * the vite plugin can emit an import a bundler keeps one class of.
   */
  sources: Record<string, string>;
  declared?: string[];
};

const SCHEMA_VERSION = 9;

/** the modules to reflect, in the order a later one shadows an earlier one: addons first, entry over them */
const specifiers = (entry: string, modules: string[], addons: boolean | undefined) =>
  [...(addons === false ? [] : [ADDONS]), entry, ...modules];

export function buildSchema(opts: SchemaOptions = {}): Schema {
  const entry = opts.entry ?? "three/webgpu";
  const modules = opts.modules ?? [];
  const cwd = opts.cwd ?? process.cwd();
  const specs = specifiers(entry, modules, opts.addons);
  // slashes, not path.sep — ts normalizes every path it hands the host, so a windows
  // backslash probe would never match and the in-memory file would go unfound
  const probe = `${cwd.split(path.sep).join("/").replace(/\/$/, "")}/__tscene-probe__.ts`;
  const source = specs.map((m, i) => `import * as M${i} from ${JSON.stringify(m)};\nexport type P${i} = typeof M${i};\n`).join("");

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: false,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    fileName === probe
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : getSourceFile(fileName, languageVersion, onError, shouldCreate);
  host.fileExists = ((orig) => (f: string) => f === probe || orig(f))(host.fileExists.bind(host));
  host.readFile = ((orig) => (f: string) => (f === probe ? source : orig(f)))(host.readFile.bind(host));

  const program = ts.createProgram([probe], options, host);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(probe)!;

  const classes: Record<string, ClassInfo> = {};
  const constants: Record<string, TypeRef> = {};
  const sources: Record<string, string> = {};

  // later modules win, so a project class may deliberately shadow a three one
  for (const [i, name] of specs.entries()) {
    const decl = sf.statements[i * 2] as ts.ImportDeclaration;
    const moduleSymbol = checker.getSymbolAtLocation(decl.moduleSpecifier);
    if (!moduleSymbol) {
      // addons are on by default, so a three without the barrel must not take the whole schema down
      if (name === ADDONS && opts.addons === undefined) continue;
      throw new Error(`cannot resolve types for ${name} from ${cwd}`);
    }
    reflect(moduleSymbol, name);
  }

  // the plugin's default is the entry, so only the exceptions are worth carrying
  for (const name of Object.keys(sources)) if (sources[name] === entry) delete sources[name];

  return { entry, modules, version: threeVersion(cwd, entry), classes, constants, sources, ...(opts.declare ? { declared: opts.declare } : {}) };

  function reflect(moduleSymbol: ts.Symbol, spec: string) {
  for (const raw of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = raw.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw;
    const name = raw.getName();
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;

    const instance = checker.getDeclaredTypeOfSymbol(symbol);
    const isClass = !!(symbol.flags & ts.SymbolFlags.Class) && !!instance.getSymbol();
    if (isClass) {
      classes[name] = classInfo(checker, symbol, instance, sf);
      sources[name] = specifierOf(symbol, spec);
      continue;
    }
    if (symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.EnumMember | ts.SymbolFlags.Property)) {
      const t = checker.getTypeOfSymbolAtLocation(symbol, sf);
      if (t.getCallSignatures().length || t.getConstructSignatures().length) continue;
      constants[name] = typeRef(checker, t);
      sources[name] = specifierOf(symbol, spec);
    }
  }
  }
}

/**
 * Where an emitted `import { X }` should point. `three/addons` re-exports 270 modules, and importing the
 * barrel for one class would pin every one of them — so an addon is traced back to the file it is
 * declared in and keyed to that deep path instead.
 */
function specifierOf(symbol: ts.Symbol, spec: string): string {
  if (spec !== ADDONS) return spec;
  const file = (symbol.declarations?.[0]?.getSourceFile().fileName ?? "").split("\\").join("/");
  const jsm = file.indexOf("/examples/jsm/");
  if (jsm < 0) return spec;
  return `${ADDONS}/${file.slice(jsm + "/examples/jsm/".length).replace(/\.d\.ts$|\.ts$/, ".js")}`;
}

/** the leading TSDoc sentence, if three has one — hover shows it */
function docOf(checker: ts.TypeChecker, symbol: ts.Symbol): string | undefined {
  const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  if (!text) return undefined;
  const first = text.split(/\n\s*\n/)[0]!.replace(/\s+/g, " ");
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

const paramsOf = (checker: ts.TypeChecker, sig: ts.Signature | undefined, ref: ts.Node): Param[] =>
  (sig?.getParameters() ?? []).map((p) => {
    const declared = p.valueDeclaration as ts.ParameterDeclaration | undefined;
    return {
      name: p.getName(),
      type: typeRef(checker, checker.getTypeOfSymbolAtLocation(p, declared ?? ref)),
      optional: !!(declared?.questionToken || declared?.initializer || declared?.dotDotDotToken),
    };
  });

function classInfo(checker: ts.TypeChecker, symbol: ts.Symbol, instance: ts.Type, ref: ts.Node): ClassInfo {
  const decl = symbol.declarations?.find(ts.isClassDeclaration);
  const staticType = checker.getTypeOfSymbolAtLocation(symbol, ref);
  const signatures = staticType.getConstructSignatures();
  const ctors = signatures.length ? signatures.map((s) => paramsOf(checker, s, ref)) : [[]];

  const props: Record<string, PropInfo> = {};
  const methods: Record<string, Method[]> = {};
  let copyable = false;
  for (const p of checker.getPropertiesOfType(instance)) {
    const name = p.getName();
    if (name === "copy") copyable = true;
    if (name.startsWith("_") || !/^[A-Za-z]\w*$/.test(name)) continue;
    const d = p.valueDeclaration ?? p.declarations?.[0];
    if (!d) continue;
    const mods = ts.getCombinedModifierFlags(d as ts.Declaration);
    if (mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static)) continue;
    if (/^is[A-Z]/.test(name)) continue; // three's isMesh/isLight brand flags
    const t = checker.getTypeOfSymbolAtLocation(p, d);
    const calls = t.getCallSignatures();
    if (calls.length) {
      methods[name] = calls.map((c) => ({ params: paramsOf(checker, c, d), returns: typeRef(checker, c.getReturnType()) }));
      continue;
    }
    props[name] = { type: typeRef(checker, t), readonly: !!(mods & ts.ModifierFlags.Readonly), ...doc(docOf(checker, p)) };
  }

  return {
    bases: (instance.getBaseTypes() ?? []).map((b) => b.getSymbol()?.getName()).filter((n): n is string => !!n),
    ctors,
    props,
    methods,
    copyable,
    abstract: !!(decl && ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Abstract),
    ...doc(docOf(checker, symbol)),
  };
}

const doc = (text: string | undefined) => (text ? { doc: text } : {});

/** member names of a `typeof A | typeof B` alias, or undefined if it is any other shape */
function enumMembers(node: ts.TypeNode): string[] | undefined {
  const parts = ts.isUnionTypeNode(node) ? node.types : [node];
  const names: string[] = [];
  for (const p of parts) {
    if (!ts.isTypeQueryNode(p) || !ts.isIdentifier(p.exprName)) return undefined;
    names.push(p.exprName.text);
  }
  return names.length ? names : undefined;
}

function typeRef(checker: ts.TypeChecker, t: ts.Type, depth = 0): TypeRef {
  const F = ts.TypeFlags;
  if (depth > 4) return { kind: "any" };
  if (t.flags & (F.Any | F.Unknown | F.Never)) return { kind: "any" };

  // `type Side = typeof FrontSide | typeof BackSide | typeof DoubleSide` — keep the member names,
  // otherwise every one of three's ~200 numeric constants looks assignable to `side`
  const alias = t.aliasSymbol?.declarations?.find(ts.isTypeAliasDeclaration);
  const members = alias && enumMembers(alias.type);
  if (members) return { kind: "enum", name: t.aliasSymbol!.getName(), members };

  if (t.flags & (F.Number | F.NumberLiteral | F.Enum | F.EnumLiteral | F.BigInt)) return { kind: "number" };
  if (t.flags & (F.String | F.StringLiteral | F.TemplateLiteral)) return { kind: "string" };
  if (t.flags & (F.Boolean | F.BooleanLiteral)) return { kind: "boolean" };
  if (t.flags & (F.Null | F.Undefined | F.Void)) return { kind: "null" };
  if (t.flags & F.TypeParameter) {
    // class Mesh<TGeometry extends BufferGeometry = BufferGeometry> — report the default/constraint
    const resolved = checker.getDefaultFromTypeParameter(t) ?? checker.getBaseConstraintOfType(t);
    return resolved ? typeRef(checker, resolved, depth + 1) : { kind: "any" };
  }
  if (t.isUnion()) {
    const of: TypeRef[] = [];
    for (const part of t.types) {
      const r = typeRef(checker, part, depth + 1);
      if (!of.some((o) => JSON.stringify(o) === JSON.stringify(r))) of.push(r);
    }
    return of.length === 1 ? of[0]! : { kind: "union", of };
  }
  if (checker.isArrayType(t)) {
    const el = checker.getTypeArguments(t as ts.TypeReference)[0];
    return { kind: "array", of: el ? typeRef(checker, el, depth + 1) : { kind: "any" } };
  }
  const symbol = t.getSymbol();
  const name = symbol?.getName();
  const fields = symbol && recordFields(checker, t, symbol, depth);
  if (fields) return { kind: "record", ...(name && /^[A-Z]\w*$/.test(name) ? { name } : {}), fields };
  if (name && /^[A-Z]\w*$/.test(name)) return { kind: "class", name };
  return { kind: "any" };
}

/**
 * The fields of an options bag — `LoftGeometryOptions`, `WaterOptions` — so `{ capStart: true }` is
 * checked key by key instead of passing as `any`. Only plain data qualifies: an interface with methods
 * is a live object (`HTMLElement`) and stays an opaque class, and one with an index signature
 * (`userData`'s `Record<string, any>`) takes any key at all and stays `any`.
 */
function recordFields(checker: ts.TypeChecker, t: ts.Type, symbol: ts.Symbol, depth: number): Record<string, Field> | undefined {
  if (!(symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeLiteral))) return undefined;
  if (checker.getIndexInfosOfType(t).length || t.getCallSignatures().length || t.getConstructSignatures().length) return undefined;
  const props = checker.getPropertiesOfType(t);
  if (!props.length) return undefined;
  const fields: Record<string, Field> = {};
  for (const p of props) {
    const d = p.valueDeclaration ?? p.declarations?.[0];
    if (!d) return undefined;
    const pt = checker.getTypeOfSymbolAtLocation(p, d);
    // a method means this is behaviour, not settings — the whole type is the wrong shape for a record
    if (pt.getCallSignatures().length) return undefined;
    fields[p.getName()] = { type: typeRef(checker, pt, depth + 1), optional: !!(p.flags & ts.SymbolFlags.Optional) };
  }
  return fields;
}

function threeVersion(cwd: string, entry: string): string {
  try {
    const req = createRequire(path.join(cwd, "noop.js"));
    const pkg = entry.split("/")[0]!;
    let dir = path.dirname(req.resolve(pkg));
    for (; dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const p = path.join(dir, "package.json");
      if (!fs.existsSync(p)) continue;
      const json = JSON.parse(fs.readFileSync(p, "utf8"));
      if (json.name === pkg) return json.version ?? "0";
    }
    return "0";
  } catch {
    return "0";
  }
}

// ---------------------------------------------------------------- cache

/** three's version pins its own typings; an extra --module is usually a local file, so stamp its mtime */
function stamp(cwd: string, modules: string[]): string {
  const req = createRequire(path.join(cwd, "noop.js"));
  return modules
    .map((m) => {
      try {
        return String(fs.statSync(req.resolve(m)).mtimeMs);
      } catch {
        return "?";
      }
    })
    .join(",");
}

export function loadSchema(opts: SchemaOptions = {}): Schema {
  const entry = opts.entry ?? "three/webgpu";
  const modules = opts.modules ?? [];
  const cwd = opts.cwd ?? process.cwd();
  const declared = opts.declare?.length ? { declared: opts.declare } : {};
  if (opts.cache === false) return buildSchema({ entry, modules, addons: opts.addons, cwd, declare: opts.declare });
  const version = threeVersion(cwd, entry);
  const key = createHash("sha1").update(specifiers(entry, modules, opts.addons).join("+")).update(stamp(cwd, modules)).digest("hex").slice(0, 12);
  const file = path.join(cwd, "node_modules", ".cache", "tscene", `${entry.replace(/\W/g, "_")}-${version}-${key}-v${SCHEMA_VERSION}.json`);
  try {
    return { ...(JSON.parse(fs.readFileSync(file, "utf8")) as Schema), ...declared };
  } catch {}
  const schema = buildSchema({ entry, modules, addons: opts.addons, cwd });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(schema));
  } catch {}
  return { ...schema, ...declared };
}
