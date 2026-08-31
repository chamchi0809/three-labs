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
  canRedo, canUndo, change, history, redo, redoName, repeat, repeatName, separate, undo, undoName,
  type Command, type History,
} from "./doc/history.ts";
import { demoMap } from "./doc/demo.ts";

class Session {
  /**
   * `raw`, and it matters twice.
   *
   * The history is a plain immutable value that is replaced on every change and never written into, so a
   * deep proxy buys nothing and costs a wrapper on every node of the tree the renderer walks. And a proxy
   * is not the thing it wraps: `editor.world === thatWorld` would be false for the world it was built from,
   * which is exactly the comparison the unsaved-changes marker is.
   */
  #history = $state.raw(history(newEditor(demoMap())));

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

  get repeatName(): string | undefined {
    return repeatName(this.#history);
  }

  /** an edit, named for the undo stack; `over` carries a gesture's collate key and its repeat form */
  run(name: string, apply: (e: Editor) => Editor, over: Partial<Command> = {}): void {
    this.#history = change(this.#history, name, apply, over);
  }

  /**
   * The gesture is over. The next command with the same collate key starts a fresh undo entry instead of
   * joining this one — mouse up, tool changed, focus lost.
   */
  separate(): void {
    this.#history = separate(this.#history);
  }

  /** the last repeatable thing, done again to whatever is selected now */
  repeat(): void {
    this.#history = repeat(this.#history);
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

  /**
   * A different document entirely: opened, reverted, or started from nothing.
   *
   * The history is replaced rather than added to, because the undo stack belongs to the file it was built
   * against — pressing ⌘Z after opening a map and getting the previous designer's last edit back is not
   * undo, it is two documents sharing a stack.
   */
  load(editor: Editor): void {
    this.#history = history(editor);
  }

  undo(): void {
    this.#history = undo(this.#history);
  }

  redo(): void {
    this.#history = redo(this.#history);
  }
}

export const session = new Session();
