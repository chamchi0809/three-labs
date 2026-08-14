// .tscene — CSS-like syntax for three.js scene graphs.
//   nesting = children, `#id` = object.name, `.cls` = @template application.
//   values are explicit calls: vec3(0,1,0), color(#ff8000), texture("./t.png"), DoubleSide.
import { MATH, math } from "./names.ts";

export type Pos = { start: number; end: number; file?: string };

export type ObjectValue = Pos & {
  kind: "object";
  name: string;
  id?: string;
  /** source range of `#id` including the hash */
  idSpan?: Pos;
  classes: string[];
  /** source range of each `.cls` including the dot, index-aligned with `classes` */
  classSpans: Pos[];
  args: Value[];
  body: Member[];
  hasBody: boolean;
  /**
   * Set by expand() on a node inside an `each()` whose value depends on the loop binding. One AST node is
   * normally one instance — that is what makes a material in a `--var` shared — but a node that reads the
   * loop variable has to be built once per iteration.
   */
  dynamic?: true;
};

export type Value =
  | (Pos & { kind: "number"; value: number; unit: "" | "deg" | "rad" })
  | (Pos & { kind: "string"; value: string })
  | (Pos & { kind: "hex"; value: number })
  | (Pos & { kind: "ident"; name: string })
  | (Pos & { kind: "var"; name: string; fallback?: Value; namePos: Pos })
  /** `ref(#id)` — the instance built for that node. `node` is the node name expand() resolved it to. */
  | (Pos & { kind: "ref"; name: string; namePos: Pos; node?: string })
  | (Pos & { kind: "array"; items: Value[] })
  /** `namePos` is the key's own range — what a "no such setting" fix rewrites inside an `@bakery` block */
  | (Pos & { kind: "record"; entries: { name: string; namePos: Pos; value: Value }[] })
  | (Pos & { kind: "calc"; op: "+" | "-" | "*" | "/"; left: Value; right: Value })
  /** a {@link MATH} function inside `calc()`: `sin(x)`, `pow(x, 2)`, and `pi` with no arguments at all */
  | (Pos & { kind: "fn"; name: string; args: Value[] })
  /** `each(--j, 48, expr)` — `expr` once per index, or once per item when the second argument is an array */
  | (Pos & { kind: "each"; name: string; namePos: Pos; over: Value; body: Value })
  /** `var(--p).x` — a property of a value */
  | (Pos & { kind: "read"; target: Value; name: string; namePos: Pos })
  /** `splineCurve(…).getPoints(120)` — what a method of a value returns */
  | (Pos & { kind: "call"; target: Value; name: string; namePos: Pos; args: Value[] })
  /** `var(--points)[var(--i)]` */
  | (Pos & { kind: "index"; target: Value; at: Value })
  | ObjectValue;

export type Member =
  /** `name` may be a dotted path: `position.x`, `material.color` */
  | (Pos & { kind: "prop"; name: string; value: Value })
  | (Pos & { kind: "node"; object: ObjectValue })
  | (Pos & { kind: "var"; name: string; value: Value; namePos: Pos })
  /** `@bakery { size: 512 }` — settings for a tool, not for three. Valid at the top level and in any node */
  | (Pos & { kind: "at"; name: string; value: RecordValue });

export type RecordValue = Extract<Value, { kind: "record" }>;

export type Statement =
  | Member
  | (Pos & { kind: "import"; path: string })
  | (Pos & { kind: "template"; node?: string; name: string; body: Member[]; namePos: Pos });

export type Comment = Pos & { text: string };
/** `errors` is what the parser could not make sense of; `statements` is everything it could. */
export type Sheet = { statements: Statement[]; comments: Comment[]; text: string; file?: string; errors: Diagnostic[] };

export type Diagnostic = Pos & {
  message: string;
  severity: "error" | "warning";
  /** single-range text replacement the autofixer may apply */
  fix?: { start: number; end: number; text: string };
};

export class SceneSyntaxError extends Error {
  pos: Pos;
  constructor(message: string, pos: Pos) {
    super(message);
    this.pos = pos;
  }
}

// ---------------------------------------------------------------- lexer

export type TokType = "ident" | "number" | "string" | "hash" | "at" | "var" | "punc" | "eof";
export type Tok = Pos & { type: TokType; value: string; unit?: string };

const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
const isId = (c: string) => /[A-Za-z0-9_-]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

/**
 * The lexer, standing on its own — highlighting and folding need the tokens of a document that does
 * not parse yet.
 * @internal
 */
export function tokenize(text: string, file?: string): { toks: Tok[]; comments: Comment[]; errors: Diagnostic[] } {
  const toks: Tok[] = [];
  const comments: Comment[] = [];
  const errors: Diagnostic[] = [];
  const bad = (message: string, pos: Pos) => errors.push({ message, severity: "error", ...pos });
  let i = 0;
  const tok = (type: TokType, value: string, start: number, unit?: string) =>
    toks.push({ type, value, start, end: i, file, ...(unit ? { unit } : {}) });

  while (i < text.length) {
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    const start = i;
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      comments.push({ start, end: i, file, text: text.slice(start, i) });
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      comments.push({ start, end: i, file, text: text.slice(start, i) });
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      let out = "";
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") { out += text[i + 1] ?? ""; i += 2; }
        else out += text[i++];
      }
      if (i >= text.length) bad("unterminated string", { start, end: i, file });
      else i++;
      tok("string", out, start);
      continue;
    }
    if (c === "#") {
      i++;
      while (i < text.length && isId(text[i]!)) i++;
      tok("hash", text.slice(start + 1, i), start);
      continue;
    }
    if (c === "@") {
      i++;
      while (i < text.length && isId(text[i]!)) i++;
      tok("at", text.slice(start + 1, i), start);
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      i += 2;
      while (i < text.length && isId(text[i]!)) i++;
      tok("var", text.slice(start + 2, i), start);
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(text[i + 1] ?? "")) || ((c === "-" || c === "+") && (isDigit(text[i + 1] ?? "") || text[i + 1] === "."))) {
      if (c === "-" || c === "+") i++;
      if (text[i] === "0" && (text[i + 1] === "x" || text[i + 1] === "X")) {
        i += 2;
        while (i < text.length && /[0-9a-fA-F]/.test(text[i]!)) i++;
      } else {
        while (i < text.length && isDigit(text[i]!)) i++;
        if (text[i] === ".") { i++; while (i < text.length && isDigit(text[i]!)) i++; }
        if (text[i] === "e" || text[i] === "E") {
          i++;
          if (text[i] === "-" || text[i] === "+") i++;
          while (i < text.length && isDigit(text[i]!)) i++;
        }
      }
      const numEnd = i;
      while (i < text.length && /[a-zA-Z%]/.test(text[i]!)) i++;
      tok("number", text.slice(start, numEnd), start, text.slice(numEnd, i));
      continue;
    }
    if (isIdStart(c)) {
      i++;
      while (i < text.length && isId(text[i]!)) i++;
      tok("ident", text.slice(start, i), start);
      continue;
    }
    if ("{}[]();:,.+-*/".includes(c)) { i++; tok("punc", c, start); continue; }
    i++;
    bad(`unexpected character ${JSON.stringify(c)}`, { start, end: i, file });
  }
  toks.push({ type: "eof", value: "", start: text.length, end: text.length, file });
  return { toks, comments, errors };
}

// ---------------------------------------------------------------- parser

export function parse(text: string, file?: string): Sheet {
  const { toks, comments, errors } = tokenize(text, file);
  let p = 0;
  const peek = (n = 0) => toks[Math.min(p + n, toks.length - 1)]!;
  const next = () => toks[p++]!;
  const at = (type: TokType, value?: string) => peek().type === type && (value === undefined || peek().value === value);
  const fail = (msg: string, t: Tok = peek()): never => {
    throw new SceneSyntaxError(`${msg}, got ${t.type === "eof" ? "end of file" : JSON.stringify(t.value)}`, t);
  };
  const expect = (type: TokType, value?: string) => (at(type, value) ? next() : fail(`expected ${value ?? type}`));
  const eatSemis = () => { while (at("punc", ";")) next(); };

  /**
   * Records the error and skips to the end of the broken statement, so one typo does not
   * blank out the diagnostics (and the completions) for the rest of the file.
   */
  function recover(e: unknown) {
    if (!(e instanceof SceneSyntaxError)) throw e;
    errors.push({ message: e.message, severity: "error", ...e.pos });
    let depth = 0;
    for (;;) {
      const t = peek();
      if (t.type === "eof") return;
      if (t.type === "punc") {
        if ("{[(".includes(t.value)) depth++;
        else if ("}])".includes(t.value)) {
          if (depth === 0) return; // the enclosing block closes here — let it
          depth--;
        } else if (t.value === ";" && depth === 0) { next(); return; }
      }
      next();
    }
  }

  function parseSheet(): Statement[] {
    const out: Statement[] = [];
    eatSemis();
    while (!at("eof")) {
      const before = p;
      try {
        out.push(parseStatement());
      } catch (e) {
        recover(e);
        if (p === before) next(); // a stray `}` at top level: drop it and keep going
      }
      eatSemis();
    }
    return out;
  }

  // `@bakery` is a member, so it also works inside a node — the other two are top level only
  function parseStatement(): Statement {
    if (at("at") && (peek().value === "import" || peek().value === "template")) {
      const t = next();
      if (t.value === "import") {
        const s = expect("string");
        const end = at("punc", ";") ? next().end : s.end;
        return { kind: "import", path: s.value, start: t.start, end, file };
      }
      // `@template mesh.glow { }` — the node type it applies to, `@template .glow { }` for any Object3D
      const node = at("ident") ? next().value : undefined;
      const dot = expect("punc", ".");
      const name = expect("ident");
      const body = parseBlock();
      const namePos = { start: dot.start, end: name.end, file };
      return { kind: "template", node, name: name.value, body: body.members, namePos, start: t.start, end: body.end, file };
    }
    return parseMember();
  }

  function parseMember(): Member {
    const t = peek();
    if (t.type === "at") {
      next();
      if (t.value !== "bakery") return fail(`unknown at-rule @${t.value}`, t);
      if (!at("punc", "{")) return fail(`@${t.value} takes a block: @${t.value} { size: 512 }`);
      const value = parseValue() as RecordValue;
      const end = at("punc", ";") ? next().end : value.end;
      return { kind: "at", name: t.value, value, start: t.start, end, file };
    }
    if (t.type === "var") {
      next();
      expect("punc", ":");
      const value = parseValue();
      const end = at("punc", ";") ? next().end : value.end;
      return { kind: "var", name: t.value, value, namePos: { start: t.start, end: t.end, file }, start: t.start, end, file };
    }
    if (t.type !== "ident") return fail("expected a property or node name");
    // `position.x: 1` — a dotted path into a property of a property. `mesh.glow #a {` is not one:
    // only a run of `ident (. ident)*` that ends in `:` is a property.
    const path = [t.value];
    let k = 1;
    while (peek(k).type === "punc" && peek(k).value === "." && peek(k + 1).type === "ident") {
      path.push(peek(k + 1).value);
      k += 2;
    }
    if (peek(k).type === "punc" && peek(k).value === ":") {
      for (let n = 0; n <= k; n++) next();
      const value = parseValue();
      const end = at("punc", ";") ? next().end : value.end;
      return { kind: "prop", name: path.join("."), value, start: t.start, end, file };
    }
    const object = parseObject();
    const end = at("punc", ";") ? next().end : object.end;
    return { kind: "node", object, start: object.start, end, file };
  }

  function parseBlock(): { members: Member[]; end: number } {
    const open = expect("punc", "{");
    const members: Member[] = [];
    eatSemis();
    while (!at("punc", "}")) {
      if (at("eof")) {
        errors.push({ message: "expected }, got end of file", severity: "error", start: open.start, end: open.end, file });
        return { members, end: peek().end };
      }
      const before = p;
      try {
        members.push(parseMember());
      } catch (e) {
        recover(e);
        if (p === before) next();
      }
      eatSemis();
    }
    return { members, end: next().end };
  }

  function parseObject(): ObjectValue {
    const name = expect("ident");
    let id: string | undefined;
    let idSpan: Pos | undefined;
    const classes: string[] = [];
    const classSpans: Pos[] = [];
    for (;;) {
      if (at("hash")) {
        const h = next();
        id = h.value;
        idSpan = { start: h.start, end: h.end, file };
        continue;
      }
      if (at("punc", ".")) {
        const dot = next();
        const cls = expect("ident");
        classes.push(cls.value);
        classSpans.push({ start: dot.start, end: cls.end, file });
        continue;
      }
      break;
    }
    const args: Value[] = [];
    if (at("punc", "(")) {
      next();
      while (!at("punc", ")")) {
        args.push(parseValue());
        if (at("punc", ",")) next();
        else break;
      }
      expect("punc", ")");
    }
    let body: Member[] = [];
    let hasBody = false;
    let end = toks[p - 1]!.end;
    if (at("punc", "{")) {
      const b = parseBlock();
      body = b.members;
      end = b.end;
      hasBody = true;
    }
    return { kind: "object", name: name.value, id, idSpan, classes, classSpans, args, body, hasBody, start: name.start, end, file };
  }

  /**
   * `.name`, `.name(…)` and `[…]` after a value that is already complete. A `.` *before* an argument list
   * is a `@template` class, which is why `parseObject` has eaten those already — `foo.glow(1)` applies a
   * template, `foo(1).glow` reads a property.
   */
  function postfix(target: Value): Value {
    for (;;) {
      if (at("punc", ".") && peek(1).type === "ident") {
        next();
        const name = expect("ident");
        const namePos = { start: name.start, end: name.end, file };
        if (!at("punc", "(")) {
          target = { kind: "read", target, name: name.value, namePos, start: target.start, end: name.end, file };
          continue;
        }
        next();
        const args: Value[] = [];
        while (!at("punc", ")")) {
          args.push(parseValue());
          if (at("punc", ",")) next();
          else break;
        }
        target = { kind: "call", target, name: name.value, namePos, args, start: target.start, end: expect("punc", ")").end, file };
        continue;
      }
      if (at("punc", "[")) {
        next();
        const at0 = parseValue();
        target = { kind: "index", target, at: at0, start: target.start, end: expect("punc", "]").end, file };
        continue;
      }
      return target;
    }
  }

  const parseValue = (): Value => postfix(parsePrimary());

  function parsePrimary(): Value {
    const t = peek();
    if (t.type === "punc" && t.value === "[") {
      next();
      const items: Value[] = [];
      while (!at("punc", "]")) {
        items.push(parseValue());
        if (at("punc", ",")) next();
        else break;
      }
      return { kind: "array", items, start: t.start, end: expect("punc", "]").end, file };
    }
    if (t.type === "punc" && t.value === "{") {
      next();
      const entries: RecordValue["entries"] = [];
      eatSemis();
      while (!at("punc", "}")) {
        const name = at("string") ? next() : expect("ident");
        expect("punc", ":");
        entries.push({ name: name.value, namePos: { start: name.start, end: name.end, file }, value: parseValue() });
        if (at("punc", ",")) next();
        eatSemis();
      }
      return { kind: "record", entries, start: t.start, end: expect("punc", "}").end, file };
    }
    if (t.type === "number") {
      next();
      const unit = t.unit ?? "";
      if (unit && unit !== "deg" && unit !== "rad") fail(`unknown unit ${JSON.stringify(unit)}`, t);
      const value = /^[-+]?0[xX]/.test(t.value) ? Number(t.value) : parseFloat(t.value);
      return { kind: "number", value, unit: unit as "" | "deg" | "rad", start: t.start, end: t.end, file };
    }
    if (t.type === "string") { next(); return { kind: "string", value: t.value, start: t.start, end: t.end, file }; }
    if (t.type === "hash") {
      next();
      if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(t.value)) fail("expected a hex color like #ff8000", t);
      const hex = t.value.length === 3 ? t.value.replace(/./g, (c) => c + c) : t.value;
      return { kind: "hex", value: parseInt(hex, 16), start: t.start, end: t.end, file };
    }
    if (t.type === "ident") {
      if (t.value === "var" && peek(1).type === "punc" && peek(1).value === "(") {
        next(); next();
        const name = expect("var");
        const fallback = at("punc", ",") ? (next(), parseValue()) : undefined;
        const close = expect("punc", ")");
        return { kind: "var", name: name.value, fallback, namePos: { start: name.start, end: name.end, file }, start: t.start, end: close.end, file };
      }
      if (t.value === "ref" && peek(1).type === "punc" && peek(1).value === "(") {
        next(); next();
        const target = expect("hash");
        const close = expect("punc", ")");
        return { kind: "ref", name: target.value, namePos: { start: target.start, end: target.end, file }, start: t.start, end: close.end, file };
      }
      if (t.value === "calc" && peek(1).type === "punc" && peek(1).value === "(") {
        next(); next();
        const expr = parseSum();
        return { ...expr, start: t.start, end: expect("punc", ")").end, file };
      }
      // `each(--j, 48, expr)` — a list, so it is a value and never a node
      if (t.value === "each" && peek(1).type === "punc" && peek(1).value === "(") {
        next(); next();
        const name = expect("var");
        expect("punc", ",");
        const over = parseValue();
        expect("punc", ",");
        const body = parseValue();
        const close = expect("punc", ")");
        const namePos = { start: name.start, end: name.end, file };
        return { kind: "each", name: name.value, namePos, over, body, start: t.start, end: close.end, file };
      }
      const n = peek(1);
      const isObject = n.type === "hash" || (n.type === "punc" && (n.value === "(" || n.value === "{" || n.value === "."));
      if (isObject) return parseObject();
      next();
      return { kind: "ident", name: t.value, start: t.start, end: t.end, file };
    }
    return fail("expected a value");
  }

  // calc(): `+ -` over `* /` over atoms. Folded to a number by expand(), once vars are known.
  const parseSum = () => binary(parseProduct, "+", "-");
  const parseProduct = () => binary(parseAtom, "*", "/");

  function binary(operand: () => Value, ...ops: ("+" | "-" | "*" | "/")[]): Value {
    let left = operand();
    for (;;) {
      const op = calcOp(ops);
      if (!op) return left;
      const right = operand();
      left = { kind: "calc", op, left, right, start: left.start, end: right.end, file };
    }
  }

  /** the operator in front of the cursor — `2 -1` counts, the sign is peeled off the number token */
  function calcOp(ops: ("+" | "-" | "*" | "/")[]): "+" | "-" | "*" | "/" | undefined {
    for (const op of ops) if (at("punc", op)) { next(); return op; }
    const t = peek();
    if (t.type === "number" && ops.includes(t.value[0] as "+" | "-")) {
      const op = t.value[0] as "+" | "-";
      t.value = t.value.slice(1); // the lexer swallowed the sign into the number — peel it back off
      t.start++;
      return op;
    }
    return undefined;
  }

  function parseAtom(): Value {
    if (at("punc", "(")) {
      next();
      const v = parseSum();
      expect("punc", ")");
      return postfix(v);
    }
    const t = peek();
    // a math function, and `pi`, which takes no arguments and so needs no parens
    if (t.type === "ident" && MATH[t.value]) {
      const parens = peek(1).type === "punc" && peek(1).value === "(";
      if (parens || MATH[t.value]!.arity === 0) {
        next();
        const args: Value[] = [];
        if (parens) {
          next();
          while (!at("punc", ")")) {
            args.push(parseSum());
            if (at("punc", ",")) next();
            else break;
          }
        }
        const end = parens ? expect("punc", ")").end : t.end;
        return { kind: "fn", name: t.value, args, start: t.start, end, file };
      }
    }
    return parseValue();
  }

  const statements = parseSheet();
  return { statements, comments, text, file, errors: errors.sort((a, b) => a.start - b.start) };
}

export function lineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") { line++; last = i; }
  return { line, col: offset - last };
}

// ---------------------------------------------------------------- printer / autofixer

/** Re-print a sheet with canonical formatting. Comments are kept but always land on their own line. */
export function print(sheet: Sheet): string {
  const comments = [...sheet.comments].sort((a, b) => a.start - b.start);
  let ci = 0;
  const out: string[] = [];
  const emit = (indent: string, s: string) => out.push(indent + s);

  // comments are re-emitted in source order, each on its own line
  const flush = (before: number, indent: string, push: (s: string) => void = (s) => out.push(s)) => {
    while (ci < comments.length && comments[ci]!.start < before) {
      for (const line of comments[ci]!.text.split("\n")) push(indent + line.trim());
      ci++;
    }
  };

  const value = (v: Value, indent = ""): string => {
    switch (v.kind) {
      case "number": return `${v.value}${v.unit}`;
      case "string": return JSON.stringify(v.value);
      case "hex": return "#" + v.value.toString(16).padStart(6, "0");
      case "ident": return v.name;
      case "var": return `var(--${v.name}${v.fallback ? `, ${value(v.fallback, indent)}` : ""})`;
      case "ref": return `ref(#${v.name})`;
      case "array": return `[${v.items.map((i) => value(i, indent)).join(", ")}]`;
      case "record": return `{ ${v.entries.map((e) => `${e.name}: ${value(e.value, indent)}`).join("; ")} }`;
      case "calc": return `calc(${expr(v, indent)})`;
      // a bare fn only ever comes out of a calc(), so it needs the wrapper back
      case "fn": return `calc(${arith(v, indent)})`;
      case "each": return `each(--${v.name}, ${value(v.over, indent)}, ${value(v.body, indent)})`;
      case "read": return `${value(v.target, indent)}.${v.name}`;
      case "call": return `${value(v.target, indent)}.${v.name}(${v.args.map((a) => value(a, indent)).join(", ")})`;
      case "index": return `${value(v.target, indent)}[${value(v.at, indent)}]`;
      case "object": return object(v, indent);
    }
  };

  // nested arithmetic is always parenthesised, so precedence survives a round trip
  const expr = (v: Value & { kind: "calc" }, indent: string): string => {
    const side = (s: Value) => (s.kind === "calc" ? `(${expr(s, indent)})` : arith(s, indent));
    return `${side(v.left)} ${v.op} ${side(v.right)}`;
  };

  /** inside a calc(), where a function is written bare rather than wrapped in another calc() */
  const arith = (v: Value, indent: string): string =>
    v.kind === "fn"
      ? MATH[v.name]!.arity === 0
        ? v.name
        : `${v.name}(${v.args.map((a) => (a.kind === "calc" ? expr(a, indent) : arith(a, indent))).join(", ")})`
      : value(v, indent);

  const header = (o: ObjectValue) =>
    o.name + o.classes.map((c) => `.${c}`).join("") + (o.id ? ` #${o.id}` : "") +
    (o.args.length || (!o.hasBody && !o.id && !o.classes.length) ? `(${o.args.map((a) => value(a)).join(", ")})` : "");

  const object = (o: ObjectValue, indent: string): string => {
    if (!o.hasBody) return header(o);
    const inner = members(o.body, indent + "  ", o.end);
    return inner ? `${header(o)} {\n${inner}\n${indent}}` : `${header(o)} {}`;
  };

  // `end` is the closing brace of the block: comments sitting after the last member belong inside it
  const members = (list: Member[], indent: string, end = -Infinity): string => {
    const lines: string[] = [];
    const push = (s: string) => lines.push(...s.split("\n"));
    for (const m of list) {
      flush(m.start, indent, push);
      if (m.kind === "prop") push(indent + `${m.name}: ${value(m.value, indent)};`);
      else if (m.kind === "var") push(indent + `--${m.name}: ${value(m.value, indent)};`);
      else if (m.kind === "at") push(indent + `@${m.name} ${value(m.value, indent)};`);
      else push(indent + object(m.object, indent));
    }
    flush(end, indent, push);
    return lines.join("\n");
  };

  for (const s of sheet.statements) {
    flush(s.start, "");
    if (s.kind === "import") emit("", `@import ${JSON.stringify(s.path)};`);
    else if (s.kind === "template") {
      const inner = members(s.body, "  ", s.end);
      const head = `@template ${s.node ?? ""}.${s.name}`;
      emit("", inner ? `${head} {\n${inner}\n}` : `${head} {}`);
    } else out.push(members([s], ""));
    out.push("");
  }
  flush(Infinity, "");
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

/** Apply non-overlapping single-range fixes to source text. */
export function applyFixes(text: string, diagnostics: Diagnostic[]): string {
  const fixes = diagnostics.map((d) => d.fix).filter((f) => !!f).sort((a, b) => b.start - a.start);
  let out = text;
  let prev = Infinity;
  for (const f of fixes) {
    if (f.end > prev) continue; // overlapping fix — skip, next run picks it up
    out = out.slice(0, f.start) + f.text + out.slice(f.end);
    prev = f.start;
  }
  return out;
}

// ---------------------------------------------------------------- expansion (@import / vars / @template)

export type Loader = (path: string, from: string | undefined) => Promise<{ text: string; file: string }>;

export type Template = Extract<Statement, { kind: "template" }>;

/** a resolved use site and the declaration it resolved to — what "find references" and "rename" run on */
export type Binding = { use: Pos; decl: Pos };

export type Expanded = {
  nodes: Member[];
  diagnostics: Diagnostic[];
  templates: Template[];
  bindings: Binding[];
  /** `#id` → the node that declared it, in document order */
  ids: Map<string, ObjectValue>;
};

type Bound = { value: Value; decl: Pos };
type Scope = {
  vars: Map<string, Bound>;
  /** names declared in *this* block, so a redeclaration can be told from shadowing an outer one */
  own: Set<string>;
  templates: Map<string, { body: Member[]; scope: Scope; decl: Pos }>;
  /**
   * Names an `each()` binds. They have no value until the loop runs, so `var()` is left standing and the
   * arithmetic around it stays unfolded — the runtime is what finally evaluates it.
   */
  loop: Map<string, Pos>;
};

const childScope = (s: Scope): Scope => ({ vars: new Map(s.vars), own: new Set(), templates: s.templates, loop: s.loop });

/**
 * Can the constant folder still work this out, or does it have to wait for the runtime? A loop binding, a
 * property of one, or what a method returns are all only known once the scene is being built; a string or
 * a list never becomes a number, and those are what `calc() works on numbers only` is for.
 */
function deferred(v: Value): boolean {
  switch (v.kind) {
    case "var": case "read": case "call": case "index": case "each": case "ident": case "object": case "ref": return true;
    case "calc": return deferred(v.left) || deferred(v.right);
    case "fn": return v.args.some(deferred);
    default: return false;
  }
}

/** does this value read a loop binding — i.e. is it a different value on every iteration? */
function varies(v: Value, loop: Map<string, Pos>): boolean {
  switch (v.kind) {
    case "var": return loop.has(v.name);
    case "calc": return varies(v.left, loop) || varies(v.right, loop);
    case "fn": return v.args.some((a) => varies(a, loop));
    case "array": return v.items.some((i) => varies(i, loop));
    case "record": return v.entries.some((e) => varies(e.value, loop));
    case "read": return varies(v.target, loop);
    case "index": return varies(v.target, loop) || varies(v.at, loop);
    case "call": return varies(v.target, loop) || v.args.some((a) => varies(a, loop));
    // an each() of its own shadows nothing it does not bind, so its body counts too
    case "each": return varies(v.over, loop) || varies(v.body, loop);
    case "object": return v.args.some((a) => varies(a, loop)) || v.body.some((m) => m.kind !== "node" ? varies(m.value, loop) : varies(m.object, loop));
    default: return false;
  }
}

/** Resolves @import, substitutes var(--x) and applies .class templates. */
export async function expand(sheet: Sheet, load?: Loader): Promise<Expanded> {
  const diagnostics: Diagnostic[] = [];
  const templates: Template[] = [];
  const scope: Scope = { vars: new Map(), own: new Set(), templates: new Map(), loop: new Map() };
  const root = sheet.file ?? "<input>";
  const included = new Set<string>([root]);
  const ids = new Map<string, ObjectValue>();
  const pendingRefs: Extract<Value, { kind: "ref" }>[] = [];
  const declaredVars: (Member & { kind: "var" })[] = [];
  const bindings: Binding[] = [];
  /** declarations something actually resolved to — what "never used" is measured against */
  const usedDecls = new Set<string>();
  const declKey = (p: Pos) => `${p.file}:${p.start}:${p.end}`;
  const bind = (use: Pos, decl: Pos) => {
    bindings.push({ use, decl });
    usedDecls.add(declKey(decl));
  };
  const err = (message: string, pos: Pos) => diagnostics.push({ message, severity: "error", ...pos });
  const warn = (message: string, pos: Pos) => diagnostics.push({ message, severity: "warning", ...pos });

  /** `chain` is the @import path being followed, so a diamond is fine and only a real cycle errors */
  async function collect(s: Sheet, sc: Scope, chain: string[]): Promise<Member[]> {
    const nodes: Member[] = [];
    const top = new Set<string>();
    for (const st of s.statements) {
      if (st.kind === "import") {
        if (!load) { err("@import needs a loader", st); continue; }
        try {
          const { text, file } = await load(st.path, s.file);
          if (chain.includes(file)) { err(`circular @import of ${st.path}`, st); continue; }
          if (included.has(file)) continue; // already spliced in elsewhere — @import is idempotent
          included.add(file);
          nodes.push(...(await collect(parse(text, file), sc, [...chain, file])));
        } catch (e) {
          err(e instanceof SceneSyntaxError ? `in ${st.path}: ${e.message}` : `cannot import ${st.path}: ${(e as Error).message}`, st);
        }
      } else if (st.kind === "template") {
        const prev = sc.templates.get(st.name);
        if (prev) {
          warn(`.${st.name} is already defined; the later declaration wins`, st);
          usedDecls.add(declKey(prev.decl)); // shadowed, not dead — the duplicate warning covers it
        }
        sc.templates.set(st.name, { body: st.body, scope: sc, decl: st.namePos });
        duplicates(st.body);
        templates.push(st);
      } else if (st.kind === "var") {
        if (top.has(st.name)) warn(`--${st.name} is set twice in this file`, st);
        top.add(st.name);
        declare(st, sc);
      } else if (isRepeat(st)) {
        nodes.push(...repeat((st as Member & { kind: "node" }).object, sc));
      } else {
        nodes.push(member(st, sc));
      }
    }
    return nodes;
  }

  function declare(m: Member & { kind: "var" }, sc: Scope) {
    const prev = sc.own.has(m.name) ? sc.vars.get(m.name) : undefined;
    if (prev) usedDecls.add(declKey(prev.decl)); // redeclared in the same block — "set twice" covers it
    sc.vars.set(m.name, { value: subst(m.value, sc), decl: m.namePos });
    sc.own.add(m.name);
    declaredVars.push(m);
  }

  /** repeated property or variable names inside one literal body — the later one silently wins */
  function duplicates(body: Member[]) {
    const seen = new Set<string>();
    for (const m of body) {
      if (m.kind === "node") continue;
      const key = `${m.kind}:${m.name}`;
      const shown = m.kind === "var" ? `--${m.name}` : m.kind === "at" ? `@${m.name}` : m.name;
      if (seen.has(key)) warn(`${shown} is set twice in this block`, m);
      seen.add(key);
    }
  }

  function fold(v: Value & { kind: "calc" }, sc: Scope): Value {
    const left = subst(v.left, sc);
    const right = subst(v.right, sc);
    if (left.kind !== "number" || right.kind !== "number") {
      // not statically a number: the runtime folds what is left of the expression
      if (deferred(left) || deferred(right)) return { ...v, left, right };
      err("calc() works on numbers only", v);
      return { kind: "number", value: 0, unit: "", start: v.start, end: v.end, file: v.file };
    }
    if (left.unit && right.unit && left.unit !== right.unit) err(`calc() cannot mix ${left.unit} and ${right.unit}`, v);
    const value = v.op === "+" ? left.value + right.value
      : v.op === "-" ? left.value - right.value
        : v.op === "*" ? left.value * right.value
          : right.value === 0 ? (err("calc() divides by zero", v), 0) : left.value / right.value;
    return { kind: "number", value, unit: left.unit || right.unit, start: v.start, end: v.end, file: v.file };
  }

  /** `sin(x)` and friends: folded when the arguments are already numbers, left standing when they are not */
  function apply(v: Value & { kind: "fn" }, sc: Scope): Value {
    const args = v.args.map((a) => subst(a, sc));
    const knob = MATH[v.name]!;
    if (args.length !== knob.arity) {
      err(`${v.name}() takes ${knob.arity} argument(s), got ${args.length}`, v);
      return { kind: "number", value: 0, unit: "", start: v.start, end: v.end, file: v.file };
    }
    if (!args.every((a) => a.kind === "number")) {
      if (args.some(deferred)) return { ...v, args };
      err(`${v.name}() works on numbers only`, v);
      return { kind: "number", value: 0, unit: "", start: v.start, end: v.end, file: v.file };
    }
    const numbers = args.map((a) => (a.kind === "number" && a.unit === "deg" ? (a.value * Math.PI) / 180 : (a as { value: number }).value));
    return { kind: "number", value: math(v.name, numbers), unit: "", start: v.start, end: v.end, file: v.file };
  }

  /** `each(--j, 48, expr)` — the binding is the loop's, so the body is substituted with it left standing */
  function loop(v: Value & { kind: "each" }, sc: Scope): Value {
    const inner = childScope(sc);
    inner.loop = new Map(sc.loop);
    // `--index` and `--count` come along, exactly as they do in repeat()
    for (const name of [v.name, "index", "count"]) inner.loop.set(name, v.namePos);
    return { ...v, over: subst(v.over, sc), body: subst(v.body, inner) };
  }

  function subst(v: Value, sc: Scope): Value {
    if (v.kind === "var") {
      // a name the enclosing each() binds shadows every declaration of it; it gets its value at run time
      const bound = sc.loop.get(v.name);
      if (bound) { bind(v.namePos, bound); return v; }
      const found = sc.vars.get(v.name);
      if (found) { bind(v.namePos, found.decl); return found.value; }
      if (v.fallback) return subst(v.fallback, sc);
      err(`unknown variable --${v.name}`, v);
      return { kind: "ident", name: "null", start: v.start, end: v.end, file: v.file };
    }
    // a ref may name a node further down the sheet, so it is resolved once everything is expanded
    if (v.kind === "ref") {
      const out = { ...v };
      pendingRefs.push(out);
      return out;
    }
    if (v.kind === "calc") return fold(v, sc);
    if (v.kind === "fn") return apply(v, sc);
    if (v.kind === "each") return loop(v, sc);
    if (v.kind === "read") return { ...v, target: subst(v.target, sc) };
    if (v.kind === "index") return { ...v, target: subst(v.target, sc), at: subst(v.at, sc) };
    if (v.kind === "call") return { ...v, target: subst(v.target, sc), args: v.args.map((a) => subst(a, sc)) };
    if (v.kind === "array") return { ...v, items: v.items.map((i) => subst(i, sc)) };
    if (v.kind === "record") return { ...v, entries: v.entries.map((e) => ({ ...e, value: subst(e.value, sc) })) };
    if (v.kind === "object") return object(v, sc);
    return v;
  }

  let inRepeat = 0;

  /** `repeat(3) { … }` — n copies of its body, with `--index` (0-based) and `--count` bound inside each */
  function repeat(o: ObjectValue, outer: Scope): Member[] {
    const count = o.args.length === 1 ? subst(o.args[0]!, outer) : undefined;
    if (!count || count.kind !== "number" || !Number.isInteger(count.value) || count.value < 0) {
      err("repeat() takes one whole number, e.g. repeat(3) { … }", o);
      return [];
    }
    if (o.id || o.classes.length) err("repeat() takes no #id or template", o);
    const num = (value: number): Value => ({ kind: "number", value, unit: "", start: o.start, end: o.end, file: o.file });
    const out: Member[] = [];
    inRepeat++;
    for (let i = 0; i < count.value; i++) {
      const sc = childScope(outer);
      sc.vars.set("index", { value: num(i), decl: o });
      sc.vars.set("count", { value: num(count.value), decl: o });
      out.push(...expandBody(o.body, sc));
    }
    inRepeat--;
    return out;
  }

  const isRepeat = (m: Member) => m.kind === "node" && m.object.name === "repeat";

  function member(m: Member, sc: Scope): Member {
    if (m.kind === "prop") return { ...m, value: subst(m.value, sc) };
    if (m.kind === "node") return { ...m, object: object(m.object, sc) };
    if (m.kind === "at") return { ...m, value: subst(m.value, sc) as RecordValue };
    return m;
  }

  function object(o: ObjectValue, outer: Scope): ObjectValue {
    const sc = childScope(outer);
    duplicates(o.body);
    if (o.id) {
      const first = ids.get(o.id);
      // repeat() copies share the id the body was written with — that is the point, not a mistake
      if (first && !inRepeat) warn(`#${o.id} is already used; getObjectByName finds only the first`, { start: o.start, end: o.end, file: o.file });
      else ids.set(o.id, o);
    }

    // a node's own --vars are read before its templates run, which is how a template takes parameters
    const params = new Map<string, Bound>();
    for (const m of o.body) {
      if (m.kind !== "var") continue;
      declare(m, sc);
      params.set(m.name, sc.vars.get(m.name)!);
    }

    const body: Member[] = [];
    for (const [i, cls] of o.classes.entries()) {
      const use = o.classSpans[i] ?? o;
      const t = sc.templates.get(cls);
      if (!t) { err(`unknown template .${cls}`, use); continue; }
      bind(use, t.decl);
      const inner = childScope(t.scope);
      // the parameter keeps the caller's declaration, so the template's var(--x) renames with it
      for (const [name, bound] of params) inner.vars.set(name, bound);
      body.push(...expandBody(t.body, inner));
    }
    body.push(...expandBody(o.body, sc));
    const out: ObjectValue = { ...o, args: o.args.map((a) => subst(a, sc)), body };
    // one AST node is one instance — unless it reads an each() binding, in which case every iteration
    // has to build its own
    if (sc.loop.size && varies(out, sc.loop)) out.dynamic = true;
    return out;
  }

  function expandBody(list: Member[], sc: Scope): Member[] {
    const out: Member[] = [];
    for (const m of list) {
      if (m.kind === "var") { sc.vars.set(m.name, { value: subst(m.value, sc), decl: m.namePos }); continue; }
      if (isRepeat(m)) { out.push(...repeat((m as Member & { kind: "node" }).object, sc)); continue; }
      out.push(member(m, sc));
    }
    return out;
  }

  const nodes = await collect(sheet, scope, [root]);

  for (const r of pendingRefs) {
    const target = ids.get(r.name);
    if (!target) { err(`unknown node #${r.name}`, r); continue; }
    bind(r.namePos, target.idSpan ?? target);
    r.node = target.name;
  }

  // a sheet with no nodes is a library — its declarations are meant to be used from elsewhere.
  // Deadness is per declaration, not per name: a --x nobody in *this* scope reads is dead even
  // if some other block declares its own --x and uses that.
  if (sheet.statements.some((s) => s.kind === "node")) {
    for (const v of declaredVars) {
      if (v.file === sheet.file && !usedDecls.has(declKey(v.namePos))) warn(`--${v.name} is never used`, v);
    }
    for (const t of templates) {
      if (t.file === sheet.file && !usedDecls.has(declKey(t.namePos))) warn(`.${t.name} is never applied`, t);
    }
  }

  return { nodes, diagnostics, templates, bindings, ids };
}
