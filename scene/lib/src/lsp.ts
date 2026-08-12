#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
// Language server for .tscene: diagnostics, completion, hover, signature help,
// go-to-definition, document symbols, formatting and quick fixes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CodeAction, CodeActionKind, CompletionItemKind, createConnection, DiagnosticSeverity,
  ProposedFeatures, SymbolKind, TextDocumentSyncKind, TextDocuments, TextEdit,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { checkSource, fixSource, loadSchema, resolveSheet } from "./tools.ts";
import { ALIASES, BUILTINS, className, nodeName } from "./check.ts";
import { expand, parse, type Loader, type Member, type ObjectValue, type Pos, type Sheet } from "./parse.ts";
import type { ClassInfo, Schema, TypeRef } from "./schema.ts";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let schema: Schema;
let folders: string[] = [];

connection.onInitialize((params) => {
  const options = (params.initializationOptions ?? {}) as { entry?: string; modules?: string[]; declare?: string[] };
  folders = params.workspaceFolders?.map((f) => fileURLToPath(f.uri)) ?? (params.rootPath ? [params.rootPath] : []);
  // three may be installed at any folder root or above it (monorepo, global node_modules)
  const roots = [...folders, process.cwd()];
  for (const cwd of roots) {
    try {
      schema = loadSchema({ cwd, entry: options.entry, modules: options.modules, declare: options.declare });
      break;
    } catch (e) {
      if (cwd === roots.at(-1)) {
        connection.window.showErrorMessage(`three-scene: ${(e as Error).message}`);
        schema = {
          entry: options.entry ?? "three/webgpu", modules: options.modules ?? [], version: "0",
          classes: {}, constants: {}, declared: options.declare,
        };
      }
    }
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: [" ", ":", "{", "."] },
      hoverProvider: true,
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      documentLinkProvider: { resolveProvider: false },
      codeActionProvider: true,
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
  t.kind === "class" || t.kind === "enum" ? t.name : t.kind === "union" ? t.of.map(show).join(" | ") : t.kind === "array" ? `${show(t.of)}[]` : t.kind;
const signature = (name: string, info: ClassInfo) =>
  `${name}(${info.ctor.map((p) => `${p.name}${p.optional ? "?" : ""}: ${show(p.type)}`).join(", ")})`;

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
        source: "three-scene",
        data: d.fix,
      })),
  });
}

// an edit to one sheet changes the diagnostics of every sheet that @imports it
const revalidateAll = () => { for (const doc of documents.all()) void validate(doc); };
documents.onDidChangeContent(revalidateAll);
documents.onDidClose((e) => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  revalidateAll();
});
connection.onDidChangeWatchedFiles(revalidateAll);

// ---------------------------------------------------------------- position lookup

type Hit =
  | { kind: "object"; object: ObjectValue }
  | { kind: "prop"; name: string; cls: string | undefined; member: Member };

/** deepest AST hit at `offset` — the object whose name is under the cursor, or the property name */
function locate(sheet: Sheet, offset: number): Hit | undefined {
  let hit: Hit | undefined;
  const inside = (p: Pos) => offset >= p.start && offset <= p.end;

  const visitObject = (o: ObjectValue) => {
    if (!inside(o)) return;
    if (offset <= o.start + o.name.length) hit = { kind: "object", object: o };
    for (const a of o.args) if (a.kind === "object") visitObject(a);
    visitMembers(o.body, className(o.name));
  };
  const visitMembers = (members: Member[], cls: string | undefined) => {
    for (const m of members) {
      if (!inside(m)) continue;
      if (m.kind === "node") visitObject(m.object);
      else if (m.kind === "prop") {
        if (offset <= m.start + m.name.length) hit = { kind: "prop", name: m.name, cls, member: m };
        if (m.value.kind === "object") visitObject(m.value);
      }
    }
  };

  for (const s of sheet.statements) {
    if (s.kind === "node" || s.kind === "prop" || s.kind === "var") visitMembers([s], undefined);
    // a template body is checked against the node type it declares, so hover follows the same rule
    else if (s.kind === "template" && inside(s)) visitMembers(s.body, className(s.node ?? "object3D"));
  }
  return hit;
}

/**
 * Name of the block the cursor sits in — `mesh.floor #ground {` → `mesh`, `material: meshStandardMaterial {` → `meshStandardMaterial`.
 * Found by brace counting rather than parsing, because a document being typed into rarely parses.
 * ponytail: a `{`, `}` or `;` inside a comment or string throws this off; the parser owns diagnostics, this only drives completion.
 */
function enclosingName(text: string, offset: number): string | undefined {
  let depth = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{" && depth-- === 0) {
      const header = text.slice(0, i).split(/[;{}]/).pop()!;
      const template = /@template\s+([a-zA-Z_]\w*)?\s*\./.exec(header);
      if (template) return template[1] ?? "object3D";
      return /([a-zA-Z_]\w*)\s*$/.exec(header.replace(/\([^)]*\)/g, "").replace(/[.#][\w-]+/g, ""))?.[1];
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

  const owner = enclosingName(text, offset);
  const cls = owner ? schema.classes[className(owner)] : undefined;

  // right after `prop:` — offer only values that fit the declared type
  const afterColon = /([A-Za-z_][\w]*)\s*:\s*[\w-]*$/.exec(head);
  const prop = afterColon && cls?.props[afterColon[1]!];
  if (prop) return valueCompletions(prop.type);

  // inside a constructor call — only what fits the parameter under the cursor
  const call = activeCall(head);
  if (call) return valueCompletions(call.info.ctor[call.activeParameter]?.type ?? { kind: "any" });

  return [...(cls ? propCompletions(cls) : []), ...objectCompletions()];
});

/** ponytail: relative paths only — completing a bare specifier would mean scanning every package */
function importCompletions(doc: TextDocument, offset: number, typed: string) {
  const base = path.dirname(pathOf(doc));
  const dir = path.resolve(base, typed.endsWith("/") ? typed : path.dirname(typed));
  const prefix = typed.endsWith("/") ? "" : path.basename(typed);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const edit = (text: string) =>
    TextEdit.replace({ start: doc.positionAt(offset - prefix.length), end: doc.positionAt(offset) }, text);
  return entries
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
      const target = path.resolve(path.dirname(file), m[3]!);
      try {
        stack[0]!.push(...variablesAt(target, read(target), Infinity, seen));
      } catch {}
    }
  }
  return stack.flat();
}

const settable = (t: TypeRef, readonly: boolean) => !readonly || (t.kind === "class" && !!schema.classes[t.name]?.copyable);

const propCompletions = (cls: ClassInfo) =>
  Object.entries(cls.props)
    .filter(([, p]) => settable(p.type, p.readonly))
    .map(([name, p]) => ({ label: name, kind: CompletionItemKind.Property, detail: show(p.type), insertText: `${name}: ` }));

const objectCompletions = () => [
  ...Object.entries(BUILTINS).map(([name, b]) => ({ label: name, kind: CompletionItemKind.Keyword, detail: b.signature })),
  ...Object.entries(schema.classes)
    .filter(([, c]) => !c.abstract)
    .map(([name, c]) => ({ label: nodeName(name), kind: CompletionItemKind.Class, detail: signature(nodeName(name), c) })),
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
        out.push({ label, kind: CompletionItemKind.Constructor, detail: signature(label, info), insertText: `${label}(` });
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
  if (word && schema.constants[word]) {
    return { contents: md("```ts", `${word}: ${show(schema.constants[word]!)}`, "```", `exported by ${schema.entry}`), range: here };
  }

  const sheet = tryParse(doc);
  if (!sheet) return null;
  const hit = locate(sheet, offset);
  if (!hit) return null;

  if (hit.kind === "object") {
    const cls = className(hit.object.name);
    const info = schema.classes[cls];
    if (!info) return null;
    return {
      contents: md("```ts", signature(hit.object.name, info), "```", [cls, ...bases(cls)].join(" < "), ...(info.doc ? ["", info.doc] : [])),
      range: range(doc, { start: hit.object.start, end: hit.object.start + hit.object.name.length }),
    };
  }

  // a dotted path hovers as its own leaf: `material.color` → Material.color
  const path0 = hit.name.split(".");
  let cls = hit.cls;
  for (const seg of path0.slice(0, -1)) {
    const t = cls ? schema.classes[cls]?.props[seg]?.type : undefined;
    cls = t?.kind === "class" ? t.name : undefined;
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

/** the call the cursor is inside, walking back to the unclosed `(` and counting top-level commas */
function activeCall(head: string) {
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
  const info = name ? schema.classes[className(name)] : undefined;
  return name && info ? { name, info, activeParameter } : null;
}

connection.onSignatureHelp((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const call = activeCall(doc.getText().slice(0, doc.offsetAt(params.position)));
  if (!call) return null;
  const { name, info, activeParameter } = call;
  return {
    signatures: [{
      label: signature(name, info),
      parameters: info.ctor.map((p) => ({ label: `${p.name}${p.optional ? "?" : ""}: ${show(p.type)}` })),
    }],
    activeSignature: 0,
    activeParameter: Math.min(activeParameter, Math.max(0, info.ctor.length - 1)),
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
    const target = path.resolve(path.dirname(file), s.path);
    try {
      yield* sheetsFrom(target, read(target), seen);
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

/**
 * Every use↔declaration edge that expand() itself resolved, over every sheet in the workspace —
 * so shadowing, @import and template parameters all fall out of the real scoping rules.
 * ponytail: rebuilt per request; memoise on document version if a big workspace ever feels it.
 */
async function bindingGraph() {
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
  for (const file of allFiles()) {
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
    if (s.kind === "var") {
      return [{
        name: `--${s.name}`, kind: SymbolKind.Variable, range: range(doc, s),
        selectionRange: range(doc, { start: s.start, end: s.start + s.name.length + 2 }), children: [],
      }];
    }
    return [];
  });
});

// ---------------------------------------------------------------- formatting & quick fixes

connection.onDocumentFormatting(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const text = doc.getText();
  const formatted = await fixSource(text, pathOf(doc), schema, loader);
  return formatted === text ? [] : [TextEdit.replace({ start: doc.positionAt(0), end: doc.positionAt(text.length) }, formatted)];
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
