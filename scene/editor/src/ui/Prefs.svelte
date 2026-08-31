<script lang="ts">
  // The preferences panel. One row per setting, read from the same table the store defaults from, so a
  // preference added there turns up here without a second edit.
  import IconSettings from "@tabler/icons-svelte/icons/settings";
  import Dialog from "./Dialog.svelte";
  import { tooltip } from "./tooltip.ts";
  import { prefs, SETTINGS, type Prefs, type Setting } from "./prefs.svelte.ts";

  let open = $state(false);

  const groups = $derived.by(() => {
    const by = new Map<string, Setting[]>();
    for (const setting of SETTINGS) {
      const list = by.get(setting.group) ?? by.set(setting.group, []).get(setting.group)!;
      list.push(setting);
    }
    return [...by];
  });

  /** the value beside the slider — a zero autosave is off, and saying "0 s" would be saying nothing */
  const shown = (setting: Setting, value: number): string =>
    setting.key === "autosave" && value === 0 ? "off" : `${value}${"unit" in setting ? setting.unit : ""}`;

  const number = (setting: Setting, raw: string): void =>
    prefs.set(setting.key, Number(raw) as Prefs[typeof setting.key]);
</script>

<button class="btn" class:on={open} use:tooltip={"preferences"} onclick={() => (open = !open)}>
  <IconSettings size={16} />
</button>

{#if open}
  <Dialog title="preferences" say="yours, not the map's" width={380} onclose={() => (open = false)}>
    {#snippet actions()}
      <button class="plain" disabled={!prefs.changed} onclick={() => prefs.reset()}>defaults</button>
    {/snippet}
    {#each groups as [group, settings] (group)}
      <p class="group">{group}</p>
      {#each settings as setting (setting.key)}
        <label class="row">
          <span class="title">{setting.title}</span>
          {#if setting.kind === "switch"}
            <input
              type="checkbox"
              checked={prefs.all[setting.key] as boolean}
              onchange={(e) => prefs.set(setting.key, e.currentTarget.checked as Prefs[typeof setting.key])}
            />
          {:else}
            <input
              type="range"
              min={setting.min}
              max={setting.max}
              step={setting.step}
              value={prefs.all[setting.key] as number}
              oninput={(e) => number(setting, e.currentTarget.value)}
            />
            <span class="value">{shown(setting, prefs.all[setting.key] as number)}</span>
          {/if}
        </label>
      {/each}
    {/each}
  </Dialog>
{/if}

<style>
  .group {
    margin: 10px 0 2px; padding: 0 12px;
    color: var(--muted); font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .row { display: flex; gap: 8px; align-items: center; min-height: 26px; padding: 1px 12px; }
  .row:hover { background: var(--panel-2); }
  .title { margin-right: auto; }
  /* the numbers do not jog the slider about as they change */
  .value { width: 42px; text-align: right; color: var(--p9); font-variant-numeric: tabular-nums; }
  input[type="range"] { width: 120px; }
</style>
