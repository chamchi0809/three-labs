#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
// Language server for .tscene: diagnostics, completion, hover, signature help,
// go-to-definition, document symbols, formatting and quick fixes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CodeAction, CodeActionKind, CompletionItemKind, createConnection, DiagnosticSeverity,
  ProposedFeatures, SymbolKind, TextDocumentSyncKind, TextDocuments, TextEdit,
  type Color, type ColorInformation,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { checkSource, fixSource, loadSchema, resolveSheet } from "./tools.ts";
import { ALIASES, BAKERY, BROOM, BUILTINS, FACE_PROPS, LOADERS, MATH, PATCH_PROPS, PATCH_UV, className, concrete, nodeName, type Knob } from "./names.ts";
import { expand, parse, tokenize, type Loader, type Member, type ObjectValue, type Pos, type Sheet, type Tok } from "./parse.ts";
import type { ClassInfo, Method, Param, Schema, TypeRef } from "./schema.ts";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let schema: Schema;
let folders: string[] = [];

connection.onInitialize((params) => {
  const options = (params.initializationOptions ?? {}) as { entry?: string; modules?: string[]; addons?: boolean; declare?: string[] };
  folders = params.workspaceFolders?.map((f) => fileURLToPath(f.uri)) ?? (params.rootPath ? [params.rootPath] : []);
  // three may be installed at any folder root or above it (monorepo, global node_modules)
  const roots = [...folders, process.cwd()];
  for (const cwd of roots) {
    try {
      // `addons: false` only when the client says so — undefined lets a three without the barrel pass
      schema = loadSchema({
        cwd, entry: options.entry, modules: options.modules, declare: options.declare,
        ...(options.addons === false ? { addons: false as const } : {}),
      });
      break;
    } catch (e) {
      if (cwd === roots.at(-1)) {
        connection.window.showErrorMessage(`tscene: ${(e as Error).message}`);
        schema = {
          entry: options.entry ?? "three/webgpu", modules: options.modules ?? [], version: "0",
          classes: {}, constants: {}, sources: {}, declared: options.declare,
        };
      }
    }
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: [" ", ":", "{", ".", "@"] },
      hoverProvider: true,
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      documentLinkProvider: { resolveProvider: false },
      codeActionProvider: true,
      colorProvider: true,
      foldingRangeProvider: true,
      semanticTokensProvider: { legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: [] }, full: true },
    },
  };
});

const pathOf = (doc: TextDocument) => (doc.uri.startsWith("file:") ? fileURLToPath(doc.uri) : doc.uri);

/** the open buffer for a path — the client's uri may differ in case (win32, macOS), so fall back to a case-insensitive scan */
function openDoc(file: string): TextDocument | undefined {
  const exact = documents.get(pathToFileURL(file).href);
  if (exact) return exact;
  const lower = file.toLowerCase();
  return documents.all().find((d) => pathOf(d).toLowerCase() === lower);
}

/** an open editor buffer beats what is on disk — @imports must see unsaved edits */
const read = (file: string) => openDoc(file)?.getText() ?? fs.readFileSync(file, "utf8");
const docFor = (file: string) => openDoc(file) ?? TextDocument.create(pathToFileURL(file).href, "scene", 0, read(file));
const loader: Loader = async (p, from) => {
  const file = resolveSheet(p, from);
  return { text: read(file), file };
};
/** the file an `@import` names, if it exists — relative or out of node_modules */
function importTarget(spec: string, from: string): string | undefined {
  try {
    const target = resolveSheet(spec, from);
    return fs.existsSync(target) ? target : undefined;
  } catch {
    return undefined;
  }
}

const range = (doc: TextDocument, pos: Pos) => ({ start: doc.positionAt(pos.start), end: doc.positionAt(pos.end) });
const show = (t: TypeRef): string =>
  t.kind === "class" || t.kind === "enum" ? t.name
    : t.kind === "record" ? (t.name ?? `{ ${Object.keys(t.fields).join(", ")} }`)
      : t.kind === "union" ? t.of.map(show).join(" | ") : t.kind === "array" ? `${show(t.of)}[]` : t.kind;
const paramList = (params: Param[]) => params.map((p) => `${p.name}${p.optional ? "?" : ""}: ${show(p.type)}`).join(", ");
const signature = (name: string, params: Param[]) => `${name}(${paramList(params)})`;
const methodDetail = (m: Method) => `(${paramList(m.params)}) → ${show(m.returns)}`;
const methodLabel = (name: string, m: Method) => `${name}${methodDetail(m)}`;

const tryParse = (doc: TextDocument): Sheet | undefined => {
  try {
    return parse(doc.getText(), pathOf(doc));
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------- diagnostics

async function validate(doc: TextDocument) {
  const file = pathOf(doc);
  const found = await checkSource(doc.getText(), file, schema, loader);
  connection.sendDiagnostics({
    uri: doc.uri,
    diagnostics: found
      .filter((d) => (d.file ?? file) === file)
      .map((d) => ({
        range: range(doc, d),
        severity: d.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
        message: d.message,
        source: "tscene",
        data: d.fix,
      })),
  });
}

/**
 * Every open sheet, not just the edited one: an edit changes the diagnostics of everything that
 * `@import`s it. But not on every keystroke — a pass parses the whole import graph and reflects it
 * against three, and a fast typist used to have one of those in flight per character typed. Coalesced
 * to one pass a beat, and the passes are chained so a slow one cannot publish over a newer one.
 */
const DEBOUNCE = 120;
let pending: NodeJS.Timeout | undefined;
let queue: Promise<unknown> = Promise.resolve();
const revalidateAll = () => {
  clearTimeout(pending);
  pending = setTimeout(() => {
    // a pass that throws — an @import naming a file that was just deleted — must not break the chain
    queue = queue
      .then(() => Promise.all(documents.all().map((doc) => validate(doc))))
      .catch((e: unknown) => connection.console.error(`tscene: ${(e as Error).message}`));
  }, DEBOUNCE);
};
documents.onDidChangeContent(revalidateAll);
documents.onDidClose((e) => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  revalidateAll();
});
connection.onDidChangeWatchedFiles(revalidateAll);

// ---------------------------------------------------------------- position lookup

type Hit =
  /** `cls` is the class of the body it sits in, which is what makes a bare call a method */
  | { kind: "object"; object: ObjectValue; cls: string | undefined }
  | { kind: "prop"; name: string; cls: string | undefined; member: Member };

/** deepest AST hit at `offset` — the object whose name is under the cursor, or the property name */
function locate(sheet: Sheet, offset: number): Hit | undefined {
  let hit: Hit | undefined;
  const inside = (p: Pos) => offset >= p.start && offset <= p.end;

  const visitObject = (o: ObjectValue, owner: string | undefined) => {
    if (!inside(o)) return;
    if (offset <= o.start + o.name.length) hit = { kind: "object", object: o, cls: owner };
    // an argument is a value, never a statement — nothing in one is a method of the enclosing class
    for (const a of o.args) if (a.kind === "object") visitObject(a, undefined);
    visitMembers(o.body, className(o.name));
  };
  const visitMembers = (members: Member[], cls: string | undefined) => {
    for (const m of members) {
      if (!inside(m)) continue;
      if (m.kind === "node") visitObject(m.object, cls);
      else if (m.kind === "prop") {
        if (offset <= m.start + m.name.length) hit = { kind: "prop", name: m.name, cls, member: m };
        if (m.value.kind === "object") visitObject(m.value, undefined);
      }
    }
  };

  for (const s of sheet.statements) {
    if (s.kind === "node" || s.kind === "prop" || s.kind === "var") visitMembers([s], undefined);
    // a template body is checked against the node type it declares, so hover follows the same rule
    else if (s.kind === "template" && inside(s)) visitMembers(s.body, className(s.node ?? "object3D"));
    // …and an @override body against the type its last compound names
    else if (s.kind === "override" && inside(s)) visitMembers(s.body, className(s.selector[s.selector.length - 1]!.type ?? "object3D"));
  }
  return hit;
}

/**
 * The block the cursor sits in: what opened it — `mesh.floor #ground {` → `mesh`,
 * `material: meshStandardMaterial {` → `meshStandardMaterial`, `@bakery {` → `@bakery` — and where its
 * `{` is, so the block enclosing *that* can be found the same way.
 * Found by brace counting rather than parsing, because a document being typed into rarely parses.
 * ponytail: a `{`, `}` or `;` inside a comment or string throws this off; the parser owns diagnostics, this only drives completion.
 */
function enclosingBlock(text: string, offset: number): { name: string | undefined; brace: number } | undefined {
  let depth = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{" && depth-- === 0) {
      // comments are not part of the header, and they may hold anything the rules below look for
      const header = text.slice(0, i).split(/[;{}]/).pop()!.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const template = /@template\s+([a-zA-Z_]\w*)?\s*\./.exec(header);
      if (template) return { name: template[1] ?? "object3D", brace: i };
      // an @override body is checked against the type its last compound names, and nothing narrower
      const override = /@override\s+(\S[^{]*)$/.exec(header);
      if (override) return { name: /^([a-zA-Z_]\w*)/.exec(override[1]!.trim().split(/\s+/).pop()!)?.[1] ?? "object3D", brace: i };
      const at = /@([a-zA-Z_]\w*)\s*$/.exec(header);
      if (at) return { name: `@${at[1]}`, brace: i };
      if (/:\s*$/.test(header)) return { name: ":record", brace: i }; // `userData: { … }` — a record literal
      // innermost first, repeatedly, so `face(vec3(0, 0, 0), …)` loses both levels and leaves `face` behind
      let outside = header;
      for (let shorter = ""; shorter !== outside; ) {
        shorter = outside;
        outside = outside.replace(/\([^()]*\)/g, "");
      }
      outside = outside.replace(/[.#][\w-]+/g, "");
      // a `(` the strip above could not close is an argument list still open: `loftGeometry(sections, { …`
      if (outside.includes("(")) return { name: ":record", brace: i };
      return { name: /([a-zA-Z_]\w*)\s*$/.exec(outside)?.[1], brace: i };
    }
  }
  return undefined;
}

/** the identifier under the cursor plus the character in front of it */
function wordAt(text: string, offset: number) {
  let start = offset;
  while (start > 0 && /[\w-]/.test(text[start - 1]!)) start--;
  let end = offset;
  while (end < text.length && /[\w-]/.test(text[end]!)) end++;
  return { word: text.slice(start, end), start, end, before: text.slice(Math.max(0, start - 2), start) };
}

// ---------------------------------------------------------------- completion

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const text = doc.getText();
  const offset = doc.offsetAt(params.position);
  const head = text.slice(0, offset);

  // inside an `@import "…"` — the sheets sitting next to this one
  const importing = /@import\s+["']([^"']*)$/.exec(head);
  if (importing) return importCompletions(doc, offset, importing[1]!);

  // inside `var(` — every --variable reachable from this file
  const typed = /var\(\s*([\w-]*)$/.exec(head);
  if (typed) return variableCompletions(doc, offset, typed[1]!.length);

  // `@` opens an at-rule — three's namespace has nothing to offer there
  const at = /@[\w-]*$/.exec(head);
  if (at) return atCompletions(doc, at.index, offset, enclosingBlock(text, offset)?.name);

  // `.` after a value that is already complete reads a property or calls a method; a `.` after a bare
  // node name is a template, which is the branch below
  if (/[)\]]\s*\.[\w-]*$/.test(head)) return memberCompletions(receiverAt(head));

  // inside `calc(` — arithmetic, so three's namespace has nothing to offer and the math table does
  if (inCalc(head)) {
    return Object.entries(MATH).map(([label, m]) => ({
      label,
      kind: CompletionItemKind.Function,
      detail: m.summary,
      ...(m.arity ? { insertText: `${label}(` } : {}),
    }));
  }

  // `.` after a node name completes templates declared for that node type, including imported ones
  const dotted = /([A-Za-z_]\w*)\.[\w-]*$/.exec(head);
  if (dotted) {
    const node = className(dotted[1]!);
    const out = [];
    for (const { file, sheet: s } of sheetsFrom(pathOf(doc), text)) {
      for (const st of s.statements) {
        if (st.kind !== "template" || !isA(node, className(st.node ?? "object3D"))) continue;
        out.push({ label: st.name, kind: CompletionItemKind.Snippet, detail: `@template ${st.node ?? ""}.${st.name} — ${path.basename(file)}` });
      }
    }
    return out;
  }

  const block = enclosingBlock(text, offset);
  // `@bakery { … }` and `@broom { … }` are not three's namespace: their keys are fixed tables, and no three name belongs in either
  if (block?.name === "@bakery" || block?.name === "@broom") return knobCompletions(block.name, knobPosition(block.name, text, block.brace), head);
  // an options bag: its keys are the fields the slot declares. A record in an `any` slot (userData) has none
  if (block?.name === ":record") {
    // a patch's `uv: { … }` is not a slot the schema declares — a patch names no class for it to hang off
    if (isPatchUv(text, block.brace)) return tableCompletions(PATCH_UV, head);
    return recordCompletions(recordAt(text, block.brace), head);
  }
  // a `face` body is the brush's own table, not a three class — `face` names no class at all
  if (block?.name === "face") return faceCompletions(head);
  // a `patch` body: three keys of its own, then the `Mesh` it becomes and the `row(…)` it is built from
  if (block?.name === "patch") return patchCompletions(head);

  const owner = block?.name;
  const cls = owner ? schema.classes[className(owner)] : undefined;

  // right after `prop:` — offer only values that fit the declared type
  const afterColon = /([A-Za-z_][\w]*)\s*:\s*[\w-]*$/.exec(head);
  const prop = afterColon && cls?.props[afterColon[1]!];
  if (prop) return valueCompletions(prop.type);

  // inside a call — only what fits the parameter under the cursor
  const call = activeCall(head);
  if (call) return valueCompletions(call.params[call.activeParameter]?.type ?? { kind: "any" });

  return [...(cls ? propCompletions(cls) : []), ...objectCompletions()];
});

/** the at-rules legal here: a sheet takes all five, a body only takes the two knob tables */
function atCompletions(doc: TextDocument, start: number, offset: number, block: string | undefined) {
  // no at-rule nests inside a block of values
  if (block === "@bakery" || block === "@broom" || block === ":record" || block === "face") return [];
  const rules: [string, string][] = block
    ? [
        ["@bakery", "lightmap baker settings for this node or material"],
        ["@broom", "editor settings for this node"],
      ]
    : [
        ["@import", "splice in another sheet"],
        ["@template", "a body applied by .name"],
        ["@override", "a body appended to every node a selector matches"],
        ["@bakery", "lightmap baker settings for the sheet"],
        ["@broom", "editor settings for the sheet"],
      ];
  // `@` is not a word character, so the typed sigil has to be replaced explicitly
  return rules.map(([label, detail]) => ({
    label,
    kind: CompletionItemKind.Keyword,
    detail,
    textEdit: TextEdit.replace({ start: doc.positionAt(start), end: doc.positionAt(offset) }, label),
  }));
}

const dirents = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** does this package ship sheets? a top-level .tscene, or a package.json that names one */
function shipsSheets(dir: string): boolean {
  if (dirents(dir).some((e) => e.isFile() && e.name.endsWith(".tscene"))) return true;
  try {
    return fs.readFileSync(path.join(dir, "package.json"), "utf8").includes(".tscene");
  } catch {
    return false;
  }
}

/** package name → its directory, for every node_modules above `from` that ships sheets */
function sheetPackages(from: string): Map<string, string> {
  const out = new Map<string, string>();
  for (let at = path.dirname(from); ; at = path.dirname(at)) {
    const root = path.join(at, "node_modules");
    for (const e of dirents(root)) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const inner = e.name.startsWith("@") ? dirents(path.join(root, e.name)).map((s) => `${e.name}/${s.name}`) : [e.name];
      // a nearer node_modules shadows the one above it, exactly as resolution does
      for (const name of inner) if (!out.has(name) && shipsSheets(path.join(root, name))) out.set(name, path.join(root, name));
    }
    if (at === path.dirname(at)) return out;
  }
}

function importCompletions(doc: TextDocument, offset: number, typed: string) {
  const from = pathOf(doc);
  const prefix = typed.endsWith("/") ? "" : path.basename(typed);
  const edit = (text: string) =>
    TextEdit.replace({ start: doc.positionAt(offset - prefix.length), end: doc.positionAt(offset) }, text);

  // a bare specifier: package names until the name is complete, then the files inside it
  let dir: string;
  if (typed.startsWith(".") || path.isAbsolute(typed)) {
    dir = path.resolve(path.dirname(from), typed.endsWith("/") ? typed : path.dirname(typed));
  } else {
    const packages = sheetPackages(from);
    const segments = typed.split("/");
    const depth = typed.startsWith("@") ? 2 : 1; // a scope is half a package name, not a directory
    const root = packages.get(segments.slice(0, depth).join("/"));
    if (!root || segments.length <= depth) {
      return [...packages.keys()]
        .filter((name) => name.startsWith(typed))
        // the whole specifier is replaced: a scope and the typed prefix are one label
        .map((name) => ({
          label: name,
          kind: CompletionItemKind.Module,
          textEdit: TextEdit.replace({ start: doc.positionAt(offset - typed.length), end: doc.positionAt(offset) }, name),
        }));
    }
    const sub = segments.slice(depth).join("/");
    dir = path.join(root, sub.endsWith("/") ? sub : path.dirname(sub));
  }

  return dirents(dir)
    .filter((e) => (e.isDirectory() ? e.name !== "node_modules" : e.name.endsWith(".tscene")) && path.resolve(dir, e.name) !== pathOf(doc))
    .map((e) => ({
      label: e.isDirectory() ? `${e.name}/` : e.name,
      kind: e.isDirectory() ? CompletionItemKind.Folder : CompletionItemKind.File,
      textEdit: edit(e.isDirectory() ? `${e.name}/` : e.name),
    }));
}

const variableCompletions = (doc: TextDocument, offset: number, typed: number) => {
  // a nearer declaration shadows an outer one, so the last of a name wins — Map.set keeps the earlier slot
  const visible = new Map<string, Variable>();
  for (const v of variablesAt(pathOf(doc), doc.getText(), offset)) visible.set(v.name, v);
  return [...visible.values()].map(({ file, name, value }) => ({
    label: `--${name}`,
    kind: CompletionItemKind.Variable,
    detail: `${value} — ${path.basename(file)}`,
    // the default word pattern stops at `-`, so the typed prefix has to be replaced explicitly
    textEdit: TextEdit.replace({ start: doc.positionAt(offset - typed), end: doc.positionAt(offset) }, `--${name}`),
  }));
};

type Variable = { file: string; name: string; value: string; start: number };

/**
 * Variables in scope at `offset`, matching what expand() resolves: declared earlier, in the
 * block the cursor sits in or one enclosing it, plus the top level of anything @imported before it.
 * Lexical, because a document being typed into rarely parses — `var(` alone is already a syntax error.
 * ponytail: a brace inside a comment or string shifts the scope stack; nothing but completion reads it.
 */
function variablesAt(file: string, text: string, offset: number, seen = new Set<string>()): Variable[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const stack: Variable[][] = [[]];
  const token = /\{|\}|--([A-Za-z_][\w-]*)\s*:\s*([^;{}]*)|@import\s+["']([^"']+)["']/g;
  for (let m = token.exec(text); m && m.index < offset; m = token.exec(text)) {
    if (m[0] === "{") stack.push([]);
    else if (m[0] === "}") { if (stack.length > 1) stack.pop(); }
    else if (m[1]) stack.at(-1)!.push({ file, name: m[1], value: m[2]!.trim(), start: m.index });
    else {
      // an imported sheet contributes only its top level — reading it whole leaves exactly that on the stack
      const target = importTarget(m[3]!, file);
      try {
        if (target) stack[0]!.push(...variablesAt(target, read(target), Infinity, seen));
      } catch {}
    }
  }
  return stack.flat();
}

const settable = (t: TypeRef, readonly: boolean) => !readonly || (t.kind === "class" && !!schema.classes[t.name]?.copyable);

/** what a node's body accepts: its settable properties, and its methods called bare — `lookAt(0, 1, 0);` */
const propCompletions = (cls: ClassInfo) => [
  ...Object.entries(cls.props)
    .filter(([, p]) => settable(p.type, p.readonly))
    .map(([name, p]) => ({ label: name, kind: CompletionItemKind.Property, detail: show(p.type), insertText: `${name}: ` })),
  ...Object.entries(cls.methods).map(([name, m]) => ({
    label: name,
    kind: CompletionItemKind.Method,
    detail: methodDetail(m[0]!),
    insertText: `${name}(`,
  })),
];

/**
 * Which table of a knob at-rule applies, decided by the block that at-rule sits in.
 * `@bakery` has three positions, `@broom` only two — a material has nothing to say to the editor.
 */
function knobPosition(rule: string, text: string, brace: number): string {
  const outer = enclosingBlock(text, brace)?.name;
  if (!outer) return "scene";
  return rule === "@bakery" && isA(className(outer), "Material") ? "material" : "node";
}

const knobTable = (rule: string, position: string): Record<string, Knob> => {
  const tables: Record<string, Record<string, Knob>> = rule === "@broom" ? BROOM : BAKERY;
  return tables[position] ?? {};
};

const knobType = (k: Knob) =>
  k.values ? k.values.join(" | ") : k.type === "numbers" ? `${k.length ?? ""} numbers`.trim() : k.type;

/** the keys of one knob at-rule's position, or — right after `key:` — the values that key accepts */
function knobCompletions(rule: string, position: string, head: string) {
  const table = knobTable(rule, position);
  const key = /([A-Za-z_]\w*)\s*:\s*[\w-]*$/.exec(head)?.[1];
  if (key) {
    const values = table[key]?.values ?? (table[key]?.type === "boolean" ? ["true", "false"] : []);
    return values.map((label) => ({ label, kind: CompletionItemKind.Value, detail: `${rule} ${key}` }));
  }
  return Object.entries(table).map(([name, k]) => ({
    label: name,
    kind: CompletionItemKind.Property,
    detail: knobType(k),
    insertText: `${name}: `,
  }));
}

/** the properties a `face` body takes, or — right after `uv:` — the two coordinate systems */
function faceCompletions(head: string) {
  const key = /([A-Za-z_]\w*)\s*:\s*[\w-]*$/.exec(head)?.[1];
  if (key === "uv") {
    return [
      { label: "paraxial", kind: CompletionItemKind.Value, detail: "world-axis aligned, Quake's system" },
      { label: "parallel", kind: CompletionItemKind.Value, detail: "in the face's own plane; parallel(u, v) to pin the axes" },
    ];
  }
  if (key) return [];
  return Object.entries(FACE_PROPS).map(([name, p]) => ({
    label: name,
    kind: CompletionItemKind.Property,
    detail: p.summary,
    insertText: `${name}: `,
  }));
}

/** one fixed table of keys, or — right after `key:` — nothing, since these keys take values three never names */
function tableCompletions(table: Record<string, { summary: string }>, head: string) {
  if (/([A-Za-z_]\w*)\s*:\s*[\w-]*$/.test(head)) return [];
  return Object.entries(table).map(([name, k]) => ({
    label: name,
    kind: CompletionItemKind.Property,
    detail: k.summary,
    insertText: `${name}: `,
  }));
}

/**
 * A `patch` body. Its own three keys first, because they are the reason to have written `patch` rather than
 * `mesh`; then `row(…)`, which is the grid; then everything a `Mesh` takes, since that is what a patch becomes.
 */
function patchCompletions(head: string) {
  const key = /([A-Za-z_]\w*)\s*:\s*[\w-]*$/.exec(head)?.[1];
  if (key === "material") return valueCompletions({ kind: "class", name: "Material" });
  if (key) return [];
  const mesh = schema.classes[className("mesh")];
  return [
    ...Object.entries(PATCH_PROPS).map(([name, p]) => ({
      label: name,
      kind: CompletionItemKind.Property,
      detail: p.summary,
      insertText: `${name}: `,
    })),
    { label: "row", kind: CompletionItemKind.Function, detail: BUILTINS.row!.signature, insertText: "row(" },
    ...(mesh ? propCompletions(mesh) : []),
  ];
}

/** is the `{` at `brace` a patch's `uv: { … }`? — the one record in the language the schema cannot describe */
function isPatchUv(text: string, brace: number): boolean {
  if (!/\buv\s*:\s*$/.test(text.slice(0, brace))) return false;
  return enclosingBlock(text, brace)?.name === "patch";
}

/** index of the `(` that matches the `)` at the end of `text`, or -1 */
function openingParen(text: string): number {
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ")") depth++;
    else if (text[i] === "(" && --depth === 0) return i;
  }
  return -1;
}

/**
 * The type of the value in front of the last `.` in `head` — `splineCurve([…]).getPoints(4).` resolves to
 * `Vector2[]`. Only a chain of calls is followed: a `var(--p)` receiver is a loop binding the schema cannot
 * see, and a bare name is a template application.
 */
function receiverAt(head: string): TypeRef | undefined {
  const dot = head.lastIndexOf(".");
  if (dot < 0) return undefined;
  let text = head.slice(0, dot).replace(/\s+$/, "");
  const methods: string[] = [];
  while (text.endsWith(")")) {
    const open = openingParen(text);
    if (open < 0) return undefined;
    const name = /([A-Za-z_]\w*)\s*$/.exec(text.slice(0, open))?.[1];
    if (!name) return undefined;
    const before = text.slice(0, text.slice(0, open).lastIndexOf(name)).replace(/\s+$/, "");
    if (before.endsWith(".")) { methods.unshift(name); text = before.slice(0, -1).replace(/\s+$/, ""); continue; }
    // the innermost call is the constructor, and the names peeled off it are methods called on its result
    let type: TypeRef | undefined = schema.classes[className(name)] ? { kind: "class", name: className(name) } : undefined;
    for (const method of methods) {
      if (type?.kind !== "class") return undefined;
      type = schema.classes[concrete(type.name)]?.methods[method]?.[0]?.returns;
    }
    return type;
  }
  return undefined;
}

/** the properties and methods of a value's type */
function memberCompletions(type: TypeRef | undefined) {
  const cls = type?.kind === "class" ? schema.classes[concrete(type.name)] : undefined;
  if (!cls) return [];
  return [
    ...Object.entries(cls.props).map(([label, p]) => ({ label, kind: CompletionItemKind.Property, detail: show(p.type) })),
    ...Object.entries(cls.methods).map(([label, m]) => ({
      label,
      kind: CompletionItemKind.Method,
      detail: methodDetail(m[0]!),
      insertText: `${label}(`,
    })),
  ];
}

/** is the cursor inside an unclosed `calc(`, where arithmetic is the only thing that fits? */
function inCalc(head: string): boolean {
  let depth = 0;
  for (let i = head.length - 1; i >= 0; i--) {
    const c = head[i]!;
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth) { depth--; continue; }
      const name = /([A-Za-z_]\w*)\s*$/.exec(head.slice(0, i))?.[1];
      return name === "calc" || (!!name && !!MATH[name]);
    } else if (c === "{" || c === "}" || c === ";") return false;
  }
  return false;
}

/** the options bag a `{` at `brace` is filling in — the property it is assigned to, or the argument it sits in */
function recordAt(text: string, brace: number): Extract<TypeRef, { kind: "record" }> | undefined {
  const head = text.slice(0, brace);
  const assigned = /([A-Za-z_]\w*)\s*:\s*$/.exec(head);
  if (assigned) {
    const owner = enclosingBlock(text, brace)?.name;
    const cls = owner ? schema.classes[className(owner)] : undefined;
    return recordType(cls?.props[assigned[1]!]?.type);
  }
  const call = activeCall(head);
  return recordType(call?.params[call.activeParameter]?.type);
}

const recordType = (t: TypeRef | undefined): Extract<TypeRef, { kind: "record" }> | undefined => {
  if (t?.kind === "record") return t;
  if (t?.kind === "union") for (const part of t.of) { const r = recordType(part); if (r) return r; }
  return undefined;
};

/** the fields of one options bag, or — right after `key:` — the values that field accepts */
function recordCompletions(shape: Extract<TypeRef, { kind: "record" }> | undefined, head: string) {
  if (!shape) return [];
  const key = /([A-Za-z_]\w*)\s*:\s*[\w-]*$/.exec(head)?.[1];
  const field = key ? shape.fields[key] : undefined;
  if (field) return valueCompletions(field.type);
  if (key) return [];
  return Object.entries(shape.fields).map(([name, f]) => ({
    label: name,
    kind: CompletionItemKind.Property,
    detail: show(f.type) + (f.optional ? " (optional)" : ""),
    insertText: `${name}: `,
  }));
}

const objectCompletions = () => [
  ...Object.entries(BUILTINS).map(([name, b]) => ({ label: name, kind: CompletionItemKind.Keyword, detail: b.signature })),
  ...Object.entries(schema.classes)
    .filter(([, c]) => !c.abstract)
    // the first overload in a one-line detail; hover has room for the rest
    .map(([name, c]) => ({ label: nodeName(name), kind: CompletionItemKind.Class, detail: signature(nodeName(name), c.ctors[0]!) })),
];

function valueCompletions(type: TypeRef) {
  const parts = type.kind === "union" ? type.of : [type];
  const out: { label: string; kind: CompletionItemKind; detail: string; insertText?: string }[] = [];
  for (const t of parts) {
    if (t.kind === "boolean") out.push(...["true", "false"].map((label) => ({ label, kind: CompletionItemKind.Value, detail: "boolean" })));
    if (t.kind === "null") out.push({ label: "null", kind: CompletionItemKind.Value, detail: "null" });
    if (t.kind === "enum") {
      out.push(...t.members.map((label) => ({ label, kind: CompletionItemKind.Constant, detail: t.name })));
    }
    if (t.kind === "class") {
      const alias = Object.entries(ALIASES).find(([, c]) => c === t.name)?.[0];
      for (const [name, info] of Object.entries(schema.classes)) {
        if (info.abstract) continue;
        if (name !== t.name && !(info.bases.includes(t.name) || isA(name, t.name))) continue;
        const label = name === t.name && alias ? alias : nodeName(name);
        out.push({ label, kind: CompletionItemKind.Constructor, detail: signature(label, info.ctors[0]!), insertText: `${label}(` });
      }
    }
  }
  return out;
}

function isA(cls: string, base: string): boolean {
  const stack = [cls];
  const seen = new Set<string>();
  while (stack.length) {
    const c = stack.pop()!;
    if (c === base) return true;
    if (seen.has(c)) continue;
    seen.add(c);
    stack.push(...(schema.classes[c]?.bases ?? []));
  }
  return false;
}

// ---------------------------------------------------------------- hover

const md = (...lines: string[]) => ({ kind: "markdown" as const, value: lines.join("\n") });

connection.onHover(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const offset = doc.offsetAt(params.position);
  const file = pathOf(doc);
  const { word, start, end } = wordAt(text, offset);
  const here = range(doc, { start, end });

  // --var, .template and bare constants live outside the class schema
  if (word.startsWith("--")) {
    // the binding graph knows which declaration actually won; the lexical scan is the mid-edit fallback
    const decl = await declarationOf({ sigil: "--", range: { start, end, file } });
    const declared = decl && declText(decl);
    if (decl && declared) return { contents: md("```scene", declared, "```", path.basename(decl.file!)), range: here };
    const found = variablesAt(file, text, offset).filter((v) => v.name === word.slice(2)).at(-1);
    return found ? { contents: md("```scene", `--${found.name}: ${found.value};`, "```", path.basename(found.file)), range: here } : null;
  }
  if (word && text[start - 1] === ".") {
    for (const { file: f, sheet: s } of sheetsFrom(file, text)) {
      for (const st of s.statements) {
        if (st.kind === "template" && st.name === word) {
          return { contents: md("```scene", `@template ${st.node ?? "object3D"}.${st.name}`, "```", path.basename(f)), range: here };
        }
      }
    }
  }
  if (BUILTINS[word]) {
    return { contents: md("```scene", BUILTINS[word]!.signature, "```", BUILTINS[word]!.summary), range: here };
  }
  if (word === "each") {
    return { contents: md("```scene", "each(--name, count | list, value)", "```", "a list: `value` once per index, or once per item. Binds `--name`, `--index` and `--count`"), range: here };
  }
  // a calc() function, which is the language's own and so not in the schema
  if (MATH[word] && inCalc(text.slice(0, start))) {
    const knob = MATH[word]!;
    const args = { 0: "", 1: "(x)", 2: "(a, b)", 3: "(x, a, b)" }[knob.arity] ?? "(…)";
    return { contents: md("```scene", `${word}${args}`, "```", knob.summary), range: here };
  }
  if (word && schema.constants[word]) {
    return { contents: md("```ts", `${word}: ${show(schema.constants[word]!)}`, "```", `exported by ${schema.entry}`), range: here };
  }
  // a `@bakery` or `@broom` key is a setting for a tool, so the schema knows nothing about it — the table does
  const block = enclosingBlock(text, offset);
  if (word && (block?.name === "@bakery" || block?.name === "@broom")) {
    const position = knobPosition(block.name, text, block.brace);
    const knob = knobTable(block.name, position)[word];
    return knob ? { contents: md("```scene", `${block.name} ${word}: ${knobType(knob)}`, "```", `${position} setting`), range: here } : null;
  }
  // a `face` key is the brush's own, and the brush is the language's, not three's
  if (word && block?.name === "face" && FACE_PROPS[word]) {
    return { contents: md("```scene", `${word}: ${FACE_PROPS[word]!.type}`, "```", FACE_PROPS[word]!.summary), range: here };
  }
  // a `patch` key is the language's too — all but these three belong to the `Mesh` and hover below as one
  if (word && block?.name === "patch" && PATCH_PROPS[word]) {
    return { contents: md("```scene", `${word}: ${PATCH_PROPS[word]!.type}`, "```", PATCH_PROPS[word]!.summary), range: here };
  }
  // an options-bag key — `loftGeometry(sections, { capStart: true })`. A record in an `any` slot has no fields
  if (word && block?.name === ":record") {
    if (PATCH_UV[word] && isPatchUv(text, block.brace)) {
      return { contents: md("```scene", `${word}: ${PATCH_UV[word]!.type}`, "```", PATCH_UV[word]!.summary), range: here };
    }
    const shape = recordAt(text, block.brace);
    const field = shape?.fields[word];
    if (field) {
      const owner = shape!.name ? `${shape!.name}.` : "";
      return { contents: md("```ts", `${owner}${word}${field.optional ? "?" : ""}: ${show(field.type)}`, "```"), range: here };
    }
  }

  const sheet = tryParse(doc);
  if (!sheet) return null;
  const hit = locate(sheet, offset);
  if (!hit) return null;

  if (hit.kind === "object") {
    const name = hit.object.name;
    const at = range(doc, { start: hit.object.start, end: hit.object.start + name.length });

    // a loader is not its class: `texture("/x.png")` takes a url, and `Texture`'s constructor does not
    const loader = LOADERS[name];
    if (loader) {
      return { contents: md("```ts", `${name}(url: string) → ${loader.class}`, "```", loader.summary), range: at };
    }

    const cls = className(name);
    const info = schema.classes[cls];
    // a bare call in a body — `lookAt(0, 1, 0);` — is a method of the class whose body it is, and
    // every overload is worth showing: which one it is depends on what was typed
    const overloads = !info && hit.cls ? schema.classes[hit.cls]?.methods[name] : undefined;
    if (overloads?.length) {
      return {
        contents: md("```ts", overloads.map((m) => `${hit.cls}.${methodLabel(name, m)}`).join("\n"), "```"),
        range: at,
      };
    }
    if (!info) return null;
    return {
      contents: md(
        "```ts",
        // every constructor, the way methods hover: `color(#fff)` and `color(1, .5, 0)` are both legal
        // and a hover that showed only the first read as though the other were a mistake
        info.ctors.map((params) => signature(name, params)).join("\n"),
        "```",
        [cls, ...bases(cls)].join(" < "),
        ...(info.doc ? ["", info.doc] : []),
      ),
      range: at,
    };
  }

  // a dotted path hovers as its own leaf: `material.color` → Material.color
  const path0 = hit.name.split(".");
  let cls = hit.cls;
  for (const seg of path0.slice(0, -1)) {
    const t = cls ? schema.classes[cls]?.props[seg]?.type : undefined;
    cls = t?.kind === "class" ? concrete(t.name) : undefined;
  }
  const leaf = path0.at(-1)!;
  const prop = cls ? schema.classes[cls]?.props[leaf] : undefined;
  if (!cls || !prop) return null;
  return {
    contents: md(
      "```ts", `${prop.readonly ? "readonly " : ""}${cls}.${leaf}: ${show(prop.type)}`, "```",
      prop.readonly ? "_read-only in three — assigned with `.copy()`_" : "",
      ...(prop.doc ? ["", prop.doc] : []),
    ),
    range: range(doc, { start: hit.member.start, end: hit.member.start + hit.name.length }),
  };
});

function bases(cls: string): string[] {
  const out: string[] = [];
  let next = schema.classes[cls]?.bases ?? [];
  while (next.length) {
    out.push(...next);
    next = next.flatMap((b) => schema.classes[b]?.bases ?? []);
  }
  return out;
}

// ---------------------------------------------------------------- signature help

/**
 * The call the cursor is inside, walking back to the unclosed `(` and counting top-level commas.
 * Three kinds of name reach here: a loader, a class, and — inside a node body — a method of that
 * node's class, because `lookAt(0, 1, 0);` is as much a call as `vec3(0, 1, 0)` is.
 */
function activeCall(head: string): { label: string; params: Param[]; activeParameter: number } | null {
  let depth = 0;
  let activeParameter = 0;
  let i = head.length - 1;
  for (; i >= 0; i--) {
    const c = head[i]!;
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) activeParameter++;
    else if (c === "{" || c === "}" || c === ";") return null;
  }
  if (i < 0) return null;

  const name = /([A-Za-z_][\w]*)\s*$/.exec(head.slice(0, i))?.[1];
  if (!name) return null;

  // a loader takes a url. Its class' constructor describes a call no sheet can write — `texture(…)`
  // used to help with `Texture(mapping?, wrapS?, …)`, which is not what the parentheses hold
  const loader = LOADERS[name];
  if (loader) {
    const params = loader.args.map((type) => ({ name: "url", type, optional: false }));
    return { label: `${name}(${paramList(params)}) → ${loader.class}`, params, activeParameter };
  }

  const info = schema.classes[className(name)];
  // same rule as a method below: the constructor overload that has a slot for the argument being typed
  if (info) {
    const best = info.ctors.find((p) => activeParameter < p.length) ?? info.ctors[0]!;
    return { label: signature(name, best), params: best, activeParameter };
  }

  // the class of the block this call sits in, which is what a bare method call is a method of
  const owner = enclosingBlock(head, head.length)?.name;
  const cls = owner && !owner.startsWith("@") && owner !== ":record" ? className(owner) : undefined;
  const overloads = cls ? schema.classes[cls]?.methods[name] : undefined;
  if (!overloads?.length) return null;
  // the overload that has a slot for the argument being typed — `lookAt(x, y, z)` is the second one,
  // and the first (`lookAt(vector)`) would call every argument past the cursor a mistake
  const best = overloads.find((o) => activeParameter < o.params.length) ?? overloads[0]!;
  return { label: `${cls}.${methodLabel(name, best)}`, params: best.params, activeParameter };
}

connection.onSignatureHelp((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const call = activeCall(doc.getText().slice(0, doc.offsetAt(params.position)));
  if (!call) return null;
  return {
    signatures: [{ label: call.label, parameters: call.params.map((p) => ({ label: `${p.name}${p.optional ? "?" : ""}: ${show(p.type)}` })) }],
    activeSignature: 0,
    activeParameter: Math.min(call.activeParameter, Math.max(0, call.params.length - 1)),
  };
});

// ---------------------------------------------------------------- definition (templates, vars, imports)

// ctrl-click on an @import path
connection.onDocumentLinks((params) => {
  const doc = documents.get(params.textDocument.uri);
  const sheet = doc && tryParse(doc);
  if (!doc || !sheet) return [];
  const out = [];
  for (const s of sheet.statements) {
    if (s.kind !== "import") continue;
    const target = importTarget(s.path, pathOf(doc));
    const text = doc.getText().slice(s.start, s.end);
    const open = text.search(/["']/);
    if (!target || open < 0) continue;
    const close = text.indexOf(text[open]!, open + 1);
    out.push({
      range: range(doc, { start: s.start + open + 1, end: s.start + (close < 0 ? text.length : close) }),
      target: pathToFileURL(target).href,
    });
  }
  return out;
});

connection.onDefinition(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const offset = doc.offsetAt(params.position);
  const file = pathOf(doc);
  const sheet = tryParse(doc);

  // inside an @import string → jump to the file
  for (const s of sheet?.statements ?? []) {
    if (s.kind === "import" && offset >= s.start && offset <= s.end) {
      const target = importTarget(s.path, file);
      if (!target) return null;
      return [{ uri: pathToFileURL(target).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }];
    }
  }

  const at = (f: string, pos: { start: number; end: number }) => {
    const doc2 = docFor(f);
    return [{ uri: doc2.uri, range: range(doc2, pos) }];
  };

  const { word, before } = wordAt(text, offset);

  // --name, #id, .template → wherever expand() bound this use
  const sym = symbolAt(file, text, offset);
  if (sym) {
    const decl = await declarationOf(sym);
    if (decl) return at(decl.file!, decl);
  }

  // mid-edit the sheet may not expand at all — fall back to the lexical scan
  if (word.startsWith("--")) {
    const found = variablesAt(file, text, offset).filter((v) => v.name === word.slice(2)).at(-1);
    return found ? at(found.file, { start: found.start, end: found.start + found.name.length + 2 }) : null;
  }

  if (!before.endsWith(".") || !word) return null;
  for (const { file: f, sheet: s } of sheetsFrom(file, text)) {
    for (const st of s.statements) if (st.kind === "template" && st.name === word) return at(f, st);
  }
  return null;
});

/** the document plus everything it @imports, transitively */
function* sheetsFrom(file: string, text: string, seen = new Set<string>()): Generator<{ file: string; sheet: Sheet }> {
  if (seen.has(file)) return;
  seen.add(file);
  let sheet: Sheet;
  try {
    sheet = parse(text, file);
  } catch {
    return;
  }
  yield { file, sheet };
  for (const s of sheet.statements) {
    if (s.kind !== "import") continue;
    const target = importTarget(s.path, file);
    try {
      if (target) yield* sheetsFrom(target, read(target), seen);
    } catch {}
  }
}

// ---------------------------------------------------------------- references & rename

type Sym = { sigil: "--" | "#" | "."; range: Pos };

/** the --var, #id or .template under the cursor, as its exact source range including the sigil */
function symbolAt(file: string, text: string, offset: number): Sym | undefined {
  const { word, start, end } = wordAt(text, offset);
  if (!word) return undefined;
  if (word.startsWith("--")) return { sigil: "--", range: { start, end, file } };
  if (text[start - 1] === "#") {
    // `color(#ff8000)` is a hex literal, not an id — but `ref(#lamp)` is an id
    const before = text.slice(0, start - 1).replace(/\s+$/, "");
    if (/[(,:]$/.test(before) && !/\bref\s*\($/.test(before)) return undefined;
    return { sigil: "#", range: { start: start - 1, end, file } };
  }
  if (text[start - 1] === ".") return { sigil: ".", range: { start: start - 1, end, file } };
  return undefined;
}

/** every .tscene in the workspace folders, plus whatever is open outside them */
function allFiles(): string[] {
  const files = new Set(documents.all().map(pathOf));
  for (const folder of folders) {
    try {
      for (const f of fs.globSync(path.join(folder, "**/*.tscene"), { exclude: (p) => p.includes("node_modules") })) {
        files.add(path.resolve(f));
      }
    } catch {}
  }
  return [...files];
}

const posKey = (p: Pos) => `${p.file}:${p.start}:${p.end}`;

/** what makes a sheet's contents different: the open buffer's version, or the file's mtime */
function stamp(file: string): string {
  const open = openDoc(file);
  if (open) return `${file}@${open.version}`;
  try {
    return `${file}@${fs.statSync(file).mtimeMs}`;
  } catch {
    return `${file}@-`;
  }
}

let graph: { key: string; value: ReturnType<typeof buildGraph> } | undefined;

/**
 * Every use↔declaration edge that expand() itself resolved, over every sheet in the workspace —
 * so shadowing, @import and template parameters all fall out of the real scoping rules.
 * Cached on the set of sheets and their versions: rename asks for the same graph once per file it edits.
 */
function bindingGraph(): ReturnType<typeof buildGraph> {
  const files = allFiles();
  const key = files.map(stamp).join("|");
  if (graph?.key !== key) graph = { key, value: buildGraph(files) };
  return graph.value;
}

async function buildGraph(files: string[]) {
  const edges = new Map<string, Set<string>>();
  const positions = new Map<string, Pos>();
  /** use → the declaration expand() actually resolved it to */
  const decls = new Map<string, Pos>();
  const link = (a: Pos, b: Pos) => {
    const [ka, kb] = [posKey(a), posKey(b)];
    positions.set(ka, a);
    positions.set(kb, b);
    (edges.get(ka) ?? edges.set(ka, new Set()).get(ka)!).add(kb);
    (edges.get(kb) ?? edges.set(kb, new Set()).get(kb)!).add(ka);
  };
  for (const file of files) {
    try {
      const { bindings } = await expand(parse(read(file), file), loader);
      for (const b of bindings) {
        link(b.use, b.decl);
        decls.set(posKey(b.use), b.decl);
      }
    } catch {} // a sheet mid-edit does not parse; the rest still bind
  }
  return { edges, positions, decls };
}

/** where the thing under the cursor was declared, as expand() resolved it */
const declarationOf = async (sym: Sym): Promise<Pos | undefined> => (await bindingGraph()).decls.get(posKey(sym.range));

/** the declaration's own source line, for hover — `--height: 1.5;` */
function declText(pos: Pos): string | undefined {
  try {
    const src = read(pos.file!);
    const semi = src.indexOf(";", pos.end);
    return src.slice(pos.start, semi < 0 ? pos.end : semi + 1).replace(/\s+/g, " ");
  } catch {
    return undefined;
  }
}

/** the declaration under the cursor, its uses, and anything a template parameter passes it to */
async function occurrences(sym: Sym): Promise<Pos[]> {
  const { edges, positions } = await bindingGraph();
  const root = posKey(sym.range);
  if (!edges.has(root)) return [sym.range]; // an #id, or a declaration nobody reads
  const seen = new Set([root]);
  for (const k of seen) for (const next of edges.get(k) ?? []) seen.add(next); // Set iteration picks up appends
  return [...seen].map((k) => positions.get(k)!);
}

const symbolUnderCursor = (uri: string, position: { line: number; character: number }) => {
  const doc = documents.get(uri);
  if (!doc) return undefined;
  return symbolAt(pathOf(doc), doc.getText(), doc.offsetAt(position));
};

const locations = (found: Pos[]) =>
  found.flatMap((p) => {
    try {
      const doc = docFor(p.file!);
      return [{ uri: doc.uri, range: range(doc, p) }];
    } catch {
      return [];
    }
  });

connection.onReferences(async (params) => {
  const sym = symbolUnderCursor(params.textDocument.uri, params.position);
  return sym ? locations(await occurrences(sym)) : [];
});

/** tells the editor up front what would be renamed, instead of failing after the user has typed a name */
connection.onPrepareRename((params) => {
  const doc = documents.get(params.textDocument.uri);
  const sym = symbolUnderCursor(params.textDocument.uri, params.position);
  if (!doc || !sym) return null;
  return { range: range(doc, sym.range), placeholder: doc.getText().slice(sym.range.start, sym.range.end) };
});

const NAME = /^[A-Za-z_][\w-]*$/;

connection.onRenameRequest(async (params) => {
  const sym = symbolUnderCursor(params.textDocument.uri, params.position);
  if (!sym) return null;
  const bare = params.newName.trim().replace(/^(--|[#.])/, "");
  if (!NAME.test(bare)) throw new Error(`${JSON.stringify(params.newName)} is not a valid ${sym.sigil === "--" ? "variable" : sym.sigil === "#" ? "id" : "template"} name`);
  const text = sym.sigil + bare;
  const changes: Record<string, TextEdit[]> = {};
  for (const { uri, range } of locations(await occurrences(sym))) (changes[uri] ??= []).push(TextEdit.replace(range, text));
  return { changes };
});

// ---------------------------------------------------------------- outline

connection.onDocumentSymbol((params) => {
  const doc = documents.get(params.textDocument.uri);
  const sheet = doc && tryParse(doc);
  if (!doc || !sheet) return [];

  const symbol = (o: ObjectValue): any => ({
    name: o.name + (o.id ? ` #${o.id}` : "") + o.classes.map((c) => `.${c}`).join(""),
    detail: className(o.name),
    kind: isA(className(o.name), "Light") ? SymbolKind.Event : SymbolKind.Class,
    range: range(doc, o),
    selectionRange: range(doc, { start: o.start, end: o.start + o.name.length }),
    children: o.body.filter((m) => m.kind === "node").map((m) => symbol((m as { object: ObjectValue }).object)),
  });

  return sheet.statements.flatMap((s) => {
    if (s.kind === "node") return [symbol(s.object)];
    if (s.kind === "template") {
      return [{
        name: `@template ${s.node ?? ""}.${s.name}`, kind: SymbolKind.Interface, range: range(doc, s),
        selectionRange: range(doc, { start: s.start, end: s.start + "@template .".length + (s.node?.length ?? 0) + s.name.length }), children: [],
      }];
    }
    if (s.kind === "override") {
      const last = s.selector[s.selector.length - 1]!;
      const head = { start: s.start, end: last.end };
      return [{
        name: `@override ${doc.getText(range(doc, head)).slice("@override".length).trim()}`,
        kind: SymbolKind.Interface, range: range(doc, s), selectionRange: range(doc, head), children: [],
      }];
    }
    if (s.kind === "var") {
      return [{
        name: `--${s.name}`, kind: SymbolKind.Variable, range: range(doc, s),
        selectionRange: range(doc, { start: s.start, end: s.start + s.name.length + 2 }), children: [],
      }];
    }
    return [];
  });
});

// ---------------------------------------------------------------- highlighting, folding, colours
//
// All three read the token stream, not the AST: a document being typed into is the one that most
// needs highlighting, and it is exactly the one that does not parse.

/** the legend the client is handed at initialize; a token's type is its index here */
const TOKEN_TYPES = ["comment", "string", "number", "keyword", "variable", "property", "class", "function", "enumMember", "decorator"];

/** is this ident inside an unclosed `calc(`? the token stream answer to {@link inCalc} */
function callable(toks: Tok[], i: number): boolean {
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    const t = toks[j]!;
    if (t.type !== "punc") continue;
    if (t.value === ")") depth++;
    else if (t.value === "(") {
      if (depth) { depth--; continue; }
      const name = toks[j - 1];
      return name?.type === "ident" && (name.value === "calc" || !!MATH[name.value]);
    } else if (t.value === "{" || t.value === "}" || t.value === ";") return false;
  }
  return false;
}

/** what a token means, decided from its neighbours — the parser's rules, one token of lookahead */
function tokenType(toks: Tok[], i: number): string | undefined {
  const t = toks[i]!;
  const prev = toks[i - 1];
  const next = toks[i + 1];
  switch (t.type) {
    case "string": return "string";
    case "number": return "number";
    case "at": return "keyword";
    case "var": return "variable";
    // `#ff8000` is a colour, `#box` an id — a literal only ever sits in a value position, which
    // includes inside an array: `[#ff0000, #00ff00]` is two colours, not two ids
    case "hash": return hexColor(t.value) && prev?.type === "punc" && "(,:[".includes(prev.value) ? "number" : "decorator";
    case "ident": break;
    default: return undefined;
  }
  if (next?.type === "punc" && next.value === ":") return "property";
  // `.glow` is a template, but `.getPoints(` and `.x` after a closed value read the value itself
  if (prev?.type === "punc" && prev.value === ".") {
    const before = toks[i - 2];
    return before?.type === "punc" && (before.value === ")" || before.value === "]")
      ? (next?.type === "punc" && next.value === "(" ? "function" : "property")
      : "decorator";
  }
  if (BUILTINS[t.value] || t.value === "each") return "function";
  // a math function is only one inside a calc(); elsewhere `min` could be anybody's property
  if (MATH[t.value] && callable(toks, i)) return "function";
  if (schema.classes[className(t.value)]) return "class";
  if (schema.constants[t.value]) return "enumMember";
  return "variable";
}

connection.languages.semanticTokens.on((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  const text = doc.getText();
  const { toks, comments } = tokenize(text, pathOf(doc));
  const spans = [
    ...comments.map((c) => ({ start: c.start, end: c.end, type: "comment" })),
    ...toks.flatMap((t, i) => { const type = tokenType(toks, i); return type ? [{ start: t.start, end: t.end, type }] : []; }),
  ].sort((a, b) => a.start - b.start);

  const data: number[] = [];
  let line = 0;
  let char = 0;
  for (const span of spans) {
    // a token may not cross a line, and a /* */ comment does — one piece per line
    for (let at = span.start; at < span.end; ) {
      const nl = text.indexOf("\n", at);
      const stop = nl < 0 || nl >= span.end ? span.end : nl;
      const pos = doc.positionAt(at);
      data.push(pos.line - line, pos.line === line ? pos.character - char : pos.character, stop - at, TOKEN_TYPES.indexOf(span.type), 0);
      [line, char] = [pos.line, pos.character];
      at = stop + 1;
    }
  }
  return { data };
});

connection.onFoldingRanges((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const { toks, comments } = tokenize(doc.getText(), pathOf(doc));
  const out: { startLine: number; endLine: number; kind?: string }[] = [];
  const line = (offset: number) => doc.positionAt(offset).line;
  const fold = (startLine: number, endLine: number, kind?: string) => {
    if (endLine > startLine) out.push({ startLine, endLine, ...(kind ? { kind } : {}) });
  };
  const stack: number[] = [];
  for (const t of toks) {
    if (t.type !== "punc") continue;
    if (t.value === "{") stack.push(t.start);
    // the closing brace stays visible, so a block written on one line folds to nothing and is dropped
    else if (t.value === "}" && stack.length) fold(line(stack.pop()!), line(t.start) - 1);
  }
  for (const c of comments) if (c.text.startsWith("/*")) fold(line(c.start), line(c.end), "comment");
  return out;
});

/**
 * `#rgb` or `#rrggbb` as the client's 0..1 channels.
 *
 * Three and six digits, and nothing else: a colour in a sheet has no alpha. `#ff800080` reaches three
 * as the plain number 4286578816, which `new Color()` reads as 24 bits and turns into a colour with
 * no relation to the one an editor would have shown — so an eight-digit literal gets no swatch rather
 * than a wrong one. Four digits the parser rejects outright.
 */
function hexColor(digits: string): { red: number; green: number; blue: number; alpha: number } | undefined {
  if (![3, 6].includes(digits.length) || !/^[0-9a-fA-F]+$/.test(digits)) return undefined;
  const short = digits.length === 3;
  const channel = (n: number) => {
    const d = digits.slice(n * (short ? 1 : 2), (n + 1) * (short ? 1 : 2));
    return parseInt(short ? d + d : d, 16) / 255;
  };
  return { red: channel(0), green: channel(1), blue: channel(2), alpha: 1 };
}

// three writes the working colour space, which is linear, when it is handed three numbers, and
// converts from sRGB when it is handed a hex or a name. So `color(1, .5, 0)` and `color(#ff8000)`
// are different colours, and a picker that showed them as the same one would be lying about one.
const linearToSRGB = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * `Color.NAMES`, read out of the three that is installed rather than copied in here — a list of 148
 * constants is exactly the kind of thing that goes quietly wrong when it is transcribed. Loaded on
 * the first swatch pass and kept; a three that will not import just means names get no swatch.
 */
let names: Record<string, number> | null | undefined;
async function colorNames(): Promise<Record<string, number>> {
  if (names === undefined) names = await import("three").then((m) => m.Color.NAMES as Record<string, number>, () => null);
  return names ?? {};
}

const fromHex = (hex: number | undefined): Color | undefined =>
  hex === undefined ? undefined : { red: ((hex >> 16) & 255) / 255, green: ((hex >> 8) & 255) / 255, blue: (hex & 255) / 255, alpha: 1 };

/** the tokens between the `(` at `open` and the `)` that closes it, or undefined if it never closes */
function callArgs(toks: Tok[], open: number): Tok[] | undefined {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.type !== "punc") continue;
    if (t.value === "(") depth++;
    else if (t.value === ")" && --depth === 0) return toks.slice(open + 1, i);
  }
  return undefined;
}

/** A swatch on every colour a sheet can write: `#ff8000`, `color("red")` and `color(1, .5, 0)`. */
connection.onDocumentColor(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const { toks } = tokenize(doc.getText(), pathOf(doc));
  const named = await colorNames();
  const out: ColorInformation[] = [];
  for (const [i, t] of toks.entries()) {
    if (t.type === "hash") {
      const color = tokenType(toks, i) === "number" ? hexColor(t.value) : undefined;
      if (color) out.push({ range: range(doc, t), color });
      continue;
    }
    if (t.type !== "ident" || t.value !== "color" || toks[i + 1]?.value !== "(") continue;
    // a lone `#ff8000` argument is the branch above — this is the rest of what `color()` accepts
    const args = callArgs(toks, i + 1)?.filter((a) => a.type !== "punc");
    if (!args?.length) continue;
    if (args.length === 1 && args[0]!.type === "string") {
      const text = args[0]!.value.trim();
      const color = /^#[0-9a-fA-F]+$/.test(text) ? hexColor(text.slice(1)) : fromHex(named[text.toLowerCase()]);
      if (color) out.push({ range: range(doc, args[0]!), color });
      continue;
    }
    if (args.length === 3 && args.every((a) => a.type === "number" && !a.unit)) {
      const [red, green, blue] = args.map((a) => linearToSRGB(Math.min(1, Math.max(0, Number(a.value)))));
      out.push({
        range: range(doc, { start: args[0]!.start, end: args[2]!.end }),
        color: { red: red!, green: green!, blue: blue!, alpha: 1 },
      });
    }
  }
  return out;
});

/**
 * Written back in the form it replaces: a picker must not turn `color(1, .5, 0)` into a hex literal
 * that means a different colour, nor drop the quotes a string argument is written with.
 * No alpha, ever — see {@link hexColor}.
 */
connection.onColorPresentation((params) => {
  const doc = documents.get(params.textDocument.uri);
  const was = doc ? doc.getText(params.range) : "";
  const { red, green, blue } = params.color;
  const byte = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  const hex = `#${byte(red)}${byte(green)}${byte(blue)}`;
  const edit = (label: string) => ({ label, textEdit: TextEdit.replace(params.range, label) });

  if (/^["']/.test(was)) {
    const quote = was[0]!;
    // the name, when the picked colour is exactly one — `"red"` reads better than `"#ff0000"`
    const exact = Object.entries(names ?? {}).find(([, v]) => v === parseInt(hex.slice(1), 16))?.[0];
    return [...(exact ? [edit(`${quote}${exact}${quote}`)] : []), edit(`${quote}${hex}${quote}`)];
  }
  if (/^[-.\d]/.test(was)) {
    const n = (v: number) => String(+srgbToLinear(v).toFixed(4));
    return [edit(`${n(red)}, ${n(green)}, ${n(blue)}`)];
  }
  return [edit(hex)];
});

// ---------------------------------------------------------------- formatting & quick fixes

connection.onDocumentFormatting(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const text = doc.getText();
  try {
    const formatted = await fixSource(text, pathOf(doc), schema, loader);
    return formatted === text ? [] : [TextEdit.replace({ start: doc.positionAt(0), end: doc.positionAt(text.length) }, formatted)];
  } catch {
    // fixSource refuses a sheet that does not parse, which is most of them most of the time. Format
    // on save then answered with an error, and the editor put a toast on screen for every save —
    // for something the squiggle already says. Nothing to format is an empty edit list.
    return [];
  }
});

connection.onCodeAction((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return params.context.diagnostics
    .filter((d) => d.data)
    .map((d) => {
      const fix = d.data as { start: number; end: number; text: string };
      return CodeAction.create(
        `replace with '${fix.text}'`,
        { changes: { [params.textDocument.uri]: [TextEdit.replace(range(doc, fix), fix.text)] } },
        CodeActionKind.QuickFix,
      );
    });
});

documents.listen(connection);
connection.listen();
