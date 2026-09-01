/**
 * What every key does, as data rather than as a switch statement.
 *
 * The model is **chord → command**, not command → chord, and that direction is the whole design. Two keys
 * can mean redo — ⇧⌘Z is what a Mac does and ⌘Y is what Windows does, and an editor that runs on both has
 * to answer to both — and a table keyed by command can only ever hold one of them. Keyed by chord it holds
 * as many as anyone wants, a conflict is two rows with the same key rather than an invariant to enforce,
 * and unbinding something is a row that is not there.
 *
 * What the designer changes is stored as a **difference** from the defaults: the rows they removed and the
 * rows they added. Storing the whole table instead would freeze their keymap at the version they first
 * customised it in, and every command added afterwards would arrive unbound with no way to know it should
 * not have been.
 *
 * Modifiers are three, not four: `ctrl` means "the command key", whichever key that is on this machine.
 * A map that distinguished ⌘ from ⌃ would be a map that is wrong on one of the two platforms, and nothing
 * in this editor wants a shortcut that works in Chicago and not in Berlin.
 */

export type Chord = {
  /** the key as `KeyboardEvent.key` gives it, lowercased: `"a"`, `"["`, `" "`, `"escape"`, `"arrowup"` */
  key: string;
  /** ⌘ on a Mac, ctrl everywhere else — the same intent, and never told apart */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

/** something the editor can be asked to do, and where it sits in the list */
export type Command = { id: string; title: string; group: string };

export type Binding = { chord: Chord; command: string };

/** a keymap as it is stored: the default rows that were taken out, and the rows that were put in */
export type Custom = { off: string[]; on: Binding[] };

export const NO_CUSTOM: Custom = { off: [], on: [] };

// ---------------------------------------------------------------- chords

/** the one spelling of a chord that two equal chords always share */
export function chordKey(chord: Chord): string {
  return (
    (chord.ctrl ? "ctrl+" : "") + (chord.alt ? "alt+" : "") + (chord.shift ? "shift+" : "") + chord.key
  );
}

/** a row's identity, which is what a removal has to name */
export const rowKey = (binding: Binding): string => `${chordKey(binding.chord)}=${binding.command}`;

export function parseChord(text: string): Chord | undefined {
  const parts = text.split("+");
  const key = parts.pop();
  if (!key) return undefined;
  const chord: Chord = { key };
  for (const part of parts) {
    if (part === "ctrl") chord.ctrl = true;
    else if (part === "shift") chord.shift = true;
    else if (part === "alt") chord.alt = true;
    else return undefined;
  }
  return chord;
}

/**
 * The letter a press means, whatever an input method turned it into.
 *
 * With a Hangul (or kana, or Cyrillic) keyboard on, `event.key` for the W key is `ㅈ` — so every shortcut
 * in the editor, flying included, silently stops working the moment somebody switches input modes to type
 * a layer name. `event.code` is the physical key and is unaffected, so it is what a press falls back to
 * when what came out was not a latin letter or a digit.
 *
 * The fallback is deliberately only a fallback: a Dvorak or AZERTY layout puts real latin letters under
 * different keys, and those designers mean the letter they typed rather than the one QWERTY prints there.
 */
export function keyOf(event: { key: string; code?: string }): string {
  const key = event.key.toLowerCase();
  if (/^[a-z0-9]$/.test(key)) return key;
  const code = event.code ?? "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return key;
}

/** the chord a key press is, or nothing when the press is only a modifier being held down */
export function chordOf(event: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): Chord | undefined {
  const key = keyOf(event);
  if (key === "control" || key === "meta" || key === "shift" || key === "alt") return undefined;
  const chord: Chord = { key };
  if (event.ctrlKey || event.metaKey) chord.ctrl = true;
  if (event.shiftKey) chord.shift = true;
  if (event.altKey) chord.alt = true;
  return chord;
}

/** the names of keys that have no glyph, or whose glyph is a space nobody can see */
const GLYPHS: Record<string, string> = {
  " ": "space",
  escape: "esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "↵",
  backspace: "⌫",
  delete: "⌦",
  tab: "⇥",
};

/** a chord as a designer reads it, in the same symbols the hints along the bottom already use */
export function printChord(chord: Chord): string {
  const key = GLYPHS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  // ⌥ ⇧ ⌘ in that order, which is the order every menu bar has printed them in for forty years
  return (chord.alt ? "⌥" : "") + (chord.shift ? "⇧" : "") + (chord.ctrl ? "⌘" : "") + key;
}

/**
 * The six keys the panes fly with, which nothing else may have.
 *
 * Flying is held down, not tapped, and it is the one gesture a designer is in the middle of while reaching
 * for everything else — so a tool letter or a shortcut that lands on one of these does not merely conflict,
 * it takes the navigation away for as long as that tool is in hand. Unmodified they belong to the camera;
 * with ⌘ or ⌥ they are free, which is where ⌘S and ⌘D already are.
 */
export const FLY_KEYS = ["w", "a", "s", "d", "q", "e"] as const;

/** whether a chord is one of the camera's own, and so not a chord anything else may be bound to */
export const isFlyChord = (chord: Chord): boolean =>
  !chord.ctrl && !chord.alt && (FLY_KEYS as readonly string[]).includes(chord.key);

// ---------------------------------------------------------------- the map

/** the rows in force: the defaults the designer kept, then the ones they added */
export function bindingsOf(defaults: readonly Binding[], custom: Custom = NO_CUSTOM): Binding[] {
  const off = new Set(custom.off);
  return [...defaults.filter((b) => !off.has(rowKey(b))), ...custom.on].filter((b) => !isFlyChord(b.chord));
}

/**
 * The command a chord means.
 *
 * Last one wins, so a row the designer added beats the default it was meant to replace even when they
 * left the default in place. That is the forgiving reading of a conflict, and the editor shows the
 * conflict anyway — see {@link conflictsOf}.
 */
export function commandFor(bindings: readonly Binding[], chord: Chord): string | undefined {
  const key = chordKey(chord);
  for (let i = bindings.length - 1; i >= 0; i--) {
    if (chordKey(bindings[i]!.chord) === key) return bindings[i]!.command;
  }
  return undefined;
}

/** every chord that two different commands are both claiming, and who is claiming it */
export function conflictsOf(bindings: readonly Binding[]): Map<string, string[]> {
  const byChord = new Map<string, string[]>();
  for (const binding of bindings) {
    const key = chordKey(binding.chord);
    const list = byChord.get(key) ?? byChord.set(key, []).get(key)!;
    if (!list.includes(binding.command)) list.push(binding.command);
  }
  for (const [key, list] of byChord) if (list.length < 2) byChord.delete(key);
  return byChord;
}

/** the chords bound to one command, in the order they are listed */
export const chordsFor = (bindings: readonly Binding[], command: string): Chord[] =>
  bindings.filter((b) => b.command === command).map((b) => b.chord);

// ---------------------------------------------------------------- what there is to bind

const chord = (key: string, mods: Omit<Chord, "key"> = {}): Chord => ({ key, ...mods });
const bind = (c: Chord, command: string): Binding => ({ chord: c, command });

/**
 * Everything with a key, minus the tools, which are added by the store because the tool list is the tool
 * box's to say. Grouped in the order a designer looks for them rather than alphabetically, because a
 * keymap sorted by name is a keymap you have to already know the name of something to use.
 */
export const COMMANDS: readonly Command[] = [
  { id: "file.new", title: "new map", group: "file" },
  { id: "file.open", title: "open…", group: "file" },
  { id: "file.save", title: "save", group: "file" },
  { id: "file.saveAs", title: "save as…", group: "file" },
  { id: "file.revert", title: "revert", group: "file" },
  // only does anything when the page the editor is mounted into has a game to hand the map to; the
  // command declines otherwise, which is why it can have a key at all times
  { id: "file.play", title: "play the map", group: "file" },

  { id: "edit.undo", title: "undo", group: "edit" },
  { id: "edit.redo", title: "redo", group: "edit" },
  { id: "edit.repeat", title: "repeat last action", group: "edit" },
  { id: "edit.duplicate", title: "duplicate", group: "edit" },
  { id: "edit.delete", title: "delete the selection", group: "edit" },

  { id: "structure.group", title: "group", group: "structure" },
  { id: "structure.ungroup", title: "ungroup", group: "structure" },
  { id: "structure.leave", title: "leave group", group: "structure" },
  { id: "structure.hide", title: "hide selection", group: "structure" },
  { id: "structure.isolate", title: "isolate selection", group: "structure" },
  { id: "structure.showAll", title: "show everything", group: "structure" },
  { id: "structure.lock", title: "lock selection", group: "structure" },
  { id: "structure.unlockAll", title: "unlock everything", group: "structure" },

  { id: "csg.subtract", title: "subtract the selection", group: "csg" },
  { id: "csg.intersect", title: "intersect", group: "csg" },
  { id: "csg.merge", title: "convex merge", group: "csg" },
  { id: "csg.hollow", title: "hollow", group: "csg" },

  { id: "grid.finer", title: "finer grid", group: "grid" },
  { id: "grid.coarser", title: "coarser grid", group: "grid" },

  { id: "view.layout1", title: "one pane", group: "view" },
  { id: "view.layout2", title: "two panes", group: "view" },
  { id: "view.layout3", title: "three panes", group: "view" },
  { id: "view.layout4", title: "four panes", group: "view" },
  { id: "view.maximise", title: "maximise the pane", group: "view" },
  { id: "view.frame", title: "frame the selection", group: "view" },
  { id: "view.frameAll", title: "frame it in every pane", group: "view" },

  // not `view.`, which is the prefix that means "a pane owns this" — the drawer belongs to the shell
  { id: "window.log", title: "console", group: "window" },
  { id: "window.performance", title: "performance", group: "window" },
  { id: "window.bake", title: "lightmaps", group: "window" },
];

export const DEFAULTS: readonly Binding[] = [
  bind(chord("n", { ctrl: true }), "file.new"),
  bind(chord("o", { ctrl: true }), "file.open"),
  bind(chord("s", { ctrl: true }), "file.save"),
  bind(chord("s", { ctrl: true, shift: true }), "file.saveAs"),
  // F5, which is what every editor with a game attached to it has meant by "play" for thirty years. A
  // browser reads it as reload, so the command takes the press — and when there is no game it declines,
  // the press is not swallowed, and the page reloads the way the designer expected
  bind(chord("f5"), "file.play"),

  bind(chord("z", { ctrl: true }), "edit.undo"),
  bind(chord("z", { ctrl: true, shift: true }), "edit.redo"),
  // the Windows and Linux spelling of redo. ⌘Y is unused on a Mac, so binding it everywhere costs nothing
  // and saves the editor having to decide which platform it is on
  bind(chord("y", { ctrl: true }), "edit.redo"),
  bind(chord("r", { ctrl: true }), "edit.repeat"),
  bind(chord("d", { ctrl: true }), "edit.duplicate"),
  // both of them, unmodified: ⌦ is what the key is called on a full keyboard and ⌫ is the only one a
  // laptop has, and a designer should not have to know which of the two this editor decided on
  bind(chord("delete"), "edit.delete"),
  bind(chord("backspace"), "edit.delete"),

  bind(chord("g", { ctrl: true }), "structure.group"),
  bind(chord("g", { ctrl: true, shift: true }), "structure.ungroup"),
  bind(chord("escape"), "structure.leave"),
  bind(chord("h", { ctrl: true }), "structure.hide"),
  bind(chord("h", { ctrl: true, shift: true }), "structure.isolate"),
  bind(chord("h", { ctrl: true, alt: true }), "structure.showAll"),
  bind(chord("l", { ctrl: true }), "structure.lock"),
  bind(chord("l", { ctrl: true, shift: true }), "structure.unlockAll"),

  // ⌘J for the convex merge is TrenchBroom's, and the other three are hung off it and off the minus sign
  // that already reads as "take this away" — none of them can collide with a tool, which owns every
  // unshifted letter
  bind(chord("j", { ctrl: true }), "csg.merge"),
  bind(chord("j", { ctrl: true, shift: true }), "csg.intersect"),
  bind(chord("j", { ctrl: true, alt: true }), "csg.hollow"),
  bind(chord("-", { ctrl: true }), "csg.subtract"),

  bind(chord("["), "grid.finer"),
  bind(chord("]"), "grid.coarser"),

  bind(chord("1", { ctrl: true }), "view.layout1"),
  bind(chord("2", { ctrl: true }), "view.layout2"),
  bind(chord("3", { ctrl: true }), "view.layout3"),
  bind(chord("4", { ctrl: true }), "view.layout4"),
  bind(chord(" "), "view.maximise"),
  bind(chord("f"), "view.frame"),
  bind(chord("f", { shift: true }), "view.frameAll"),

  // the key every console in every editor and every browser has been on for twenty years, and one no tool
  // letter can ever collide with. The performance tab ships without a key of its own on purpose: shift and
  // backquote is `~` on some layouts and a dead key on others, so the one press it could have had is a
  // press that would work on this machine and not on the next one. It is a tab away, and bindable.
  // `window.bake` ships without one for the same reason and a better one: every unshifted letter left is a
  // tool, and the panel behind it is a button in the header rather than something reached mid-gesture.
  bind(chord("`"), "window.log"),
];

/** which half of the editor owns a command: the document, or the panes and the tools */
export const isViewCommand = (id: string): boolean => id.startsWith("view.") || id.startsWith("tool.");
