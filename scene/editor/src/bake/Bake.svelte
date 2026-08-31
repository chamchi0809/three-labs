<script lang="ts">
  // The bake panel: what to bake at, a button, and a bar that tells the truth for four minutes.
  //
  // The settings are the six a level designer actually turns. Everything else the baker takes — the bias,
  // the firefly clamp, the dilation radius, the denoise kernel — belongs in the sheet's own `@bakery`
  // block, where it is part of the map and travels with it; putting them here would be putting a map's
  // properties in a dialog that forgets them.
  import IconFlame from "@tabler/icons-svelte/icons/flame";
  import Dialog from "../ui/Dialog.svelte";
  import { tooltip } from "../ui/tooltip.ts";
  import { bakery } from "./bake.svelte.ts";
  import { clock, type Settings } from "./protocol.ts";

  // the flag is the store's, not this component's: `window.bake` and the file menu both open this panel,
  // and neither of them is in here
  const open = $derived(bakery.open);

  // asked when the panel is first opened rather than at startup: it wakes a GPU adapter on the other
  // side, and an editor that is never used to bake should never pay for that
  $effect(() => {
    if (open && !bakery.ready) void bakery.probe();
  });

  const ready = $derived(bakery.ready);
  const can = $derived(ready?.ok === true);
  const baked = $derived(bakery.baked);

  type Row =
    | { key: keyof Settings; title: string; kind: "choice"; of: number[]; say?: (n: number) => string }
    | { key: keyof Settings; title: string; kind: "switch"; note: string };

  const ROWS: Row[] = [
    { key: "size", title: "atlas", kind: "choice", of: [256, 512, 1024, 2048, 4096], say: (n) => `${n}²` },
    { key: "samples", title: "samples per texel", kind: "choice", of: [32, 64, 128, 256, 512, 1024] },
    { key: "bounces", title: "bounces", kind: "choice", of: [1, 2, 3, 4, 6] },
    // 0 is "fit the atlas to the level", which is what anyone wants until they are rebaking one room
    { key: "texelsPerUnit", title: "texels per metre", kind: "choice", of: [0, 1, 2, 4, 8], say: (n) => (n ? `${n}` : "fit") },
    { key: "ao", title: "occlusion atlas", kind: "switch", note: "a second atlas, on the materials' aoMap" },
    { key: "exr", title: "keep the float image", kind: "switch", note: "what rebaking one room needs" },
  ];

  /** roughly how long this will take, as a shape rather than a number — the real answer is the machine's */
  const cost = $derived.by(() => {
    const { size, samples, bounces } = bakery.settings;
    const texels = (size * size) / 1000;
    const paths = (texels * samples * bounces) / 1000;
    return paths < 4000 ? "quick" : paths < 40_000 ? "a few minutes" : "a long time";
  });
</script>

<button
  class="btn opener"
  class:on={open}
  class:lit={bakery.showing}
  use:tooltip={bakery.showing ? "lightmaps — a preview is showing" : "lightmaps"}
  onclick={() => bakery.togglePanel()}
>
  <IconFlame size={16} />
  {#if bakery.running}<i>{Math.round(bakery.progress * 100)}%</i>{/if}
</button>

{#if open}
  <Dialog
    title="lightmaps"
    say={ready === undefined ? "asking…" : (ready.why ?? `from ${ready.dir}`)}
    width={420}
    onclose={() => (bakery.open = false)}
  >
    {#snippet actions()}
      {#if bakery.running}
        <button class="plain" onclick={() => void bakery.stop()}>stop</button>
      {:else}
        <button class="plain" disabled={!can} onclick={() => void bakery.run()}>bake</button>
      {/if}
    {/snippet}

    {#if bakery.running}
      <!-- the stage as well as the bar, because "unwrap" sitting still for a minute is xatlas working and
           "trace" sitting still for a minute is a bake that has hung, and the bar cannot tell them apart -->
      <div class="progress">
        <div class="bar"><span style:width="{bakery.progress * 100}%"></span></div>
        <p><b>{bakery.stage}</b> · {bakery.elapsed}</p>
      </div>
    {/if}

    {#each ROWS as row (row.key)}
      <div class="row">
        <span class="title">{row.title}</span>
        {#if row.kind === "switch"}
          <span class="note">{row.note}</span>
          <input
            type="checkbox"
            disabled={bakery.running}
            checked={bakery.settings[row.key] as boolean}
            onchange={(e) => bakery.set(row.key, e.currentTarget.checked as Settings[typeof row.key])}
          />
        {:else}
          <span class="choice">
            {#each row.of as value (value)}
              <button
                class:on={bakery.settings[row.key] === value}
                disabled={bakery.running}
                onclick={() => bakery.set(row.key, value as Settings[typeof row.key])}
              >{row.say ? row.say(value) : value}</button>
            {/each}
          </span>
        {/if}
      </div>
    {/each}

    <p class="group">how long</p>
    <div class="row"><span class="title">at these settings</span><span class="note">{cost}</span></div>

    {#if bakery.failed}<p class="bad">{bakery.failed}</p>{/if}

    {#if baked}
      <p class="group">last bake</p>
      <div class="row">
        <span class="title">{baked.width}×{baked.height}</span>
        <span class="note">{Math.round(baked.utilization * 100)}% packed · {clock(baked.ms)}</span>
      </div>
      <div class="row">
        <span class="title">files</span>
        <span class="note">{baked.files.join(" · ")}</span>
      </div>
      <div class="row">
        <span class="title">show it on the map</span>
        <span class="note">a second scene, loaded from the same sheet</span>
        <button class="plain" disabled={bakery.busy} onclick={() => void bakery.toggle()}>
          {bakery.showing ? "hide" : "show"}
        </button>
      </div>
      {#if bakery.showing}
        <label class="row">
          <span class="title">brightness</span>
          <input
            type="range" min="0.25" max="4" step="0.25"
            value={bakery.intensity}
            oninput={(e) => (bakery.intensity = Number(e.currentTarget.value))}
          />
          <span class="value">{bakery.intensity}×</span>
        </label>
      {/if}
    {/if}
  </Dialog>
{/if}

<style>
  /* the square is the tool bar's; only what is particular to this button is here. A preview that is
     showing is a viewport that is not showing the map, and that has to be visible from the bar — it is the
     one state where clicking a wall does nothing and the reason is elsewhere */
  .opener { position: relative; }
  .opener.lit { border-color: var(--accent); color: var(--accent); }
  .opener i {
    position: absolute; right: -6px; bottom: -5px;
    padding: 0 3px; border-radius: 7px;
    background: var(--accent); color: var(--p0);
    font: 9px/13px ui-sans-serif, system-ui, sans-serif; font-style: normal;
    font-variant-numeric: tabular-nums;
  }

  .group {
    margin: 10px 0 2px; padding: 0 12px;
    color: var(--muted); font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .row { display: flex; gap: 8px; align-items: center; min-height: 26px; padding: 1px 12px; }
  .row:hover { background: var(--panel-2); }
  .title { margin-right: auto; }
  .note { color: var(--muted); }
  .value { width: 34px; text-align: right; color: var(--p9); font-variant-numeric: tabular-nums; }
  .bad { margin: 6px 0 0; padding: 0 12px; color: var(--bad); }

  .choice { display: flex; gap: 2px; }
  .choice button {
    min-width: 28px; height: 20px; padding: 0 6px; cursor: pointer;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px;
    font: var(--mono); color: var(--muted);
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .choice button:hover:not(:disabled) { background: var(--accent-dim); color: var(--p9); }
  .choice button.on { background: var(--accent); border-color: var(--accent); color: var(--p0); }
  .choice button:disabled { cursor: default; opacity: 0.5; }

  .progress { padding: 6px 12px 8px; }
  .bar { height: 5px; background: var(--p4); border-radius: 3px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--accent); transition: width 0.2s linear; }
  .progress p { margin: 5px 0 0; color: var(--muted); }
  .progress b { color: var(--p9); font-weight: 600; }

  input[type="range"] { width: 120px; }
</style>
