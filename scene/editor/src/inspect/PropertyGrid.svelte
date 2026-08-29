<script lang="ts">
  /**
   * The property grid: every property the selection has, plus every one its definition says it could have.
   *
   * The list is not sorted. A definition writes `color` before `castShadow` because that is the order
   * somebody thought about them in, and a node's own extras follow in the order the sheet wrote them —
   * an inspector that alphabetises throws that away and gets nothing for it, and worse, moves a row out
   * from under the pointer between one edit and the next.
   */
  import type { Value } from "tscene";
  import type { Row } from "../doc/inspect.ts";
  import { str } from "../doc/props.ts";
  import PropertyRow from "./PropertyRow.svelte";

  type Props = {
    rows: Row[];
    ids: string[];
    materials: string[];
    set: (name: string, value: Value) => void;
    clear: (name: string) => void;
    rename: (from: string, to: string) => void;
  };
  let { rows, ids, materials, set, clear, rename }: Props = $props();

  let adding = $state("");

  function add() {
    const name = adding.trim();
    if (!name) return;
    adding = "";
    // an empty string rather than a guess: the row appears at once, and the editor it gets is the one the
    // first thing typed into it earns
    set(name, str(""));
  }
</script>

<div class="grid">
  {#each rows as row (row.name)}
    <PropertyRow
      {row}
      {ids}
      {materials}
      set={(value) => set(row.name, value)}
      clear={() => clear(row.name)}
      rename={(to) => rename(row.name, to)}
    />
  {/each}
  {#if !rows.length}<p class="none">no properties</p>{/if}
  <div class="add">
    <input
      placeholder="add a property…"
      bind:value={adding}
      onkeydown={(e) => e.key === "Enter" && add()}
      onblur={add}
    />
  </div>
</div>

<style>
  .grid { display: flex; flex-direction: column; }
  .none { margin: 2px 0 4px; color: var(--dim); font: var(--mono); }
  .add { padding-top: 3px; }
  .add input { width: 100%; }
</style>
