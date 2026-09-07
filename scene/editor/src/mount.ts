/**
 * The editor as something a page mounts, rather than as a page.
 *
 * `three-broom` is a level editor and a level is not the product — the game is. So the same shell that
 * fills `index.html` when the editor is run on its own goes into a `<div>` on a page that also has a game
 * on it, gains a **Play** button, and hands the document over without a file in between. That is
 * pixi-vania's arrangement, and it is the one that makes a change to a level cost one keystroke to look
 * at instead of a save, a reload and a walk back to where you were standing.
 *
 * ```ts
 * const editor = mountEditor(document.querySelector("#editor")!, {
 *   projectPath: "/scenes/arena.tscene",
 *   onPlay: (project) => void play(project),
 *   save: devServerSave(),
 * });
 * ```
 *
 * One editor per page. Everything it is made of — the session, the open project, the tool box, the
 * preferences — is a module singleton, because a brush editor is a document editor and a second copy of it
 * in the same window would be a second opinion about the same document. A page that wants two views of a
 * level has four of them already, in the pane layout.
 */
import { mount, unmount } from "svelte";
import App from "./App.svelte";
import { host } from "./host.svelte.ts";
import { project, type Snapshot, type Writer } from "./io/project.svelte.ts";
// the palette, which a host page has no other way of knowing about
import "./theme.css";

export type { Snapshot, Writer };
// the writer a dev server can back, which is the one a page mounting the editor almost always wants
export { devServerSave, SHEETS_ROUTE } from "./io/http.ts";

export interface EditorOptions {
  /**
   * The sheet to open, as a path the page can `fetch`. Its `@import`s are followed and come with it, so
   * this is a whole project rather than a file. Without one the editor opens the demo map.
   */
  projectPath?: string;
  /**
   * What to do with the document when Play is pressed. Given one, the toolbar grows a Play button and F5
   * means it; without one there is no Play button, because there is nothing to play.
   *
   * The argument is the project as it stands — what a save would have written. Nothing has been written.
   */
  onPlay?: (project: Snapshot) => void;
  /**
   * Where a save goes. A dev server that writes the sheet back is the answer during development
   * (`devServerSave()`); without one the editor asks for a file, or downloads one.
   */
  save?: Writer;
}

export interface EditorHandle {
  /** the project as it stands: what a save would write, which is what a game should load */
  snapshot(): Snapshot | undefined;
  /** open another sheet, over the network, with its imports */
  open(path: string): Promise<boolean>;
  save(): Promise<boolean>;
  isDirty(): boolean;
  /**
   * Stand down, or come back.
   *
   * A paused editor draws nothing and answers no keys — both of which the game needs, and neither of which
   * hiding the element achieves: a `display: none` viewport keeps its animation loop, and an `inert`
   * subtree still has a window listening for W behind it.
   */
  setPaused(paused: boolean): void;
  destroy(): void;
}

export function mountEditor(target: HTMLElement, opts: EditorOptions = {}): EditorHandle {
  host.onPlay = opts.onPlay;
  host.path = opts.projectPath;
  host.paused = false;
  project.writeWith(opts.save);

  const app = mount(App, { target });

  return {
    snapshot: () => project.snapshot(),
    open: (path) => project.fetchProject(path),
    save: () => project.save(),
    isDirty: () => project.dirty,
    setPaused: (paused) => void (host.paused = paused),
    destroy: () => {
      host.onPlay = undefined;
      host.path = undefined;
      host.paused = false;
      project.writeWith(undefined);
      void unmount(app);
    },
  };
}
