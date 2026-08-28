<script lang="ts">
  // The shell. M0 is a single viewport and a status bar; M7 splits the centre into the three-pane
  // layout and M10 hangs the inspectors off the right edge.
  import Viewport from "./viewport/Viewport.svelte";
  import { DEFAULT_EXPONENT, clampExponent, formatSize, gridSize } from "./grid/snap.ts";

  let exponent = $state(DEFAULT_EXPONENT);
  const size = $derived(gridSize(exponent));

  // `[` and `]` step the grid, as they do in TrenchBroom. Bound on window rather than on the viewport
  // so the grid still responds while the focus sits in a panel.
  function onKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target instanceof HTMLInputElement) return;
    if (event.key === "[") exponent = clampExponent(exponent - 1);
    else if (event.key === "]") exponent = clampExponent(exponent + 1);
    else return;
    event.preventDefault();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="shell">
  <header>
    <span class="mark">three-broom</span>
    <span class="milestone">M0 · scaffold</span>
  </header>
  <main><Viewport {size} /></main>
  <footer>
    <span>grid <b>{formatSize(size)}</b></span>
    <span class="hint">[ / ] to change</span>
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
