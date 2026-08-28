/**
 * Which panes are on screen, and where each of them is looking.
 *
 * Two kinds of state, kept apart on purpose.
 *
 * The **layout** — how many panes, where the splitters are, which pane is maximised, which one is active —
 * changes when a designer presses a key, and every change of it moves DOM. That is reactive.
 *
 * The **cameras** change sixty times a second for as long as a drag lasts, and nothing in the DOM depends
 * on them; only the render loop reads them, and it reads them on the frame it draws. Making those reactive
 * would put a Svelte invalidation between every mouse move and the pixel it produces, for no gain
 * whatsoever. So they are a plain object, mutated in place by the input handlers and read by the loop.
 */
import {
  DEFAULT_LAYOUT, DEFAULT_SPLIT, cellsOf, clampSplit, soloCell, splittersOf,
  type Cell, type LayoutKind, type Split, type Splitter,
} from "./layout.ts";
import { VIEW_KINDS, newView, type View, type ViewKind } from "./view.ts";

/** every pane's camera, whether or not the current layout shows it — a pane keeps its place while away */
export const views: Record<ViewKind, View> = Object.fromEntries(
  VIEW_KINDS.map((kind) => [kind, newView(kind)]),
) as Record<ViewKind, View>;

class Panes {
  layout = $state<LayoutKind>(DEFAULT_LAYOUT);
  split = $state<Split>({ ...DEFAULT_SPLIT });
  /** the pane blown up to fill the whole area, if any; the layout underneath is untouched */
  maximised = $state<ViewKind | undefined>(undefined);
  /** where a keyboard command lands — the last pane the mouse went into, as in every editor */
  active = $state<ViewKind>("3d");

  get cells(): Cell[] {
    return this.maximised ? soloCell(this.maximised) : cellsOf(this.layout, this.split);
  }

  get splitters(): Splitter[] {
    return this.maximised ? [] : splittersOf(this.layout, this.split);
  }

  /** the views the current layout actually shows, which is what "frame in every view" means */
  get shown(): ViewKind[] {
    return this.cells.map((cell) => cell.view);
  }

  setLayout(kind: LayoutKind): void {
    this.layout = kind;
    this.maximised = undefined;
    if (!this.shown.includes(this.active)) this.active = this.shown[0] ?? "3d";
  }

  setSplit(split: Partial<Split>): void {
    this.split = clampSplit({ ...this.split, ...split });
  }

  /** maximise the pane given, or restore if it is already the one filling the area */
  toggleMaximised(view: ViewKind = this.active): void {
    this.maximised = this.maximised === view ? undefined : view;
    if (this.maximised) this.active = view;
  }
}

export const panes = new Panes();
