<script lang="ts">
  /**
   * The file menu, and the name of the thing being edited.
   *
   * A menu rather than a row of buttons because there are six of these and only two get pressed often; the
   * two that do have keys, and the header has a level to draw. The name sits outside the menu, though, with
   * the dirty marker on it — "is my work saved" is a question a designer asks by glancing, not by opening
   * something.
   *
   * `open` and `save as` put up a browser dialogue, which is only allowed to happen inside a real click.
   * That is why these are buttons calling the store directly rather than actions routed through a command
   * table: a gesture that has been through a queue is no longer a gesture the browser trusts.
   *
   * The keys beside the labels are read out of the keymap rather than typed in here, so that a rebound ⌘S
   * is rebound in the menu too — a menu that says one key while another one works is worse than a menu with
   * no keys in it at all.
   */
  import IconChevronDown from "@tabler/icons-svelte/icons/chevron-down";
  import IconFolder from "@tabler/icons-svelte/icons/folder";
  import { bakery } from "../bake/bake.svelte.ts";
  import { tooltip } from "../ui/tooltip.ts";
  import { keys } from "../keys/keys.svelte.ts";
  import { printChord } from "../keys/keymap.ts";
  import { project } from "./project.svelte.ts";

  let open = $state(false);
  let root = $state<HTMLElement>();

  /** the menu closes on the way to doing the thing, so a dialogue never opens behind it */
  function run(what: () => unknown) {
    open = false;
    what();
  }

  const said = (command: string): string => {
    const chord = keys.chordsFor(command)[0];
    return chord ? printChord(chord) : "";
  };

  const items = $derived([
    { label: "new", key: said("file.new"), run: () => project.newMap() },
    { label: "open…", key: said("file.open"), run: () => void project.open() },
    { label: "open folder…", key: "", run: () => void project.openFolder() },
    { label: "save", key: said("file.save"), run: () => void project.save() },
    { label: "save as…", key: said("file.saveAs"), run: () => void project.saveAs() },
    { label: "revert", key: said("file.revert"), run: () => project.revert(), off: !project.dirty },
    // a rule above these two, because everything above writes the map and everything below copies it
    { label: "export .obj", key: "", run: () => project.exportObj(), rule: true },
    { label: "export .glb", key: "", run: () => project.exportGlb() },
    // below its own rule: baking neither writes the map nor copies it out — it makes something new beside
    // it. The item opens the panel rather than starting a bake, which is what an item with no dialogue
    // behind it would be doing to a machine for the next four minutes
    { label: "bake lightmaps…", key: said("window.bake"), run: () => (bakery.open = true), rule: true },
  ]);
</script>

<!-- a press anywhere else closes the menu. Asked as "is it inside" rather than answered by stopping the
     event on the way up, so that the toggle stays a toggle and nothing else in the header has its press
     swallowed by a menu that happens to be open -->
<svelte:window
  onpointerdown={(e) => {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }}
/>

<span class="file" bind:this={root}>
  <button class="btn wide menu" class:on={open} use:tooltip={"file"} onclick={() => (open = !open)}>
    <IconFolder size={15} />
    <IconChevronDown size={12} />
  </button>
  <span class="name" use:tooltip={project.files.join(" · ")}>
    {project.name}{#if project.dirty}<b class="dot">•</b>{/if}
  </span>

  {#if open}
    <ul>
      {#each items as item (item.label)}
        <li class:rule={item.rule}>
          <button disabled={item.off} onclick={() => run(item.run)}>
            <span>{item.label}</span><span class="key">{item.key}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</span>

<style>
  /* the square is the tool bar's; the menu that hangs off it is this component's */
  .file { position: relative; display: flex; gap: 7px; align-items: center; }
  .menu { padding: 0 5px !important; gap: 3px !important; }
  .name {
    max-width: 150px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    color: var(--p9); font-weight: 600;
  }
  .dot { color: var(--warn); font-weight: 700; }
  ul {
    position: absolute; top: 32px; left: 0; z-index: 20; min-width: 180px;
    list-style: none; margin: 0; padding: 4px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.5);
  }
  li.rule { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--border); }
  li button {
    display: flex; gap: 16px; width: 100%; padding: 4px 8px; cursor: pointer;
    background: transparent; border: 0; border-radius: 5px;
    font: var(--ui); color: var(--text); text-align: left;
    transition: background-color 110ms ease, color 110ms ease;
  }
  li button span:last-child { margin-left: auto; color: var(--dim); font: var(--mono); }
  li button:hover:not(:disabled) { background: var(--p4); color: var(--p9); }
  li button:disabled { color: var(--dim); cursor: default; }
</style>
