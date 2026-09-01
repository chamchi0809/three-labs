<script lang="ts">
  /**
   * The entity browser: the types this project places, and what each one is.
   *
   * pixi-vania keeps the palette and the defs editor in two dialogs; here they are one, because the list
   * that picks a type to place is the same list that picks a type to edit — clicking a name arms it for
   * the next click in a pane *and* opens it on the right. A type lives in the sheet rather than in a
   * project file: it is a `@template entity.spawn { … }`, so every edit in here is an edit to a
   * declaration and `io/templates.ts` writes it back on save.
   *
   * An entity is not a mesh and this is not the object browser. Nothing in here draws: what a click arms
   * is a record — `hp`, `kind`, `target` — that a click in a pane places at a point, and that the game
   * reads back with `entities(root)`.
   *
   * The fields table is `doc/schema.ts`'s job, because a field is two things in a sheet — a default in
   * `@entity` and a declaration in `@fields` — and one row in a table. The defaults grid under it is the
   * same {@link PropertyGrid} the inspector uses, so a default gets the editor its type earns rather than
   * a second set of widgets written here.
   */
  import type { FieldType } from "tscene";
  import IconPlus from "@tabler/icons-svelte/icons/plus";
  import IconTrash from "@tabler/icons-svelte/icons/trash";
  import { deleteTemplate, renameTemplate } from "../actions.ts";
  import { clearDefProp, defKey, entityDefs, setDefProp, type ObjectDef } from "../doc/catalogue.ts";
  import { defRows } from "../doc/inspect.ts";
  import {
    FIELD_TYPES, addSchemaField, removeSchemaField, renameSchemaField, schemaOf, setSchemaKnob,
    setSchemaType, type SchemaRow,
  } from "../doc/schema.ts";
  import { library } from "../library.svelte.ts";
  import { session } from "../session.svelte.ts";
  import { setEntityDef } from "../tools/entity.ts";
  import { tools } from "../tools/tools.svelte.ts";
  import { tooltip } from "../ui/tooltip.ts";
  import PropertyGrid from "./PropertyGrid.svelte";

  const types = $derived(entityDefs(library.catalogue));

  /** by `@broom { category }`, in the order the sheet first mentioned each one — a project's own order */
  const groups = $derived.by(() => {
    const out = new Map<string, ObjectDef[]>();
    for (const def of types) {
      const key = def.category ?? "other";
      (out.get(key) ?? out.set(key, []).get(key)!).push(def);
    }
    return [...out];
  });

  let picked = $state<string | undefined>(undefined);
  // the list can lose what was picked under you — a delete, a rename, a sheet reloaded — so the fallback
  // is the first type rather than an empty pane
  const def = $derived(types.find((d) => defKey(d) === picked) ?? types[0]);
  const rows = $derived(def ? schemaOf(def) : []);
  const defaults = $derived(def ? defRows(def, "fields") : []);
  const materials = $derived(library.materials.map((m) => m.name));

  const save = (next: ObjectDef, what: string) => library.editTemplate(next, `${what} ${next.name}`);

  /** the half-extent of the box an entity is picked in, which is the only size a point can have */
  const half = (d: ObjectDef): number => (d.size ? d.size[3]! : 0.2);

  /** how many keys a type has: its `@entity` defaults, plus any `@fields` declaration that adds to them */
  const count = (d: ObjectDef): number =>
    new Set([...d.fields.map((f) => f.name), ...d.declared.map((f) => f.name)]).size;

  function choose(d: ObjectDef) {
    picked = defKey(d);
    setEntityDef(d);
    // arming a type and then having to remember to press `o` is one step too many — this browser is a way
    // of saying "place this", and saying it picks the tool that does
    tools.use("entity");
    session.set((e) => ({ ...e, note: `placing ${d.name} — click in a viewport` }));
  }

  // adding a type is saying "I want to place these", so it is armed the moment it exists
  const add = () => choose(library.addEntityType());

  function remove(d: ObjectDef) {
    deleteTemplate(d);
    if (picked === defKey(d)) picked = undefined;
  }

  const text = (e: Event): string => (e.target as HTMLInputElement).value.trim();

  /** `undefined` rather than `""`: a knob nobody filled in is one the declaration should not carry */
  const some = (raw: string): string | undefined => raw || undefined;

  const csv = (row: SchemaRow): string => (row.field?.options ?? []).join(", ");

  const numberOr = (raw: string): number | undefined => (raw.trim() === "" ? undefined : Number(raw));
</script>

<div class="wrap">
  <div class="list">
    {#each groups as [category, defs] (category)}
      <h4>{category}</h4>
      <ul>
        {#each defs as t (defKey(t))}
          <li>
            <!-- one outline for both jobs: the type being edited is the type the next click places -->
            <button class="pick" class:active={picked === defKey(t)} onclick={() => choose(t)}
              title={t.doc ?? "select this type to place it and edit it"}>
              <span class="dot" style:background={t.colour === undefined ? "var(--dim)" : `#${t.colour.toString(16).padStart(6, "0")}`}></span>
              <span class="name">{t.name}</span>
              {#if count(t)}<span class="fields">{count(t)}</span>{/if}
            </button>
            <button class="icon" use:tooltip={"delete this type and every entity placed from it"} onclick={() => remove(t)}>
              <IconTrash size={13} />
            </button>
          </li>
        {/each}
      </ul>
    {/each}
    <button class="add" onclick={add}><IconPlus size={13} /> add type</button>
    <p class="what">click a type, then click in a viewport to place one. use select (V) to move it.</p>
  </div>

  {#if def}
    {@const d = def}
    <div class="detail">
      <div class="row">
        <label>
          name
          <!-- the class every instance carries, so a rename here renames them too: see renameTemplate -->
          <input value={d.name} onchange={(e) => {
            renameTemplate(d, text(e));
            (e.target as HTMLInputElement).value = d.name;
          }} />
        </label>
        <label>
          category
          <input value={d.category ?? ""} placeholder="other"
            onchange={(e) => save({ ...d, category: some(text(e)) }, "categorise")} />
        </label>
        <label class="tight">
          colour
          <input type="color" value={`#${(d.colour ?? 0x66ccff).toString(16).padStart(6, "0")}`}
            oninput={(e) => save({ ...d, colour: Number.parseInt((e.target as HTMLInputElement).value.slice(1), 16) }, "colour")} />
        </label>
        <label class="tight">
          size
          <input type="number" min="0.05" step="0.05" value={half(d)} use:tooltip={"half-size in metres of the box you click to select it"}
            onchange={(e) => {
              const h = Math.max(0.01, Number((e.target as HTMLInputElement).value) || 0.2);
              save({ ...d, size: [-h, -h, -h, h, h, h] }, "size");
            }} />
        </label>
      </div>
      <div class="row">
        <label class="grow">
          doc
          <input value={d.doc ?? ""} placeholder="short description"
            onchange={(e) => save({ ...d, doc: some(text(e)) }, "document")} />
        </label>
      </div>

      <h4>fields</h4>
      <table>
        <thead><tr><th>name</th><th>type</th><th>choices / range</th><th></th></tr></thead>
        <tbody>
          {#each rows as row (row.name)}
            <tr>
              <td>
                <input value={row.name} onchange={(e) => save(renameSchemaField(d, row.name, text(e)), "rename in")} />
              </td>
              <td>
                <select value={row.type}
                  onchange={(e) => save(setSchemaType(d, row.name, (e.target as HTMLSelectElement).value as FieldType), "type in")}>
                  {#each FIELD_TYPES as t (t)}<option value={t}>{t}</option>{/each}
                </select>
                {#if !row.declared}
                  <span class="guess" use:tooltip={"guessed from the default value; pick a type to declare it"}>?</span>
                {/if}
              </td>
              <td>
                {#if row.type === "enum"}
                  <input value={csv(row)} placeholder="calm, angry"
                    onchange={(e) => save(setSchemaKnob(d, row.name, "options",
                      text(e) ? text(e).split(",").map((x) => x.trim()).filter(Boolean) : undefined), "choices in")} />
                {:else if row.type === "int" || row.type === "float"}
                  <span class="range">
                    <input type="number" placeholder="min" value={row.field?.min ?? ""}
                      onchange={(e) => save(setSchemaKnob(d, row.name, "min", numberOr(text(e))), "range in")} />
                    <input type="number" placeholder="max" value={row.field?.max ?? ""}
                      onchange={(e) => save(setSchemaKnob(d, row.name, "max", numberOr(text(e))), "range in")} />
                  </span>
                {:else}
                  <input value={row.field?.doc ?? ""} placeholder="doc"
                    onchange={(e) => save(setSchemaKnob(d, row.name, "doc", some(text(e))), "document")} />
                {/if}
              </td>
              <td>
                <button class="icon" use:tooltip={"delete this field"}
                  onclick={() => save(removeSchemaField(d, row.name), "drop a field from")}>
                  <IconTrash size={13} />
                </button>
              </td>
            </tr>
          {/each}
          {#if !rows.length}
            <tr><td colspan="4" class="none">no fields yet</td></tr>
          {/if}
        </tbody>
      </table>
      <button class="add" onclick={() => save(addSchemaField(d), "add a field to")}>
        <IconPlus size={13} /> add field
      </button>

      <h4>defaults</h4>
      <p class="what">values a new entity starts with, unless you change them</p>
      <PropertyGrid rows={defaults} ids={[]} {materials}
        set={(name, value) => save(setDefProp(d, "fields", name, value), "default in")}
        clear={(name) => save(clearDefProp(d, "fields", name), "unset in")}
        rename={(from, to) => save(renameSchemaField(d, from, to), "rename in")} />
    </div>
  {:else}
    <div class="detail empty">
      <p>no entity types yet.</p>
      <p class="what">a type is a <code>@template entity.name</code> in the sheet. add one and it is written on save.</p>
    </div>
  {/if}
</div>

<style>
  .wrap { display: grid; grid-template-columns: 170px 1fr; gap: 12px; min-height: 320px; }
  .list {
    padding: 0 10px 0 0; display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
    border-right: 1px solid var(--border); overflow: auto;
  }
  .list ul { list-style: none; margin: 0 0 4px; padding: 0; width: 100%; display: flex; flex-direction: column; gap: 2px; }
  .list li { display: flex; gap: 3px; }
  .fields { color: var(--muted); font-size: var(--ui-xs); }
  .pick {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; padding: 5px 7px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px;
    color: var(--text); font: inherit; text-align: left; cursor: pointer;
  }
  .pick:hover { background: var(--accent-dim); }
  .pick.active { outline: 1px solid var(--accent); border-color: var(--accent); }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .name { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .detail { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
  .detail.empty { color: var(--muted); }
  .row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
  label { display: flex; flex-direction: column; gap: 3px; flex: 1 1 120px; min-width: 0; font-size: var(--ui-xs); color: var(--muted); }
  label.tight { flex: 0 0 72px; }
  label.grow { flex: 1 1 100%; }
  input, select {
    width: 100%; box-sizing: border-box; padding: 4px 6px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); font: var(--mono);
  }
  input[type="color"] { padding: 1px; height: 24px; }
  h4 { margin: 4px 0 0; font-size: var(--ui-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font: var(--mono); }
  th { text-align: left; font-weight: 400; font-size: var(--ui-xs); color: var(--muted); padding: 0 4px 2px 0; }
  td { padding: 1px 4px 1px 0; vertical-align: middle; }
  td:last-child, th:last-child { width: 22px; padding-right: 0; }
  .range { display: flex; gap: 4px; }
  .guess { color: var(--dim); cursor: help; margin-left: 3px; }
  .none { color: var(--dim); padding: 4px 0; }
  .what { margin: 0; color: var(--muted); font-size: var(--ui-xs); }
  .add {
    display: inline-flex; align-items: center; gap: 5px; align-self: flex-start; padding: 4px 8px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px;
    color: var(--text); font: inherit; cursor: pointer;
  }
  .add:hover { background: var(--accent-dim); }
  .icon {
    display: inline-flex; align-items: center; justify-content: center; padding: 3px;
    background: transparent; border: 1px solid transparent; border-radius: 4px;
    color: var(--muted); cursor: pointer;
  }
  .icon:hover { color: var(--p9); background: var(--accent-dim); border-color: var(--border); }
  code { font: var(--mono); color: var(--dim); }
</style>
