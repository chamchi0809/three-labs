/**
 * Saving over HTTP: the browser half.
 *
 * A mounted editor has a problem a standalone one does not. It was handed a *path* — `/scenes/arena.tscene`
 * — and a browser cannot write to a path. The File System Access API can write to a file, but only one the
 * designer picked out of a dialogue, and a dialogue asking them to confirm where the file they are already
 * editing lives is a dialogue that answers a question nobody asked.
 *
 * So during development the sheet goes back the way it came: a POST to the dev server, which writes it. The
 * server half is `io/server.ts`, four routes' worth of middleware in vite. A built page has no server behind
 * it and so has no writer at all, which is the honest answer — `project.saveAs()` downloads instead.
 *
 * Nothing here imports node, or vite, or anything else. It is a `fetch` and a route name.
 */
import type { Snapshot, Writer } from "./project.svelte.ts";

/**
 * Where the sheet routes live.
 *
 * `/@` is vite's own marker for "the tooling is talking, not a file in your project", so it cannot collide
 * with a path a level might legitimately want to fetch.
 */
export const SHEETS_ROUTE = "/@sheets";

/**
 * A {@link Writer} that posts the project to the dev server.
 *
 * Every file is sent, changed or not, and the server writes only what differs — the same rule the file
 * handles follow, for the same reason: a file nobody touched should keep its modification time, so a
 * watcher watching it does not fire and a game that reloads on change does not.
 */
export function devServerSave(route = SHEETS_ROUTE): Writer {
  return async (project: Snapshot): Promise<void> => {
    const res = await fetch(`${route}/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(project),
    });
    if (!res.ok) {
      // the server's own words, which say which file it refused and why; a status code alone would send
      // the designer to the network tab to find out that one path was outside the project
      const said = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(said || `${res.status} ${res.statusText}`);
    }
  };
}
