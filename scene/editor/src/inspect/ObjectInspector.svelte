<script lang="ts">
  /**
   * The object inspector: what the selected nodes are, and every property they carry.
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
    duplicate, enterGroup, group, hollowBrushes, intersectBrushes, leaveGroup, link, linkedDuplicate,
    matchCopies, mergeBrushes, renameTemplate, subtractBrushes, ungroup, unlink,
  } from "../actions.ts";
  import {
    clearDefProp, ENTITY_NODE, renameDefProp, setDefProp, type DefHalf,
  } from "../doc/catalogue.ts";
  import { isLinked, linkedWith, linkOf } from "../doc/groups.ts";
  import { nodeById } from "../doc/document.ts";
  import {
    commonDef, defRows, describeNodes, entityRowsFor, removeNodesField, removeNodesProp, renameNode,
    renameNodesField, renameNodesProp, rowsFor, setClasses, setNodesField, setNodesProp, setSheetId,
    sheetIds, typeName,
  } from "../doc/inspect.ts";
  import { selectedNodes } from "../doc/selection.ts";
  import { library } from "../library.svelte.ts";
  import { session } from "../session.svelte.ts";
  import Panel from "../ui/Panel.svelte";
  import PatchInspector from "./PatchInspector.svelte";
  import PropertyGrid from "./PropertyGrid.svelte";

  const nodes = $derived(selectedNodes(session.editor.world, session.editor.selection));
  const ids = $derived(nodes.map((n) => n.id));
  const def = $derived(commonDef(library.catalogue, nodes));
  const rows = $derived(rowsFor(nodes, def));
  const fields = $derived(entityRowsFor(nodes, def, library.catalogue.enums));
  // an `entity` node is nothing but its data, so its panel is the point of the whole inspector rather
  // than a footnote under three's properties — see doc/entity.ts and the lib's `Entity` class
  const allEntities = $derived(
    nodes.length > 0 && nodes.every((n) => n.kind === "object" && n.type === ENTITY_NODE),
  );
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

  // the same three against `@entity { … }` — the level's own data, which every object may carry
  const setField = (name: string, value: Value) => {
    session.run(`set ${name}`, (e) => ({ ...e, world: setNodesField(e.world, ids, name, value) }), {
      repeatable: true,
      again: (e) => ({ ...e, world: setNodesField(e.world, e.selection.nodes, name, value) }),
    });
    session.set((e) => ({ ...e, note: `${ids.length} × @entity ${name}` }));
  };

  const clearField = (name: string) =>
    session.run(`clear ${name}`, (e) => ({ ...e, world: removeNodesField(e.world, ids, name) }));

  const renameField = (from: string, to: string) =>
    session.run(`rename ${from}`, (e) => ({ ...e, world: renameNodesField(e.world, ids, from, to) }));

  // ---------------------------------------------------------------- the template half
  //
  // The prefab. `#switch mesh.button` is two things a designer edits separately: the switch, and what
  // every switch is. The grids above write the node; these write the `@template` the node's class names,
  // and the two buttons are the traffic between them — revert takes the template's value, override gives
  // the template the node's. Unity's words, because it is Unity's model.

  const defProps = $derived(def ? defRows(def, "props") : []);
  const defFields = $derived(def ? defRows(def, "fields") : []);

  const editDef = (half: DefHalf) => ({
    set: (name: string, value: Value) => def && library.editTemplate(setDefProp(def, half, name, value)),
    clear: (name: string) => def && library.editTemplate(clearDefProp(def, half, name)),
    rename: (from: string, to: string) => def && library.editTemplate(renameDefProp(def, half, from, to)),
  });
  const propEdits = $derived(editDef("props"));
  const fieldEdits = $derived(editDef("fields"));

  /** the starred rows: what these nodes say and the template does not */
  const over = $derived({ props: rows.filter((r) => r.differs), fields: fields.filter((r) => r.differs) });
  const overs = $derived(over.props.length + over.fields.length);

  /**
   * Clearing an overridden property *is* reverting it: what is left showing is the template's value, or,
   * where the template declares none, the node type's own default. One command, so one ⌘Z.
   */
  function revert() {
    const props = over.props.map((r) => r.name);
    const data = over.fields.map((r) => r.name);
    session.run("revert changes", (e) => {
      let world = e.world;
      for (const name of props) world = removeNodesProp(world, ids, name);
      for (const name of data) world = removeNodesField(world, ids, name);
      return { ...e, world };
    });
  }

  /** the other direction: the template takes what the node says. A row the selection disagrees about is
      skipped — there is no one value to push up. */
  function override() {
    if (!def) return;
    let next = def;
    for (const half of ["props", "fields"] as const) {
      for (const row of over[half]) if (row.value && !row.mixed) next = setDefProp(next, half, row.name, row.value);
    }
    if (next !== def) library.editTemplate(next, `override ${def.name}`);
  }

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
  // CSG is about solids and only solids — a patch bounds no volume, so it is not something to cut with
  const solids = $derived(nodes.filter((n) => n.kind === "brush"));
  const linked = $derived(groups.filter(isLinked));
  const open = $derived(session.editor.open ? nodeById(session.editor.world, session.editor.open) : undefined);
  const copies = $derived(only && isLinked(only) ? linkedWith(session.editor.world, only.id).length : 0);

  const setName = (value: string) => {
    const name = value.trim();
    if (!only || !name) return;
    session.run("rename", (e) => ({ ...e, world: renameNode(e.world, only.id, name) }));
  };
</script>

<Panel title="selection">
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
  {:else}
    <p class="none">pick something to see what it is</p>
  {/if}
</Panel>

{#if nodes.length}
  <Panel title="properties">
    <PropertyGrid {rows} {ids} materials={names} {set} {clear} {rename} />

    <!-- a patch's shape is half in a number, so it gets rows here where a solid's shape needs none -->
    <PatchInspector />
  </Panel>

  <!-- pixi-vania titles this panel with the entity type's own name, which is what a designer is looking
       at when everything selected is one kind of thing -->
  <Panel title={allEntities && def ? def.name : "entity"}>
    <p class="what">
      {allEntities
        ? "the record this entity places — its type's fields, plus anything added here"
        : "what the game reads off this node — the definition's fields, plus anything added here"}
    </p>
    <PropertyGrid rows={fields} {ids} materials={names}
      set={setField} clear={clearField} rename={renameField} />
  </Panel>
{/if}

{#if def}
  <Panel title="template .{def.name}">
    <p class="what">the declaration every <b>.{def.name}</b> follows — an edit here reaches all of them</p>
    <div class="fields">
      <label for="tpl-name">name</label>
      <!-- renaming the declaration renames the class on every instance of it, in the same command -->
      <input id="tpl-name" value={def.name} title="the class every instance carries — renaming it renames them too"
        onchange={(e) => {
          renameTemplate(def, (e.target as HTMLInputElement).value);
          // whatever the rename decided is what the box should say — a refused name has to come back
          (e.target as HTMLInputElement).value = def.name;
        }} />
    </div>
    <div class="buttons pair">
      <button disabled={!overs} title="put the template's value back on the selection (or the type's default, where the template has none)"
        onclick={revert}>revert changes{#if overs}&nbsp;({overs}){/if}</button>
      <button disabled={!overs} title="make the template say what the selection says"
        onclick={override}>override</button>
    </div>
    <PropertyGrid rows={defProps} {ids} materials={names} {...propEdits} />
    <p class="what">@entity defaults</p>
    <PropertyGrid rows={defFields} {ids} materials={names} {...fieldEdits} />
  </Panel>
{/if}

<Panel title="structure">
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
</Panel>

<Panel title="solids">
  <div class="buttons">
    <button disabled={!solids.length} title="cut the selected solids out of everything they overlap, then delete them"
      onclick={subtractBrushes}>subtract</button>
    <button disabled={solids.length < 2} title="keep only the volume every selected solid shares"
      onclick={intersectBrushes}>intersect</button>
    <button disabled={solids.length < 2} title="replace the selection with its convex hull"
      onclick={mergeBrushes}>merge</button>
    <button disabled={!solids.length} title="turn each selected solid into a shell one grid cell thick"
      onclick={hollowBrushes}>hollow</button>
  </div>
</Panel>

<style>
  .head { margin: 0 0 6px; font: var(--mono); color: var(--text); }
  .what { margin: 0 0 5px; color: var(--dim); font: var(--mono); }
  .head b { color: var(--p9); font-weight: 600; }
  .def { color: var(--accent); }
  .none { margin: 2px 0; color: var(--dim); font: var(--mono); }
  .dim { color: var(--dim); font: var(--mono); }
  .fields { display: grid; grid-template-columns: 56px 1fr; gap: 5px; align-items: center; }
  .fields label, .fields .label { color: var(--muted); font: var(--mono); }
  .buttons.pair { grid-template-columns: repeat(2, 1fr); }
  .what b { color: var(--p9); font-weight: 600; }
  .buttons { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; margin-bottom: 3px; }
  .buttons button, .inside button {
    height: 21px; padding: 0 2px; cursor: pointer;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px;
    font: var(--mono); color: var(--text);
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .buttons button:hover:not(:disabled), .inside button:hover { background: var(--accent-dim); color: var(--p9); }
  .buttons button:disabled { color: var(--dim); opacity: 0.5; cursor: default; }
  .inside { display: flex; gap: 5px; align-items: center; margin: 0 0 4px; font: var(--mono); color: var(--text); }
  .inside b, .linked b { color: var(--p9); font-weight: 600; }
  .inside button { margin-left: auto; padding: 0 8px; }
  .linked { margin: 4px 0 0; font: var(--mono); color: var(--dim); }
</style>
