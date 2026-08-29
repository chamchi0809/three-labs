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
    duplicate, enterGroup, group, leaveGroup, link, linkedDuplicate, matchCopies, ungroup, unlink,
  } from "../actions.ts";
  import { isLinked, linkedWith, linkOf } from "../doc/groups.ts";
  import { nodeById } from "../doc/document.ts";
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

  // what the structure buttons are allowed to do with what is selected
  const groups = $derived(nodes.filter((n) => n.kind === "group"));
  const linked = $derived(groups.filter(isLinked));
  const open = $derived(session.editor.open ? nodeById(session.editor.world, session.editor.open) : undefined);
  const copies = $derived(only && isLinked(only) ? linkedWith(session.editor.world, only.id).length : 0);

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

<h3>structure</h3>
{#if open}
  <p class="inside">inside <b>{open.kind === "group" ? open.name : "a group"}</b>
    <button onclick={leaveGroup}>leave</button></p>
{/if}
<div class="buttons">
  <button disabled={!nodes.length} onclick={() => group()}>group</button>
  <button disabled={!groups.length} onclick={ungroup}>ungroup</button>
  <button disabled={groups.length !== 1} onclick={() => enterGroup(groups[0]!.id)}>enter</button>
  <button disabled={!nodes.length} onclick={duplicate}>duplicate</button>
</div>
<div class="buttons">
  <button disabled={!groups.length} onclick={linkedDuplicate}>linked copy</button>
  <button disabled={groups.length < 2} onclick={link}>link</button>
  <button disabled={!linked.length} onclick={unlink}>unlink</button>
  <button disabled={!linked.length} title="make the other copies match this one"
    onclick={matchCopies}>match</button>
</div>
{#if only && isLinked(only)}
  <p class="linked">
    one of <b>{copies + 1}</b> copies of <b>{linkOf(only)}</b> — an edit here reaches all of them
  </p>
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
  .buttons { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; margin-bottom: 3px; }
  .buttons button {
    height: 20px; padding: 0 2px; cursor: pointer;
    background: var(--raised); border: 1px solid var(--line); border-radius: 3px; font: var(--mono); color: var(--text);
  }
  .buttons button:hover:not(:disabled) { border-color: var(--edge); color: var(--ink); }
  .buttons button:disabled { color: var(--dim); opacity: 0.5; cursor: default; }
  .inside { display: flex; gap: 5px; align-items: center; margin: 0 0 4px; font: var(--mono); color: var(--text); }
  .inside b, .linked b { color: var(--ink); font-weight: 600; }
  .inside button {
    margin-left: auto; padding: 1px 6px; cursor: pointer;
    background: var(--raised); border: 1px solid var(--line); border-radius: 3px; font: var(--mono); color: var(--text);
  }
  .linked { margin: 2px 0 0; font: var(--mono); color: var(--dim); }
</style>
