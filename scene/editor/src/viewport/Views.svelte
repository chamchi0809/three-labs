<script lang="ts">
  // The viewports: one renderer, one scene, and up to four panes looking at it from different places.
  //
  // The single most important decision here is that there is one canvas rather than one per pane. Four
  // WebGPU contexts would mean four device queues, four copies of every buffer, and a scene that has to be
  // uploaded four times — for four pictures of the *same* geometry. Instead each pane is a viewport and a
  // scissor rectangle on one canvas, drawn in turn from its own camera. Adding a pane costs one more draw
  // of a scene that is already resident, which is why a four-pane layout is not four times the price of a
  // one-pane one.
  //
  // Input is handled here rather than on the pane elements for the same reason the cameras live outside
  // Svelte: a pane is a rectangle, not a component, and "which pane is this pointer in" is a comparison
  // against four numbers. That also makes splitter dragging fall out — a splitter is just the strip where
  // no pane is.
  import * as THREE from "three/webgpu";
  import { idOf } from "../render/batch.ts";
  import { newCompass, updateCompass } from "../render/compass.ts";
  import { COLOURS } from "../render/materials.ts";
  import { newPicker, pickAt } from "../render/pick.ts";
  import { newRenderScene, sceneBounds, setHover, syncScene } from "../render/scene.ts";
  import { layoutLabels } from "../render/text.ts";
  import type { Bounds } from "../brush/builder.ts";
  import { nodeById, nodeBounds, union } from "../doc/document.ts";
  import { selectNodes } from "../doc/selection.ts";
  import { session } from "../session.svelte.ts";
  import { applyCamera, gridReach, newCamera, placeGridPlane, type ViewCamera } from "./camera.ts";
  import { LAYOUTS, cellAt, rectOf, type Cell } from "./layout.ts";
  import { panes, views } from "./views.svelte.ts";
  import {
    VIEW_KINDS, VIEW_TITLES, flyView, frameView, lookView, orbitView, panView, zoomView,
    type Size, type ViewKind,
  } from "./view.ts";

  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let status = $state("initializing…");
  let backend = $state("");
  let cursor = $state("default");
  let readout = $state<Record<string, string>>({});

  // Everything below is deliberately outside `$state`: it changes every frame and nothing in the DOM
  // depends on it, so making it reactive would only add an invalidation between a mouse move and a pixel.
  const rs = newRenderScene();
  const compass = newCompass();
  const picker = newPicker();
  const cameras = Object.fromEntries(VIEW_KINDS.map((k) => [k, newCamera(k)])) as Record<ViewKind, ViewCamera>;
  const sizes = Object.fromEntries(VIEW_KINDS.map((k) => [k, { width: 1, height: 1 }])) as Record<ViewKind, Size>;

  let area = { width: 1, height: 1 };
  /** the camera or the map moved, so what was under a motionless cursor may not be any more */
  let moved = true;

  type Mode = "pan" | "orbit" | "look";
  let drag: { view: ViewKind; mode: Mode; x: number; y: number } | undefined;
  let splitting: "x" | "y" | undefined;
  let pointer: { view: ViewKind; x: number; y: number } | undefined;
  let picked: { view: ViewKind; x: number; y: number } | undefined;
  let picking = false;
  const held = new Set<string>();

  // ---------------------------------------------------------------- the renderer

  // Reads nothing reactive, so it runs exactly once: a reactive read here would tear the renderer down and
  // rebuild it on every edit.
  $effect(() => {
    const forceWebGL = !("gpu" in navigator);
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
    rs.scene.background = new THREE.Color(COLOURS.background);

    const observer = new ResizeObserver(() => resize(renderer));
    observer.observe(host);

    let disposed = false;
    let last = 0;
    (async () => {
      try {
        await renderer.init();
        if (disposed) return;
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        // every pane clears and draws inside its own rectangle, so the scissor stays on for good
        renderer.setScissorTest(true);
        resize(renderer);
        syncScene(rs, session.editor);
        frameAll();
        backend = forceWebGL ? "WebGL" : "WebGPU";
        status = "";

        renderer.setAnimationLoop((now) => {
          const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
          last = now;
          fly(dt);
          draw(renderer);
          void hover(renderer);
        });
      } catch (e) {
        status = `renderer failed: ${(e as Error).message}`;
      }
    })();

    return () => {
      disposed = true;
      observer.disconnect();
      renderer.setAnimationLoop(null);
      renderer.dispose();
    };
  });

  // The scene follows the document; the diff inside `syncScene` is what keeps that cheap.
  $effect(() => {
    syncScene(rs, session.editor);
    moved = true;
  });

  // A layout change moves every pane, so what is under the pointer is no longer what it was.
  $effect(() => {
    void panes.cells;
    moved = true;
  });

  function resize(renderer: THREE.WebGPURenderer): void {
    const { clientWidth: width, clientHeight: height } = host;
    if (width === 0 || height === 0) return;
    area = { width, height };
    measure();
    renderer.setSize(width, height, false);
    moved = true;
  }

  /** each shown pane's size in CSS pixels, which is what framing and picking are both measured in */
  function measure(): void {
    for (const cell of panes.cells) {
      const rect = rectOf(cell, area);
      sizes[cell.view] = { width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) };
    }
  }

  // ---------------------------------------------------------------- drawing

  /**
   * One frame: every pane in turn, each into its own rectangle.
   *
   * The order inside a pane is map, then compass over the corner with the depth buffer cleared. The
   * viewport and the scissor are set to the same rectangle both times — the viewport is what the
   * projection is stretched across, the scissor is what may be written to, and a compass drawn without the
   * second would clear the pane it is standing in.
   */
  function draw(renderer: THREE.WebGPURenderer): void {
    for (const cell of panes.cells) {
      const rect = rectOf(cell, area);
      if (rect.width <= 0 || rect.height <= 0) continue;
      const view = views[cell.view];
      const camera = cameras[cell.view];
      const size = { width: rect.width, height: rect.height };
      sizes[cell.view] = size;

      applyCamera(camera, view, size);
      rs.grid.reach.value = gridReach(view);
      placeGridPlane(rs.gridPlane, view, size);
      layoutLabels(rs.labels, camera, rect.height);

      // the canvas counts up from the bottom, the layout counts down from the top
      const bottom = area.height - rect.top - rect.height;
      renderer.autoClear = true;
      renderer.setViewport(rect.left, bottom, rect.width, rect.height);
      renderer.setScissor(rect.left, bottom, rect.width, rect.height);
      renderer.render(rs.scene, camera);

      const dial = Math.min(84, Math.floor(Math.min(rect.width, rect.height) * 0.4));
      if (dial >= 44) {
        updateCompass(compass, camera, dial);
        renderer.autoClear = false;
        renderer.setViewport(rect.left + rect.width - dial - 6, bottom + 6, dial, dial);
        renderer.setScissor(rect.left + rect.width - dial - 6, bottom + 6, dial, dial);
        renderer.clearDepth();
        renderer.render(compass.scene, compass.camera);
      }
    }
  }

  // ---------------------------------------------------------------- picking

  /** what is under the pointer, at most once a frame and only when the pointer or the view has moved */
  async function hover(renderer: THREE.WebGPURenderer): Promise<void> {
    if (picking || drag || splitting) return;
    if (!pointer) return;
    const at = pointer;
    if (picked && picked.view === at.view && picked.x === at.x && picked.y === at.y && !moved) return;
    picked = at;
    moved = false;
    picking = true;
    try {
      const found = await pickAt(renderer, picker, rs, cameras[at.view], at.x, at.y, sizes[at.view]);
      const id = found.ordinal === undefined ? undefined : idOf(rs.brushes, found.ordinal);
      if (setHover(rs, id ? { node: id, face: found.face } : undefined)) syncScene(rs, session.editor);
      const says = id ? `${id} · face ${found.face}` : "";
      if (readout[at.view] !== says) readout = { ...readout, [at.view]: says };
    } finally {
      picking = false;
    }
  }

  // ---------------------------------------------------------------- framing

  /** the box around the selection, or around everything drawn when nothing is selected */
  function focusBox(): Bounds | undefined {
    const editor = session.editor;
    let box: Bounds | undefined;
    for (const id of editor.selection.nodes) {
      const node = nodeById(editor.world, id);
      const own = node && nodeBounds(node);
      if (own) box = box ? union(box, own) : own;
    }
    if (box) return box;
    const all = sceneBounds(rs);
    return Number.isFinite(all.min[0]) ? all : undefined;
  }

  function frame(kinds: ViewKind[], box = focusBox()): void {
    measure();
    for (const kind of kinds) views[kind] = frameView(views[kind], box, sizes[kind]);
    moved = true;
  }

  const frameAll = () => frame(VIEW_KINDS, allBox());

  const allBox = (): Bounds | undefined => {
    const box = sceneBounds(rs);
    return Number.isFinite(box.min[0]) ? box : undefined;
  };

  // ---------------------------------------------------------------- pointer

  const at = (event: PointerEvent | WheelEvent) => {
    const box = host.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    return { x, y, fx: x / Math.max(box.width, 1), fy: y / Math.max(box.height, 1) };
  };

  function paneAt(fx: number, fy: number): { cell: Cell; left: number; top: number } | undefined {
    const cells = panes.cells;
    const found = cellAt(cells, { x: fx, y: fy });
    if (found < 0) return undefined;
    const cell = cells[found]!;
    const rect = rectOf(cell, area);
    return { cell, left: rect.left, top: rect.top };
  }

  /** the splitter within a few pixels of a point, which is what makes one grabbable at all */
  function splitterAt(x: number, y: number): "x" | "y" | undefined {
    const grab = 5;
    for (const s of panes.splitters) {
      if (s.axis === "x") {
        const line = s.x * area.width;
        if (Math.abs(x - line) <= grab && y >= s.y * area.height && y <= (s.y + s.h) * area.height) return "x";
      } else {
        const line = s.y * area.height;
        if (Math.abs(y - line) <= grab && x >= s.x * area.width && x <= (s.x + s.w) * area.width) return "y";
      }
    }
    return undefined;
  }

  /**
   * Which navigation a button starts.
   *
   * The left button is not one of them, in any pane. It belongs to the tools — select, move, clip — and an
   * editor where navigation and editing share a button is one where every mis-aimed drag moves a wall.
   */
  function modeFor(kind: ViewKind, event: PointerEvent): Mode | undefined {
    if (event.button === 1) return "pan";
    if (event.button !== 2) return undefined;
    if (kind !== "3d") return "pan";
    return event.altKey ? "orbit" : "look";
  }

  function onPointerDown(event: PointerEvent): void {
    const p = at(event);
    const splitter = splitterAt(p.x, p.y);
    if (splitter && event.button === 0) {
      splitting = splitter;
      host.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const found = paneAt(p.fx, p.fy);
    if (!found) return;
    panes.active = found.cell.view;
    const mode = modeFor(found.cell.view, event);
    if (!mode) return;
    drag = { view: found.cell.view, mode, x: event.clientX, y: event.clientY };
    host.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    const p = at(event);

    if (splitting) {
      panes.setSplit(splitting === "x" ? { x: p.fx } : { y: p.fy });
      measure();
      moved = true;
      return;
    }

    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      const kind = drag.view;
      const view = views[kind];
      views[kind] =
        drag.mode === "pan"
          ? panView(view, dx, dy, sizes[kind])
          : drag.mode === "orbit"
            ? orbitView(view, dx, dy)
            : lookView(view, dx, dy);
      moved = true;
      return;
    }

    const splitter = splitterAt(p.x, p.y);
    cursor = splitter === "x" ? "col-resize" : splitter === "y" ? "row-resize" : "default";

    const found = paneAt(p.fx, p.fy);
    if (!found) {
      leave();
      return;
    }
    // the pane the mouse is in is the one a key press means, which is how `F` frames what you are looking at
    panes.active = found.cell.view;
    pointer = { view: found.cell.view, x: p.x - found.left, y: p.y - found.top };
  }

  function onPointerUp(event: PointerEvent): void {
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    if (splitting) {
      splitting = undefined;
      return;
    }
    if (drag) {
      drag = undefined;
      return;
    }
    // Selection on click, still in the crudest possible form — M8 replaces this with the select tool.
    if (event.button !== 0 || !rs.hover) return;
    const id = rs.hover.node;
    session.set((e) => ({
      ...e,
      selection: selectNodes(e.world, e.selection, [id], event.shiftKey ? "toggle" : "replace", e.open),
    }));
  }

  function leave(): void {
    pointer = undefined;
    if (setHover(rs, undefined)) syncScene(rs, session.editor);
    if (Object.values(readout).some(Boolean)) readout = {};
  }

  function onWheel(event: WheelEvent): void {
    const p = at(event);
    const found = paneAt(p.fx, p.fy);
    if (!found) return;
    event.preventDefault();
    const kind = found.cell.view;
    views[kind] = zoomView(views[kind], -Math.sign(event.deltaY), sizes[kind], {
      x: p.x - found.left,
      y: p.y - found.top,
    });
    moved = true;
  }

  // ---------------------------------------------------------------- the keyboard

  /**
   * Flying, in metres a second scaled to how much of the world is on screen.
   *
   * A fixed speed is unusable: the same key that crosses a corridor in a second takes a minute to cross a
   * level. Scaling by the reach means "one press moves me a visible amount" at every scale, which is the
   * only rule that holds from a doorframe to a skybox.
   */
  function fly(dt: number): void {
    if (held.size === 0 || dt === 0) return;
    const kind = panes.active;
    const view = views[kind];
    if (view.kind !== "3d") return;
    const step = Math.max(0.5, view.reach * 0.9) * dt;
    const along = { right: 0, up: 0, forward: 0 };
    if (held.has("w")) along.forward += step;
    if (held.has("s")) along.forward -= step;
    if (held.has("d")) along.right += step;
    if (held.has("a")) along.right -= step;
    if (held.has("e")) along.up += step;
    if (held.has("q")) along.up -= step;
    if (!along.right && !along.up && !along.forward) return;
    views[kind] = flyView(view, along);
    moved = true;
  }

  const typing = (event: KeyboardEvent): boolean => {
    const target = event.target as HTMLElement | null;
    return target?.isContentEditable === true || target instanceof HTMLInputElement;
  };

  function onKeydown(event: KeyboardEvent): void {
    if (typing(event)) return;
    const key = event.key.toLowerCase();

    if ((event.ctrlKey || event.metaKey) && "1234".includes(key)) {
      panes.setLayout(LAYOUTS[Number(key) - 1]!);
      measure();
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey) return;

    if (key === " ") {
      panes.toggleMaximised();
      measure();
      moved = true;
      event.preventDefault();
      return;
    }
    if (key === "f") {
      // shift frames every pane at once, which is how you get four views back onto the same thing
      frame(event.shiftKey ? panes.shown : [panes.active]);
      event.preventDefault();
      return;
    }
    if ("wasdqe".includes(key) && key.length === 1) {
      held.add(key);
      event.preventDefault();
    }
  }

  const onKeyup = (event: KeyboardEvent) => held.delete(event.key.toLowerCase());
  const onBlur = () => held.clear();
</script>

<svelte:window onkeydown={onKeydown} onkeyup={onKeyup} onblur={onBlur} />

<div
  class="views"
  bind:this={host}
  style:cursor
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointerleave={leave}
  onwheel={onWheel}
  oncontextmenu={(e) => e.preventDefault()}
  role="presentation"
>
  <canvas bind:this={canvas}></canvas>

  {#each panes.cells as cell (cell.view)}
    <div
      class="pane"
      class:active={panes.active === cell.view}
      style:left="{cell.x * 100}%"
      style:top="{cell.y * 100}%"
      style:width="{cell.w * 100}%"
      style:height="{cell.h * 100}%"
    >
      <span class="title">{VIEW_TITLES[cell.view]}</span>
      {#if readout[cell.view]}<span class="over">{readout[cell.view]}</span>{/if}
    </div>
  {/each}

  {#if status}<div class="status">{status}</div>{/if}
  {#if backend}<span class="backend">{backend}</span>{/if}
</div>

<style>
  .views { position: relative; width: 100%; height: 100%; overflow: hidden; touch-action: none; }
  canvas { display: block; width: 100%; height: 100%; }
  .pane {
    position: absolute; pointer-events: none; box-sizing: border-box;
    border: 1px solid #24272c;
    font: 11px ui-monospace, monospace; color: #6d7480;
  }
  .pane.active { border-color: #3d4653; }
  .title { position: absolute; left: 7px; top: 5px; }
  .over { position: absolute; left: 7px; bottom: 5px; color: #9aa1ac; }
  .status { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
  .backend {
    position: absolute; right: 8px; top: 5px; pointer-events: none;
    font: 11px ui-monospace, monospace; color: #4d545e;
  }
</style>
