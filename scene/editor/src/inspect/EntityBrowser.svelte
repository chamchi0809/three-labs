<script lang="ts">
  /**
   * The entity browser: the types of data this project places, grouped the way it filed them.
   *
   * pixi-vania's `EntityPalette`, brought over as it stands — categories as headings, a coloured dot, the
   * name, how many fields the type has, and the line at the bottom that tells you what to do next. The one
   * thing that changed is where a type comes from: there it is a record in the project file, edited in a
   * dialog; here a type *is* a `@template entity.spawner { … }` in the sheet, so the dot is its
   * `@broom { color }`, the category its `@broom { category }`, and the fields its `@entity`/`@fields`.
   *
   * An entity is not a mesh and this is not the object browser. Nothing in here draws: what a click arms
   * is a record — `hp`, `kind`, `target` — that a click in a pane then places at a point, and that the game
   * reads back with `entities(root)`.
   */
  import IconSettings from "@tabler/icons-svelte/icons/settings";
  import { entityDefs, type ObjectDef } from "../doc/catalogue.ts";
  import { library } from "../library.svelte.ts";
  import { session } from "../session.svelte.ts";
  import { entitySettings, setEntityDef } from "../tools/entity.ts";
  import { tools } from "../tools/tools.svelte.ts";
  import { tooltip } from "../ui/tooltip.ts";

  let { onedittypes }: { onedittypes?: () => void } = $props();

  /** by `@broom { category }`, in the order the sheet first mentioned each one — a project's own order */
  const groups = $derived.by(() => {
    const out = new Map<string, ObjectDef[]>();
    for (const def of entityDefs(library.catalogue)) {
      const key = def.category ?? "other";
      (out.get(key) ?? out.set(key, []).get(key)!).push(def);
    }
    return [...out];
  });

  const armed = $derived(entitySettings.def?.name);

  const swatch = (def: ObjectDef): string =>
    def.colour === undefined ? "var(--dim)" : `#${def.colour.toString(16).padStart(6, "0")}`;

  /** how many keys a type has: its `@entity` defaults, plus any `@fields` declaration that adds to them */
  const count = (def: ObjectDef): number =>
    new Set([...def.fields.map((f) => f.name), ...def.declared.map((f) => f.name)]).size;

  function choose(def: ObjectDef) {
    setEntityDef(def);
    // arming a type and then having to remember to press `e` is one step too many — this browser is a way
    // of saying "place this", and saying it picks the tool that does
    tools.use("entity");
    session.set((e) => ({ ...e, note: `placing ${def.name} — click in a pane` }));
  }
</script>

{#each groups as [category, defs] (category)}
  <h4>{category}</h4>
  <ul class="ents">
    {#each defs as def (def.name)}
      <li class:active={armed === def.name}>
        <button onclick={() => choose(def)} title={def.doc ?? def.file ?? "the open sheet"}>
          <span class="dot" style:background={swatch(def)}></span>
          <span class="name">{def.name}</span>
          {#if count(def)}<span class="fields">{count(def)} field{count(def) > 1 ? "s" : ""}</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
{/each}

{#if !groups.length}
  <p class="hint">no entity types yet — a type is a <code>@template entity.name</code> in the sheet.</p>
{/if}

{#if onedittypes}
  <button class="edit" use:tooltip={"edit entity types"} onclick={onedittypes}>
    <IconSettings size={13} /> edit types…
  </button>
{/if}

<p class="hint">click a type, then click in a pane to place it. use select (V) to move it.</p>

<style>
  .edit {
    display: inline-flex; align-items: center; gap: 5px; margin-top: 8px; padding: 5px 9px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px;
    color: var(--text); font: inherit; cursor: pointer;
  }
  .edit:hover { background: var(--accent-dim); }
  h4 {
    margin: 6px 2px 3px;
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted);
  }
  .ents { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li button {
    width: 100%; display: flex; align-items: center; gap: 7px; padding: 6px 8px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px;
    color: var(--text); font: inherit; text-align: left; cursor: pointer;
  }
  li button:hover { background: var(--accent-dim); }
  li.active button { outline: 1px solid var(--accent); border-color: var(--accent); }
  .dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }
  .name { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .fields { color: var(--muted); font-size: 10px; }
  .hint { color: var(--muted); font-size: 10px; margin: 8px 2px 0; }
  code { font: var(--mono); color: var(--dim); }
</style>
