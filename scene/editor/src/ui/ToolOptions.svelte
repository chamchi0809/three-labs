<script lang="ts">
  /**
   * The row under the tool bar: what the live tool is set to, as buttons.
   *
   * Every setting here already had a key — tab cycles the shape, `,` and `.` step its sides — and every
   * key stays exactly as it was. What a key cannot do is *show* the answer, so a designer who has not read
   * the hint along the bottom has no way of knowing a shape tool draws six different solids. The keys are
   * printed next to the controls they drive, which is how the row teaches them rather than replacing them.
   *
   * The row reads `tools.rev` because a tool's settings are plain module state and are read sixty times a
   * second by a drag; the counter is what tells this to look again after a press changed one.
   */
  import { TOOL_KEYS, optionsFor } from "../tools/options.ts";
  import { tools } from "../tools/tools.svelte.ts";
  import { tooltip } from "./tooltip.ts";

  // The values are read here rather than in the markup on purpose: a setting is plain module state, so
  // nothing downstream would ever re-read it — `rev` changing is the only news there is, and this is the
  // one place that hears it.
  const options = $derived(
    (void tools.rev, optionsFor(tools.current.id).map((option) => ({ option, value: option.get() }))),
  );

  const shortcuts = $derived(TOOL_KEYS[tools.current.id] ?? []);

  const set = (note: string) => tools.apply({ note });
</script>

{#if options.length || shortcuts.length}
  <div class="options">
    <span class="of">{tools.current.title}</span>
    {#each options as { option, value } (option.label)}
      <span class="option" use:tooltip={`${option.label} — ${option.about}`}>
        <!-- the tool's own name is already at the head of the row; saying "shape shape" says nothing -->
        {#if option.label !== tools.current.title}<span class="label">{option.label}</span>{/if}
        {#if option.kind === "choice"}
          <span class="values">
            {#each option.values as v (v)}
              <button class="pick" class:on={v === value} onclick={() => set(option.set(v))}>{v}</button>
            {/each}
          </span>
          {#if !option.values.includes(String(value))}<span class="other">{value}</span>{/if}
          {#if option.key}<span class="key">[{option.key}] to cycle</span>{/if}
        {:else}
          <span class="steps">
            <button class="step" onclick={() => set(option.set(Number(value) - 1))}>−</button>
            <b>{value}</b>
            <button class="step" onclick={() => set(option.set(Number(value) + 1))}>+</button>
          </span>
          {#if option.keys}<span class="key">[{option.keys[0]}] [{option.keys[1]}]</span>{/if}
        {/if}
      </span>
    {/each}

    {#if shortcuts.length}
      <span class="keys">
        {#each shortcuts as [key, means] (key)}
          <span class="shortcut"><kbd>{key}</kbd> {means}</span>
        {/each}
      </span>
    {/if}
  </div>
{/if}

<style>
  .options {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 5px 10px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    user-select: none;
    overflow-x: auto;
    overflow-y: hidden;
    font: var(--ui);
    color: var(--muted);
  }
  .of {
    color: var(--accent);
    font-weight: 700;
    white-space: nowrap;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .label {
    color: var(--dim);
  }
  .values, .steps {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 5px;
  }
  .steps {
    gap: 6px;
    padding: 2px 8px;
  }
  .steps b {
    min-width: 18px;
    text-align: center;
    color: var(--p9);
    font-weight: 600;
  }
  .pick, .step {
    padding: 2px 8px;
    background: none;
    border: 0;
    border-radius: 4px;
    color: var(--text);
    font: inherit;
    cursor: pointer;
    transition: background-color 130ms ease, color 130ms ease;
  }
  .pick:hover, .step:hover {
    background: var(--accent-dim);
    color: var(--p9);
  }
  .pick.on {
    background: var(--accent);
    color: var(--p0);
    font-weight: 600;
  }
  .step {
    padding: 0 4px;
  }
  /* an object definition picked in the browser is not one of the buttons; it still has to be readable */
  .other {
    color: var(--p9);
    font-weight: 600;
  }
  .key {
    color: var(--dim);
    font-size: 11px;
  }
  /* the keys that act rather than set: after the controls, on the same left edge as everything else */
  .keys {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .shortcut {
    color: var(--dim);
    white-space: nowrap;
  }
  kbd {
    padding: 1px 4px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text);
    font: inherit;
    font-size: 11px;
  }
</style>
