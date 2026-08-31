<script lang="ts">
  /**
   * Templates: the level read by kind rather than by place.
   *
   * There is no list to configure. A kind is a `@template` the project already declares, so this is the
   * project's own vocabulary rather than a second one kept in step by hand.
   *
   * Each row does the three things a designer wants from a kind of thing: select all of them, show only
   * them, or put the class on what is selected. Filtering *is* isolating, deliberately — one answer to "is
   * this showing", which the viewport, the picker and the undo stack all read.
   */
  import { renameTemplate, selectTemplate, toggleTemplate } from "../actions.ts";
  import { ANY_NODE } from "../doc/catalogue.ts";
  import {
    key, templateCounts, templatesOf, templatesOfSelection, type Template,
  } from "../doc/templates.ts";
  import { library } from "../library.svelte.ts";
  import { session } from "../session.svelte.ts";
  import RenameBox from "../ui/RenameBox.svelte";

  const templates = $derived(templatesOf(library.catalogue));
  const counts = $derived(templateCounts(session.editor.world, templates));
  const on = $derived(templatesOfSelection(session.editor.world, session.editor.selection, templates));

  // double-click a name to rename the kind, the way double-clicking one in the hierarchy renames a node.
  // The `@template` and the class on every instance move together — see `renameTemplate` in actions.ts
  let renaming = $state<string | undefined>(undefined);
  const defOf = (t: Template) => library.objects.find((d) => d.name === t.name && d.node === t.node);

  function rename(t: Template, to: string): void {
    renaming = undefined;
    const def = defOf(t);
    if (def) renameTemplate(def, to);
  }

  const mark = (t: Template) =>
    on.all.some((x) => key(x) === key(t)) ? "all" : on.some.some((x) => key(x) === key(t)) ? "some" : "none";
</script>

{#if templates.length}
  <ul>
    {#each templates as t (key(t))}
      <li>
        <span class="swatch" style:background={t.colour === undefined ? "transparent" : `#${t.colour.toString(16).padStart(6, "0")}`}></span>
        {#if renaming === key(t)}
          <RenameBox value={t.name} done={(to) => rename(t, to)} cancel={() => (renaming = undefined)} />
        {:else}
          <button class="name" title="select every {t.name} — double-click to rename the kind"
            onclick={() => selectTemplate(t)} ondblclick={() => (renaming = key(t))}>{t.name}</button>
        {/if}
        <!-- the node type an instance is written as; a template of no type says nothing, because it fits any -->
        <span class="on">{t.node && t.node !== ANY_NODE ? t.node : ""}</span>
        <span class="count">{counts.get(key(t)) ?? 0}</span>
        <button class:mark={mark(t) !== "none"} title="put this template on the selection"
          onclick={() => toggleTemplate(t)}>{mark(t) === "all" ? "\u2713" : mark(t) === "some" ? "\u2013" : "+"}</button>
      </li>
    {/each}
  </ul>
{:else}
  <p class="none">the project declares no @template</p>
{/if}

<style>
  ul { list-style: none; margin: 0; padding: 0; }
  li {
    display: flex; gap: 4px; align-items: center;
    padding: 1px 3px; border-radius: 4px; font: var(--mono);
  }
  li:hover { background: color-mix(in srgb, var(--accent-dim) 55%, transparent); }
  .swatch { flex: none; width: 7px; height: 7px; border: 1px solid var(--border); border-radius: 2px; }
  .name {
    flex: 1 1 auto; min-width: 0; overflow: hidden; text-align: left; white-space: nowrap; text-overflow: ellipsis;
    background: transparent; border: 0; padding: 1px 2px; color: var(--p9); cursor: pointer;
  }
  .name:hover { color: var(--accent); }
  /* the type is the first thing to give way when the column is narrow: the name is what is being read */
  .on {
    flex: 0 99 auto; min-width: 0; color: var(--dim);
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  }
  .count { width: 20px; color: var(--dim); text-align: right; font-variant-numeric: tabular-nums; }
  li button:not(.name) {
    flex: none; padding: 0 5px; cursor: pointer;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px;
    font: var(--mono); color: var(--muted);
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  li button:not(.name):hover { background: var(--accent-dim); border-color: var(--p5); color: var(--p9); }
  .mark { color: var(--p0) !important; background: var(--accent) !important; border-color: var(--accent) !important; }
  .none { margin: 4px 0; color: var(--dim); font: var(--mono); }
</style>
