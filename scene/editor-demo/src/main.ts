/**
 * The page: an editor on the left of nothing, and a game on top of it when Play is pressed.
 *
 * This file is the whole of the arrangement pixi-vania demonstrates and the reason the editor grew a
 * `mountEditor`. There is no build step between drawing a level and playing it, no export, and no file:
 * **Play** hands over a {@link Snapshot} — the text of every sheet in the project as it stands, unsaved
 * edits and all — and the game loads that snapshot exactly the way a shipped game would load the same
 * sheets off a server. Esc hands the screen back. A change to the arena costs one keystroke to look at.
 *
 * Two overlays, both fixed to the viewport, and one of them hidden at a time:
 *
 * - `#editor` holds the editor. While the game is up it is `inert` *and* paused — the first stops it
 *   answering keys behind the game, the second stops it drawing four panes of a level the GPU is busy with.
 *   Hiding it would do neither: a `display: none` canvas keeps its animation loop.
 * - `#play` holds the renderer, the HUD, and the panels below. While the editor is up it is `inert` and
 *   `aria-hidden`, and empty besides — a stopped session leaves nothing behind.
 *
 * The launch counter is the guard that makes it safe to press Play twice quickly. Starting a session is
 * asynchronous — a sheet to parse, a renderer to initialise — and a session that comes back to find its
 * launch is no longer the current one stops itself instead of taking a screen that has moved on.
 */
import { devServerSave, mountEditor, type Snapshot } from "tscene-editor";
import { startGame, type GameHandle } from "./game/game.ts";

const editorEl = must("#editor");
const playEl = must("#play");

/** the sheet the demo opens with; `tools/make-arena.mjs` wrote the first version of it */
const ARENA = "/scenes/arena.tscene";

let session: GameHandle | null = null;
/** which launch is the current one; every stop invalidates the one before it */
let launch = 0;

const editor = mountEditor(editorEl, {
  projectPath: ARENA,
  onPlay: (project) => void play(project),
  // A built page has no server to write to, so it has no writer and the editor's save downloads a file
  // instead. During development the sheet goes back where it came from and the next reload has it.
  save: import.meta.env.DEV ? devServerSave() : undefined,
});

// the same handle the editor opens on itself, for the same reason: "why did that shot miss" is a question a
// console with the session in it answers, and a screenshot does not
if (import.meta.env.DEV) Object.assign(globalThis, { broomDemo: { editor, play, stop } });

async function play(project: Snapshot): Promise<void> {
  if (session) return;
  const mine = ++launch;
  toGame(true);
  panel("loading the level…", "");

  try {
    const game = await startGame(playEl, project, { onExit: stop });
    if (mine !== launch) {
      // Esc, or another Play, arrived while the renderer was still coming up
      game.stop();
      return;
    }
    clearPanel();
    session = game;
  } catch (e) {
    if (mine !== launch) return;
    // A sheet that does not load is the common failure here, and it is a *level* failure: the message is
    // the parser's, it names the file and the line, and the way out is the editor rather than a reload.
    panel("that level would not load", (e as Error).message);
  }
}

function stop(): void {
  launch += 1;
  session?.stop();
  session = null;
  clearPanel();
  toGame(false);
}

/** which overlay has the screen, the keyboard and the GPU */
function toGame(on: boolean): void {
  playEl.classList.toggle("on", on);
  playEl.inert = !on;
  playEl.ariaHidden = on ? null : "true";
  editorEl.inert = on;
  editor.setPaused(on);
}

// ---------------------------------------------------------------- the panels

let panelEl: HTMLElement | null = null;
let panelKeys: AbortController | null = null;

/**
 * Something to read where the game would be.
 *
 * It carries its own Escape handler, because the game's is inside a session that either has not started or
 * has failed to — and a page with no way out but a reload is not a demo of anything.
 */
function panel(title: string, detail: string): void {
  clearPanel();
  panelEl = document.createElement("div");
  panelEl.className = "notice";
  const heading = document.createElement("h1");
  heading.textContent = title;
  const note = document.createElement("p");
  note.textContent = detail;
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "back to the editor";
  back.addEventListener("click", stop);
  panelEl.append(heading, note, back);
  playEl.append(panelEl);
  back.focus({ preventScroll: true });

  panelKeys = new AbortController();
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code === "Escape") stop();
    },
    { signal: panelKeys.signal },
  );
}

function clearPanel(): void {
  panelKeys?.abort();
  panelKeys = null;
  panelEl?.remove();
  panelEl = null;
}

function must(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`the page has no ${selector}`);
  return el;
}
