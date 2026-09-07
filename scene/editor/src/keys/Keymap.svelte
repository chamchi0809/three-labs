<script lang="ts">
  // The keymap, as a designer edits it. One row per command, one chip per chord: a chip is removed by
  // clicking it and a chord is added by pressing it, which is the only way of asking for a key that cannot
  // be got wrong. Nothing is resolved behind anyone's back — a chord two commands both want stays bound to
  // both and is called out in red, because a keymap that quietly unbinds the thing you had is worse than
  // one that tells you what you just did.
  import IconKeyboard from "@tabler/icons-svelte/icons/keyboard";
  import Dialog from "../ui/Dialog.svelte";
  import { tooltip } from "../ui/tooltip.ts";
  import { printChord, chordKey, chordOf, isFlyChord, type Chord, type Command } from "./keymap.ts";
  import { keys } from "./keys.svelte.ts";

  let open = $state(false);
  /** the command whose next press is a binding rather than a command, or nothing */
  let catching = $state<string>();

  const bindings = $derived(keys.bindings);
  const conflicts = $derived(keys.conflicts);
  let refused = $state("");

  const groups = $derived.by(() => {
    const by = new Map<string, Command[]>();
    for (const command of keys.commands) {
      const list = by.get(command.group) ?? by.set(command.group, []).get(command.group)!;
      list.push(command);
    }
    return [...by];
  });

  const chordsOf = (id: string): Chord[] => bindings.filter((b) => b.command === id).map((b) => b.chord);

  const titles = $derived(new Map(keys.commands.map((c) => [c.id, c.title])));

  /** who else wants this chord — the whole point of showing a conflict is showing what it is with */
  const clash = (chord: Chord, id: string): string | undefined => {
    const others = conflicts.get(chordKey(chord))?.filter((c) => c !== id);
    return others?.length ? others.map((c) => titles.get(c) ?? c).join(", ") : undefined;
  };

  /**
   * Caught in the capture phase, so the chord being bound never also runs. The listener only exists while
   * a row is waiting for one, which is why this is an effect rather than a permanent handler.
   */
  $effect(() => {
    if (!catching) return;
    const id = catching;
    const onKeydown = (event: KeyboardEvent) => {
      const chord = chordOf(event);
      if (!chord) return; // a modifier on its own is the start of a chord, not a chord
      event.preventDefault();
      event.stopImmediatePropagation();
      catching = undefined;
      // the camera's six letters are refused out loud: bindingsOf drops them anyway, and a row that
      // appeared and then did nothing would look like a bug rather than a rule
      if (isFlyChord(chord)) return void (refused = `${printChord(chord)} flies the camera`);
      refused = "";
      if (chord.key !== "escape" || chord.ctrl || chord.shift || chord.alt) keys.add(id, chord);
    };
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });

  function close() {
    catching = undefined;
    open = false;
  }
</script>

<button class="btn" class:on={open} use:tooltip={"keyboard shortcuts"} onclick={() => (open = !open)}>
  <IconKeyboard size={16} />
</button>

{#if open}
  <Dialog
    title="keyboard"
    say={refused || (catching ? "press the keys you want" : "click a key to unbind it")}
    onclose={close}
  >
    {#snippet actions()}
      <button class="plain" disabled={!keys.customised} onclick={() => keys.reset()}>defaults</button>
    {/snippet}
    {#each groups as [group, commands] (group)}
      <p class="group">{group}</p>
      {#each commands as command (command.id)}
        <div class="row">
          <span class="title">{command.title}</span>
          <span class="chords">
            {#each chordsOf(command.id) as chord (chordKey(chord))}
              {@const with_ = clash(chord, command.id)}
              <button
                class="chord"
                class:bad={with_}
                title={with_ ? `also ${with_}` : "unbind"}
                onclick={() => keys.remove(command.id, chord)}>{printChord(chord)}</button
              >
            {/each}
            <button
              class="add"
              class:waiting={catching === command.id}
              title="bind a key"
              onclick={() => (catching = catching === command.id ? undefined : command.id)}
              >{catching === command.id ? "…" : "+"}</button
            >
          </span>
        </div>
      {/each}
    {/each}
  </Dialog>
{/if}

<style>
  .group {
    margin: 10px 0 2px; padding: 0 12px;
    color: var(--muted); font-size: var(--ui-xs); font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .row {
    display: flex; gap: 8px; align-items: center; min-height: 24px; padding: 1px 12px;
  }
  .row:hover { background: var(--panel-2); }
  .title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .chords { display: flex; gap: 3px; margin-left: auto; }
  .chord, .add {
    min-width: 24px; height: 20px; padding: 0 6px; cursor: pointer;
    background: var(--bg); border: 1px solid var(--border); border-radius: 5px;
    font: var(--mono); color: var(--p9);
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .chord:hover { border-color: var(--bad); color: var(--bad); }
  .chord.bad { border-color: var(--bad); color: var(--bad); }
  .add { color: var(--muted); }
  .add:hover { background: var(--accent-dim); border-color: var(--p5); color: var(--p9); }
  .add.waiting { background: var(--accent); border-color: var(--accent); color: var(--p0); }
</style>
