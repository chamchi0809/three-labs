<script lang="ts">
  /**
   * The hierarchy: the level's own tree, and the one place its shape can be changed by hand.
   *
   * Every row is draggable and every row is a target, because a scene graph is the thing a designer
   * reorganises — a lamp goes *under* the lift so it rides with it, and a stack of props goes in a group
   * so it can be hidden in one click. The drop is drawn before it happens: a line between two rows, at the
   * depth it will land, for a reorder, and a ring round the row for "inside this one". The line glides
   * between targets rather than jumping, which is the difference between reading a drag and guessing at it.
   *
   * The list is flat — see doc/tree.ts. Rows are a fixed height, so the row under the pointer is a
   * division rather than a walk over the DOM, and the drop's arithmetic is the one part of this that has a
   * check behind it.
   */
  import IconBulb from "@tabler/icons-svelte/icons/bulb";
  import IconChevronDown from "@tabler/icons-svelte/icons/chevron-down";
  import IconChevronRight from "@tabler/icons-svelte/icons/chevron-right";
  import IconCube from "@tabler/icons-svelte/icons/cube";
  import IconDatabase from "@tabler/icons-svelte/icons/database";
  import IconEye from "@tabler/icons-svelte/icons/eye";
  import IconEyeOff from "@tabler/icons-svelte/icons/eye-off";
  import IconFold from "@tabler/icons-svelte/icons/fold";
  import IconFolder from "@tabler/icons-svelte/icons/folder";
  import IconLock from "@tabler/icons-svelte/icons/lock";
  import IconLockOpen from "@tabler/icons-svelte/icons/lock-open";
  import IconShape from "@tabler/icons-svelte/icons/shape";
  import IconVectorBezier from "@tabler/icons-svelte/icons/vector-bezier";
  import type { Icon } from "@tabler/icons-svelte";

  import {
    hideNode, lockNode, pickNodes, renameTo, reparent, setId, showEverything, unlockEverything,
  } from "../actions.ts";
  import { ENTITY_NODE } from "../doc/catalogue.ts";
  import { nodeById, nodeTypeName, type Node, type NodeId } from "../doc/document.ts";
  import { dropAt, dropOn, rowsOf, type Drop, type TreeRow } from "../doc/tree.ts";
  import { session } from "../session.svelte.ts";
  import Panel from "../ui/Panel.svelte";
  import { tooltip } from "../ui/tooltip.ts";

  /** one row's height, in CSS pixels — the `.row` rule and the drag's arithmetic read the same number */
  const ROW = 22;
  /** how far a pointer travels before a click becomes a drag */
  const SLOP = 4;

  let collapsed = $state(new Set<NodeId>());
  let renaming = $state<NodeId | undefined>(undefined);
  let anchor = $state(0);
  let box = $state<HTMLDivElement>();
  let strip = $state<HTMLDivElement>();

  const world = $derived(session.editor.world);
  const rows = $derived(rowsOf(world, collapsed));
  const picked = $derived(new Set(session.editor.selection.nodes));

  // ---------------------------------------------------------------- what a row says it is

  const ICONS: Record<string, Icon> = {
    layer: IconFolder, group: IconFolder, brush: IconCube, patch: IconVectorBezier,
  };
  const iconOf = (node: Node): Icon => {
    if (node.kind === "object") {
      if (node.type === ENTITY_NODE) return IconDatabase;
      return node.type.toLowerCase().includes("light") ? IconBulb : IconShape;
    }
    return ICONS[node.kind] ?? IconShape;
  };

  const named = (node: Node): boolean => node.kind === "group" || node.kind === "layer";
  const labelOf = (node: Node): string =>
    named(node) ? (node as { name: string }).name : node.sheetId ? `#${node.sheetId}` : nodeTypeName(node);
  /** what a row is, when its name does not already say — a `#lamp` is still worth knowing is a light */
  const kindOf = (node: Node): string =>
    named(node) ? "" : [node.sheetId ? nodeTypeName(node) : "", ...node.classes.map((c) => `.${c}`)].join("");

  // ---------------------------------------------------------------- picking

  function clicked(row: TreeRow, i: number, e: PointerEvent): void {
    const id = row.node.id;
    if (e.metaKey || e.ctrlKey) return void (pickNodes([id], "toggle"), (anchor = i));
    if (e.shiftKey) {
      const [from, to] = anchor <= i ? [anchor, i] : [i, anchor];
      return pickNodes(rows.slice(from, to + 1).map((r) => r.node.id), "replace");
    }
    anchor = i;
    // an already-picked row is left alone until the pointer goes up, so a drag can carry the whole
    // selection rather than collapsing it to whatever was grabbed
    if (!picked.has(id)) pickNodes([id], "replace");
  }

  const toggle = (id: NodeId): void => {
    collapsed = new Set(collapsed).has(id)
      ? new Set([...collapsed].filter((x) => x !== id))
      : new Set([...collapsed, id]);
  };
  const expand = (id: NodeId): void => {
    if (collapsed.has(id)) collapsed = new Set([...collapsed].filter((x) => x !== id));
  };
  const foldAll = (): void => {
    const shut = rows.filter((r) => r.kids).map((r) => r.node.id);
    collapsed = collapsed.size ? new Set() : new Set(shut);
  };

  // ---------------------------------------------------------------- dragging

  type Drag = { ids: NodeId[]; from: { x: number; y: number }; at: { x: number; y: number }; live: boolean };
  let drag = $state<Drag | undefined>(undefined);
  let drop = $state<Drop | undefined>(undefined);
  /** the rows the last drop moved, briefly, so the eye can find where they went */
  let landed = $state(new Set<NodeId>());

  let edge = 0;
  let scrolling = 0;

  /** the drop a pointer at this y means, worked out from the row height rather than from the DOM */
  function aim(clientY: number): void {
    if (!strip || !drag) return;
    // measured against the rows themselves rather than the box: their own top has the scroll in it already
    const y = clientY - strip.getBoundingClientRect().top;
    const span = rows.length * ROW;
    const at = Math.min(Math.max(y, 0), span - 1);
    drop = dropOn(world, rows, Math.floor(at / ROW), (at % ROW) / ROW, drag.ids);
  }

  function autoscroll(clientY: number): void {
    if (!box) return;
    const rect = box.getBoundingClientRect();
    edge = clientY < rect.top + 22 ? -1 : clientY > rect.bottom - 22 ? 1 : 0;
    if (edge && !scrolling) scrolling = requestAnimationFrame(roll);
  }

  function roll(): void {
    scrolling = 0;
    if (!edge || !box || !drag) return;
    box.scrollTop += edge * 9;
    aim(drag.at.y);
    scrolling = requestAnimationFrame(roll);
  }

  function down(e: PointerEvent, row: TreeRow, i: number): void {
    if (e.button !== 0 || renaming) return;
    clicked(row, i, e);
    const ids = picked.has(row.node.id) ? [...picked] : [row.node.id];
    drag = { ids, from: { x: e.clientX, y: e.clientY }, at: { x: e.clientX, y: e.clientY }, live: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function moved(e: PointerEvent): void {
    if (!drag) return;
    drag.at = { x: e.clientX, y: e.clientY };
    if (!drag.live) {
      if (Math.hypot(e.clientX - drag.from.x, e.clientY - drag.from.y) < SLOP) return;
      drag.live = true;
    }
    aim(e.clientY);
    autoscroll(e.clientY);
  }

  function up(e: PointerEvent, row: TreeRow): void {
    const held = drag;
    stop();
    if (!held) return;
    if (!held.live) {
      // a plain click on a row that was already picked, which is how a selection is narrowed to one
      if (!e.metaKey && !e.ctrlKey && !e.shiftKey && picked.size > 1) pickNodes([row.node.id], "replace");
      return;
    }
    if (!drop) return void (drop = undefined);
    reparent(held.ids, drop.parent, dropAt(world, drop.parent, held.ids, drop.index));
    expand(drop.parent);
    flash(held.ids);
    drop = undefined;
  }

  function stop(): void {
    drag = undefined;
    edge = 0;
    if (scrolling) cancelAnimationFrame(scrolling);
    scrolling = 0;
  }

  function flash(ids: NodeId[]): void {
    landed = new Set(ids);
    setTimeout(() => (landed = new Set()), 450);
  }

  // ---------------------------------------------------------------- renaming

  /** F2 everywhere, and enter as well, because a Mac keyboard's F2 is two keys */
  function onkeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && drag) return void (stop(), (drop = undefined));
    if (e.key !== "F2" && e.key !== "Enter") return;
    const one = session.editor.selection.nodes;
    if (one.length !== 1) return;
    e.preventDefault();
    renaming = one[0];
  }

  function rename(node: Node, to: string): void {
    renaming = undefined;
    const name = to.trim();
    if (!name || name === labelOf(node)) return;
    if (named(node)) return renameTo(node.id, name);
    setId(node.id, name.replace(/^#/, ""));
  }

  const grab = (el: HTMLInputElement): void => {
    el.focus();
    el.select();
  };

  const chipSays = (ids: NodeId[]): string => {
    if (ids.length !== 1) return `${ids.length} nodes`;
    const node = nodeById(world, ids[0]!);
    return node ? labelOf(node) : "";
  };

  const lineTop = $derived.by(() => {
    if (!drop || drop.where === "inside") return 0;
    const i = rows.findIndex((r) => r.node.id === drop!.row);
    return (i + (drop.where === "after" ? 1 : 0)) * ROW;
  });
</script>

<Panel title="hierarchy" grow>
  {#snippet actions()}
    <button class="ico" use:tooltip={"collapse or expand everything"} onclick={foldAll}><IconFold size={13} /></button>
    <button class="ico" use:tooltip={"show everything"} onclick={showEverything}><IconEye size={13} /></button>
    <button class="ico" use:tooltip={"unlock everything"} onclick={unlockEverything}><IconLockOpen size={13} /></button>
  {/snippet}

  <!-- the list takes the keys: F2 and delete are about what is picked *here*, so they are only live while
       the panel has the focus, and cannot fire while a pane is being flown -->
  <div
    class="tree"
    class:dragging={drag?.live}
    bind:this={box}
    tabindex="-1"
    role="tree"
    {onkeydown}
  >
    <div class="rows" bind:this={strip} style:height={`${rows.length * ROW}px`}>
      {#each rows as row, i (row.node.id)}
        {@const node = row.node}
        {@const Glyph = iconOf(node)}
        <div
          class="row"
          class:on={picked.has(node.id)}
          class:into={drop?.where === "inside" && drop.row === node.id}
          class:away={drag?.live && drag.ids.includes(node.id)}
          class:landed={landed.has(node.id)}
          class:dim={row.hidden || row.byParent.hidden}
          role="treeitem"
          aria-selected={picked.has(node.id)}
          aria-expanded={row.kids ? row.open : undefined}
          tabindex="-1"
          style:padding-left={`${4 + row.depth * 12}px`}
          onpointerdown={(e) => down(e, row, i)}
          onpointermove={moved}
          onpointerup={(e) => up(e, row)}
          onpointercancel={stop}
          ondblclick={() => (renaming = node.id)}
        >
          {#if row.kids}
            <button class="twist" onpointerdown={(e) => e.stopPropagation()} onclick={() => toggle(node.id)}>
              {#if row.open}<IconChevronDown size={12} />{:else}<IconChevronRight size={12} />{/if}
            </button>
          {:else}
            <span class="twist"></span>
          {/if}

          <Glyph size={13} class="glyph" />

          {#if renaming === node.id}
            <input
              class="rename"
              value={labelOf(node)}
              use:grab
              onpointerdown={(e) => e.stopPropagation()}
              onblur={(e) => rename(node, (e.target as HTMLInputElement).value)}
              onkeydown={(e) => {
                // a key pressed in the box belongs to the box: the enter that finishes a rename would
                // otherwise reach the panel below and open a new one, and ⌫ would delete the selection
                e.stopPropagation();
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                // escape unmounts the box, which fires blur, which would commit: put the label back
                // first so that the commit renames it to what it is already called
                if (e.key === "Escape") {
                  (e.target as HTMLInputElement).value = labelOf(node);
                  renaming = undefined;
                }
              }}
            />
          {:else}
            <span class="name">{labelOf(node)}</span>
            <span class="kind">{kindOf(node)}</span>
          {/if}

          <button
            class="ico"
            class:off={!row.hidden && !row.byParent.hidden}
            use:tooltip={row.byParent.hidden ? "hidden by a parent" : row.hidden ? "hidden" : "visible"}
            onpointerdown={(e) => e.stopPropagation()}
            onclick={() => hideNode(node.id)}
          >
            {#if row.hidden || row.byParent.hidden}<IconEyeOff size={13} />{:else}<IconEye size={13} />{/if}
          </button>
          <button
            class="ico"
            class:off={!row.locked && !row.byParent.locked}
            use:tooltip={row.byParent.locked ? "locked by a parent" : row.locked ? "locked" : "unlocked"}
            onpointerdown={(e) => e.stopPropagation()}
            onclick={() => lockNode(node.id)}
          >
            {#if row.locked || row.byParent.locked}<IconLock size={13} />{:else}<IconLockOpen size={13} />{/if}
          </button>
        </div>
      {/each}

      {#if drop && drop.where !== "inside"}
        <div class="line" style:top={`${lineTop}px`} style:left={`${6 + drop.depth * 12}px`}></div>
      {/if}
    </div>

    {#if !rows.length}<p class="none">nothing in the level yet</p>{/if}
  </div>

  {#if drag?.live}
    <!-- what is in hand, under the cursor: a count rather than a list, because eight rows following a
         pointer is a curtain over the thing being aimed at -->
    <div class="chip" style:transform={`translate3d(${drag.at.x + 12}px, ${drag.at.y + 10}px, 0)`}>
      {chipSays(drag.ids)}
      {#if drop}<i>{drop.where === "inside" ? "inside" : drop.where}</i>{:else}<i class="no">no</i>{/if}
    </div>
  {/if}
</Panel>

<style>
  /* the list is the scroller, not the column: a drag that runs off the bottom has something to scroll, and
     the templates and history panels stay reachable under a level with two hundred things in it */
  .tree { position: relative; max-height: 55vh; overflow-y: auto; outline: none; }
  .tree.dragging { cursor: grabbing; }
  .rows { position: relative; }
  .row {
    position: relative;
    display: flex; gap: 3px; align-items: center;
    height: 22px; padding-right: 2px;
    border-radius: 4px;
    font: var(--mono); color: var(--text);
    user-select: none; touch-action: none;
    transition: background-color 110ms ease, opacity 110ms ease, box-shadow 130ms ease;
  }
  .row:hover { background: color-mix(in srgb, var(--accent-dim) 55%, transparent); }
  .row.on { background: var(--accent-dim); color: var(--p9); }
  .row.dim .name, .row.dim :global(.glyph) { opacity: 0.45; }
  /* what is in hand is left in place, faded: a list that closed the gap under the pointer would make the
     line the drag is aiming at move as well */
  .row.away { opacity: 0.4; }
  .row.into { box-shadow: inset 0 0 0 1px var(--accent); background: var(--accent-dim); }
  .row.landed { animation: landed 450ms ease-out; }
  @keyframes landed {
    from { background: var(--accent); }
    to { background: transparent; }
  }
  .name { flex: none; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 60%; }
  .kind { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--dim); }
  .rename { flex: 1; min-width: 0; height: 18px; }
  .twist {
    flex: none; display: grid; place-items: center;
    width: 14px; height: 18px; padding: 0;
    background: transparent; border: 0; color: var(--muted); cursor: pointer;
  }
  .twist:hover { color: var(--p9); }
  .row :global(.glyph) { flex: none; color: var(--muted); }
  .row.on :global(.glyph) { color: var(--accent); }
  .ico {
    flex: none; display: grid; place-items: center;
    width: 18px; height: 18px; padding: 0;
    background: transparent; border: 0; border-radius: 4px;
    color: var(--muted); cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
  }
  .ico:hover { background: var(--p4); color: var(--p9); }
  .ico.off { opacity: 0; }
  .row:hover .ico.off, .row.on .ico.off { opacity: 0.5; }

  /* the promise the drop makes: where the line is, is where the nodes go */
  .line {
    position: absolute; right: 4px; height: 2px;
    background: var(--accent); border-radius: 2px;
    box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 70%, transparent);
    pointer-events: none;
    transition: top 90ms cubic-bezier(0.2, 0.9, 0.3, 1), left 90ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  .line::before {
    content: ""; position: absolute; left: -4px; top: -3px;
    width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
  }

  .chip {
    position: fixed; left: 0; top: 0; z-index: 20;
    display: flex; gap: 6px; align-items: center;
    padding: 3px 8px;
    background: var(--panel-2); border: 1px solid var(--accent); border-radius: 5px;
    box-shadow: 0 8px 20px rgb(0 0 0 / 0.45);
    font: var(--mono); color: var(--p9);
    pointer-events: none;
  }
  .chip i { font-style: normal; color: var(--accent); }
  .chip i.no { color: var(--dim); }

  .none { margin: 4px; color: var(--dim); font: var(--mono); }
</style>
