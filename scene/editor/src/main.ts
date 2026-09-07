import { nodeBounds, walk } from "./doc/document.ts";
import { mountEditor } from "./mount.ts";
import { session } from "./session.svelte.ts";

const target = document.getElementById("app");
if (!target) throw new Error("#app is missing from index.html");

// through `mountEditor` rather than around it: the editor running on its own is a page with one editor on
// it and nothing else, which is the same thing every other host is, minus a game
mountEditor(target);

if (import.meta.env.DEV) {
  // A handle on the editor from the browser console, for the development build only.
  //
  // A brush editor is one of the few programs where "is that solid really where it looks like it is"
  // cannot be answered by looking: perspective, snapping and a 2 px outline all lie by about the same
  // amount, and two linked copies of a room look alike by construction. `broom.boxes()` prints every
  // node's extent as numbers, which is the one answer that cannot be misread.
  Object.assign(globalThis, {
    broom: {
      get editor() { return session.editor; },
      get world() { return session.editor.world; },
      boxes: () =>
        [...walk(session.editor.world)].flatMap((node) => {
          const box = nodeBounds(node);
          return box ? [{ id: node.id, kind: node.kind, min: box.min, max: box.max }] : [];
        }),
    },
  });
}
