/**
 * The live tool, and the one place an {@link Outcome} turns into something that happened.
 *
 * Tools are pure — they answer with a value and touch nothing. Somebody has to be the impure half, and it
 * is this file rather than the viewport component, because the tool bar changes tools too and both routes
 * have to reach the same undo stack in the same order. Two places applying outcomes is two places to get
 * the order of `set` and `edit` wrong, and getting it wrong means a move that reads the selection from
 * before the click that started it.
 *
 * `decor` is the one part not applied here. Lines belong to a renderer, and the renderer belongs to the
 * viewport, so `apply` hands the lines back to its caller and stays out of three.js entirely.
 */
import { session } from "../session.svelte.ts";
import type { Outcome, ToolId } from "./tool.ts";
import { newToolBox } from "./tools.ts";
import type { Tool } from "./tool.ts";
import type { Rect } from "./input.ts";
import type { ViewKind } from "../viewport/view.ts";

export type Band = { view: ViewKind; rect: Rect };

class Tools {
  readonly box = newToolBox();
  #id = $state<ToolId>(this.box.current.id);
  #band = $state<Band | null>(null);

  get all(): Tool[] {
    return this.box.tools;
  }

  get current(): Tool {
    // read the reactive id so that a component using `current` re-runs when the tool changes; the box is
    // plain mutable state on purpose, since a drag tracker has no business being a reactive proxy
    void this.#id;
    return this.box.current;
  }

  /** the rubber band, in the pixels of one pane */
  get band(): Band | null {
    return this.#band;
  }

  /**
   * An outcome carried out, in the one order that is right: what is selected first, then the edit that
   * reads it, then what the status line says about the result.
   */
  apply(outcome: Outcome | undefined): Outcome["decor"] {
    if (!outcome) return undefined;
    if (outcome.set) session.set(outcome.set);
    if (outcome.edit) session.run(outcome.edit.name, outcome.edit.apply, outcome.edit);
    if (outcome.note !== undefined) {
      const note = outcome.note ?? undefined;
      session.set((e) => (e.note === note ? e : { ...e, note }));
    }
    if (outcome.separate) session.separate();
    if (outcome.band !== undefined) this.#band = outcome.band;
    this.#id = this.box.current.id;
    return outcome.decor;
  }

  use(id: ToolId): Outcome["decor"] {
    return this.apply(this.box.select(id, session.editor));
  }

  /** a key that might be a tool's letter; returns whether it was one */
  useKey(key: string): boolean {
    const tool = this.box.byKey(key);
    if (!tool || tool === this.box.current) return false;
    this.use(tool.id);
    return true;
  }
}

export const tools = new Tools();
