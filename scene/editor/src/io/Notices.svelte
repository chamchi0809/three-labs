<script lang="ts">
  /**
   * The three things the file layer has to say, in the one place a designer will see them.
   *
   * A recovery offer, whatever the last save could not express, and whatever the last open could not
   * understand. None of these is an error dialogue: a dialogue stops the work to report something the
   * designer usually cannot act on right now, and this is a strip they can read and dismiss.
   *
   * The recovery offer is read once, at start, rather than watched: it describes a *previous* session. It
   * goes away on the first save of this one, though — by then it is offering to replace work that is on
   * disk with work that is older, which is not the trade it was put up to make.
   */
  import { project, type Recovery } from "./project.svelte.ts";

  let found = $state<Recovery | undefined>(project.recovery());
  let hushed = $state(false);

  const problems = $derived(project.problems);
  const diagnostics = $derived(project.diagnostics);
  const ago = (at: number): string => {
    const minutes = Math.round((Date.now() - at) / 60_000);
    if (minutes < 1) return "moments ago";
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.round(minutes / 60)} h ago`;
  };

  function take() {
    if (found) project.recover(found);
    found = undefined;
  }

  function drop() {
    project.discardRecovery();
    found = undefined;
  }
</script>

{#if found && !project.saves}
  <div class="notice recover">
    <b>{found.name}</b> has unsaved work from {ago(found.at)}.
    <button onclick={take}>recover</button>
    <button class="quiet" onclick={drop}>discard</button>
  </div>
{/if}

{#if (problems.length || diagnostics.length) && !hushed}
  <div class="notice bad">
    <ul>
      {#each problems as problem, i (`p${i}`)}<li>{problem}</li>{/each}
      {#each diagnostics as diagnostic, i (`d${i}`)}<li>{diagnostic}</li>{/each}
    </ul>
    <button class="quiet" onclick={() => (hushed = true)}>dismiss</button>
  </div>
{/if}

<style>
  .notice {
    display: flex; gap: 8px; align-items: flex-start;
    padding: 5px 10px; border-bottom: 1px solid var(--border);
    background: var(--panel); font: var(--mono); color: var(--text);
  }
  .recover { border-left: 3px solid var(--warn); }
  .bad { border-left: 3px solid var(--bad); }
  b { color: var(--p9); font-weight: 600; }
  ul { flex: 1; min-width: 0; list-style: none; margin: 0; padding: 0; }
  li { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  button {
    flex: none; padding: 1px 6px; cursor: pointer;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 3px;
    font: var(--mono); color: var(--p9);
  }
  button:hover { border-color: var(--p5); }
  .quiet { color: var(--dim); }
  .recover button { margin-left: 0; }
  .recover { align-items: center; }
</style>
