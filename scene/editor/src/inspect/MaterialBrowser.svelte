<script lang="ts">
  /**
   * The material browser: every `--var` the project declares as a material.
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
   */
  import { withFace } from "../brush/uv.ts";
  import { facesInScope } from "../doc/inspect.ts";
  import { isEmpty } from "../doc/selection.ts";
  import { library } from "../library.svelte.ts";
  import { withPatchMaterial } from "../patch/uv.ts";
  import { session } from "../session.svelte.ts";
  import { changeFaces } from "../tools/attributes.ts";

  let filter = $state("");

  const matches = $derived(
    library.materials.filter((m) => !filter || m.name.toLowerCase().includes(filter.toLowerCase())),
  );
  const current = $derived(session.editor.material);
  const scope = $derived(facesInScope(session.editor.world, session.editor.selection));

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
</script>

<div class="browser">
  <input class="filter" placeholder="filter materials…" bind:value={filter} />
  <p class="scope">
    <!-- "surface" rather than "face", because a patch's one surface is in this count too -->
    {#if scope.length}{scope.length} surface{scope.length === 1 ? "" : "s"} will take it
    {:else if isEmpty(session.editor.selection)}nothing picked — a click just arms it
    {:else}the selection has no surfaces{/if}
  </p>
  <ul>
    {#each matches as m (m.name)}
      <li>
        <button class:on={current === m.name} onclick={() => use(m.name)} title={`${m.type}${m.file ? ` · ${m.file}` : ""}`}>
          <i class="chip" style:background={swatch(m.colour)}></i>
          <span class="name">{m.name}</span>
          <span class="type">{m.type.replace(/^mesh|Material$/g, "")}</span>
        </button>
      </li>
    {/each}
    {#if !matches.length}<li class="none">{library.materials.length ? "nothing matches" : "the sheet declares no materials"}</li>{/if}
  </ul>
</div>

<style>
  .browser { display: flex; flex-direction: column; gap: 4px; min-height: 0; }
  .filter { width: 100%; }
  .scope { margin: 0; color: var(--dim); font: var(--mono); }
  ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; max-height: 220px; }
  li { display: block; }
  .none { padding: 4px; color: var(--dim); font: var(--mono); }
  button {
    display: flex; gap: 6px; align-items: center; width: 100%; padding: 3px 5px; cursor: pointer;
    background: transparent; border: 1px solid transparent; border-radius: 5px;
    font: var(--mono); color: var(--text); text-align: left;
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  button:hover { background: color-mix(in srgb, var(--accent-dim) 55%, transparent); color: var(--p9); }
  button.on { background: var(--accent-dim); border-color: var(--accent); color: var(--p9); }
  .chip { flex: none; width: 16px; height: 16px; border-radius: 4px; border: 1px solid #0006; }
  .name { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .type { flex: none; color: var(--dim); }
</style>
