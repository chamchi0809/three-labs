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
  import { isEmpty } from "../doc/selection.ts";
  import { session } from "../session.svelte.ts";
  import EntityInspector from "./EntityInspector.svelte";
  import FaceInspector from "./FaceInspector.svelte";
  import MapInspector from "./MapInspector.svelte";

  type Tab = "map" | "entity" | "face";
  const TABS: Tab[] = ["map", "entity", "face"];

  let chosen = $state<Tab | undefined>(undefined);

  const suggested = $derived<Tab>(
    session.editor.selection.faces.length ? "face" : isEmpty(session.editor.selection) ? "map" : "entity",
  );
  const tab = $derived(chosen ?? suggested);
</script>

<aside class="inspector">
  <nav>
    {#each TABS as name (name)}
      <button class:on={tab === name} onclick={() => (chosen = chosen === name ? undefined : name)}>{name}</button>
    {/each}
  </nav>
  <div class="body">
    {#if tab === "map"}<MapInspector />
    {:else if tab === "entity"}<EntityInspector />
    {:else}<FaceInspector />{/if}
  </div>
</aside>

<style>
  .inspector {
    display: grid; grid-template-rows: auto 1fr; width: 320px; min-height: 0;
    background: var(--panel); border-left: 1px solid var(--line);
  }
  nav { display: flex; gap: 2px; padding: 5px 6px; border-bottom: 1px solid var(--line); }
  nav button {
    flex: 1; height: 20px; cursor: pointer;
    background: var(--raised); border: 1px solid var(--line); border-radius: 3px;
    font: var(--mono); color: var(--dim);
  }
  nav button:hover { border-color: var(--edge); color: var(--text); }
  nav button.on { background: var(--on); border-color: var(--edge); color: var(--ink); }
  .body { padding: 8px; overflow-y: auto; min-height: 0; }

  /* every control in the panel, styled once — the children ask for an input, not for a look */
  .body :global(input), .body :global(select) {
    box-sizing: border-box; height: 20px; min-width: 0; padding: 0 5px;
    background: var(--sunk); border: 1px solid var(--line); border-radius: 3px;
    font: var(--mono); color: var(--ink);
  }
  .body :global(input:focus), .body :global(select:focus) { outline: 1px solid var(--accent); outline-offset: -1px; }
  .body :global(input::placeholder) { color: var(--dim); }
  .body :global(input[type="color"]) { padding: 1px; }
  .body :global(input[type="checkbox"]) { height: auto; }
</style>
