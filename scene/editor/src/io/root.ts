/**
 * Which of the sheets in hand is the document.
 *
 * A map that `@import`s is several files and one document, and a browser hands over a *set* of files with
 * no indication of which one the designer meant. The answer is structural rather than a guess: the root is
 * the sheet nobody imports. Everything else is somebody's part.
 *
 * Split out of `project.svelte.ts` because it is arithmetic on a parse tree and has no business needing a
 * browser to be checked — see `root.check.ts`.
 */
import type { Sheet, Statement } from "tscene";

/** a sheet's own name once it is a key in the project: the file name, no directory */
export const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/**
 * The root of a set of sheets.
 *
 * Falls back twice, and the order matters. A cycle — or a set where every sheet is imported by another —
 * has no unimported sheet at all; then `map.tscene` if one of them is called that, and otherwise the first,
 * which in a file dialogue is the one the designer picked first.
 */
export function rootOf(sheets: Map<string, Sheet>): string {
  const names = [...sheets.keys()];
  if (!names.length) return "untitled.tscene";

  const imported = new Set<string>();
  for (const sheet of sheets.values()) {
    for (const statement of sheet.statements) {
      const target = importTarget(statement);
      if (!target) continue;
      // an `@import` writes a path relative to its own file and the keys here are relative to the folder
      // that was opened, so the file name is what the two spellings have in common
      const match = names.find((n) => n === target) ?? names.find((n) => nameOf(n) === nameOf(target));
      if (match) imported.add(match);
    }
  }

  return (
    names.find((n) => !imported.has(n)) ?? names.find((n) => nameOf(n) === "map.tscene") ?? names[0]!
  );
}

/** the path an `@import` names */
export function importTarget(statement: Statement): string | undefined {
  return statement.kind === "import" ? statement.path : undefined;
}
