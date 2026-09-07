<script lang="ts">
  // The shell. M7 fills the centre with the pane layout; M10 hangs the inspectors off the right edge;
  // M11 gives the structure commands their keys.
  //
  // The frame is pixi-vania's: a tool bar across the top, a column of titled panels down each side, the
  // work in the middle. The left column is the level's own filing — layers, tags, what has been done to it
  // — and the right is whatever is picked. Both are things a designer reads *while* working, which is
  // exactly the argument for a column rather than a tab in a panel that is also showing something else.
  import { onMount } from "svelte";
  import Views from "./viewport/Views.svelte";
  import Hierarchy from "./inspect/Hierarchy.svelte";
  import Inspector from "./inspect/Inspector.svelte";
  import TemplatesPanel from "./inspect/TemplatesPanel.svelte";
  import Notices from "./io/Notices.svelte";
  import Console from "./ui/Console.svelte";
  import HistoryPanel from "./ui/HistoryPanel.svelte";
  import Toolbar from "./ui/Toolbar.svelte";
  import { host } from "./host.svelte.ts";
  import { log } from "./ui/log.svelte.ts";
  import { project } from "./io/project.svelte.ts";
  import { runCommand } from "./keys/commands.ts";
  import { isViewCommand, printChord } from "./keys/keymap.ts";
  import { keys } from "./keys/keys.svelte.ts";
  import { formatSize } from "./grid/snap.ts";
  import { session } from "./session.svelte.ts";
  import { tools } from "./tools/tools.svelte.ts";

  const exponent = $derived(session.editor.world.broom.grid);
  const selected = $derived(session.editor.selection.nodes.length);
  const faces = $derived(session.editor.selection.faces.length);
  const note = $derived(session.editor.note ?? tools.current.hint);

  let rootEl = $state<HTMLDivElement>();

  // the hint reads the keymap rather than repeating it, so a rebound key is not a lie along the bottom of
  // the window. `grid` is the pair, since one half of it on its own says nothing
  const SHOWN: [string, string][] = [
    ["file.save", "save"], ["structure.group", "group"], ["edit.duplicate", "duplicate"],
    ["structure.hide", "hide"], ["view.maximise", "maximise"], ["view.frame", "frame"],
  ];
  const said = (id: string): string | undefined => {
    const chord = keys.chordsFor(id)[0];
    return chord && printChord(chord);
  };
  const hint = $derived(
    [
      ...SHOWN.map(([id, word]) => { const key = said(id); return key && `${key} ${word}`; }),
      said("grid.finer") && said("grid.coarser") && `${said("grid.finer")} / ${said("grid.coarser")} grid`,
      "wasd / qe fly",
    ].filter(Boolean).join(" · "),
  );

  // the demo map is the document until something is opened; taking it as the baseline is what keeps the
  // first autosave from being a copy of a map the designer did not write. The log starts catching first,
  // so that anything the boot itself complains about is in it.
  onMount(() => {
    log.watch();
    project.boot();
    // a page that mounted the editor at a sheet of its own: fetched here rather than in `mountEditor`,
    // because the log has to be catching before anything the open complains about is said
    if (host.path) void project.fetchProject(host.path);
  });

  /**
   * A tab with unsaved work asks before it closes.
   *
   * The browser will not show a message of ours and will not fire this at all without a real interaction
   * first, so this is a best effort next to the autosave rather than instead of it.
   */
  function onBeforeUnload(event: BeforeUnloadEvent) {
    if (!project.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  }

  /**
   * The document half of the keymap.
   *
   * Bound on window rather than on the viewport so a file or structure command still works while the focus
   * sits in a panel: grouping is a thing done to the map, not to a pane. Everything about *where* a view is
   * looking stays in `Views.svelte`, which is the only thing that knows how big a pane is — it reads
   * `defaultPrevented` to see whether this handler has already answered the press.
   *
   * What each key means is the keymap's to say, not this function's; all it does is refuse the half that
   * belongs to the viewport and hand the rest over.
   */
  function onKeydown(event: KeyboardEvent) {
    // the game has the keyboard: ⌘S while playing is the player's browser, not the designer's editor
    if (host.paused) return;
    const command = keys.commandFor(event);
    if (!command || isViewCommand(command)) return;
    if (!runCommand(command)) return;
    event.preventDefault();
  }

  /** a field being typed into is committed by clicking anywhere else, rather than only by tab or enter */
  function isTyping(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return !!el && !!el.closest('input, textarea, select, [contenteditable="true"]');
  }

  function commitFocusedEditor(e: PointerEvent) {
    const active = document.activeElement;
    const target = e.target;
    if (!(active instanceof HTMLElement) || !(target instanceof Node)) return;
    if (!rootEl?.contains(active) || active.contains(target) || !isTyping(active)) return;
    active.blur();
  }

  onMount(() => {
    const root = rootEl;
    root?.addEventListener("pointerdown", commitFocusedEditor, { capture: true });
    return () => root?.removeEventListener("pointerdown", commitFocusedEditor, { capture: true });
  });
</script>

<svelte:window onkeydown={onKeydown} onbeforeunload={onBeforeUnload} />

<div class="shell" bind:this={rootEl}>
  <Toolbar />

  <div class="notices"><Notices /></div>

  <aside class="left">
    <Hierarchy />
    <TemplatesPanel />
    <HistoryPanel />
  </aside>

  <main class="center"><Views /></main>

  <aside class="right"><Inspector /></aside>

  <Console />

  <footer>
    <span>grid <b>{formatSize(2 ** exponent)}</b></span>
    <!-- the separator is an expression because the space in front of it is at the edge of a block, and
         that is exactly the whitespace the compiler is entitled to drop -->
    <span>selected <b>{selected}</b>{#if faces}{" · "}faces <b>{faces}</b>{/if}</span>
    <span class="note">{note}</span>
    <span class="hint">{hint}</span>
  </footer>
</div>

<style>
  /* the notices row is a wrapper rather than the component itself, so that two notices are still one row.
     The drawer's row is `auto`, so it is nothing at all when it is closed and exactly its own height when
     it is open — the panes give up the space rather than the window growing a scrollbar */
  .shell {
    display: grid;
    grid-template-columns: 248px 1fr 320px;
    grid-template-rows: auto auto 1fr auto auto;
    height: 100%;
    width: 100%;
    overflow: hidden;
    container-type: inline-size;
    background: var(--bg);
    color: var(--p9);
    font: var(--ui);
  }
  .shell :global(*) {
    box-sizing: border-box;
  }
  .notices { grid-column: 1 / -1; min-height: 0; }
  .left, .right {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    background: var(--panel);
  }
  /* the column scrolls, the panels in it keep their height: the tree, the templates and the history are
     three lists and a short window should push the third below the fold rather than slice each */
  .left { grid-column: 1; grid-row: 3; overflow-y: auto; border-right: 1px solid var(--border); }
  .center { grid-column: 2; grid-row: 3; position: relative; min-width: 0; min-height: 0; }
  .right { grid-column: 3; grid-row: 3; border-left: 1px solid var(--border); }

  footer {
    grid-column: 1 / -1;
    display: flex; gap: 12px; align-items: center;
    padding: 6px 10px;
    background: var(--panel-2); border-top: 1px solid var(--border);
    color: var(--muted);
  }
  .hint { margin-left: auto; color: var(--dim); }
  .note {
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    color: var(--text);
  }
  footer b { color: var(--p9); font-weight: 600; }

  /* ---- Tooltips -------------------------------------------------------
     Bubbles are rendered into document.body, outside the shell, so they cannot inherit its CSS vars —
     keep these colours literal. */
  :global(.sv-tooltip) {
    position: fixed;
    z-index: 10001;
    box-sizing: border-box;
    pointer-events: none;
    max-width: 260px;
    padding: 4px 8px;
    border-radius: 5px;
    background: #0d0b18;
    color: #cdd4a5;
    border: 1px solid #3b405e;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    font: var(--ui);
    white-space: normal;
    overflow-wrap: anywhere;
    animation: sv-tooltip-in 90ms ease-out;
  }
  @keyframes sv-tooltip-in {
    from { opacity: 0; transform: translateY(-2px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* ---- Form controls -------------------------------------------------
     Native select/range/checkbox are replaced with themed ones. Base rules are wrapped in :where() so they
     carry zero specificity and a component's own sizing still wins. Lifted from pixi-vania's shell, which
     is the point: one editor's controls, not two sets that nearly match. */

  /* Focus is drawn *inside* the control — an outer ring hung off an already bordered field reads as tacked
     on. Fields recolour their own border instead; borderless things get an inset outline. */
  .shell :global(button:focus-visible),
  .shell :global([tabindex]:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .shell :global(input:focus-visible),
  .shell :global(textarea:focus-visible),
  .shell :global(select:focus-visible) {
    outline: none;
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .shell :global(input[type="checkbox"]:focus-visible) {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .shell :global(input[type="range"]:focus-visible) {
    outline: none;
    box-shadow: none;
  }
  .shell :global(input[type="range"]:focus-visible::-webkit-slider-thumb) {
    background: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 40%, transparent);
  }

  /* text fields ------------------------------------------------------- */
  .shell :global(:where(input:not([type="checkbox"]):not([type="range"]):not([type="color"]), textarea)) {
    box-sizing: border-box;
    min-width: 0;
    padding: 3px 6px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--p9);
    font: inherit;
  }
  .shell :global(input::placeholder) { color: var(--dim); }
  .shell :global(:where(input, textarea, select)) {
    transition:
      border-color 130ms ease,
      background-color 130ms ease,
      box-shadow 130ms ease;
  }
  .shell :global(:where(input[type="color"])) {
    padding: 1px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 5px;
  }

  /* select ------------------------------------------------------------ */
  .shell :global(:where(select)) {
    appearance: none;
    box-sizing: border-box;
    padding: 3px 22px 3px 7px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background-color: var(--bg);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23af7e7f' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 6px center;
    color: var(--p9);
    font: inherit;
    cursor: pointer;
  }
  .shell :global(:where(select):hover:not(:disabled)) { border-color: var(--p5); }
  .shell :global(:where(select):disabled) { opacity: 0.5; cursor: default; }

  @supports (appearance: base-select) {
    .shell :global(select) {
      appearance: base-select;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding-right: 6px;
      background-image: none;
    }
    .shell :global(select::picker-icon) {
      color: var(--muted);
      margin-inline-start: auto;
      transition: rotate 170ms cubic-bezier(0.2, 0.9, 0.3, 1), color 130ms ease;
    }
    .shell :global(select:open::picker-icon) { rotate: 180deg; color: var(--accent); }
    .shell :global(select::picker(select)) {
      appearance: base-select;
      min-width: anchor-size(width);
      margin-block-start: 4px;
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel-2);
      box-shadow: 0 12px 32px rgb(0 0 0 / 0.5);
      opacity: 0;
      translate: 0 -6px;
      transition:
        opacity 140ms ease,
        translate 140ms cubic-bezier(0.2, 0.9, 0.3, 1),
        overlay 140ms allow-discrete,
        display 140ms allow-discrete;
    }
    .shell :global(select:open::picker(select)) { opacity: 1; translate: 0 0; }
    @starting-style {
      .shell :global(select:open::picker(select)) { opacity: 0; translate: 0 -6px; }
    }
    .shell :global(select option) {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      border-radius: 5px;
      background: transparent;
      color: var(--p9);
      cursor: pointer;
      transition: background-color 110ms ease, color 110ms ease;
    }
    .shell :global(select option:hover), .shell :global(select option:focus) { background: var(--p4); }
    .shell :global(select option:checked) { color: var(--accent); }
    .shell :global(select option::checkmark) {
      order: 1;
      margin-inline-start: auto;
      color: var(--accent);
    }
  }

  /* range -------------------------------------------------------------- */
  .shell :global(:where(input[type="range"])) {
    appearance: none;
    width: 100%;
    height: 16px;
    background: transparent;
    cursor: pointer;
    --range-track: var(--p4);
    --range-fill: var(--accent);
  }
  .shell :global(input[type="range"]:disabled) { opacity: 0.45; cursor: default; }
  .shell :global(input[type="range"]::-webkit-slider-runnable-track) {
    height: 4px;
    border-radius: 999px;
    background: var(--range-track);
  }
  .shell :global(input[type="range"]::-webkit-slider-thumb) {
    appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4px;
    border-radius: 50%;
    background: var(--p9);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.5);
    transition: background-color 130ms ease, scale 130ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  .shell :global(input[type="range"]:hover:not(:disabled)::-webkit-slider-thumb) {
    background: var(--accent);
    scale: 1.18;
  }
  .shell :global(input[type="range"]:active:not(:disabled)::-webkit-slider-thumb) { scale: 0.94; }
  .shell :global(input[type="range"]::-moz-range-track) {
    height: 4px;
    border-radius: 999px;
    background: var(--range-track);
  }
  .shell :global(input[type="range"]::-moz-range-progress) {
    height: 4px;
    border-radius: 999px;
    background: var(--range-fill);
  }
  .shell :global(input[type="range"]::-moz-range-thumb) {
    width: 12px;
    height: 12px;
    border: none;
    border-radius: 50%;
    background: var(--p9);
  }

  /* checkbox ----------------------------------------------------------- */
  .shell :global(:where(input[type="checkbox"])) {
    appearance: none;
    display: inline-grid;
    place-content: center;
    flex: none;
    width: 15px;
    height: 15px;
    margin: 0;
    border: 1px solid var(--p5);
    border-radius: 4px;
    background: var(--bg);
    cursor: pointer;
    transition: background-color 130ms ease, border-color 130ms ease;
  }
  .shell :global(input[type="checkbox"]::before) {
    content: "";
    width: 9px;
    height: 9px;
    background: var(--p0);
    clip-path: polygon(14% 44%, 0 65%, 42% 100%, 100% 20%, 82% 6%, 38% 68%);
    scale: 0;
    transition: scale 150ms cubic-bezier(0.2, 0.9, 0.4, 1.4);
  }
  .shell :global(input[type="checkbox"]:hover:not(:checked):not(:disabled)) { border-color: var(--accent); }
  .shell :global(input[type="checkbox"]:checked) { background: var(--accent); border-color: var(--accent); }
  .shell :global(input[type="checkbox"]:checked::before) { scale: 1; }
  .shell :global(input[type="checkbox"]:indeterminate) { background: var(--accent-dim); border-color: var(--accent); }
  .shell :global(input[type="checkbox"]:disabled) { opacity: 0.45; cursor: default; }

  @media (prefers-reduced-motion: reduce) {
    .shell :global(*),
    .shell :global(*::before),
    .shell :global(*::after) {
      transition-duration: 1ms !important;
      animation-duration: 1ms !important;
    }
  }

  /* A narrow window gives the side columns up before it gives up the viewport: the panes are the work and
     the panels are about the work. */
  @container (max-width: 1180px) {
    .shell { grid-template-columns: 224px 1fr; }
    .left { grid-row: 3; }
    .center { grid-column: 2; grid-row: 3; }
    .right {
      grid-column: 1 / -1;
      grid-row: 4;
      border-left: 0;
      border-top: 1px solid var(--border);
      max-height: 34vh;
    }
    .shell { grid-template-rows: auto auto 1fr auto auto auto; }
  }
</style>
