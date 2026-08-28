<script lang="ts">
  // The shell. M6 is a single viewport over the render scene and a status bar; M7 splits the centre into
  // the three-pane layout and M10 hangs the inspectors off the right edge.
  import Viewport from "./viewport/Viewport.svelte";
  import { clampExponent, formatSize } from "./grid/snap.ts";
  import { withGrid } from "./doc/editor.ts";
  import { session } from "./session.svelte.ts";

  const exponent = $derived(session.editor.world.broom.grid);
  const selected = $derived(session.editor.selection.nodes.length);

  // `[` and `]` step the grid, as they do in TrenchBroom; ⌘/Ctrl+Z undoes. Bound on window rather than on
  // the viewport so both still work while the focus sits in a panel.
  function onKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target instanceof HTMLInputElement) return;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      if (event.shiftKey) session.redo();
      else session.undo();
    } else if (event.key === "[") {
      session.set((e) => withGrid(e, clampExponent(exponent - 1)));
    } else if (event.key === "]") {
      session.set((e) => withGrid(e, clampExponent(exponent + 1)));
    } else {
      return;
    }
    event.preventDefault();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="shell">
  <header>
    <span class="mark">three-broom</span>
    <span class="milestone">M6 · renderer</span>
  </header>
  <main><Viewport /></main>
  <footer>
    <span>grid <b>{formatSize(2 ** exponent)}</b></span>
    <span>selected <b>{selected}</b></span>
    <span class="hint">[ / ] grid · click to select · shift-click to add</span>
  </footer>
</div>

<style>
  .shell { display: grid; grid-template-rows: auto 1fr auto; height: 100%; }
  header, footer {
    display: flex; gap: 12px; align-items: center;
    padding: 6px 10px; background: #16181b; border-color: #24272c; border-style: solid;
    font: 12px ui-monospace, monospace; color: #9aa1ac;
  }
  header { border-width: 0 0 1px; }
  footer { border-width: 1px 0 0; }
  main { min-height: 0; }
  .mark { color: #d6dae0; font-weight: 600; }
  .milestone, .hint { color: #6d7480; }
  .hint { margin-left: auto; }
  b { color: #d6dae0; font-weight: 600; }
</style>
