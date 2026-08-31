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
   *
   * A patch's one surface is in this panel too, on the same footing: the same material and the same three
   * numbers in the same units. What it has not got — the choice of axes, `fit`, `justify`, and the uv
   * editor's outline — needs a face's plane, so those are hidden or greyed when a patch is in scope rather
   * than shown as buttons that would do nothing.
   */
  import type { UvMode } from "tscene";
  import { hasRelief, materialByName } from "../doc/catalogue.ts";
  import { faceInfo, facesInScope } from "../doc/inspect.ts";
  import {
    fitUv, flipUv, justifyUv, nudgeUv, resetUv, rotateUv, setUvScale, withFace, type Justify,
  } from "../brush/uv.ts";
  import { gridSize } from "../doc/editor.ts";
  import { library } from "../library.svelte.ts";
  import {
    flipPatchUv, nudgePatchUv, resetPatchUv, rotatePatchUv, setPatchUvScale, withPatchMaterial,
  } from "../patch/uv.ts";
  import { session } from "../session.svelte.ts";
  import { changeFaces, type Change, type PatchChange } from "../tools/attributes.ts";
  import Panel from "../ui/Panel.svelte";
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
  function edit(name: string, change: Change, note: string, onPatch?: PatchChange) {
    const picked = faces;
    if (!picked.length) return;
    session.run(name, (e) => ({ ...e, world: changeFaces(e.world, picked, change, onPatch) }), {
      repeatable: true,
      again: (e) => ({ ...e, world: changeFaces(e.world, e.selection.faces, change, onPatch) }),
    });
    session.set((e) => ({ ...e, note }));
  }

  const setOffset = (axis: 0 | 1, to: number) => {
    const was = info?.offset.value ?? [0, 0];
    const by: [number, number] = axis === 0 ? [to - was[0], 0] : [0, to - was[1]];
    edit("offset material", (b, i) => nudgeUv(b, i, by), `offset ${axis === 0 ? "u" : "v"} ${round(to)} m`,
      (p) => nudgePatchUv(p, by));
  };

  const setScale = (axis: 0 | 1, to: number) => {
    const was = info?.scale.value ?? [1, 1];
    const next: [number, number] = axis === 0 ? [to || 1, was[1]] : [was[0], to || 1];
    edit("size material", (b, i) => setUvScale(b, i, next), `scale ${next[0]}, ${next[1]} m per tile`,
      (p) => setPatchUvScale(p, next));
  };

  const setRotation = (degrees: number) => {
    const was = info?.rotation.value ?? 0;
    const by = degrees * DEGREE - was;
    edit("turn material", (b, i) => rotateUv(b, i, by), `${round(degrees)}°`, (p) => rotatePatchUv(p, by));
  };

  // no patch half: a patch's material runs along the surface, so there is no other set of axes to choose
  const setMode = (kind: UvMode["kind"]) =>
    edit("uv mode", (b, i) => withFace(b, i, { uv: { kind } }), kind);

  const setMaterial = (material: string) =>
    edit("set material", (b, i) => withFace(b, i, { material }), material,
      (p) => withPatchMaterial(p, material));

  /** how many of the surfaces in scope are brush faces, which is what fit and justify have anything to say to */
  const walls = $derived(info ? info.count - info.patches : 0);

  /** how the header names what is in scope, when it is not all one kind */
  const counted = $derived.by(() => {
    if (!info) return "";
    const bits: string[] = [];
    if (walls) bits.push(`${walls} face${walls === 1 ? "" : "s"}`);
    if (info.patches) bits.push(`${info.patches} patch${info.patches === 1 ? "" : "es"}`);
    return bits.join(" + ");
  });

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

<Panel title="surface">
  {#if !info}
    <p class="none">select a face or a solid to see its material</p>
  {:else}
    <p class="count">{counted}</p>

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

      {#if info.uv}
        <span class="label">axes</span>
        <span class="modes">
          {#each ["paraxial", "parallel"] as const as kind (kind)}
            <button
              class:on={!info.uv.mixed && info.uv.value.kind === kind}
              title={kind === "paraxial" ? "axes from the nearest world plane, so walls stay aligned to the map" : "axes in the face's own plane, so a slope keeps its material square to itself"}
              onclick={() => setMode(kind)}>{kind}</button>
          {/each}
        </span>
      {/if}

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
          <button class="revert" title="back to the {relief.depth ?? 0.03} m declared in the sheet"
            onclick={() => library.setDepth(relief.name, undefined)}>sheet</button>
        {/if}
      </div>
      <p class="none">{relief.name} has relief · this slider is preview only and is not saved</p>
    {/if}

    <div class="tools">
      <button onclick={() => edit("reset material", (b, i) => resetUv(b, i), "reset", resetPatchUv)} title="offset 0, scale 1, no rotation">reset</button>
      <button disabled={!walls} onclick={() => edit("fit material", (b, i) => fitUv(b, i), "fitted")} title="one tile across the whole face · faces only, a patch has no outline to fit to">fit</button>
      <button onclick={() => edit("flip material", (b, i) => flipUv(b, i, "u"), "flipped u", (p) => flipPatchUv(p, "u"))}>flip u</button>
      <button onclick={() => edit("flip material", (b, i) => flipUv(b, i, "v"), "flipped v", (p) => flipPatchUv(p, "v"))}>flip v</button>
      <button onclick={() => edit("nudge material", (b, i) => nudgeUv(b, i, [-grid, 0]), `nudged -${grid} u`, (p) => nudgePatchUv(p, [-grid, 0]))}>−u</button>
      <button onclick={() => edit("nudge material", (b, i) => nudgeUv(b, i, [grid, 0]), `nudged +${grid} u`, (p) => nudgePatchUv(p, [grid, 0]))}>+u</button>
      <button onclick={() => edit("nudge material", (b, i) => nudgeUv(b, i, [0, -grid]), `nudged -${grid} v`, (p) => nudgePatchUv(p, [0, -grid]))}>−v</button>
      <button onclick={() => edit("nudge material", (b, i) => nudgeUv(b, i, [0, grid]), `nudged +${grid} v`, (p) => nudgePatchUv(p, [0, grid]))}>+v</button>
    </div>

    <!-- justify puts a material against an edge of the face's outline, which is a thing only a face has —
         so with nothing but patches picked these go grey rather than sitting there doing nothing -->
    <div class="tools">
      {#each JUSTIFY as side (side)}
        <button disabled={!walls}
          onclick={() => edit("justify material", (b, i) => justifyUv(b, i, side), side)}>{side}</button>
      {/each}
    </div>

    {#if info.only}
      <UvEditor brush={info.only.brush} face={info.only.face} />
    {:else if info.patches === info.count}
      <p class="none">a patch maps its material along the surface; the numbers above are all it has</p>
    {:else}
      <p class="none">select a single face to see how its material is placed</p>
    {/if}

    {#if info.patches && info.patches < info.count}
      <p class="none">fit and justify apply to the {info.count - info.patches} face{info.count - info.patches === 1 ? "" : "s"} only</p>
    {/if}
  {/if}
</Panel>

<Panel title="materials">
  <MaterialBrowser />
</Panel>

<style>
  .none { margin: 4px 0; color: var(--dim); font: var(--mono); }
  .count { margin: 0 0 6px; color: var(--text); font: var(--mono); }
  .fields { display: grid; grid-template-columns: 56px 1fr; gap: 5px; align-items: center; }
  .fields label, .fields .label { color: var(--muted); font: var(--mono); }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
  .unit { color: var(--dim); font: var(--mono); align-self: center; }
  .modes { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
  .tools { display: flex; flex-wrap: wrap; gap: 3px; margin: 8px 0; }
  .relief {
    display: grid; grid-template-columns: 56px 1fr auto auto; gap: 5px; align-items: center;
    margin-top: 8px;
  }
  .relief label { color: var(--muted); font: var(--mono); }
  .relief input { width: 100%; }
  .tools button, .modes button, .relief .revert {
    height: 21px; padding: 0 8px; cursor: pointer;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px;
    font: var(--mono); color: var(--text);
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .tools button:hover:not(:disabled), .modes button:hover, .relief .revert:hover {
    background: var(--accent-dim); color: var(--p9);
  }
  .tools button:disabled { color: var(--dim); opacity: 0.5; cursor: default; }
  .modes button.on { background: var(--accent); border-color: var(--accent); color: var(--p0); }
</style>
