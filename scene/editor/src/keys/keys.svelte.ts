/**
 * The keymap in force, and the designer's changes to it.
 *
 * The table itself is in `keymap.ts` and knows nothing about storage or about tools; this is the part that
 * remembers. Two things are joined here: the fixed list of commands, and the tools, whose letters belong to
 * the tool box rather than to a constant — a tool added later should turn up in the keymap editor without
 * anybody having to remember to list it twice.
 *
 * Changes go to local storage as a difference, not as a table. See `keymap.ts` for why.
 */
import { tools } from "../tools/tools.svelte.ts";
import {
  bindingsOf, chordOf, chordsFor, commandFor, conflictsOf, COMMANDS, DEFAULTS, NO_CUSTOM, rowKey,
  type Binding, type Chord, type Command, type Custom,
} from "./keymap.ts";

const STORE_KEY = "three-broom:keys";

/** the tools, as commands — their letters are the tool box's to say, so they are read rather than listed */
const toolCommands = (): Command[] =>
  tools.all.map((t) => ({ id: `tool.${t.id}`, title: t.title, group: "tools" }));

const toolBindings = (): Binding[] =>
  tools.all
    .filter((t) => t.key)
    .map((t) => ({ chord: { key: t.key.toLowerCase() }, command: `tool.${t.id}` }));

function load(): Custom {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return NO_CUSTOM;
    const value = JSON.parse(raw) as Custom;
    return Array.isArray(value?.off) && Array.isArray(value?.on) ? value : NO_CUSTOM;
  } catch {
    return NO_CUSTOM;
  }
}

class Keys {
  /** fixed for the life of the page: the tool box does not grow tools while it is running */
  readonly commands: Command[] = [...COMMANDS, ...toolCommands()];
  readonly defaults: Binding[] = [...DEFAULTS, ...toolBindings()];

  #custom = $state.raw<Custom>(typeof localStorage === "undefined" ? NO_CUSTOM : load());

  get bindings(): Binding[] {
    return bindingsOf(this.defaults, this.#custom);
  }

  /** every chord two different commands are claiming — shown in the editor, never resolved behind anyone */
  get conflicts(): Map<string, string[]> {
    return conflictsOf(this.bindings);
  }

  get customised(): boolean {
    return this.#custom.off.length > 0 || this.#custom.on.length > 0;
  }

  chordsFor(command: string): Chord[] {
    return chordsFor(this.bindings, command);
  }

  /**
   * The command a key press means, or nothing.
   *
   * A press while the focus is in a text field is not a shortcut — it is typing, and an editor that steals
   * ⌘Z from the name box is an editor whose name box cannot be corrected.
   */
  commandFor(event: KeyboardEvent): string | undefined {
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target instanceof HTMLInputElement) return undefined;
    const chord = chordOf(event);
    return chord && commandFor(this.bindings, chord);
  }

  /** bind a chord to a command, leaving whatever else it was bound to alone; the editor shows the clash */
  add(command: string, chord: Chord): void {
    const row: Binding = { chord, command };
    const key = rowKey(row);
    if (this.bindings.some((b) => rowKey(b) === key)) return;
    this.#save({
      // putting a default back means taking it off the removed list rather than adding it twice
      off: this.#custom.off.filter((k) => k !== key),
      on: this.defaults.some((b) => rowKey(b) === key) ? this.#custom.on : [...this.#custom.on, row],
    });
  }

  remove(command: string, chord: Chord): void {
    const key = rowKey({ chord, command });
    this.#save({
      off: this.defaults.some((b) => rowKey(b) === key) ? [...new Set([...this.#custom.off, key])] : this.#custom.off,
      on: this.#custom.on.filter((b) => rowKey(b) !== key),
    });
  }

  reset(): void {
    this.#save(NO_CUSTOM);
  }

  #save(custom: Custom): void {
    this.#custom = custom;
    try {
      if (custom.off.length || custom.on.length) localStorage.setItem(STORE_KEY, JSON.stringify(custom));
      else localStorage.removeItem(STORE_KEY);
    } catch {
      // a keymap that cannot be remembered still works for this session, and saying so would help nobody
    }
  }
}

export const keys = new Keys();
