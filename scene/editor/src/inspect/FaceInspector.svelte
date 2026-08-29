<script lang="ts">
  /**
   * The face inspector: what a wall is made of, and where the material sits on it.
   *
   * Every button here is a call into `brush/uv.ts`, the same functions the material tool's keys and drag
   * go through. That is deliberate and it is the whole design: there is one implementation of "fit this
   * material to this face" and two ways to ask for it, rather than a tool and a panel that agree until
   * somebody fixes a rounding bug in one of them.
   *
   * Values are shown for the whole selection, and a field the faces disagree about shows `mixed` rather
   * than the first face's number. Typing into it sets every one of them, which is the point of picking a
   * set of faces first.
   */
  import type { UvMode } from "tscene";
  import { hasRelief, materialByName } from "../doc/catalogue.ts";
  import { faceInfo, facesInScope } from "../doc/inspect.ts";
  import {
    fitUv, flipUv, justifyUv, nudgeUv, resetUv, rotateUv, setUvScale, withFace, type Justify,
  } from "../brush/uv.ts";
  import { gridSize } from "../doc/editor.ts";
  import { library } from "../library.svelte.ts";
  import { session } from "../session.svelte.ts";
  import { changeFaces, type Change } from "../tools/attributes.ts";
  import MaterialBrowser from "./MaterialBrowser.svelte";
  import UvEditor from "./UvEditor.svelte";

  const DEGREE = Math.PI / 180;
  const JUSTIFY: Justify[] = ["left", "right", "top", "bottom", "centre", "middle"];

  const faces = $derived(facesInScope(session.editor.world, session.editor.selection));
  const info = $derived(faceInfo(session.editor.world, faces));
  const grid = $derived(gridSize(session.editor));

  const round = (v: number) => Math.round(v * 1000) / 1000;
  const shown = (a: { value: number; mixed: boolean }) => (a.mixed ? "" : String(round(a.value)));
  const numberOf = (t: EventTarget | null) => Number((t as HTMLInputElement).value) || 0;

  /** every button and box on this panel comes through here, so they are one undo entry each and named */
  function edit(name: string, change: Change, note: string) {
    const picked = faces;
    if (!picked.length) return;
    session.run(name, (e) => ({ ...e, world: changeFaces(e.world, picked, change) }), {
      repeatable: true,
      again: (e) => ({ ...e, world: changeFaces(e.world, e.selection.faces, change) }),
    });
    session.set((e) => ({ ...e, note }));
  }

  const setOffset = (axis: 0 | 1, to: number) => {
    const was = info?.offset.value ?? [0, 0];
    const by: [number, number] = axis === 0 ? [to - was[0], 0] : [0, to - was[1]];
    edit("offset material", (b, i) => nudgeUv(b, i, by), `offset ${axis === 0 ? "u" : "v"} ${round(to)} m`);
  };

  const setScale = (axis: 0 | 1, to: number) => {
    const was = info?.scale.value ?? [1, 1];
    const next: [number, number] = axis === 0 ? [to || 1, was[1]] : [was[0], to || 1];
    edit("size material", (b, i) => setUvScale(b, i, next), `scale ${next[0]}, ${next[1]} m per tile`);
  };

  const setRotation = (degrees: number) => {
    const was = info?.rotation.value ?? 0;
    const by = degrees * DEGREE - was;
    edit("turn material", (b, i) => rotateUv(b, i, by), `${round(degrees)}°`);
  };

  const setMode = (kind: UvMode["kind"]) =>
    edit("uv mode", (b, i) => withFace(b, i, { uv: { kind } }), kind);

  const setMaterial = (material: string) =>
    edit("set material", (b, i) => withFace(b, i, { material }), material);

  /**
   * The relief the picked faces are made of, when they agree on one material and it has a height map.
   *
   * Deliberately not shown for a mixed selection. Depth belongs to the material, so dragging it with two
   * materials picked would change both, and a slider that silently edits something not in front of you is
   * worse than no slider.
   */
  const relief = $derived.by(() => {
    if (!info || info.material.mixed || !info.material.value) return undefined;
    const def = materialByName(library.catalogue, info.material.value);
    return def && hasRelief(def) ? def : undefined;
  });
</script>

{#if !info}
  <p class="none">pick a face, or a solid, to see what it is made of</p>
{:else}
  <p class="count">{info.count} face{info.count === 1 ? "" : "s"}</p>

  <div class="fields">
    <label for="face-material">material</label>
    <select
      id="face-material"
      value={info.material.mixed ? "" : info.material.value ?? ""}
      onchange={(e) => setMaterial((e.target as HTMLSelectElement).value)}
    >
      {#if info.material.mixed}<option value="">mixed</option>{/if}
      <option value="">default</option>
      {#each library.materials as m (m.name)}<option value={m.name}>{m.name}</option>{/each}
    </select>

    <span class="label">axes</span>
    <span class="modes">
      {#each ["paraxial", "parallel"] as const as kind (kind)}
        <button
          class:on={!info.uv.mixed && info.uv.value.kind === kind}
          title={kind === "paraxial" ? "axes from the nearest world plane — a wall stays aligned to the map" : "axes in the face's own plane — a slope keeps its material square to itself"}
          onclick={() => setMode(kind)}>{kind}</button>
      {/each}
    </span>

    <label for="face-offset">offset</label>
    <span class="pair">
      <input id="face-offset" type="number" step={grid} value={info.offset.mixed ? "" : round(info.offset.value[0])}
        placeholder={info.offset.mixed ? "mixed" : ""} onchange={(e) => setOffset(0, numberOf(e.target))} />
      <input type="number" step={grid} value={info.offset.mixed ? "" : round(info.offset.value[1])}
        placeholder={info.offset.mixed ? "mixed" : ""} onchange={(e) => setOffset(1, numberOf(e.target))} />
    </span>

    <label for="face-scale">scale</label>
    <span class="pair">
      <input id="face-scale" type="number" step="any" value={info.scale.mixed ? "" : round(info.scale.value[0])}
        placeholder={info.scale.mixed ? "mixed" : ""} onchange={(e) => setScale(0, numberOf(e.target))} />
      <input type="number" step="any" value={info.scale.mixed ? "" : round(info.scale.value[1])}
        placeholder={info.scale.mixed ? "mixed" : ""} onchange={(e) => setScale(1, numberOf(e.target))} />
    </span>

    <label for="face-turn">turn</label>
    <span class="pair">
      <input id="face-turn" type="number" step="15" value={shown({ value: info.rotation.value / DEGREE, mixed: info.rotation.mixed })}
        placeholder={info.rotation.mixed ? "mixed" : ""} onchange={(e) => setRotation(numberOf(e.target))} />
      <span class="unit">degrees</span>
    </span>
  </div>

  {#if relief}
    <!-- one knob, because there is one thing to decide. Whether a pixel is normal-mapped, marched, or
         writing its own depth follows from how far the camera is, and a designer choosing that per
         material would be choosing wrong at every distance but one -->
    <div class="relief">
      <label for="face-depth">depth</label>
      <input id="face-depth" type="range" min="0" max="0.12" step="0.001"
        value={library.depthOf(relief.name) ?? 0.03}
        oninput={(e) => library.setDepth(relief.name, Number((e.target as HTMLInputElement).value))} />
      <span class="unit">{Math.round((library.depthOf(relief.name) ?? 0.03) * 1000)} mm</span>
      {#if library.overridden(relief.name)}
        <button class="revert" title="back to the {relief.depth ?? 0.03} m the sheet declares"
          onclick={() => library.setDepth(relief.name, undefined)}>sheet</button>
      {/if}
    </div>
    <p class="none">{relief.name} has relief · the slider is this session only, not the sheet</p>
  {/if}

  <div class="tools">
    <button onclick={() => edit("reset material", (b, i) => resetUv(b, i), "reset")} title="offset 0, scale 1, no rotation">reset</button>
    <button onclick={() => edit("fit material", (b, i) => fitUv(b, i), "fitted")} title="one tile across the whole face">fit</button>
    <button onclick={() => edit("flip material", (b, i) => flipUv(b, i, "u"), "flipped u")}>flip u</button>
    <button onclick={() => edit("flip material", (b, i) => flipUv(b, i, "v"), "flipped v")}>flip v</button>
    <button onclick={() => edit("nudge material", (b, i) => nudgeUv(b, i, [-grid, 0]), `nudged -${grid} u`)}>−u</button>
    <button onclick={() => edit("nudge material", (b, i) => nudgeUv(b, i, [grid, 0]), `nudged +${grid} u`)}>+u</button>
    <button onclick={() => edit("nudge material", (b, i) => nudgeUv(b, i, [0, -grid]), `nudged -${grid} v`)}>−v</button>
    <button onclick={() => edit("nudge material", (b, i) => nudgeUv(b, i, [0, grid]), `nudged +${grid} v`)}>+v</button>
  </div>

  <div class="tools">
    {#each JUSTIFY as side (side)}
      <button onclick={() => edit("justify material", (b, i) => justifyUv(b, i, side), side)}>{side}</button>
    {/each}
  </div>

  {#if info.only}
    <UvEditor brush={info.only.brush} face={info.only.face} />
  {:else}
    <p class="none">pick one face to see where its material sits</p>
  {/if}
{/if}

<h3>materials</h3>
<MaterialBrowser />

<style>
  .none { margin: 4px 0; color: var(--dim); font: var(--mono); }
  .count { margin: 0 0 6px; color: var(--text); font: var(--mono); }
  .fields { display: grid; grid-template-columns: 56px 1fr; gap: 4px; align-items: center; }
  .fields label, .fields .label { color: var(--dim); font: var(--mono); }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  .unit { color: var(--dim); font: var(--mono); align-self: center; }
  .modes { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  .tools { display: flex; flex-wrap: wrap; gap: 3px; margin: 6px 0; }
  .relief {
    display: grid; grid-template-columns: 56px 1fr auto auto; gap: 4px; align-items: center;
    margin-top: 6px;
  }
  .relief label { color: var(--dim); font: var(--mono); }
  .relief input { width: 100%; accent-color: var(--edge); }
  .tools button, .modes button, .relief .revert {
    padding: 2px 7px; cursor: pointer;
    background: var(--raised); border: 1px solid var(--line); border-radius: 3px;
    font: var(--mono); color: var(--text);
  }
  .tools button:hover, .modes button:hover, .relief .revert:hover { border-color: var(--edge); color: var(--ink); }
  .modes button.on { background: var(--on); border-color: var(--edge); color: var(--ink); }
  h3 {
    margin: 12px 0 4px; padding-top: 8px; border-top: 1px solid var(--line);
    font: var(--mono); font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em;
  }
</style>
