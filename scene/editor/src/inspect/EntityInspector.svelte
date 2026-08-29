<script lang="ts">
  /**
   * The entity inspector: what the selected nodes are, and every property they carry.
   *
   * It edits the whole selection at once. Picking eight lamps and typing `12` into `intensity` writes
   * eight properties, and a field they disagree about says so rather than showing the first one's number —
   * which is the difference between an inspector a designer can trust with a selection and one they have
   * to click through node by node.
   *
   * The head of a node — its `#id` and its classes — is edited separately from its body, because that is
   * how the sheet is written: `mesh.crate#lamp { … }`. The id is what `ref(#lamp)` on another node points
   * at, so it is a name in the level rather than a property of the thing.
   */
  import type { Value } from "tscene";
  import {
    commonDef, describeNodes, removeNodesProp, renameNode, renameNodesProp, rowsFor, setClasses,
    setNodesProp, setSheetId, sheetIds, typeName,
  } from "../doc/inspect.ts";
  import { selectedNodes } from "../doc/selection.ts";
  import { library } from "../library.svelte.ts";
  import { session } from "../session.svelte.ts";
  import EntityBrowser from "./EntityBrowser.svelte";
  import PropertyGrid from "./PropertyGrid.svelte";

  const nodes = $derived(selectedNodes(session.editor.world, session.editor.selection));
  const ids = $derived(nodes.map((n) => n.id));
  const def = $derived(commonDef(library.catalogue, nodes));
  const rows = $derived(rowsFor(nodes, def));
  const only = $derived(nodes.length === 1 ? nodes[0] : undefined);
  const names = $derived(library.materials.map((m) => m.name));
  const taken = $derived(sheetIds(session.editor.world));

  const set = (name: string, value: Value) => {
    session.run(`set ${name}`, (e) => ({ ...e, world: setNodesProp(e.world, ids, name, value) }), {
      repeatable: true,
      again: (e) => ({ ...e, world: setNodesProp(e.world, e.selection.nodes, name, value) }),
    });
    session.set((e) => ({ ...e, note: `${ids.length} × ${name}` }));
  };

  const clear = (name: string) =>
    session.run(`clear ${name}`, (e) => ({ ...e, world: removeNodesProp(e.world, ids, name) }));

  const rename = (from: string, to: string) =>
    session.run(`rename ${from}`, (e) => ({ ...e, world: renameNodesProp(e.world, ids, from, to) }));

  function setId(value: string) {
    const id = value.trim();
    if (!only || id === (only.sheetId ?? "")) return;
    // two nodes answering to `#lamp` means `ref(#lamp)` no longer names one thing, so the box refuses
    // rather than writing a level that reads back wrong
    if (id && taken.includes(id)) return session.set((e) => ({ ...e, note: `#${id} is taken` }));
    session.run("set id", (e) => ({ ...e, world: setSheetId(e.world, only.id, id) }));
  }

  const setClassList = (value: string) => {
    const classes = value.split(/[\s.]+/).filter(Boolean);
    session.run("set classes", (e) => ({ ...e, world: setClasses(e.world, ids, classes) }));
  };

  const setName = (value: string) => {
    const name = value.trim();
    if (!only || !name) return;
    session.run("rename", (e) => ({ ...e, world: renameNode(e.world, only.id, name) }));
  };
</script>

<p class="head">
  <b>{describeNodes(nodes)}</b>{#if def}<span class="def">.{def.name}</span>{/if}
</p>

{#if nodes.length}
  <div class="fields">
    {#if only && (only.kind === "group" || only.kind === "layer")}
      <label for="node-name">name</label>
      <input id="node-name" value={only.name} onchange={(e) => setName((e.target as HTMLInputElement).value)} />
    {/if}

    <label for="node-id">id</label>
    {#if only}
      <input id="node-id" placeholder="none" value={only.sheetId ?? ""}
        onchange={(e) => setId((e.target as HTMLInputElement).value)} />
    {:else}
      <span class="dim">one at a time</span>
    {/if}

    <label for="node-classes">classes</label>
    <input id="node-classes" placeholder="none"
      value={only ? only.classes.join(" ") : [...new Set(nodes.flatMap((n) => n.classes))].join(" ")}
      onchange={(e) => setClassList((e.target as HTMLInputElement).value)} />

    <span class="label">kind</span>
    <span class="dim">{[...new Set(nodes.map(typeName))].join(", ")}</span>
  </div>

  <h3>properties</h3>
  <PropertyGrid {rows} {ids} materials={names} {set} {clear} {rename} />
{:else}
  <p class="none">pick something to see what it is</p>
{/if}

<h3>definitions</h3>
<EntityBrowser />

<style>
  .head { margin: 0 0 6px; font: var(--mono); color: var(--text); }
  .head b { color: var(--ink); font-weight: 600; }
  .def { color: var(--accent); }
  .none { margin: 4px 0; color: var(--dim); font: var(--mono); }
  .dim { color: var(--dim); font: var(--mono); }
  .fields { display: grid; grid-template-columns: 56px 1fr; gap: 4px; align-items: center; }
  .fields label, .fields .label { color: var(--dim); font: var(--mono); }
  h3 {
    margin: 12px 0 4px; padding-top: 8px; border-top: 1px solid var(--line);
    font: var(--mono); font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em;
  }
</style>
