<script lang="ts">
  /**
   * The layer list, in the left column rather than behind a tab.
   *
   * A layer is the level's own filing, not a thing in the level, so it does not belong in an inspector that
   * is otherwise about whatever is picked — and it is read *while* working, which is the whole argument for
   * a column. Its eye and its lock are the two controls a designer reaches for a hundred times a day: hide
   * the detail pass to work on the blockout, lock the blockout so the detail pass cannot nudge it.
   */
  import IconArrowNarrowLeft from "@tabler/icons-svelte/icons/arrow-narrow-left";
  import IconEye from "@tabler/icons-svelte/icons/eye";
  import IconEyeOff from "@tabler/icons-svelte/icons/eye-off";
  import IconLock from "@tabler/icons-svelte/icons/lock";
  import IconLockOpen from "@tabler/icons-svelte/icons/lock-open";
  import IconPlus from "@tabler/icons-svelte/icons/plus";
  import IconX from "@tabler/icons-svelte/icons/x";

  import {
    deleteLayer, hideNode, lockNode, moveSelectionToLayer, nameLayer, newLayer, showEverything,
    unlockEverything, useLayer,
  } from "../actions.ts";
  import type { LayerNode } from "../doc/document.ts";
  import { isEmpty } from "../doc/selection.ts";
  import { session } from "../session.svelte.ts";
  import Panel from "../ui/Panel.svelte";
  import { tooltip } from "../ui/tooltip.ts";

  const world = $derived(session.editor.world);
  const holding = $derived(!isEmpty(session.editor.selection));

  const rename = (layer: LayerNode, name: string) => {
    if (!name || name === layer.name) return;
    nameLayer(layer.id, name);
  };
</script>

<Panel title="layers" grow>
  {#snippet actions()}
    <button class="ico" use:tooltip={"show everything"} onclick={showEverything}><IconEye size={13} /></button>
    <button class="ico" use:tooltip={"unlock everything"} onclick={unlockEverything}><IconLockOpen size={13} /></button>
    <button class="ico" use:tooltip={"new layer"} onclick={() => newLayer()}><IconPlus size={13} /></button>
  {/snippet}

  <ul>
    {#each world.layers as layer (layer.id)}
      <li class:on={session.editor.layer === layer.id}>
        <button
          class="ico"
          class:off={layer.broom.hidden}
          use:tooltip={layer.broom.hidden ? "hidden" : "visible"}
          onclick={() => hideNode(layer.id)}
        >
          {#if layer.broom.hidden}<IconEyeOff size={13} />{:else}<IconEye size={13} />{/if}
        </button>
        <button
          class="ico"
          class:off={!layer.broom.locked}
          use:tooltip={layer.broom.locked ? "locked" : "unlocked"}
          onclick={() => lockNode(layer.id)}
        >
          {#if layer.broom.locked}<IconLock size={13} />{:else}<IconLockOpen size={13} />{/if}
        </button>
        <input
          class="name"
          value={layer.name}
          onchange={(e) => rename(layer, (e.target as HTMLInputElement).value.trim())}
          onfocus={() => useLayer(layer.id)}
        />
        <span class="count">{layer.children.length}</span>
        {#if holding}
          <!-- the selection moved here, which is the only thing a layer list is for that a name is not -->
          <button class="ico" use:tooltip={`move the selection to ${layer.name}`}
            onclick={() => moveSelectionToLayer(layer.id)}><IconArrowNarrowLeft size={13} /></button>
        {/if}
        {#if world.layers.length > 1}
          <button class="ico danger" use:tooltip={`delete ${layer.name}; what is in it goes to the next layer`}
            onclick={() => deleteLayer(layer.id)}><IconX size={13} /></button>
        {/if}
      </li>
    {/each}
  </ul>
</Panel>

<style>
  ul { list-style: none; margin: 0; padding: 0; }
  li {
    display: flex; gap: 2px; align-items: center;
    padding: 1px 2px; border-radius: 4px;
  }
  li.on { background: var(--accent-dim); }
  li:hover { background: color-mix(in srgb, var(--accent-dim) 55%, transparent); }
  li.on:hover { background: var(--accent-dim); }
  .name {
    flex: 1; min-width: 0; height: 20px;
    background: transparent; border: 1px solid transparent; color: var(--p9);
  }
  .name:hover { border-color: var(--border); }
  .count {
    flex: none; width: 20px; text-align: right;
    color: var(--dim); font: var(--mono); font-variant-numeric: tabular-nums;
  }
  .ico {
    flex: none;
    display: grid; place-items: center;
    width: 19px; height: 19px; padding: 0;
    background: transparent; border: 0; border-radius: 4px;
    color: var(--muted); cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }
  .ico:hover { background: var(--p4); color: var(--p9); }
  .ico.off { color: var(--dim); }
  .ico.danger:hover { background: var(--bad); color: var(--p0); }
</style>
