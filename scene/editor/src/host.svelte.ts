/**
 * The page the editor is mounted into, as far as the editor is concerned.
 *
 * Standing alone, an editor answers to nobody: it opens files, it saves them, and the window is its own.
 * Mounted into a game's page it gains exactly two obligations, and this is both of them — there is a
 * **Play** button, and while the game is running the editor is *not*.
 *
 * A module singleton rather than props threaded down the tree, which is how everything else in this
 * editor that is not about one panel is held (`session`, `project`, `tools`, `prefs`). The toolbar asks
 * whether there is anything to play; the viewport and the shell ask whether they are paused. Neither has
 * to have been handed anything by the component above it.
 *
 * Pausing is not politeness. The viewport's own `setAnimationLoop` would otherwise keep drawing four
 * panes of a level at sixty frames a second underneath a game that wants the whole GPU, and the shell's
 * window keydown handler would keep reading W and S as *fly* while the player is walking with them.
 */
import { project, type Snapshot } from "./io/project.svelte.ts";

class Host {
  /** what the page does with the document when Play is pressed; absent when nobody asked for a game */
  #play = $state.raw<((project: Snapshot) => void) | undefined>(undefined);
  /**
   * The game has the screen: draw nothing, read no keys.
   *
   * Plain `$state` because the viewport's render loop is not the only reader — the toolbar dims, and the
   * shell stops answering the keymap — and all three want to hear about it at once.
   */
  paused = $state(false);

  /** the sheet the page wants open, loaded by the shell once it is up */
  path: string | undefined;

  get canPlay(): boolean {
    return this.#play !== undefined;
  }

  /** called by `mountEditor`; the editor never sets this for itself */
  set onPlay(play: ((project: Snapshot) => void) | undefined) {
    this.#play = play;
  }

  /**
   * Hand the document over as it stands.
   *
   * `snapshot()` is what a save *would* write, not what the last one did, so the level the player walks
   * into is the level on the screen — no save, no round trip through a file, nothing to forget to do
   * first. That is the whole reason the editor and the game live in one page.
   *
   * Declines when there is no game to play or the world cannot be written at all, which is what makes it
   * safe to bind to a key: a declined command falls through to whatever else wanted the press.
   */
  play(): boolean {
    if (!this.#play) return false;
    const snapshot = project.snapshot();
    if (!snapshot) return false;
    this.#play(snapshot);
    return true;
  }
}

export const host = new Host();
