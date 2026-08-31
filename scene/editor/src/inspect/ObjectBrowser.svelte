<script lang="ts">
  /**
   * The object browser: everything the project declares that a designer can put in a level.
   *
   * The list is the sheet's own `@template`s, so a project that declares a torch has a torch in here and
   * one that does not, does not. There is no second file to keep in step and nothing to import.
   *
   * Which half of TrenchBroom's split a definition falls in comes from its `@broom { kind }`. A **point**
   * definition arms the create-object tool: the next click in a pane places an instance. A **brush**
   * definition is not placed at all — it is applied, by writing its class onto the solids already
   * selected, which is what "make these five solids a trigger" means.
   */
  import { ANY_NODE, isEntityDef, type ObjectDef } from "../doc/catalogue.ts";
  import { setClasses } from "../doc/inspect.ts";
  import { selectedNodes } from "../doc/selection.ts";
  import { library } from "../library.svelte.ts";
  import { session } from "../session.svelte.ts";
  import { setObjectDef } from "../tools/object.ts";
  import { tools } from "../tools/tools.svelte.ts";

  let filter = $state("");
  let armed = $state("");

  // an entity type is not an object anybody draws, and it has a browser of its own — see EntityBrowser
  const placeable = $derived(library.objects.filter((d) => !isEntityDef(d)));
  const matches = $derived(
    placeable.filter((d) => !filter || `${d.node}.${d.name}`.toLowerCase().includes(filter.toLowerCase())),
  );
  const selected = $derived(selectedNodes(session.editor.world, session.editor.selection));

  const label = (d: ObjectDef) => `${d.node === ANY_NODE ? "" : d.node}.${d.name}`;

  function use(def: ObjectDef) {
    if (def.kind === "brush") return apply(def);
    armed = label(def);
    setObjectDef(def);
    // arming a definition and then having to remember to press `n` is one step too many — the browser is
    // a way of saying "place this", and saying it selects the tool that does
    tools.use("object");
    session.set((e) => ({ ...e, note: `placing ${armed}` }));
  }

  function apply(def: ObjectDef) {
    const ids = selected.map((n) => n.id);
    if (!ids.length) return session.set((e) => ({ ...e, note: `${def.name} applies to a selection` }));
    session.run(`apply ${def.name}`, (e) => ({
      ...e,
      // added to whatever classes are already there rather than replacing them: `.trigger.once` is two
      // templates on one node and both of them mean something
      world: ids.reduce(
        (w, id) => setClasses(w, [id], [...new Set([...(nodeClasses(id) ?? []), def.name])]),
        e.world,
      ),
    }));
    session.set((e) => ({ ...e, note: `${ids.length} × .${def.name}` }));
  }

  const nodeClasses = (id: string) => selected.find((n) => n.id === id)?.classes;
</script>

<div class="browser">
  <input class="filter" placeholder="filter definitions…" bind:value={filter} />
  <ul>
    {#each matches as def (def.node + "." + def.name)}
      <li>
        <button class:on={armed === label(def)} onclick={() => use(def)} title={def.file ?? "the open sheet"}>
          <i class="dot" style:background={def.colour === undefined ? "var(--dim)" : `#${def.colour.toString(16).padStart(6, "0")}`}></i>
          <span class="name">{label(def)}</span>
          <span class="kind">{def.kind}</span>
        </button>
      </li>
    {/each}
    {#if !matches.length}<li class="none">{placeable.length ? "nothing matches" : "the sheet declares no @template"}</li>{/if}
  </ul>
</div>

<style>
  .browser { display: flex; flex-direction: column; gap: 4px; min-height: 0; }
  .filter { width: 100%; }
  ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; max-height: 190px; }
  li { display: block; }
  .none { padding: 4px; color: var(--dim); font: var(--mono); }
  button {
    display: flex; gap: 6px; align-items: center; width: 100%; padding: 3px 5px; cursor: pointer;
    background: transparent; border: 1px solid transparent; border-radius: 3px;
    font: var(--mono); color: var(--text); text-align: left;
  }
  button:hover { background: var(--panel-2); border-color: var(--border); }
  button.on { background: var(--accent-dim); border-color: var(--p5); color: var(--p9); }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 2px; }
  .name { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .kind { flex: none; color: var(--dim); }
</style>
