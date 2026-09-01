<script lang="ts">
  /**
   * A titled section of a side column — pixi-vania's `Panel`, brought over as-is.
   *
   * The title bar is what makes a column of unrelated lists readable: a small caps label on a raised strip,
   * and the buttons that belong to *that* list sitting in it rather than floating in the body. `grow` is for
   * the one panel in a column that should take whatever height is left.
   */
  import type { Snippet } from "svelte";

  let {
    title,
    actions,
    children,
    grow = false,
  }: {
    title: string;
    actions?: Snippet;
    children: Snippet;
    grow?: boolean;
  } = $props();
</script>

<section class="panel" class:grow>
  <header>
    <span class="title">{title}</span>
    {#if actions}
      <div class="actions">{@render actions()}</div>
    {/if}
  </header>
  <div class="body">
    {@render children()}
  </div>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    /* never squeezed: a short window scrolls the column rather than crushing the panels at the top of it
       out of existence, which is what `1 1 auto` would do to a panel above a long list */
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
  }
  .panel.grow {
    flex-grow: 1;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 5px 8px;
    background: var(--panel-2);
    border-bottom: 1px solid var(--border);
  }
  .title {
    font-size: var(--ui-xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .actions {
    display: flex;
    gap: 3px;
  }
  .body {
    overflow: auto;
    min-height: 0;
    padding: 6px;
  }
  .panel.grow .body {
    flex: 1;
  }
</style>
