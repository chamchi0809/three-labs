<script lang="ts">
  /**
   * The bar across the top: what you are editing, what you are editing it *with*, and what it costs to
   * look away from it.
   *
   * Laid out the way pixi-vania's is — a brand, then groups of square icon buttons separated by nothing but
   * their own spacing, then a spacer, then the things that are about the file rather than the level. Icons
   * rather than words for the tools because there are fifteen of them and a row of fifteen words is a menu;
   * the word is still there, in the tooltip, along with the key.
   *
   * Nothing here decides anything. Every button is the same call the keymap makes, so a tool picked with
   * the mouse and one picked with a letter go through the same door.
   */
  import IconArrowBackUp from "@tabler/icons-svelte/icons/arrow-back-up";
  import IconArrowForwardUp from "@tabler/icons-svelte/icons/arrow-forward-up";
  import IconBulb from "@tabler/icons-svelte/icons/bulb";
  import IconCube from "@tabler/icons-svelte/icons/cube";
  import IconCubePlus from "@tabler/icons-svelte/icons/cube-plus";
  import IconDeviceFloppy from "@tabler/icons-svelte/icons/device-floppy";
  import IconItalic from "@tabler/icons-svelte/icons/italic";
  import IconLayoutColumns from "@tabler/icons-svelte/icons/layout-columns";
  import IconLayoutGrid from "@tabler/icons-svelte/icons/layout-grid";
  import IconLayoutRows from "@tabler/icons-svelte/icons/layout-rows";
  import IconLine from "@tabler/icons-svelte/icons/line";
  import IconArrowsMove from "@tabler/icons-svelte/icons/arrows-move";
  import IconPoint from "@tabler/icons-svelte/icons/point";
  import IconPointer from "@tabler/icons-svelte/icons/pointer";
  import IconPolygon from "@tabler/icons-svelte/icons/polygon";
  import IconResize from "@tabler/icons-svelte/icons/resize";
  import IconRotate from "@tabler/icons-svelte/icons/rotate";
  import IconRoute from "@tabler/icons-svelte/icons/route";
  import IconSlice from "@tabler/icons-svelte/icons/slice";
  import IconSparkles from "@tabler/icons-svelte/icons/sparkles";
  import IconSquare from "@tabler/icons-svelte/icons/square";
  import IconStackPush from "@tabler/icons-svelte/icons/stack-push";
  import IconTerminal2 from "@tabler/icons-svelte/icons/terminal-2";
  import IconTexture from "@tabler/icons-svelte/icons/texture";
  import IconVectorBezier from "@tabler/icons-svelte/icons/vector-bezier";
  import type { Icon } from "@tabler/icons-svelte";

  import Bake from "../bake/Bake.svelte";
  import Files from "../io/Files.svelte";
  import Keymap from "../keys/Keymap.svelte";
  import Prefs from "./Prefs.svelte";
  import ToolOptions from "./ToolOptions.svelte";
  import { keys } from "../keys/keys.svelte.ts";
  import { printChord } from "../keys/keymap.ts";
  import { look } from "../render/look.svelte.ts";
  import { project } from "../io/project.svelte.ts";
  import { session } from "../session.svelte.ts";
  import { tools } from "../tools/tools.svelte.ts";
  import { LAYOUTS, type LayoutKind } from "../viewport/layout.ts";
  import { panes } from "../viewport/views.svelte.ts";
  import type { ToolId } from "../tools/tool.ts";
  import { drawer } from "./drawer.svelte.ts";
  import { log } from "./log.svelte.ts";
  import { tooltip } from "./tooltip.ts";

  /** the picture each tool gets, by id; a tool with no entry falls back to its own initial */
  const TOOL_ICONS: Partial<Record<ToolId, Icon>> = {
    select: IconPointer,
    move: IconArrowsMove,
    rotate: IconRotate,
    scale: IconResize,
    shear: IconItalic,
    shape: IconCubePlus,
    patch: IconVectorBezier,
    entity: IconBulb,
    extrude: IconStackPush,
    sweep: IconRoute,
    clip: IconSlice,
    vertex: IconPoint,
    edge: IconLine,
    face: IconPolygon,
    attributes: IconTexture,
  };

  const LAYOUT_ICONS: Record<LayoutKind, Icon> = {
    one: IconSquare,
    two: IconLayoutColumns,
    three: IconLayoutRows,
    four: IconLayoutGrid,
  };

  const said = (id: string): string => {
    const chord = keys.chordsFor(id)[0];
    return chord ? printChord(chord) : "";
  };

  const withKey = (label: string, id: string): string => {
    const key = said(id);
    return key ? `${label} · ${key}` : label;
  };

  const saveLabel = $derived(project.dirty ? "save" : "saved");
</script>

<div class="bar">
  <header class="toolbar">
    <span class="brand">three-broom</span>

    <Files />

    <span class="group tools">
      {#each tools.all as tool (tool.id)}
        {@const Icon = TOOL_ICONS[tool.id]}
        <button
          class="tool"
          class:on={tools.current.id === tool.id}
          use:tooltip={`${tool.title} (${tool.key.toUpperCase()})`}
          onclick={() => tools.use(tool.id)}
        >
          {#if Icon}<Icon size={16} />{:else}{tool.title.slice(0, 1)}{/if}
        </button>
      {/each}
    </span>

    <span class="group">
      <button
        class="btn"
        disabled={!session.canUndo}
        use:tooltip={withKey(session.undoName ? `undo ${session.undoName}` : "undo", "edit.undo")}
        onclick={() => session.undo()}
      >
        <IconArrowBackUp size={16} />
      </button>
      <button
        class="btn"
        disabled={!session.canRedo}
        use:tooltip={withKey(session.redoName ? `redo ${session.redoName}` : "redo", "edit.redo")}
        onclick={() => session.redo()}
      >
        <IconArrowForwardUp size={16} />
      </button>
    </span>

    <!-- two states, not a slider: "classic" is what a level is built in and "modern" is what it will look
         like, and anything in between is a third thing a designer has to think about for no gain -->
    <span class="group looks">
      <button
        class="btn"
        class:on={!look.pbr}
        use:tooltip={"classic — flat shading, one material, one draw call: the shape of the level"}
        onclick={() => (look.current = "classic")}
      >
        <IconCube size={16} />
      </button>
      <button
        class="btn"
        class:on={look.pbr}
        use:tooltip={"modern — the sheet's own materials and the map's own lights: what a player will see"}
        onclick={() => (look.current = "pbr")}
      >
        <IconSparkles size={16} />
      </button>
    </span>

    <span class="group layouts">
      {#each LAYOUTS as kind, i (kind)}
        {@const Icon = LAYOUT_ICONS[kind]}
        <button
          class="btn"
          class:on={panes.layout === kind && !panes.maximised}
          use:tooltip={`${kind} pane · ⌘${i + 1}`}
          onclick={() => panes.setLayout(kind)}
        >
          <Icon size={16} />
        </button>
      {/each}
    </span>

    <span class="group">
      <Bake />
      <Keymap />
      <Prefs />
      <!-- the mark is what makes a console worth having a button for: something was said while you were
           looking somewhere else, and its colour is how bad it was -->
      <button
        class="btn console"
        class:on={drawer.open}
        class:warn={log.pending === "warn"}
        class:bad={log.pending === "bad"}
        use:tooltip={withKey("console", "window.log")}
        onclick={() => drawer.toggle("log")}
      >
        <IconTerminal2 size={16} />
        {#if log.unread}<i>{log.unread > 99 ? "99+" : log.unread}</i>{/if}
      </button>
    </span>

    <span class="spacer"></span>

    <button
      class="save"
      class:dirty={project.dirty}
      use:tooltip={withKey("save", "file.save")}
      onclick={() => void project.save()}
    >
      <IconDeviceFloppy size={14} />
      {saveLabel}
    </button>
  </header>

  <!-- the live tool's own settings, under the row that picked it -->
  <ToolOptions />
</div>

<style>
  /* one grid child for both rows, so the options row can come and go with the tool without the shell's
     rows having to be renumbered around it */
  .bar {
    grid-column: 1 / -1;
    min-width: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: var(--panel-2);
    border-bottom: 1px solid var(--border);
    user-select: none;
    overflow-x: auto;
    overflow-y: hidden;
    font: var(--ui);
    color: var(--text);
  }
  .brand {
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--accent);
    padding-right: 6px;
    white-space: nowrap;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 3px;
  }
  .tools {
    gap: 2px;
  }
  /* every square button in the bar, including the openers the file, bake, keys and prefs components
     draw for themselves — one rule rather than five copies that fall out of step */
  .toolbar :global(.tool),
  .toolbar :global(.btn) {
    flex: none;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    padding: 0;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text);
    font: inherit;
    cursor: pointer;
    transition:
      background-color 130ms ease,
      border-color 130ms ease,
      color 130ms ease;
  }
  .toolbar :global(.tool:hover:not(:disabled)),
  .toolbar :global(.btn:hover:not(:disabled)) {
    background: var(--accent-dim);
    color: var(--p9);
  }
  .toolbar :global(.tool.on),
  .toolbar :global(.btn.on) {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--p0);
  }
  .toolbar :global(.btn:disabled) {
    opacity: 0.35;
    cursor: default;
  }
  /* a button that has a word in it as well as a picture */
  .toolbar :global(.btn.wide) {
    width: auto;
    padding: 0 9px;
    font-size: 11px;
    font-weight: 600;
    gap: 5px;
    grid-auto-flow: column;
  }

  .console {
    position: relative;
  }
  .console i {
    position: absolute;
    right: -3px;
    top: -4px;
    min-width: 13px;
    padding: 0 2px;
    border-radius: 7px;
    background: var(--p5);
    color: var(--p9);
    font: 9px/13px ui-sans-serif, system-ui, sans-serif;
    font-style: normal;
    text-align: center;
  }
  .console.warn i {
    background: var(--warn);
    color: var(--p0);
  }
  .console.bad i {
    background: var(--bad);
    color: var(--p0);
  }

  .spacer {
    flex: 1;
  }

  .save {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    padding: 6px 12px;
    background: var(--accent-dim);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .save.dirty {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--p0);
  }
</style>
