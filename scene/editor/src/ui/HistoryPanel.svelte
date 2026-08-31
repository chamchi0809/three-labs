<script lang="ts">
  /**
   * The undo stack, written down.
   *
   * The stack is already there — every command is named for it — so showing it costs nothing and answers
   * the question a designer actually has, which is not "can I undo" but "how far back is the thing I want".
   * Clicking a row walks there: undo down to it, redo up to it. Nothing else; a history that lets you delete
   * an entry out of the middle is a history that no longer describes the document.
   */
  import IconArrowBackUp from "@tabler/icons-svelte/icons/arrow-back-up";
  import IconArrowForwardUp from "@tabler/icons-svelte/icons/arrow-forward-up";

  import { session } from "../session.svelte.ts";
  import Panel from "./Panel.svelte";
  import { tooltip } from "./tooltip.ts";

  /** past oldest-first, then the redoable ones — `future` is a stack, so its newest end is its last */
  const rows = $derived([
    ...session.history.past.map((entry, i) => ({ name: entry.name, at: i + 1, done: true })),
    ...[...session.history.future].reverse().map((entry, i) => ({
      name: entry.name,
      at: session.history.past.length + i + 1,
      done: false,
    })),
  ]);
  const here = $derived(session.history.past.length);

  /** `at` is how many commands should have been applied; the difference is how many steps to take */
  function goto(at: number) {
    for (let i = here; i > at; i--) session.undo();
    for (let i = here; i < at; i++) session.redo();
  }
</script>

<Panel title="history">
  {#snippet actions()}
    <button class="ico" disabled={!session.canUndo} use:tooltip={session.undoName ? `undo ${session.undoName}` : "undo"}
      onclick={() => session.undo()}><IconArrowBackUp size={13} /></button>
    <button class="ico" disabled={!session.canRedo} use:tooltip={session.redoName ? `redo ${session.redoName}` : "redo"}
      onclick={() => session.redo()}><IconArrowForwardUp size={13} /></button>
  {/snippet}

  <ol>
    <li class="step" class:on={here === 0}>
      <button onclick={() => goto(0)}><span class="dot"></span>opened</button>
    </li>
    {#each rows as row (row.at)}
      <li class="step" class:on={row.at === here} class:undone={!row.done}>
        <button onclick={() => goto(row.at)}><span class="dot"></span>{row.name}</button>
      </li>
    {/each}
  </ol>
</Panel>

<style>
  ol { list-style: none; margin: 0; padding: 0; }
  .step button {
    display: flex; align-items: center; gap: 6px;
    width: 100%; padding: 2px 4px;
    background: transparent; border: 0; border-radius: 4px;
    color: var(--text); font: var(--mono); text-align: left; cursor: pointer;
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    transition: background-color 120ms ease, color 120ms ease;
  }
  .step button:hover { background: color-mix(in srgb, var(--accent-dim) 55%, transparent); color: var(--p9); }
  .step.on button { background: var(--accent-dim); color: var(--p9); }
  .step.undone button { color: var(--dim); }
  .dot {
    flex: none; width: 5px; height: 5px; border-radius: 50%;
    background: var(--p5);
  }
  .step.on .dot { background: var(--accent); }
  .step.undone .dot { background: transparent; box-shadow: inset 0 0 0 1px var(--p5); }

  .ico {
    display: grid; place-items: center;
    width: 19px; height: 19px; padding: 0;
    background: transparent; border: 0; border-radius: 4px;
    color: var(--muted); cursor: pointer;
  }
  .ico:hover:not(:disabled) { background: var(--p4); color: var(--p9); }
  .ico:disabled { opacity: 0.35; cursor: default; }
</style>
