<script lang="ts">
  /**
   * The material browser: every `--var` the project declares as a material, and the one place they are
   * written.
   *
   * A Quake editor browses a directory of textures; tscene has no directory, it has declarations, and a
   * declaration is better in the one way that matters — `--wall` is a whole material, colour and
   * roughness and maps together, so what a face names is the finished surface rather than one image out
   * of the five that make it.
   *
   * Clicking one does two things: it becomes the current material, so the next solid drawn is made of it,
   * and it is assigned to whatever is picked. Picked faces if there are any, and otherwise every face of
   * the picked solids — a designer who has selected a room's worth of walls and clicks `brick` has
   * already said what they mean, and making them press "select all faces" first would be making them say
   * it twice.
   *
   * Editing one writes the declaration back into the sheet on the next save; see `io/materials.ts`. Only
   * the fields shown here are ever rewritten, so a material with an `emissive` or a `side` nobody drew a
   * box for keeps them. What is *not* undoable is any of this: a declaration is not part of the map, and
   * ⌘Z belongs to the map. The exception is a rename, which has to go round every face that names the
   * old material, and that half is an edit like any other.
   */
  import IconPlus from "@tabler/icons-svelte/icons/plus";
  import IconPencil from "@tabler/icons-svelte/icons/pencil";
  import IconTrash from "@tabler/icons-svelte/icons/trash";
  import IconX from "@tabler/icons-svelte/icons/x";

  import { withFace } from "../brush/uv.ts";
  import { MAP_SLOTS, hasRelief, type MaterialDef } from "../doc/catalogue.ts";
  import { facesInScope, facesUsing } from "../doc/inspect.ts";
  import { isEmpty } from "../doc/selection.ts";
  import { cleanName } from "../io/materials.ts";
  import { library } from "../library.svelte.ts";
  import { withPatchMaterial } from "../patch/uv.ts";
  import { session } from "../session.svelte.ts";
  import { changeFaces } from "../tools/attributes.ts";

  /** the material node types the browser offers; anything else a sheet writes is kept as it is */
  const TYPES = ["meshStandardMaterial", "meshPhysicalMaterial", "meshBasicMaterial", "heightMaterial"];

  let filter = $state("");
  /** which material the form is open on, by the name its declaration has in the *sheet* */
  let editing = $state<string | null>(null);

  /**
   * The material the form is showing, read back out of the catalogue rather than kept beside it — a copy
   * would still be showing the old roughness one ⌘Z after the change, and be written back on the next
   * keystroke.
   */
  const def = $derived.by((): MaterialDef | null => {
    if (editing === null) return null;
    const draft = library.drafts.get(editing);
    if (draft !== undefined) return draft;
    return library.materials.find((m) => m.name === editing) ?? null;
  });

  const matches = $derived(
    library.materials.filter((m) => !filter || m.name.toLowerCase().includes(filter.toLowerCase())),
  );
  const current = $derived(session.editor.material);
  const scope = $derived(facesInScope(session.editor.world, session.editor.selection));
  const used = $derived(def ? facesUsing(session.editor.world, def.name).length : 0);

  const swatch = (v: number | undefined) =>
    v === undefined ? "var(--dim)" : `#${(v & 0xffffff).toString(16).padStart(6, "0")}`;

  function use(material: string) {
    const faces = scope;
    session.set((e) => ({ ...e, material }));
    if (!faces.length) {
      session.set((e) => ({ ...e, note: `${material} — the next solid drawn` }));
      return;
    }
    const onFace = (b: Parameters<typeof withFace>[0], i: number) => withFace(b, i, { material });
    const onPatch = (p: Parameters<typeof withPatchMaterial>[0]) => withPatchMaterial(p, material);
    session.run(
      "set material",
      (e) => ({ ...e, world: changeFaces(e.world, faces, onFace, onPatch) }),
      { repeatable: true, again: (e) => ({ ...e, world: changeFaces(e.world, e.selection.faces, onFace, onPatch) }) },
    );
    session.set((e) => ({ ...e, note: `${faces.length} × ${material}` }));
  }

  const edit = (m: MaterialDef) => (editing = library.keyFor(m.name));

  /** one field changed: the draft is what the declaration will be written as */
  function patch(change: Partial<MaterialDef>, what: string) {
    if (editing === null || !def) return;
    library.edit(editing, { ...def, ...change }, `set ${what}`);
  }

  /** a number box left empty means the declaration should not say it at all */
  const setNumber = (name: "roughness" | "metalness" | "depth", raw: string) =>
    patch({ [name]: raw.trim() === "" ? undefined : Number(raw) }, name);

  const setMap = (slot: (typeof MAP_SLOTS)[number], raw: string) => {
    const maps = { ...def!.maps };
    if (raw.trim()) maps[slot] = raw.trim();
    else delete maps[slot];
    patch({ maps }, slot);
  };

  /**
   * A rename, which is the one change here that reaches the map: every face that names the old material
   * has to name the new one, or the rename would be a delete with extra steps.
   */
  function rename(raw: string) {
    const name = cleanName(raw);
    const key = editing;
    const was = def?.name;
    if (key === null || !def || !name || !was || name === was) return;
    const renamed = { ...def, name };
    const faces = facesUsing(session.editor.world, was);
    const onFace = (b: Parameters<typeof withFace>[0], i: number) => withFace(b, i, { material: name });
    const onPatch = (p: Parameters<typeof withPatchMaterial>[0]) => withPatchMaterial(p, name);
    // the declaration and every face that names it, in one entry: see the note at the top
    session.run(`rename ${was}`, (e) => ({
      ...e,
      materials: new Map(e.materials).set(key, renamed),
      world: faces.length ? changeFaces(e.world, faces, onFace, onPatch) : e.world,
      material: e.material === was ? name : e.material,
    }));
  }

  function add() {
    filter = "";
    editing = library.add().name;
  }

  function remove(m: MaterialDef) {
    const orphans = facesUsing(session.editor.world, m.name).length;
    library.remove(
      library.keyFor(m.name),
      orphans ? `${m.name} deleted — ${orphans} surface(s) now name nothing` : `${m.name} deleted`,
    );
    editing = null;
  }
</script>

<div class="browser">
  <div class="top">
    <input class="filter" placeholder="filter materials…" bind:value={filter} />
    <button class="icon" title="new material" onclick={add}><IconPlus size={14} /></button>
  </div>
  <p class="scope">
    <!-- "surface" rather than "face", because a patch's one surface is in this count too -->
    {#if scope.length}{scope.length} surface{scope.length === 1 ? "" : "s"} will take it
    {:else if isEmpty(session.editor.selection)}nothing picked — a click just arms it
    {:else}the selection has no surfaces{/if}
  </p>
  <ul>
    {#each matches as m (m.name)}
      <li>
        <button class="row" class:on={current === m.name} onclick={() => use(m.name)} title={`${m.type}${m.file ? ` · ${m.file}` : ""}`}>
          <i class="chip" style:background={swatch(m.colour)}></i>
          <span class="name">{m.name}</span>
          <span class="type">{m.type.replace(/^mesh|Material$/g, "")}</span>
        </button>
        <button class="icon" title={`edit ${m.name}`} onclick={() => edit(m)}><IconPencil size={13} /></button>
      </li>
    {/each}
    {#if !matches.length}<li class="none">{library.materials.length ? "nothing matches" : "the sheet declares no materials"}</li>{/if}
  </ul>

  {#if def}
    <div class="form">
      <div class="head">
        <input class="name-box" value={def.name} onchange={(e) => rename(e.currentTarget.value)} />
        <button class="icon" title={`delete ${def.name}`} onclick={() => remove(def)}><IconTrash size={13} /></button>
        <button class="icon" title="close" onclick={() => (editing = null)}><IconX size={13} /></button>
      </div>
      <label>
        <span>type</span>
        <select value={def.type} onchange={(e) => patch({ type: e.currentTarget.value }, "type")}>
          {#each TYPES as t (t)}<option value={t}>{t}</option>{/each}
          {#if !TYPES.includes(def.type)}<option value={def.type}>{def.type}</option>{/if}
        </select>
      </label>
      <label>
        <span>colour</span>
        <input
          type="color"
          value={swatch(def.colour ?? 0xffffff)}
          onchange={(e) => patch({ colour: Number.parseInt(e.currentTarget.value.slice(1), 16) }, "colour")}
        />
        <button class="clear" title="no colour of its own" onclick={() => patch({ colour: undefined }, "colour")}>clear</button>
      </label>
      <label>
        <span>roughness</span>
        <input type="number" min="0" max="1" step="0.05" value={def.roughness ?? ""} onchange={(e) => setNumber("roughness", e.currentTarget.value)} />
      </label>
      <label>
        <span>metalness</span>
        <input type="number" min="0" max="1" step="0.05" value={def.metalness ?? ""} onchange={(e) => setNumber("metalness", e.currentTarget.value)} />
      </label>
      {#if hasRelief(def) || def.type === "heightMaterial"}
        <label>
          <span>relief</span>
          <input type="number" min="0" max="1" step="0.005" value={def.depth ?? ""} onchange={(e) => setNumber("depth", e.currentTarget.value)} />
          <span class="unit">m</span>
        </label>
      {/if}
      {#each MAP_SLOTS as slot (slot)}
        <label>
          <!-- "roughness map" rather than "roughness", which is the number two rows up -->
          <span>{slot === "map" ? "map" : slot.replace(/Map$/, " map")}</span>
          <input placeholder="./texture.png" value={def.maps[slot] ?? ""} onchange={(e) => setMap(slot, e.currentTarget.value)} />
        </label>
      {/each}
      <p class="foot">
        {used} surface{used === 1 ? "" : "s"} use it · written into {def.file ?? "the sheet"} on save
      </p>
    </div>
  {/if}
</div>

<style>
  .browser { display: flex; flex-direction: column; gap: 4px; min-height: 0; }
  .top { display: flex; gap: 4px; }
  .filter { flex: 1; min-width: 0; }
  .scope { margin: 0; color: var(--dim); font: var(--mono); }
  ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; max-height: 220px; }
  li { display: flex; align-items: center; gap: 2px; }
  .none { padding: 4px; color: var(--dim); font: var(--mono); }
  .row {
    display: flex; gap: 6px; align-items: center; flex: 1; min-width: 0; padding: 3px 5px; cursor: pointer;
    background: transparent; border: 1px solid transparent; border-radius: 5px;
    font: var(--mono); color: var(--text); text-align: left;
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .row:hover { background: color-mix(in srgb, var(--accent-dim) 55%, transparent); color: var(--p9); }
  .row.on { background: var(--accent-dim); border-color: var(--accent); color: var(--p9); }
  .chip { flex: none; width: 16px; height: 16px; border-radius: 4px; border: 1px solid #0006; }
  .name { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .type { flex: none; color: var(--dim); }
  .icon {
    flex: none; display: grid; place-items: center; width: 22px; height: 22px; padding: 0;
    background: transparent; border: 1px solid var(--border); border-radius: 5px;
    color: var(--dim); cursor: pointer;
  }
  .icon:hover { background: var(--accent-dim); color: var(--p9); }

  .form {
    display: flex; flex-direction: column; gap: 3px;
    padding: 5px; border: 1px solid var(--border); border-radius: 5px; background: var(--panel-2);
  }
  .head { display: flex; gap: 4px; }
  .name-box { flex: 1; min-width: 0; font: var(--mono); }
  .form label { display: flex; align-items: center; gap: 5px; font: var(--mono); color: var(--dim); }
  .form label > span:first-child { flex: none; width: 96px; white-space: nowrap; }
  .form label input:not([type="color"]), .form label select { flex: 1; min-width: 0; }
  .form input[type="color"] { flex: none; width: 42px; height: 20px; padding: 0; }
  .clear, .unit { flex: none; }
  .clear {
    padding: 1px 5px; background: transparent; border: 1px solid var(--border); border-radius: 4px;
    color: var(--dim); font: var(--mono); cursor: pointer;
  }
  .clear:hover { color: var(--p9); }
  .foot { margin: 2px 0 0; color: var(--dim); font: var(--mono); }
</style>
