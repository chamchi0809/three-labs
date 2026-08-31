<script lang="ts">
  /**
   * The patch rows: the shape of the control grid, and the operations that keep it a grid.
   *
   * A patch is the one thing in the level whose geometry is edited by *count* rather than by dragging —
   * how many spans it has each way is a number a designer picks, not a thing they can pull on. So it gets
   * rows in the inspector where a solid gets none: a solid's shape is entirely in the viewport, and a
   * patch's shape is half in a number.
   *
   * The buttons are the patch tool's keys, reachable with any tool in hand. Add and drop work at the last
   * span, which is the end the tool uses too — a row inserted in the middle of a dome would move the
   * handles the designer was just looking at.
   */
  import {
    addPatchColumn, addPatchRow, dropPatchColumn, dropPatchRow, flipPatches, setPatchDetail, snapPatches,
  } from "../actions.ts";
  import type { PatchNode } from "../doc/document.ts";
  import { selectedNodes } from "../doc/selection.ts";
  import { columnsOf, rowsOf, spansOf } from "../patch/patch.ts";
  import { session } from "../session.svelte.ts";

  const patches = $derived(
    selectedNodes(session.editor.world, session.editor.selection)
      .filter((n): n is PatchNode => n.kind === "patch"),
  );
  const only = $derived(patches.length === 1 ? patches[0] : undefined);

  /** the grid a row of numbers can speak for: one patch, or several that happen to agree */
  const shape = $derived.by(() => {
    if (!patches.length) return undefined;
    const first = spansOf(patches[0]!.patch.grid);
    return patches.every((p) => {
      const s = spansOf(p.patch.grid);
      return s.down === first.down && s.across === first.across;
    })
      ? first
      : undefined;
  });

  const detail = $derived.by(() => {
    const first = patches[0]?.patch.subdivisions;
    return patches.every((p) => p.patch.subdivisions === first) ? first : undefined;
  });

  // a span needs two of its three control points to remain a span, so three-by-three is the floor
  const canDropRow = $derived(patches.some((p) => spansOf(p.patch.grid).down > 1));
  const canDropColumn = $derived(patches.some((p) => spansOf(p.patch.grid).across > 1));

  const setDetail = (value: string) => {
    const n = Number(value);
    setPatchDetail(value.trim() && n > 0 ? n : undefined);
  };
</script>

{#if patches.length}
  <h3>patch</h3>
  <div class="fields">
    <span class="label">spans</span>
    {#if shape}
      <span class="dim">{shape.across} across × {shape.down} down</span>
    {:else}
      <span class="dim">they disagree</span>
    {/if}

    <span class="label">points</span>
    {#if only}
      <span class="dim">{columnsOf(only.patch.grid)} × {rowsOf(only.patch.grid)}</span>
    {:else}
      <span class="dim">{patches.length} patches</span>
    {/if}

    <label for="patch-detail">detail</label>
    <span class="pair">
      <input id="patch-detail" type="number" min="1" step="1" placeholder="auto" value={detail ?? ""}
        onchange={(e) => setDetail((e.target as HTMLInputElement).value)} />
      <!-- blank is not zero: a patch with no number lets the curvature pick, which is what a sheet
           usually says and what keeps a barely-bent patch from costing sixteen rows -->
      <span class="unit">segments per span</span>
    </span>
  </div>

  <div class="buttons">
    <button title="add a row at the far edge" onclick={addPatchRow}>+ row</button>
    <button disabled={!canDropRow} title="take the last row off" onclick={dropPatchRow}>− row</button>
    <button title="add a column at the far edge" onclick={addPatchColumn}>+ col</button>
    <button disabled={!canDropColumn} title="take the last column off" onclick={dropPatchColumn}>− col</button>
  </div>
  <div class="buttons two">
    <button title="turn the surface inside out" onclick={flipPatches}>flip</button>
    <button title="put every control point on the grid" onclick={snapPatches}>snap</button>
  </div>
{/if}

<style>
  h3 {
    margin: 12px 0 4px; padding-top: 8px; border-top: 1px solid var(--border);
    font: var(--mono); font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em;
  }
  .fields { display: grid; grid-template-columns: 56px 1fr; gap: 4px; align-items: center; margin-bottom: 6px; }
  .fields label, .fields .label { color: var(--dim); font: var(--mono); }
  .dim { color: var(--dim); font: var(--mono); }
  .pair { display: grid; grid-template-columns: 1fr auto; gap: 4px; align-items: center; }
  .unit { color: var(--dim); font: var(--mono); }
  .buttons { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; margin-bottom: 3px; }
  .buttons.two { grid-template-columns: repeat(2, 1fr); }
  .buttons button {
    height: 20px; padding: 0 2px; cursor: pointer;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 3px; font: var(--mono); color: var(--text);
  }
  .buttons button:hover:not(:disabled) { border-color: var(--p5); color: var(--p9); }
  .buttons button:disabled { color: var(--dim); opacity: 0.5; cursor: default; }
</style>
