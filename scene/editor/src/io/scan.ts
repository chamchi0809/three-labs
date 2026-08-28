/**
 * Finding a node's braces in the text it was parsed from.
 *
 * The parser records where a node starts and ends but not where its body opens, and the writer needs
 * that: the head is everything before the `{`, an inserted child goes just before the `}`, and a node
 * written without a body has to be given one.
 *
 * It cannot be found by looking for the first `{`, because a record value inside the head's arguments —
 * `mesh(box({ width: 2 }))` — has braces of its own, and neither can it be found by looking backwards,
 * because a comment may hold anything at all. So this walks forward the way the lexer does, skipping
 * strings and comments, and takes the first `{` that is not inside brackets.
 */
export type Braces = { open: number; close: number };

export function findBraces(text: string, start: number, end: number): Braces | undefined {
  let depth = 0;
  for (let i = start; i < end; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      i = endOfString(text, i, end);
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 || nl >= end ? end : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 || close + 1 >= end ? end : close + 1;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "{" && depth === 0) {
      // the node's end is one past its closing brace, which the parser guarantees when it has a body
      const close = text.lastIndexOf("}", end - 1);
      return close > i ? { open: i, close } : undefined;
    }
  }
  return undefined;
}

/** the index of the quote that closes the one at `at`, or `end` if the text runs out first */
function endOfString(text: string, at: number, end: number): number {
  const quote = text[at];
  for (let i = at + 1; i < end; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return end;
}
