/**
 * What a tool is, and the box that runs one at a time.
 *
 * TrenchBroom layers `ToolBox`, `ToolChain`, `ToolController` and a family of drag trackers. The layering
 * exists there because several tools are live at once and have to agree about who gets a click. Here one
 * tool is active at a time and the chain collapses to a single dispatch — so what is left is the part that
 * actually earns its keep: **a tool answers with a value rather than doing anything**.
 *
 * An {@link Outcome} says what should be edited, what should be selected, what should be drawn and what
 * the status line should read. The host — `Views.svelte` — is the only thing that touches the session, the
 * renderer or the DOM. That is what lets `tool.check.ts` drive a whole press-move-move-release gesture and
 * assert on the world that comes out, with no canvas anywhere.
 *
 * The other decision worth stating is how a drag reaches undo. Each frame of a drag applies to the editor
 * the drag *started* from, not to the one the last frame produced, and every frame carries the same
 * `collate` key so the history folds them into one entry. Applying incrementally would accumulate rounding
 * across a two-second drag and would make snapping mean "snap the step" rather than "snap the result".
 */
import type { Editor } from "../doc/editor.ts";
import type { ViewKind } from "../viewport/view.ts";
import type { InputState, Rect } from "./input.ts";
import { DRAG_THRESHOLD, pixelsBetween } from "./input.ts";

export type ToolId =
  | "select" | "move" | "shape" | "patch" | "entity" | "extrude"
  | "clip" | "vertex" | "edge" | "face" | "rotate" | "scale" | "shear" | "sweep" | "attributes";

/** a named change that goes on the undo stack */
export type Edit = {
  name: string;
  apply: (editor: Editor) => Editor;
  /** frames of one gesture sharing a key become one entry */
  collate?: string;
  repeatable?: boolean;
  /**
   * What "repeat" runs instead of `apply`. A drag's `apply` is written against the world the drag started
   * from, so replaying it would rewind everything since; `again` is the same change written against
   * whatever is there when it is repeated. See `doc/history.ts`.
   */
  again?: (editor: Editor) => Editor;
};

/**
 * Everything a tool can ask for, all of it optional.
 *
 * `set` is for changes that are not edits — selection, the open group — which TrenchBroom also keeps off
 * the undo stack, and rightly: a designer who clicks three things and undoes wants their last *edit* back.
 */
export type Outcome = {
  edit?: Edit;
  set?: (editor: Editor) => Editor;
  /** lines to draw, by key; a key mapped to undefined takes its lines away */
  decor?: Record<string, Float32Array | undefined>;
  /**
   * A rectangle drawn flat on one pane — the rubber band, and the one thing a tool draws that is not in
   * the world. It stays out of the line batches on purpose: a band is measured in pixels and has no depth,
   * so putting it in the scene would mean un-projecting it every frame to get back what the mouse already
   * said. `null` takes it away.
   */
  band?: { view: ViewKind; rect: Rect } | null;
  /** what the status line should say, or `null` to clear it */
  note?: string | null;
  /** the gesture is over: the next edit with the same collate key starts a fresh undo entry */
  separate?: boolean;
};

/** a drag in progress. It owns everything it needs from the moment it was made */
export type DragTracker = {
  move(input: InputState, editor: Editor): Outcome | undefined;
  end(input: InputState, editor: Editor): Outcome | undefined;
  /** escape, or the pointer leaving; the tracker undoes whatever it had staged */
  cancel(editor: Editor): Outcome | undefined;
};

export type Tool = {
  id: ToolId;
  title: string;
  /** the key that activates it, as `event.key` lower-cased */
  key: string;
  /** what the status line says when the tool is active and nothing is happening */
  hint: string;
  /** which handles the renderer should show while this tool is active */
  handles?: { vertices?: boolean; edges?: boolean; faces?: boolean };
  /** a press that never became a drag */
  click?(input: InputState, editor: Editor): Outcome | undefined;
  /** a press that travelled far enough to be a drag; returning nothing declines it */
  drag?(input: InputState, editor: Editor): DragTracker | undefined;
  /** the pointer moved with no button down */
  hover?(input: InputState, editor: Editor): Outcome | undefined;
  /** a key that is not a global one; return an outcome to claim it */
  press?(key: string, input: InputState | undefined, editor: Editor): Outcome | undefined;
  /** switching away, so a tool can put back anything it was drawing */
  leave?(editor: Editor): Outcome | undefined;
};

// ---------------------------------------------------------------- the box

/**
 * One tool at a time, and the press-to-drag state machine every one of them shares.
 *
 * The threshold is the reason this is a state machine at all: between the press and the fourth pixel it is
 * not yet known whether this gesture is a click or a drag, so the press is remembered and the decision is
 * made on the first move that travels far enough.
 */
export class ToolBox {
  readonly tools: Tool[];
  current: Tool;
  /** where the button went down, kept until the gesture is decided */
  private pressed: InputState | undefined;
  private tracker: DragTracker | undefined;

  constructor(tools: Tool[], start: ToolId = "select") {
    this.tools = tools;
    this.current = tools.find((t) => t.id === start) ?? tools[0]!;
  }

  get dragging(): boolean {
    return this.tracker !== undefined;
  }

  byKey(key: string): Tool | undefined {
    return this.tools.find((t) => t.key === key);
  }

  /** switching tools ends whatever was happening, so a half-finished drag cannot outlive its tool */
  select(id: ToolId, editor: Editor): Outcome | undefined {
    if (this.current.id === id) return undefined;
    const stop = this.cancel(editor);
    const leaving = this.current.leave?.(editor);
    this.current = this.tools.find((t) => t.id === id) ?? this.current;
    return merge(merge(stop, leaving), { note: this.current.hint, separate: true });
  }

  down(input: InputState, _editor: Editor): Outcome | undefined {
    if (input.button !== 0) return undefined;
    this.pressed = input;
    return undefined;
  }

  move(input: InputState, editor: Editor): Outcome | undefined {
    if (this.tracker) return this.tracker.move(input, editor);
    if (this.pressed) {
      if (pixelsBetween(this.pressed.at, input.at) < DRAG_THRESHOLD) return undefined;
      // the drag begins from where the button went down, not from where the threshold was crossed —
      // otherwise every drag silently loses its first four pixels
      this.tracker = this.current.drag?.(this.pressed, editor);
      if (!this.tracker) {
        this.pressed = undefined;
        return undefined;
      }
      return this.tracker.move(input, editor);
    }
    return this.current.hover?.(input, editor);
  }

  up(input: InputState, editor: Editor): Outcome | undefined {
    const pressed = this.pressed;
    this.pressed = undefined;
    if (this.tracker) {
      const tracker = this.tracker;
      this.tracker = undefined;
      return merge(tracker.end(input, editor), { separate: true });
    }
    if (!pressed || input.button !== 0) return undefined;
    // a click reports where the button went *down*: the pointer may have wandered a pixel or two, and the
    // thing under the press is the thing the designer aimed at
    return merge(this.current.click?.({ ...pressed, button: input.button, mods: input.mods }, editor), {
      separate: true,
    });
  }

  press(key: string, input: InputState | undefined, editor: Editor): Outcome | undefined {
    if (key === "escape" && this.tracker) return this.cancel(editor);
    const answer = this.current.press?.(key, input, editor);
    // A setting changed during a drag is a setting the drag should already be showing. The tracker is run
    // again from where the pointer already is rather than waiting for it to move: otherwise deepening a
    // solid with `+` does nothing at all until the hand twitches, which reads as the key not working.
    if (!answer || !input || !this.tracker) return answer;
    return merge(answer, this.tracker.move(input, editor));
  }

  cancel(editor: Editor): Outcome | undefined {
    this.pressed = undefined;
    if (!this.tracker) return undefined;
    const tracker = this.tracker;
    this.tracker = undefined;
    return merge(tracker.cancel(editor), { separate: true });
  }
}

/**
 * Two outcomes as one.
 *
 * Later wins for the single-valued fields and decor keys are merged rather than replaced, because the
 * common case is a tool answering with its own lines while the box adds a `separate` — and a merge that
 * dropped the lines would leave a rubber band on screen after the mouse came up.
 */
export function merge(a: Outcome | undefined, b: Outcome | undefined): Outcome | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    edit: b.edit ?? a.edit,
    set: b.set ?? a.set,
    decor: a.decor || b.decor ? { ...a.decor, ...b.decor } : undefined,
    band: b.band !== undefined ? b.band : a.band,
    note: b.note !== undefined ? b.note : a.note,
    separate: b.separate || a.separate,
  };
}
