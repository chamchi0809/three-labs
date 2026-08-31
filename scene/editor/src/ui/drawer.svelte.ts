/**
 * Whether the panel along the bottom is up, and which half of it is showing.
 *
 * Its own store rather than state inside the component, for two reasons: a key has to be able to open it,
 * and the header button has to be able to show that there is something in it worth opening. Both of those
 * are outside the drawer, and neither is worth threading through props from the shell.
 *
 * A drawer rather than a sheet, unlike the keymap and the preferences. Those are read and closed; this one
 * is watched *while working* — the whole use of a frame time is seeing it move as you drag something — and
 * a modal that covers the viewport cannot show you the viewport's cost.
 */
import { log } from "./log.svelte.ts";

export const TABS = ["log", "performance"] as const;
export type Tab = (typeof TABS)[number];

class Drawer {
  #open = $state(false);
  #tab = $state<Tab>("log");
  /** how tall it is, in pixels, dragged by its top edge */
  #height = $state(180);

  get open(): boolean {
    return this.#open;
  }

  get tab(): Tab {
    return this.#tab;
  }

  get height(): number {
    return this.#height;
  }

  set height(px: number) {
    this.#height = Math.max(80, Math.min(px, 600));
  }

  /** opening the log is reading it, which is what clears the mark on the button */
  show(tab: Tab): void {
    this.#tab = tab;
    this.#open = true;
    if (tab === "log") log.read();
  }

  close(): void {
    this.#open = false;
  }

  toggle(tab: Tab = this.#tab): void {
    if (this.#open && this.#tab === tab) this.close();
    else this.show(tab);
  }
}

export const drawer = new Drawer();
