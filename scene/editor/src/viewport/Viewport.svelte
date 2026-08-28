<script lang="ts">
  // M0's viewport: one perspective view, the grid, and an orbit camera, on the renderer the rest of the
  // editor will use. M7 turns this into MapView3D plus three MapView2Ds in the three-pane layout.
  import * as THREE from "three/webgpu";
  import { OrbitControls } from "three/addons/controls/OrbitControls.js";
  import { buildGrid, disposeGrid } from "./gridObject.ts";

  let { size }: { size: number } = $props();

  let canvas: HTMLCanvasElement;
  let host: HTMLDivElement;
  let status = $state("initializing…");
  let backend = $state("");

  // Written by the mount effect, read by the grid effect. Deliberately not $state: the two effects run
  // in source order on mount, and making the scene reactive would re-run the grid effect for nothing.
  let scene: THREE.Scene | undefined;

  // Reads nothing reactive, so it runs exactly once. That matters: a reactive read in here — `size`,
  // say — would tear down and rebuild the renderer every time the grid changed.
  $effect(() => {
    // A WebGPU device is not always there — a headless browser, a locked-down driver — and the editor
    // has no business refusing to open over it. three's WebGL backend runs the same node materials.
    const forceWebGL = !("gpu" in navigator);
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
    const localScene = (scene = new THREE.Scene());
    localScene.background = new THREE.Color(0x1b1d21);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);
    camera.position.set(6, 5, 8);

    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (w === 0 || h === 0) return;
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
        backend = forceWebGL ? "WebGL" : "WebGPU";
        status = "";
        renderer.setAnimationLoop(() => {
          controls.update();
          renderer.render(localScene, camera);
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
      scene = undefined;
      renderer.dispose();
    };
  });

  // The grid is rebuilt rather than scaled: the line tiers are baked into its vertex colours, so a new
  // cell size is new geometry. Cheap enough — a few thousand lines, once per keypress.
  $effect(() => {
    const target = scene;
    if (!target) return;
    const grid = buildGrid(size);
    target.add(grid);
    return () => {
      target.remove(grid);
      disposeGrid(grid);
    };
  });
</script>

<div class="viewport" bind:this={host}>
  <canvas bind:this={canvas}></canvas>
  {#if status}<div class="status">{status}</div>{/if}
  {#if backend}<div class="backend">{backend}</div>{/if}
</div>

<style>
  .viewport { position: relative; width: 100%; height: 100%; overflow: hidden; }
  canvas { display: block; width: 100%; height: 100%; }
  .status { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
  .backend {
    position: absolute; right: 8px; bottom: 6px; pointer-events: none;
    font: 11px ui-monospace, monospace; color: #6d7480;
  }
</style>
