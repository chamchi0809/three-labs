<script lang="ts">
  /**
   * Tags: the level read by kind rather than by place.
   *
   * There is no tag file. A tag is a class the project already declares — a `@template` for the things
   * that are torches, a `--var` for the faces that are water — so the list here is the project's own
   * vocabulary rather than a second one kept in step by hand.
   *
   * Each row does the three things a designer wants from a kind of thing: select all of them, show only
   * them, or put the tag on what is selected. Filtering *is* isolating, deliberately — one answer to "is
   * this showing", which the viewport, the picker and the undo stack all read.
   */
  import { hideTag, isolateTag, selectTag, toggleTag } from "../actions.ts";
  import { key, tagCounts, tagsOf, tagsOfSelection, type Tag } from "../doc/tags.ts";
  import { library } from "../library.svelte.ts";
  import { session } from "../session.svelte.ts";

  const tags = $derived(tagsOf(library.catalogue));
  const counts = $derived(tagCounts(session.editor.world, tags));
  const on = $derived(tagsOfSelection(session.editor.world, session.editor.selection, tags));

  const state = (tag: Tag) =>
    on.all.some((t) => key(t) === key(tag)) ? "all" : on.some.some((t) => key(t) === key(tag)) ? "some" : "none";
</script>

{#if tags.length}
  <ul>
    {#each tags as tag (key(tag))}
      <li>
        <span class="swatch" style:background={tag.colour === undefined ? "transparent" : `#${tag.colour.toString(16).padStart(6, "0")}`}></span>
        <button class="name" title="select every {tag.name}" onclick={() => selectTag(tag)}>{tag.name}</button>
        <span class="on">{tag.on === "face" ? "face" : "node"}</span>
        <span class="count">{counts.get(key(tag)) ?? 0}</span>
        <button title="show only these" onclick={() => isolateTag(tag)}>only</button>
        <button title="hide these" onclick={() => hideTag(tag)}>hide</button>
        {#if tag.on === "node"}
          <button class:mark={state(tag) !== "none"} title="tag the selection"
            onclick={() => toggleTag(tag)}>{state(tag) === "all" ? "✓" : state(tag) === "some" ? "–" : "+"}</button>
        {/if}
      </li>
    {/each}
  </ul>
{:else}
  <p class="none">the project declares nothing to tag by</p>
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
    flex: 1; min-width: 0; overflow: hidden; text-align: left; white-space: nowrap; text-overflow: ellipsis;
    background: transparent; border: 0; padding: 1px 2px; color: var(--p9); cursor: pointer;
  }
  .name:hover { color: var(--accent); }
  .on { color: var(--dim); }
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
