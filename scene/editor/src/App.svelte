<script lang="ts">
  // The shell. M7 fills the centre with the pane layout; M10 hangs the inspectors off the right edge.
  import Views from "./viewport/Views.svelte";
  import Inspector from "./inspect/Inspector.svelte";
  import { clampExponent, formatSize } from "./grid/snap.ts";
  import { withGrid } from "./doc/editor.ts";
  import { LAYOUTS } from "./viewport/layout.ts";
  import { panes } from "./viewport/views.svelte.ts";
  import { session } from "./session.svelte.ts";
  import { tools } from "./tools/tools.svelte.ts";

  const exponent = $derived(session.editor.world.broom.grid);
  const selected = $derived(session.editor.selection.nodes.length);
  const faces = $derived(session.editor.selection.faces.length);
  const note = $derived(session.editor.note ?? tools.current.hint);

  // `[` and `]` step the grid, as they do in TrenchBroom; ⌘/Ctrl+Z undoes. Bound on window rather than on
  // the viewport so both still work while the focus sits in a panel. Everything about *where* a view is
  // looking is bound inside `Views.svelte`, which is the only thing that knows how big a pane is.
  function onKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target instanceof HTMLInputElement) return;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      if (event.shiftKey) session.redo();
      else session.undo();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
      // TrenchBroom's "repeat last actions", and the reason `again` exists on a command
      session.repeat();
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
    <span class="milestone">M10 · inspectors</span>
    <span class="tools">
      {#each tools.all as tool (tool.id)}
        <button
          class:on={tools.current.id === tool.id}
          title="{tool.title} · {tool.key}"
          onclick={() => tools.use(tool.id)}>{tool.title}</button
        >
      {/each}
    </span>
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
  <main><Views /><Inspector /></main>
  <footer>
    <span>grid <b>{formatSize(2 ** exponent)}</b></span>
    <!-- the separator is an expression because the space in front of it is at the edge of a block, and
         that is exactly the whitespace the compiler is entitled to drop -->
    <span>selected <b>{selected}</b>{#if faces}{" · "}faces <b>{faces}</b>{/if}</span>
    <span class="note">{note}</span>
    <span class="hint">[ / ] grid · space maximise · f frame · rmb look · wasd fly</span>
  </footer>
</div>

<style>
  .shell { display: grid; grid-template-rows: auto 1fr auto; height: 100%; }
  header, footer {
    display: flex; gap: 12px; align-items: center;
    padding: 6px 10px; background: var(--panel); border-color: var(--line); border-style: solid;
    font: var(--mono); color: var(--text);
  }
  header { border-width: 0 0 1px; }
  footer { border-width: 1px 0 0; }
  /* the panes take the space that is left; the inspector is as wide as it says it is */
  main { display: grid; grid-template-columns: 1fr auto; min-height: 0; }
  .mark { color: var(--ink); font-weight: 600; }
  .milestone, .hint { color: var(--dim); }
  .hint { margin-left: auto; }
  .note {
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    color: var(--text);
  }
  b { color: var(--ink); font-weight: 600; }
  .layouts, .tools { display: flex; gap: 3px; }
  .layouts { margin-left: auto; }
  .layouts button, .tools button {
    height: 18px; padding: 0 6px; cursor: pointer;
    background: var(--raised); border: 1px solid var(--line); border-radius: 3px;
    font: var(--mono); color: var(--dim);
  }
  .layouts button { width: 20px; padding: 0; }
  .layouts button:hover, .tools button:hover { border-color: var(--edge); color: var(--text); }
  .layouts button.on, .tools button.on { background: var(--on); border-color: var(--edge); color: var(--ink); }
</style>
