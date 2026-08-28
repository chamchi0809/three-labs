/**
 * Text edits: the unit a surgical save is made of.
 *
 * An edit is a range of the original text and what should stand in its place. They are all computed
 * against the *original* offsets and applied in one pass from the back, so nothing has to renumber
 * anything and the writer can work in whatever order the tree walks in.
 *
 * Overlap is an error rather than a last-one-wins, because two edits over the same range mean the writer
 * decided the same characters mean two different things, and quietly picking one would put a file on
 * disk that nobody wrote.
 */
export type TextEdit = {
  start: number;
  end: number;
  text: string;
  /** what asked for it — the only thing that makes an overlap debuggable */
  why?: string;
};

export const replaceAt = (start: number, end: number, text: string, why?: string): TextEdit => ({ start, end, text, why });
export const insertAt = (at: number, text: string, why?: string): TextEdit => ({ start: at, end: at, text, why });
export const deleteAt = (start: number, end: number, why?: string): TextEdit => ({ start, end, text: "", why });

export type PatchResult = { text: string; problems: string[] };

/**
 * Every edit applied to one text. Sorted by position, back to front; an insertion at the same point as
 * another keeps the order it was given in, which is what makes "append these three children" come out in
 * the order the tree has them.
 */
export function applyEdits(text: string, edits: TextEdit[]): PatchResult {
  const problems: string[] = [];
  const order = edits
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.start - b.e.start || a.e.end - b.e.end || a.i - b.i);

  const kept: TextEdit[] = [];
  let reach = -1;
  for (const { e } of order) {
    if (e.start > e.end || e.start < 0 || e.end > text.length) {
      problems.push(`${e.why ?? "an edit"} is outside the file: ${e.start}..${e.end} of ${text.length}`);
      continue;
    }
    // an insertion at the very end of the previous edit's range is next to it, not inside it
    if (e.start < reach) {
      problems.push(`${e.why ?? "an edit"} overlaps the one before it at ${e.start}`);
      continue;
    }
    kept.push(e);
    reach = Math.max(reach, e.end);
  }

  let out = text;
  for (let i = kept.length - 1; i >= 0; i--) {
    const e = kept[i]!;
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return { text: out, problems };
}

// ---------------------------------------------------------------- reading the shape of the text

/** the indentation of the line `at` sits on — what a member inserted beside it should match */
export function indentAt(text: string, at: number): string {
  const from = text.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  const line = text.slice(from, at);
  return /^[ \t]*/.exec(line)![0]!;
}

/**
 * The start of the run of `//` lines sitting immediately above `start`, or `start` itself.
 *
 * A comment written directly over a node is about that node — it is where a level designer says "the
 * floor is one solid so the lightmap has one chart" — so moving or deleting the node takes it along. A
 * blank line breaks the run, which is how a section heading stays a section heading.
 */
export function withComments(text: string, start: number): number {
  let at = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  if (text.slice(at, start).trim()) return start; // something shares the line; the comment is not ours
  while (at > 0) {
    const above = text.lastIndexOf("\n", at - 2) + 1;
    const line = text.slice(above, at - 1).trim();
    if (!line.startsWith("//")) break;
    at = above;
  }
  return at;
}

/** the newline convention the file already uses, so a save does not make every line a diff */
export const newlineOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

/**
 * The range a whole statement occupies once its own line is counted: back to the start of its line if
 * nothing but whitespace precedes it, forward past a trailing `;` and to the end of the line.
 *
 * This is what deleting a node has to remove. Deleting only the node's span would leave the indentation
 * it sat on and an empty line behind, and forty of those is what makes a generated file look generated.
 */
export function lineRange(text: string, start: number, end: number): { start: number; end: number } {
  let a = start;
  const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  if (!text.slice(lineStart, start).trim()) a = lineStart;

  let b = end;
  while (b < text.length && (text[b] === ";" || text[b] === " " || text[b] === "\t")) b++;
  if (text[b] === "\r") b++;
  if (text[b] === "\n") b++;
  else b = end; // something else shares the line, so leave the line alone and take only the statement
  return { start: a, end: b };
}

/**
 * A block sliced out of a file, brought back to column zero.
 *
 * The inverse of {@link reindent}, and its partner: a node lifted out of one body has to lose the
 * indentation of where it was before it can be given the indentation of where it is going.
 */
export const dedent = (block: string, indent: string): string =>
  block
    .split("\n")
    .map((line, i) =>
      i === 0 ? line.replace(/^[ \t]+/, "")
      : line.startsWith(indent) ? line.slice(indent.length)
      : line.trimStart(),
    )
    .join("\n");

/** every line of `block` after the first indented by `indent` — how a printed node joins a body */
export const reindent = (block: string, indent: string): string =>
  block.split("\n").map((line, i) => (i === 0 || !line.trim() ? line : indent + line)).join("\n");
