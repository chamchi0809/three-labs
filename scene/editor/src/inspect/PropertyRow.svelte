<script lang="ts">
  /**
   * One row of the property grid, and the editor the value's own shape earns it.
   *
   * Six editors and a seventh that is not one. A number gets a number box, a `#rrggbb` gets a swatch, a
   * `ref(#lamp)` gets the list of `#id`s actually in the map — and a `calc()` gets its own source, greyed,
   * because the honest thing to show for a value the editor cannot decode is the value. TrenchBroom calls
   * these smart editors and picks them from an entity definition's declared types; here the value declares
   * itself, which is one fewer thing to fall out of step.
   *
   * Writing goes back through the same one-property-at-a-time route every tool uses, so the rest of the
   * node's body — its order, its comments, its expressions — comes out of a save exactly as it went in.
   */
  import type { Value } from "tscene";
  import type { Row } from "../doc/inspect.ts";
  import { asColour, asVec3, bool, colour as colourValue, ident, num, read, ref, str, vec3 } from "../doc/props.ts";
  import { printValue } from "../io/literal.ts";

  type Props = {
    row: Row;
    /** every `#id` in the map, for the reference editor */
    ids: string[];
    /** every material the project declares, for the `var(--…)` editor */
    materials: string[];
    set: (value: Value) => void;
    clear: () => void;
    rename: (to: string) => void;
  };
  let { row, ids, materials, set, clear, rename }: Props = $props();

  const value = $derived(row.value);
  const mixed = $derived(row.mixed);

  const number = $derived(value?.kind === "number" ? value.value : 0);
  const unit = $derived(value?.kind === "number" ? value.unit : "");
  const triple = $derived(asVec3(value) ?? [0, 0, 0]);
  const colour = $derived(asColour(value) ?? 0);
  const flag = $derived(value?.kind === "ident" && value.name === "true");
  const named = $derived(value?.kind === "ref" || value?.kind === "var" ? value.name : "");
  // an `ident` is a bare word, not a quoted string, and writing it back as one would change what it means
  const word = $derived(value?.kind === "ident");
  const text = $derived(
    value?.kind === "string" ? value.value : value?.kind === "ident" ? value.name : "",
  );

  const swatch = (v: number) => `#${(v & 0xffffff).toString(16).padStart(6, "0")}`;

  const setAxis = (i: number, to: number) => {
    const next = [...triple] as [number, number, number];
    next[i] = to;
    set(vec3(next));
  };

  const numberOf = (target: EventTarget | null): number => Number((target as HTMLInputElement).value) || 0;
  const textOf = (target: EventTarget | null): string => (target as HTMLInputElement | HTMLSelectElement).value;
</script>

<div class="row" class:inherited={row.inherited}>
  <input
    class="name"
    value={row.name}
    readonly={row.inherited}
    title={row.inherited ? "from the definition — set a value to write it onto the node" : "rename"}
    onchange={(e) => rename(textOf(e.target))}
  />

  <span class="value">
    {#if row.type === "number"}
      <input type="number" step="any" value={mixed ? "" : number} placeholder={mixed ? "mixed" : ""}
        onchange={(e) => set(num(numberOf(e.target), unit))} />
      {#if unit}<span class="unit">{unit}</span>{/if}
    {:else if row.type === "vec3"}
      <span class="triple">
        {#each [0, 1, 2] as i (i)}
          <input type="number" step="any" value={mixed ? "" : triple[i]} placeholder={mixed ? "—" : ""}
            onchange={(e) => setAxis(i, numberOf(e.target))} />
        {/each}
      </span>
    {:else if row.type === "colour"}
      <!-- written back as `color(#rrggbb)`, never as the bare hex: see `colour` in doc/props.ts -->
      <input class="swatch" type="color" value={swatch(colour)}
        onchange={(e) => set(colourValue(parseInt(textOf(e.target).slice(1), 16)))} />
      <input class="hexed" value={mixed ? "" : swatch(colour)} placeholder={mixed ? "mixed" : ""}
        onchange={(e) => set(colourValue(parseInt(textOf(e.target).replace("#", ""), 16) || 0))} />
    {:else if row.type === "bool"}
      <input type="checkbox" checked={flag} indeterminate={mixed}
        onchange={(e) => set(bool((e.target as HTMLInputElement).checked))} />
      <span class="unit">{mixed ? "mixed" : flag ? "true" : "false"}</span>
    {:else if row.type === "ref"}
      <select value={named} onchange={(e) => set(ref(textOf(e.target)))}>
        {#if mixed || !ids.includes(named)}<option value={named}>{mixed ? "mixed" : named || "—"}</option>{/if}
        {#each ids as id (id)}<option value={id}>#{id}</option>{/each}
      </select>
    {:else if row.type === "material"}
      <select value={named} onchange={(e) => set(read(textOf(e.target)))}>
        {#if mixed || !materials.includes(named)}<option value={named}>{mixed ? "mixed" : named || "—"}</option>{/if}
        {#each materials as name (name)}<option value={name}>--{name}</option>{/each}
      </select>
    {:else if row.type === "expression"}
      <code title="an expression belongs to the sheet; the editor shows it and leaves it alone"
        >{value ? printValue(value) : "mixed"}</code>
    {:else}
      <input value={mixed ? "" : text} placeholder={mixed ? "mixed" : ""}
        onchange={(e) => set(word ? ident(textOf(e.target)) : str(textOf(e.target)))} />
    {/if}
  </span>

  <button class="clear" disabled={!row.written} title={row.written ? "remove this property" : "not written here"}
    onclick={() => clear()}>×</button>
</div>

<style>
  .row {
    display: grid; grid-template-columns: 80px 1fr 16px; gap: 4px; align-items: center;
    padding: 1px 0;
  }
  .inherited .name, .inherited .value { opacity: 0.55; }
  .name {
    min-width: 0; padding: 2px 4px;
    background: transparent; border: 1px solid transparent; border-radius: 2px;
    font: var(--mono); color: var(--text);
    overflow: hidden; text-overflow: ellipsis;
  }
  .name:hover, .name:focus { border-color: var(--border); background: var(--bg); }
  .name[readonly] { cursor: default; }
  .name[readonly]:hover { border-color: transparent; background: transparent; }
  .value { display: flex; gap: 4px; align-items: center; min-width: 0; }
  .triple { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; flex: 1; min-width: 0; }
  .unit { flex: none; color: var(--dim); font: var(--mono); }
  code {
    flex: 1; min-width: 0; padding: 2px 4px;
    background: var(--bg); border: 1px solid var(--border); border-radius: 2px;
    font: var(--mono); color: var(--dim);
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  }
  .clear {
    width: 18px; height: 18px; padding: 0; cursor: pointer;
    background: transparent; border: none; border-radius: 2px;
    font: var(--mono); color: var(--dim);
  }
  .clear:hover:not(:disabled) { background: var(--accent-dim); color: var(--p9); }
  .clear:disabled { opacity: 0.25; cursor: default; }
  .swatch { flex: none; width: 22px; height: 18px; padding: 0; border: 1px solid var(--border); background: none; }
  .hexed { width: 72px; flex: none; }
</style>
