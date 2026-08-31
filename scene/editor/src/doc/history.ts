/**
 * The command processor: do, undo, redo, and the two things that make undo feel right rather than merely
 * work.
 *
 * **Transactions.** A tool that makes six changes to finish one gesture wraps them in a transaction, and
 * the whole gesture becomes one entry. They nest, because a tool built out of other tools should not have
 * to know whether it is the outermost one.
 *
 * **Collation.** Holding the nudge key for a second should not put forty entries on the stack. A command
 * carries a `collate` key, and when the entry on top of the stack has the same one, the new state
 * replaces it instead of being pushed. There is deliberately no timer: a stack whose shape depends on how
 * fast the designer was typing is a stack they cannot predict, and `separate()` is how a tool says "the
 * next one starts a new entry" at the moment it actually knows — mouse up, focus lost, tool changed.
 *
 * Undo is by kept value, not by inverse command. The document is immutable and shares its untouched
 * subtrees, so an entry costs a spine and not a map; and an inverse is the thing that is subtly wrong for
 * the one operation nobody wrote a check for — the vertex drag that merged two faces has no inverse drag.
 */
import { settleEditor, type Editor } from "./editor.ts";
import { keepInStep } from "./groups.ts";

/** a change to the editor, as a function of it. Pure: the processor decides what to keep */
export type Command = {
  /** what the menu calls it, and what "Undo …" says */
  name: string;
  /**
   * The change, as a function. The document is immutable and shares its untouched subtrees, so a command
   * with nothing to do must return the editor it was given rather than a copy of it — that is the signal
   * the processor reads to decide whether an entry is deserved. Copying the editor and then changing
   * nothing inside it counts too; anything deeper would mean comparing whole worlds on every keystroke.
   */
  apply: (editor: Editor) => Editor;
  /**
   * Commands sharing a key collapse into one entry while they stay consecutive. Undefined means every
   * run is its own entry.
   */
  collate?: string;
  /** whether "repeat" should do this again — a move, yes; a selection change, no */
  repeatable?: boolean;
  /**
   * What {@link repeat} runs in place of `apply`.
   *
   * A drag's `apply` is written against the world the drag started from — that is what stops sixty frames
   * a second from accumulating rounding — so replaying it later would put the world back to where the drag
   * began and undo everything since. `again` is the same change written against whatever is there now,
   * which is what a designer means by "do that again". Most commands have no use for it and repeat as
   * themselves.
   */
  again?: (editor: Editor) => Editor;
};

type Entry = { name: string; before: Editor; after: Editor; collate?: string };

export type History = {
  editor: Editor;
  past: Entry[];
  future: Entry[];
  /** the transaction being built, outermost first */
  open: { name: string; before: Editor }[];
  /** the commands "repeat" will run again */
  repeat: Command[];
  /** how many entries to keep; the oldest go first */
  limit: number;
};

export const history = (editor: Editor, limit = 200): History => ({
  editor, past: [], future: [], open: [], repeat: [], limit,
});

export const canUndo = (h: History): boolean => h.past.length > 0 && !h.open.length;
export const canRedo = (h: History): boolean => h.future.length > 0 && !h.open.length;
export const undoName = (h: History): string | undefined => h.past.at(-1)?.name;
export const redoName = (h: History): string | undefined => h.future.at(-1)?.name;

// ---------------------------------------------------------------- running

/**
 * One command run. Inside a transaction the change is applied and nothing is pushed — the transaction
 * pushes one entry when it commits.
 *
 * Every command passes through {@link keepInStep} on the way, which is what makes an edit to one copy of a
 * linked group an edit to all of them. It belongs here rather than in each tool for the obvious reason:
 * there are thirty tools and one processor, and the tool that forgets is the one nobody notices until a
 * designer has built half a level out of copies that quietly stopped matching.
 */
export function run(h: History, command: Command): History {
  const after = settleEditor(keepInStep(h.editor, command.apply(h.editor)));
  if (untouched(h.editor, after)) return h; // a command that changed nothing does not deserve an entry
  const repeat = command.repeatable ? recorded(h.repeat, command) : h.repeat;
  if (h.open.length) return { ...h, editor: after, repeat };

  const top = h.past.at(-1);
  if (command.collate && top?.collate === command.collate) {
    if (untouched(top.before, after)) {
      // the gesture came back to where it started, which is what escaping out of a drag does. An entry
      // whose two ends are the same state is an undo step that undoes nothing, and a designer who
      // cancelled a drag should not then have to press undo to be rid of it — nor to be rid of the
      // repeat it would otherwise have left behind
      const forgotten = repeat.at(-1)?.collate === command.collate ? repeat.slice(0, -1) : repeat;
      return { ...h, editor: after, past: h.past.slice(0, -1), future: [], repeat: forgotten };
    }
    // the gesture continues: the entry keeps the state it started from and takes on the newest end
    const merged: Entry = { ...top, after, name: command.name };
    return { ...h, editor: after, past: [...h.past.slice(0, -1), merged], future: [], repeat };
  }
  const entry: Entry = { name: command.name, before: h.editor, after, collate: command.collate };
  return { ...h, editor: after, past: trim([...h.past, entry], h.limit), future: [], repeat };
}

/**
 * The repeat list with one more command on it — or with its last one replaced, when the two are frames of
 * the same gesture.
 *
 * Without this a two-second drag records a hundred and twenty commands and "repeat" replays every frame of
 * it. The frames collapse for exactly the reason the undo entries do, and by exactly the same rule.
 */
const recorded = (list: Command[], command: Command): Command[] => {
  const top = list.at(-1);
  const same = command.collate !== undefined && top?.collate === command.collate;
  return same ? [...list.slice(0, -1), command] : [...list, command];
};

/** field by field, so a tool that spread the editor and then changed its mind is still a no-op */
const untouched = (a: Editor, b: Editor): boolean =>
  a === b ||
  (a.world === b.world && a.selection === b.selection && a.open === b.open &&
    a.layer === b.layer && a.material === b.material && a.note === b.note &&
    a.materials === b.materials);

const trim = (entries: Entry[], limit: number): Entry[] =>
  entries.length > limit ? entries.slice(entries.length - limit) : entries;

/** the shorthand for a one-off change with no menu name worth remembering */
export const change = (h: History, name: string, apply: (e: Editor) => Editor, over: Partial<Command> = {}): History =>
  run(h, { name, apply, ...over });

/**
 * A gesture that has ended. The next command with the same collate key starts a fresh entry rather than
 * joining the one on top — what a tool calls on mouse up.
 */
export function separate(h: History): History {
  const top = h.past.at(-1);
  const lastRepeat = h.repeat.at(-1);
  // the repeat list forgets the key too, or the next drag of the same kind would replace this one's
  // record instead of being added after it
  const repeat = lastRepeat?.collate
    ? [...h.repeat.slice(0, -1), { ...lastRepeat, collate: undefined }]
    : h.repeat;
  if (!top?.collate) return repeat === h.repeat ? h : { ...h, repeat };
  return { ...h, repeat, past: [...h.past.slice(0, -1), { ...top, collate: undefined }] };
}

// ---------------------------------------------------------------- transactions

export const begin = (h: History, name: string): History => ({ ...h, open: [...h.open, { name, before: h.editor }] });

/**
 * The innermost transaction closed. Only the outermost one pushes an entry, so a tool made of tools puts
 * one thing on the stack; and a transaction that changed nothing pushes nothing at all.
 */
export function commit(h: History, name?: string): History {
  const open = h.open.at(-1);
  if (!open) return h;
  const rest = h.open.slice(0, -1);
  if (rest.length) return { ...h, open: rest };
  if (untouched(open.before, h.editor)) return { ...h, open: rest };
  const entry: Entry = { name: name ?? open.name, before: open.before, after: h.editor };
  return { ...h, open: rest, past: trim([...h.past, entry], h.limit), future: [] };
}

/** the innermost transaction abandoned; an outer one is left with whatever it had before this one began */
export function rollback(h: History): History {
  const open = h.open.at(-1);
  return open ? { ...h, editor: open.before, open: h.open.slice(0, -1) } : h;
}

/** a whole gesture in one call, rolled back if the body decides there was nothing to do */
export function transact(h: History, name: string, body: (h: History) => History): History {
  const done = body(begin(h, name));
  return commit(done, name);
}

// ---------------------------------------------------------------- moving through it

export function undo(h: History): History {
  if (!canUndo(h)) return h;
  const entry = h.past.at(-1)!;
  return { ...h, editor: entry.before, past: h.past.slice(0, -1), future: [...h.future, entry] };
}

export function redo(h: History): History {
  if (!canRedo(h)) return h;
  const entry = h.future.at(-1)!;
  return { ...h, editor: entry.after, past: trim([...h.past, entry], h.limit), future: h.future.slice(0, -1) };
}

// ---------------------------------------------------------------- repeat

/**
 * The repeatable commands since the last `clearRepeat`, run again as one entry — TrenchBroom's "repeat
 * last actions", which is how a designer builds a row of pillars by making one and pressing a key.
 *
 * They run against whatever is selected now, which is the entire point: the same move applied to the next
 * thing. A command that cannot mean anything against the new selection simply changes nothing.
 */
export function repeat(h: History): History {
  if (!h.repeat.length) return h;
  const name = h.repeat.length === 1 ? h.repeat[0]!.name : `repeat ${h.repeat.length} actions`;
  // the recorded commands are replayed as themselves, but their collate keys belong to the gesture that
  // is over, so they are dropped and the whole replay becomes one entry
  return transact(h, name, (inner) =>
    h.repeat.reduce((acc, c) => run(acc, { ...c, collate: undefined, apply: c.again ?? c.apply }), inner),
  );
}

export const clearRepeat = (h: History): History => (h.repeat.length ? { ...h, repeat: [] } : h);

/** what the "Repeat" menu item should be greyed out as saying */
export const repeatName = (h: History): string | undefined =>
  h.repeat.length === 1 ? h.repeat[0]!.name : h.repeat.length ? `${h.repeat.length} actions` : undefined;
