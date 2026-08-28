<script lang="ts">
  // The shell. M7 fills the centre with the pane layout; M10 hangs the inspectors off the right edge.
  import Views from "./viewport/Views.svelte";
  import { clampExponent, formatSize } from "./grid/snap.ts";
  import { withGrid } from "./doc/editor.ts";
  import { LAYOUTS } from "./viewport/layout.ts";
  import { panes } from "./viewport/views.svelte.ts";
  import { session } from "./session.svelte.ts";

  const exponent = $derived(session.editor.world.broom.grid);
  const selected = $derived(session.editor.selection.nodes.length);

  // `[` and `]` step the grid, as they do in TrenchBroom; ⌘/Ctrl+Z undoes. Bound on window rather than on
  // the viewport so both still work while the focus sits in a panel. Everything about *where* a view is
  // looking is bound inside `Views.svelte`, which is the only thing that knows how big a pane is.
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
    <span class="milestone">M7 · viewports</span>
    <span class="layouts">
      {#each LAYOUTS as kind, i (kind)}
        <button
          class:on={panes.layout === kind && !panes.maximised}
          title="{kind} pane · ⌘{i + 1}"
          onclick={() => panes.setLayout(kind)}>{i + 1}</button
        >
      {/each}
    </span>
  </header>
  <main><Views /></main>
  <footer>
    <span>grid <b>{formatSize(2 ** exponent)}</b></span>
    <span>selected <b>{selected}</b></span>
    <span class="hint">
      [ / ] grid · ⌘1–4 panes · space maximise · f frame · rmb look · mmb pan · wasd fly
    </span>
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
  .layouts { display: flex; gap: 3px; }
  .layouts button {
    width: 20px; height: 18px; padding: 0; cursor: pointer;
    background: #1b1e22; border: 1px solid #24272c; border-radius: 3px;
    font: 11px ui-monospace, monospace; color: #6d7480;
  }
  .layouts button:hover { border-color: #3d4653; color: #9aa1ac; }
  .layouts button.on { background: #2a3038; border-color: #3d4653; color: #d6dae0; }
</style>
