<script lang="ts">
  /**
   * The map inspector: the settings that belong to the level rather than to anything in it.
   *
   * Grid and scale live in the sheet's own `@broom` block, so they travel with the map — a level built on
   * a 0.25 m grid opens on a 0.25 m grid on somebody else's machine, which is the difference between a
   * shared convention and a house rule everybody has to be told.
   *
   * Layers are here too, because a layer is the level's own filing rather than a thing in the level. Its
   * eye and its lock are the two controls a designer reaches for a hundred times a day: hide the detail
   * pass to work on the blockout, lock the blockout so the detail pass cannot nudge it.
   */
  import { layerNode, updateNode, type LayerNode, type NodeId } from "../doc/document.ts";
  import { withGrid } from "../doc/editor.ts";
  import { mapStats } from "../doc/inspect.ts";
  import { clampExponent, exponents, formatSize } from "../grid/snap.ts";
  import { session } from "../session.svelte.ts";

  const world = $derived(session.editor.world);
  const stats = $derived(mapStats(world));

  const setGrid = (exponent: number) => session.set((e) => withGrid(e, clampExponent(exponent)));

  const setScale = (scale: number) =>
    session.run("map scale", (e) => ({
      ...e,
      world: { ...e.world, broom: { ...e.world.broom, scale: scale > 0 ? scale : 1 } },
    }));

  const flag = (layer: LayerNode, key: "hidden" | "locked") =>
    session.run(`${layer.broom[key] ? "show" : key === "hidden" ? "hide" : "lock"} layer`, (e) => ({
      ...e,
      world: updateNode<LayerNode>(e.world, layer.id, (n) => ({
        ...n,
        broom: { ...n.broom, [key]: !n.broom[key] },
      })),
    }));

  const rename = (layer: LayerNode, name: string) => {
    if (!name || name === layer.name) return;
    session.run("rename layer", (e) => ({
      ...e,
      world: updateNode<LayerNode>(e.world, layer.id, (n) => ({ ...n, name })),
    }));
  };

  const use = (id: NodeId) => session.set((e) => ({ ...e, layer: id, note: "current layer" }));

  const add = () =>
    session.run("new layer", (e) => ({
      ...e,
      world: { ...e.world, layers: [...e.world.layers, layerNode(`layer ${e.world.layers.length + 1}`)] },
    }));
</script>

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

<h3>layers</h3>
<ul>
  {#each world.layers as layer (layer.id)}
    <li class:on={session.editor.layer === layer.id}>
      <button class="eye" class:off={layer.broom.hidden} title={layer.broom.hidden ? "hidden" : "visible"}
        onclick={() => flag(layer, "hidden")}>{layer.broom.hidden ? "·" : "●"}</button>
      <button class="eye" class:off={!layer.broom.locked} title={layer.broom.locked ? "locked" : "unlocked"}
        onclick={() => flag(layer, "locked")}>{layer.broom.locked ? "▪" : "▫"}</button>
      <input class="name" value={layer.name} onchange={(e) => rename(layer, (e.target as HTMLInputElement).value.trim())}
        onfocus={() => use(layer.id)} />
      <span class="count">{layer.children.length}</span>
    </li>
  {/each}
</ul>
<button class="add" onclick={add}>new layer</button>

<h3>counts</h3>
<dl>
  <dt>solids</dt><dd>{stats.brushes}</dd>
  <dt>faces</dt><dd>{stats.faces}</dd>
  <dt>entities</dt><dd>{stats.entities}</dd>
  <dt>groups</dt><dd>{stats.groups}</dd>
  <dt>layers</dt><dd>{stats.layers}</dd>
</dl>

<style>
  .fields { display: grid; grid-template-columns: 56px 1fr; gap: 4px; align-items: center; }
  .fields label { color: var(--dim); font: var(--mono); }
  .pair { display: grid; grid-template-columns: 1fr auto; gap: 4px; align-items: center; }
  .unit { color: var(--dim); font: var(--mono); }
  h3 {
    margin: 12px 0 4px; padding-top: 8px; border-top: 1px solid var(--line);
    font: var(--mono); font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em;
  }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 3px; align-items: center; padding: 1px 2px; border-radius: 3px; }
  li.on { background: var(--on); }
  .name { flex: 1; min-width: 0; }
  .count { flex: none; width: 20px; color: var(--dim); font: var(--mono); text-align: right; }
  .eye {
    flex: none; width: 18px; padding: 0; cursor: pointer;
    background: transparent; border: 0; font: var(--mono); color: var(--ink);
  }
  .eye.off { color: var(--dim); }
  .add { margin-top: 4px; padding: 2px 7px; cursor: pointer;
    background: var(--raised); border: 1px solid var(--line); border-radius: 3px; font: var(--mono); color: var(--text); }
  .add:hover { border-color: var(--edge); color: var(--ink); }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 1px 8px; margin: 0; font: var(--mono); }
  dt { color: var(--dim); }
  dd { margin: 0; color: var(--ink); text-align: right; font-variant-numeric: tabular-nums; }
</style>
