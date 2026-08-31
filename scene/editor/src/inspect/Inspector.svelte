<script lang="ts">
  /**
   * The inspector panel: map, entity and face, in TrenchBroom's three tabs.
   *
   * The tab follows the selection until the designer says otherwise — pick a face and the face tab comes
   * up, pick a lamp and the entity tab does. That is what they were about to click anyway, and an
   * inspector that guesses right nine times out of ten costs one click on the tenth, where one that never
   * guesses costs a click every time.
   *
   * The panel owns the look of every control inside it. A `<input>` in the property grid and one in the
   * face inspector are the same box because they are styled once, here, rather than in each component
   * that happens to need one.
   */
  import IconAlertTriangle from "@tabler/icons-svelte/icons/alert-triangle";
  import IconBulb from "@tabler/icons-svelte/icons/bulb";
  import IconMap from "@tabler/icons-svelte/icons/map";
  import IconPolygon from "@tabler/icons-svelte/icons/polygon";
  import type { Icon } from "@tabler/icons-svelte";

  import { isEmpty } from "../doc/selection.ts";
  import { session } from "../session.svelte.ts";
  import { tooltip } from "../ui/tooltip.ts";
  import EntityInspector from "./EntityInspector.svelte";
  import FaceInspector from "./FaceInspector.svelte";
  import IssueBrowser from "./IssueBrowser.svelte";
  import MapInspector from "./MapInspector.svelte";

  // the issue browser is never *suggested*, only chosen: a panel that jumped to the checker because the
  // solid being dragged is briefly off the grid would be unusable
  type Tab = "map" | "entity" | "face" | "issues";
  const TABS: { id: Tab; icon: Icon; say: string }[] = [
    { id: "map", icon: IconMap, say: "map — grid, scale and what the level is made of" },
    { id: "entity", icon: IconBulb, say: "entity — the properties of what is picked" },
    { id: "face", icon: IconPolygon, say: "face — material and how it sits on the surface" },
    { id: "issues", icon: IconAlertTriangle, say: "issues — what the checker has to say" },
  ];

  let chosen = $state<Tab | undefined>(undefined);

  const suggested = $derived<Tab>(
    session.editor.selection.faces.length ? "face" : isEmpty(session.editor.selection) ? "map" : "entity",
  );
  const tab = $derived(chosen ?? suggested);
</script>

<div class="inspector">
  <nav>
    {#each TABS as { id, icon: Icon, say } (id)}
      <button class:on={tab === id} use:tooltip={say} onclick={() => (chosen = chosen === id ? undefined : id)}>
        <Icon size={15} />
        <span>{id}</span>
      </button>
    {/each}
  </nav>
  <div class="body">
    {#if tab === "map"}<MapInspector />
    {:else if tab === "entity"}<EntityInspector />
    {:else if tab === "issues"}<IssueBrowser />
    {:else}<FaceInspector />{/if}
  </div>
</div>

<style>
  .inspector {
    display: grid; grid-template-rows: auto 1fr;
    min-height: 0; height: 100%;
    background: var(--panel);
  }
  nav {
    display: flex; gap: 3px; padding: 6px;
    background: var(--panel-2); border-bottom: 1px solid var(--border);
  }
  nav button {
    /* a quarter of the column each while the inspector is a column, and no wider than a tab needs to be
       once the narrow layout lays it across the whole window */
    flex: 1 1 0; max-width: 140px;
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 4px 0 3px; cursor: pointer;
    background: var(--panel); border: 1px solid var(--border); border-radius: 5px;
    font: var(--ui); font-size: 10px; color: var(--muted);
    transition: background-color 130ms ease, border-color 130ms ease, color 130ms ease;
  }
  nav button:hover { background: var(--accent-dim); color: var(--p9); }
  nav button.on { background: var(--accent); border-color: var(--accent); color: var(--p0); }
  .body { overflow-y: auto; min-height: 0; }

  /* every control in the panel, sized once — the shell says what one looks like, this says how tall */
  .body :global(input:not([type="checkbox"]):not([type="range"])), .body :global(select) {
    height: 21px;
    font: var(--mono);
  }
  .body :global(input[type="color"]) { padding: 1px; }
</style>
