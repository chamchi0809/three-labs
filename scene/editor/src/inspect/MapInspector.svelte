<script lang="ts">
  /**
   * The map inspector: the settings that belong to the level rather than to anything in it.
   *
   * Grid and scale live in the sheet's own `@broom` block, so they travel with the map — a level built on
   * a 0.25 m grid opens on a 0.25 m grid on somebody else's machine, which is the difference between a
   * shared convention and a house rule everybody has to be told.
   *
   * Layers and tags used to be here and are now the left column's, where they can be read while working
   * rather than only while this tab happens to be up.
   */
  import { withGrid } from "../doc/editor.ts";
  import { mapStats } from "../doc/inspect.ts";
  import { clampExponent, exponents, formatSize } from "../grid/snap.ts";
  import { session } from "../session.svelte.ts";
  import Panel from "../ui/Panel.svelte";

  const world = $derived(session.editor.world);
  const stats = $derived(mapStats(world));

  const setGrid = (exponent: number) => session.set((e) => withGrid(e, clampExponent(exponent)));

  const setScale = (scale: number) =>
    session.run("map scale", (e) => ({
      ...e,
      world: { ...e.world, broom: { ...e.world.broom, scale: scale > 0 ? scale : 1 } },
    }));
</script>

<Panel title="map">
  <div class="fields">
    <label for="grid">grid</label>
    <select id="grid" value={world.broom.grid} onchange={(e) => setGrid(Number((e.target as HTMLSelectElement).value))}>
      {#each exponents() as exponent (exponent)}
        <option value={exponent}>{formatSize(2 ** exponent)}</option>
      {/each}
    </select>

    <label for="scale">scale</label>
    <span class="pair">
      <input id="scale" type="number" step="any" min="0.001" value={world.broom.scale}
        onchange={(e) => setScale(Number((e.target as HTMLInputElement).value))} />
      <span class="unit">units per metre</span>
    </span>
  </div>
</Panel>

<Panel title="counts">
  <dl>
    <dt>solids</dt><dd>{stats.brushes}</dd>
    <dt>faces</dt><dd>{stats.faces}</dd>
    <!-- counted apart from the solids, because a patch is a surface and contributes none of those faces -->
    <dt>patches</dt><dd>{stats.patches}</dd>
    <dt>entities</dt><dd>{stats.entities}</dd>
    <dt>groups</dt><dd>{stats.groups}</dd>
    <dt>layers</dt><dd>{stats.layers}</dd>
  </dl>
</Panel>

<style>
  .fields { display: grid; grid-template-columns: 56px 1fr; gap: 5px; align-items: center; }
  .fields label { color: var(--muted); font: var(--mono); }
  .pair { display: grid; grid-template-columns: 1fr auto; gap: 5px; align-items: center; }
  .unit { color: var(--dim); font: var(--mono); }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; margin: 0; font: var(--mono); }
  dt { color: var(--muted); }
  dd { margin: 0; color: var(--p9); text-align: right; font-variant-numeric: tabular-nums; }
</style>
