<script lang="ts">
  /**
   * The panel along the bottom: what the editor has said, and what it is costing.
   *
   * **The readings are polled, not watched.** `perf` writes plain numbers sixty times a second and this
   * asks for them four times a second. Reading them reactively instead would push a DOM update per frame
   * through Svelte, and a profiler whose display is a measurable share of the frame it is displaying is a
   * profiler that lies — every number in it would be a number about itself.
   *
   * **The log scrolls to the end only when it was already at the end.** Somebody reading back through what
   * happened before a crash should not be yanked to the bottom by the next line that arrives.
   */
  import { onMount } from "svelte";
  import { session } from "../session.svelte.ts";
  import { childrenOf, type Node } from "../doc/document.ts";
  import { spansOf, subdivisionsFor } from "../patch/patch.ts";
  import { perf, SPANS, type Reading } from "../viewport/perf.ts";
  import { drawer, TABS } from "./drawer.svelte.ts";
  import { log } from "./log.svelte.ts";

  let reading = $state<Reading>(perf.read());
  let body = $state<HTMLElement>();
  let stuck = true;

  const lines = $derived(log.lines);

  /** four times a second: fast enough to watch a drag get heavier, slow enough to be readable */
  onMount(() => {
    const timer = setInterval(() => {
      if (drawer.open && drawer.tab === "performance") reading = perf.read();
    }, 250);
    return () => clearInterval(timer);
  });

  // a new line scrolls into view, unless the reader has scrolled away from the end to look at an old one
  $effect(() => {
    void lines.length;
    if (!body || drawer.tab !== "log") return;
    if (stuck) queueMicrotask(() => body && (body.scrollTop = body.scrollHeight));
  });

  function onScroll() {
    if (!body) return;
    stuck = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  }

  /**
   * What is in the map, counted on demand.
   *
   * Derived rather than kept, so the walk happens when the tab is open and never otherwise. A count that
   * updated itself would be a walk of the whole document on every drag frame, which is exactly the kind of
   * cost this panel exists to find.
   */
  const tally = $derived.by(() => {
    if (!drawer.open || drawer.tab !== "performance") return undefined;
    let brushes = 0;
    let faces = 0;
    let patches = 0;
    let triangles = 0;
    let objects = 0;
    let groups = 0;
    const visit = (node: Node): void => {
      if (node.kind === "brush") {
        brushes++;
        faces += node.brush.faces.length;
      } else if (node.kind === "patch") {
        // counted in triangles as well as in patches, because that is the number this panel is for: a
        // dome is one node and one surface however finely it is tessellated, and the tessellation is
        // what a frame costs
        patches++;
        const spans = spansOf(node.patch.grid);
        const n = subdivisionsFor(node.patch);
        triangles += spans.across * n * spans.down * n * 2;
      } else if (node.kind === "object") objects++;
      else if (node.kind === "group") groups++;
      for (const kid of childrenOf(node)) visit(kid);
    };
    for (const layer of session.editor.world.layers) visit(layer);
    return { brushes, faces, patches, triangles, objects, groups };
  });

  const ms = (n: number): string => (n >= 10 ? n.toFixed(0) : n.toFixed(1));
  const big = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  const clock = (at: number): string => new Date(at).toTimeString().slice(0, 8);

  /** the frame budget as a bar: sixteen milliseconds is the whole of it at sixty frames a second */
  const share = (n: number): number => Math.min(100, (n / 16.7) * 100);

  function drag(event: PointerEvent) {
    const from = event.clientY;
    const was = drawer.height;
    const move = (e: PointerEvent) => (drawer.height = was + (from - e.clientY));
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    event.preventDefault();
  }
</script>

{#if drawer.open}
  <section class="drawer" style="height: {drawer.height}px">
    <!-- a grab bar rather than a resize handle in a corner: the drawer only has one dimension to change -->
    <div
      class="grab"
      role="separator"
      aria-label="resize the panel"
      onpointerdown={drag}
    ></div>

    <header>
      {#each TABS as tab (tab)}
        <button class:on={drawer.tab === tab} onclick={() => drawer.show(tab)}>{tab}</button>
      {/each}
      <span class="gap"></span>
      {#if drawer.tab === "log"}
        <button class="plain" onclick={() => log.clear()} disabled={!lines.length}>clear</button>
      {:else}
        <span class="dim">{reading.frames} frames</span>
      {/if}
      <button class="plain" title="close" onclick={() => drawer.close()}>×</button>
    </header>

    {#if drawer.tab === "log"}
      <div class="body log" bind:this={body} onscroll={onScroll}>
        {#if !lines.length}
          <p class="empty">nothing said yet</p>
        {:else}
          {#each lines as line, i (i)}
            <p class={line.level}>
              <span class="at">{clock(line.at)}</span>
              <span class="text">{line.text}</span>
              {#if line.count > 1}<span class="count">×{line.count}</span>{/if}
            </p>
          {/each}
        {/if}
      </div>
    {:else}
      <div class="body perf">
        <div class="big">
          <b>{reading.fps.toFixed(0)}</b><span>fps</span>
          <b>{ms(reading.ms)}</b><span>ms</span>
          <b class:bad={reading.worst > 33}>{ms(reading.worst)}</b><span>ms worst</span>
        </div>

        <div class="spans">
          {#each SPANS as span (span)}
            <div class="span">
              <span class="name">{span}</span>
              <span class="bar"><i style="width: {share(reading.spans[span])}%"></i></span>
              <span class="num">{ms(reading.spans[span])} ms</span>
            </div>
          {/each}
        </div>

        <div class="counts">
          <span>draw calls <b>{big(reading.counts.drawCalls)}</b></span>
          <span>triangles <b>{big(reading.counts.triangles)}</b></span>
          <span>geometries <b>{big(reading.counts.geometries)}</b></span>
          <span>textures <b>{big(reading.counts.textures)}</b></span>
          {#if tally}
            <span>solids <b>{big(tally.brushes)}</b></span>
            <span>faces <b>{big(tally.faces)}</b></span>
            {#if tally.patches}
              <span>patches <b>{big(tally.patches)}</b></span>
              <span title="what the patches tessellate to at their current detail">
                patch tris <b>{big(tally.triangles)}</b>
              </span>
            {/if}
            <span>objects <b>{big(tally.objects)}</b></span>
            <span>groups <b>{big(tally.groups)}</b></span>
          {/if}
        </div>
      </div>
    {/if}
  </section>
{/if}

<style>
  .drawer {
    grid-column: 1 / -1;
    position: relative; display: grid; grid-template-rows: auto auto 1fr; min-height: 0;
    background: var(--panel); border-top: 1px solid var(--border);
    font: var(--mono); color: var(--text);
  }
  .grab { height: 4px; cursor: ns-resize; background: transparent; }
  .grab:hover { background: var(--accent); }
  header {
    display: flex; gap: 4px; align-items: center; padding: 4px 8px;
    background: var(--panel-2); border-bottom: 1px solid var(--border);
  }
  .gap { flex: 1; }
  .dim { color: var(--dim); }
  header button {
    height: 20px; padding: 0 9px; cursor: pointer;
    background: var(--panel); border: 1px solid var(--border); border-radius: 5px;
    font: var(--mono); color: var(--muted);
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  header button:hover:not(:disabled) { background: var(--accent-dim); color: var(--p9); }
  header button.on { background: var(--accent); border-color: var(--accent); color: var(--p0); }
  header button.plain { background: transparent; border-color: transparent; }
  header button.plain:hover:not(:disabled) { background: var(--p4); }
  header button:disabled { color: var(--dim); cursor: default; opacity: 0.6; }

  .body { overflow: auto; min-height: 0; padding: 6px 8px 8px; }
  .empty { margin: 6px 0; color: var(--dim); }

  .log p { display: flex; gap: 8px; margin: 0; padding: 1px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .log .at { flex: none; color: var(--dim); font-variant-numeric: tabular-nums; }
  .log .text { flex: 1; min-width: 0; }
  .log .count { flex: none; color: var(--dim); }
  .log .warn .text { color: var(--warn); }
  .log .bad .text { color: var(--bad); }

  .perf { display: flex; flex-direction: column; gap: 10px; }
  .big { display: flex; gap: 6px; align-items: baseline; }
  .big b { font-size: 18px; font-weight: 600; color: var(--p9); font-variant-numeric: tabular-nums; }
  .big b.bad { color: var(--warn); }
  .big span { margin-right: 10px; color: var(--muted); }

  .spans { display: flex; flex-direction: column; gap: 3px; max-width: 460px; }
  .span { display: grid; grid-template-columns: 60px 1fr 64px; gap: 8px; align-items: center; }
  .span .name { color: var(--muted); }
  .span .num { color: var(--text); text-align: right; font-variant-numeric: tabular-nums; }
  .bar { height: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); }

  .counts { display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--muted); }
  .counts b { color: var(--p9); font-weight: 600; font-variant-numeric: tabular-nums; }
</style>
