/**
 * The one piece of mutable state the whole app shares.
 *
 * The document model and the undo stack are both plain immutable values; this is the single `$state` box
 * they live in, so that every panel reads the same editor and every edit goes through the same history.
 * Keeping it to one box matters — two sources of truth in an editor is how a selection ends up disagreeing
 * with an inspector.
 *
 * Commands are named here rather than at the call site because the name is what the undo menu shows and
 * what {@link repeat} repeats; a command with a vague name is one a designer cannot decide whether to undo.
 */
import { newEditor, type Editor } from "./doc/editor.ts";
import {
  canRedo, canUndo, change, history, redo, redoName, undo, undoName, type History,
} from "./doc/history.ts";
import { demoMap } from "./doc/demo.ts";

class Session {
  #history = $state(history(newEditor(demoMap())));

  get editor(): Editor {
    return this.#history.editor;
  }

  get history(): History {
    return this.#history;
  }

  get canUndo(): boolean {
    return canUndo(this.#history);
  }

  get canRedo(): boolean {
    return canRedo(this.#history);
  }

  get undoName(): string | undefined {
    return undoName(this.#history);
  }

  get redoName(): string | undefined {
    return redoName(this.#history);
  }

  /** an edit, named for the undo stack */
  run(name: string, apply: (e: Editor) => Editor): void {
    this.#history = change(this.#history, name, apply);
  }

  /**
   * A change that is not an edit: selection, the open group, the grid size.
   *
   * These go straight into the editor without a history entry of their own. TrenchBroom does the same and
   * it is right — a designer who clicks three things and hits undo expects the last *edit* back, not the
   * last click.
   */
  set(apply: (e: Editor) => Editor): void {
    this.#history = { ...this.#history, editor: apply(this.#history.editor) };
  }

  undo(): void {
    this.#history = undo(this.#history);
  }

  redo(): void {
    this.#history = redo(this.#history);
  }
}

export const session = new Session();
