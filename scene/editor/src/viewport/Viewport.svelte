<script lang="ts">
  // M6's viewport: one perspective view of the render scene, with hover picking and the compass.
  //
  // It is deliberately thin. Everything that decides what the picture looks like lives in `render/` and
  // everything that decides what the map *is* lives in `doc/`; this file owns a camera, a canvas and the
  // loop between them. M7 turns it into MapView3D plus three MapView2Ds in the three-pane layout, and
  // almost nothing below has to move when it does.
  import * as THREE from "three/webgpu";
  import { OrbitControls } from "three/addons/controls/OrbitControls.js";
  import { newCompass, updateCompass } from "../render/compass.ts";
  import { newPicker, pickAt } from "../render/pick.ts";
  import { idOf } from "../render/batch.ts";
  import { newRenderScene, sceneBounds, setHover, syncScene } from "../render/scene.ts";
  import { layoutLabels } from "../render/text.ts";
  import { session } from "../session.svelte.ts";
  import { selectNodes } from "../doc/selection.ts";

  let canvas: HTMLCanvasElement;
  let host: HTMLDivElement;
  let status = $state("initializing…");
  let backend = $state("");
  let over = $state("");

  const rs = newRenderScene();
  const compass = newCompass();
  const picker = newPicker();

  /** the last place the pointer was, in CSS pixels — picked from the loop rather than from the event */
  let pointer: { x: number; y: number } | undefined;
  /** where the last pick was taken, so a still pointer costs nothing */
  let picked: { x: number; y: number } | undefined;
  let picking = false;
  /** the camera or the map moved, so what is under a cursor that has not moved is not what it was */
  let moved = true;

  // Reads nothing reactive, so it runs exactly once: a reactive read here would tear the renderer down
  // and rebuild it on every edit.
  $effect(() => {
    // A WebGPU device is not always there — a headless browser, a locked-down driver — and the editor has
    // no business refusing to open over it. three's WebGL backend runs the same node materials.
    const forceWebGL = !("gpu" in navigator);
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
    rs.scene.background = new THREE.Color(0x1b1d21);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);
    camera.position.set(11, 8, 14);

    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 1.5, 0);
    controls.enableDamping = true;
    controls.addEventListener("change", () => (moved = true));

    let width = 1;
    let height = 1;
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (w === 0 || h === 0) return;
      width = w;
      height = h;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    let disposed = false;
    (async () => {
      try {
        await renderer.init();
        if (disposed) return;
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        resize();
        frameAll(camera, controls);
        backend = forceWebGL ? "WebGL" : "WebGPU";
        status = "";

        renderer.setAnimationLoop(() => {
          controls.update();
          // labels are sprites in world space, so their scale depends on where the camera ended up
          layoutLabels(rs.labels, camera, height);

          renderer.autoClear = true;
          renderer.setViewport(0, 0, width, height);
          renderer.render(rs.scene, camera);

          // the compass over the corner, with the depth buffer cleared so it is never buried in a wall
          const size = 96;
          updateCompass(compass, camera, size);
          renderer.autoClear = false;
          renderer.clearDepth();
          renderer.setViewport(width - size - 8, 8, size, size);
          renderer.render(compass.scene, compass.camera);
          renderer.setViewport(0, 0, width, height);

          void hover(renderer, camera, width, height);
        });
      } catch (e) {
        status = `renderer failed: ${(e as Error).message}`;
      }
    })();

    return () => {
      disposed = true;
      observer.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      renderer.dispose();
    };
  });

  // The scene follows the document. Reading `session.editor` is what subscribes this to every edit, and
  // the diff inside `syncScene` is what keeps that from costing anything when little changed.
  $effect(() => {
    syncScene(rs, session.editor);
    moved = true;
  });

  /**
   * What is under the pointer, asked at most once per frame and only when something moved.
   *
   * A pick is a render and a read-back, so it is not something to do per pointer event — a fast mouse
   * fires dozens between frames and they would queue up behind each other. Taking the last position at
   * frame time gives one pick per frame and always the newest one; skipping a pointer that has not moved
   * since the last pick keeps a still cursor from costing a pass every frame.
   */
  async function hover(renderer: THREE.WebGPURenderer, camera: THREE.Camera, w: number, h: number) {
    if (picking || !pointer) return;
    if (picked && picked.x === pointer.x && picked.y === pointer.y && !moved) return;
    picked = pointer;
    moved = false;
    picking = true;
    try {
      const found = await pickAt(renderer, picker, rs, camera, pointer.x, pointer.y, { width: w, height: h });
      const id = found.ordinal === undefined ? undefined : idOf(rs.brushes, found.ordinal);
      setHover(rs, id ? { node: id, face: found.face } : undefined);
      over = id ? `${id} · face ${found.face}` : "";
      syncScene(rs, session.editor);
    } finally {
      picking = false;
    }
  }

  /** the camera pulled back far enough to see the whole map, which is where a view should open */
  function frameAll(camera: THREE.PerspectiveCamera, controls: OrbitControls) {
    syncScene(rs, session.editor);
    const box = sceneBounds(rs);
    if (!Number.isFinite(box.min[0])) return;
    const centre = new THREE.Vector3(...[0, 1, 2].map((i) => (box.min[i]! + box.max[i]!) / 2));
    const reach = Math.max(...[0, 1, 2].map((i) => box.max[i]! - box.min[i]!));
    controls.target.copy(centre);
    camera.position.copy(centre).add(new THREE.Vector3(0.9, 0.7, 1).normalize().multiplyScalar(reach * 1.4));
    camera.far = Math.max(500, reach * 20);
    camera.updateProjectionMatrix();
    rs.grid.reach.value = camera.far;
  }

  function onPointerMove(event: PointerEvent) {
    const rect = host.getBoundingClientRect();
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerLeave() {
    pointer = undefined;
    setHover(rs, undefined);
    over = "";
    syncScene(rs, session.editor);
  }

  // Selection on click, in the crudest possible form — M8 replaces this with the select tool, which has
  // modifiers, group resolution and drag-to-box. It is here now because a renderer that draws selection
  // cannot be judged without something to select.
  function onClick(event: MouseEvent) {
    if (!rs.hover) return;
    const id = rs.hover.node;
    session.set((e) => ({
      ...e,
      selection: selectNodes(e.world, e.selection, [id], event.shiftKey ? "toggle" : "replace", e.open),
    }));
  }
</script>

<div
  class="viewport"
  bind:this={host}
  onpointermove={onPointerMove}
  onpointerleave={onPointerLeave}
  onclick={onClick}
  role="presentation"
>
  <canvas bind:this={canvas}></canvas>
  {#if status}<div class="status">{status}</div>{/if}
  <div class="corner">
    {#if over}<span class="over">{over}</span>{/if}
    {#if backend}<span class="backend">{backend}</span>{/if}
  </div>
</div>

<style>
  .viewport { position: relative; width: 100%; height: 100%; overflow: hidden; }
  canvas { display: block; width: 100%; height: 100%; }
  .status { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
  .corner {
    position: absolute; left: 8px; bottom: 6px; display: flex; gap: 10px; pointer-events: none;
    font: 11px ui-monospace, monospace; color: #6d7480;
  }
  .over { color: #9aa1ac; }
</style>
