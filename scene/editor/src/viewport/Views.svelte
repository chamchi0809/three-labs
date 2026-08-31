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
  import { idOf, meetSolid } from "../render/batch.ts";
  import { newCompass, updateCompass } from "../render/compass.ts";
  import { look } from "../render/look.svelte.ts";
  import { COLOURS } from "../render/materials.ts";
  import { newPicker, pickAt } from "../render/pick.ts";
  import {
    clearDecor, newRenderScene, sceneBounds, setDecor, setHover, setHoverHandle, syncHandles, syncLook,
    syncScene,
  } from "../render/scene.ts";
  import { bakery } from "../bake/bake.svelte.ts";
  import { keys } from "../keys/keys.svelte.ts";
  import { FLY_KEYS, keyOf } from "../keys/keymap.ts";
  import { library } from "../library.svelte.ts";
  import { prefs } from "../ui/prefs.svelte.ts";
  import { perf } from "./perf.ts";
  import { layoutLabels } from "../render/text.ts";
  import type { Bounds } from "../brush/builder.ts";
  import { nodeById, nodeBounds, union } from "../doc/document.ts";
  import { selectionBounds } from "../doc/selection.ts";
  import { session } from "../session.svelte.ts";
  import { meetPlane } from "../tools/drag.ts";
  import { newInput, type Hit, type InputState } from "../tools/input.ts";
  import type { Outcome, ToolId } from "../tools/tool.ts";
  import { tools } from "../tools/tools.svelte.ts";
  import { applyCamera, gridReach, newCamera, placeGridPlane, type ViewCamera } from "./camera.ts";
  import { LAYOUTS, cellAt, rectOf, type Cell } from "./layout.ts";
  import { boundsGuides, type Guide } from "./measure.ts";
  import { panes, views } from "./views.svelte.ts";
  import {
    VIEW_KINDS, VIEW_TITLES, flyView, frameView, lookView, orbitView, panView, rayThrough, zoomView,
    type Size, type ViewKind,
  } from "./view.ts";

  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let status = $state("initializing…");
  let backend = $state("");
  let cursor = $state("default");
  let readout = $state<Record<string, string>>({});
  /** the dimension overlay, per pane — see `measure.ts` for what one of these is */
  let guides = $state<Partial<Record<ViewKind, Guide[]>>>({});
  /** what a gesture in progress is doing, pinned to the cursor that is doing it */
  let gauge = $state<{ view: ViewKind; x: number; y: number; text: string } | undefined>();

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

  /**
   * The field of view is written into the views themselves rather than onto the cameras.
   *
   * A camera whose fov the preference set directly would look right and pick wrong: `rayThrough` and
   * `pixelSize` work the angle out from the view, and the two would disagree by however much the
   * preference had moved. One number, in one place, and the camera follows it like everything else does.
   */
  $effect(() => {
    const fov = prefs.fov;
    for (const kind of VIEW_KINDS) {
      const view = views[kind];
      if (view.kind === "3d" && view.fov !== fov) views[kind] = { ...view, fov };
    }
    moved = true;
  });

  type Mode = "pan" | "orbit" | "look";
  let drag: { view: ViewKind; mode: Mode; x: number; y: number } | undefined;
  /**
   * The pane a left press landed in, and where its corner is.
   *
   * Kept for the whole gesture rather than looked up per move, because a drag that started in the top
   * pane and wandered into the side one is still a drag in the top pane — the pointer is captured, and
   * re-deriving the pane every frame would make a tool change its mind halfway through.
   */
  let toolPane: { view: ViewKind; left: number; top: number } | undefined;
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
        syncScene(rs, session.editor, tools.box.dragging);
        frameAll();
        backend = forceWebGL ? "WebGL" : "WebGPU";
        status = "";

        // the same development-only handle `main.ts` opens on the document, opened on the picture. "Is that
        // wall black because it is unlit or because its material came out wrong" is not a question a
        // screenshot answers, and it is one a console with the renderer in it answers in a line. It earned
        // its keep the first time it was used: `renderer.debug.getShaderAsync` through this handle is what
        // found the conditional scope that `height.ts` now goes out of its way to avoid.
        if (import.meta.env.DEV) Object.assign(globalThis, { broomView: { rs, renderer, cameras, views } });

        renderer.setAnimationLoop((now) => {
          const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
          last = now;
          perf.frame(now);
          fly(dt);
          perf.time("draw", () => draw(renderer));
          // after the draw, because `draw` is what settles each pane's size and camera for this frame — the
          // overlay has to be measured against the same ones the picture was drawn with or it lags by one
          perf.time("overlay", remeasure);
          void hover(renderer);
          // three's counters are per-frame and it resets them itself, so they are read after the drawing
          // and before anything else has a chance to add to them
          perf.counted({
            drawCalls: renderer.info.render.drawCalls,
            triangles: renderer.info.render.triangles,
            geometries: renderer.info.memory.geometries,
            textures: renderer.info.memory.textures,
          });
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
      perf.reset();
    };
  });

  // The scene follows the document; the diff inside `syncScene` is what keeps that cheap. Timed, because
  // "cheap" is a claim and this is the one place in the editor that can check it.
  $effect(() => {
    perf.time("sync", () => {
      syncScene(rs, session.editor, tools.box.dragging);
      syncHandles(rs, session.editor, tools.current.handles);
    });
    moved = true;
  });

  // The look gets an effect of its own rather than a line inside the one above, because hovering a wall
  // runs `syncScene` sixty times a second and rebuilding the map's materials at that rate would recompile
  // every shader in the level between two mouse positions. `syncLook` guards both halves on identity, so
  // this being reached often is fine and this being *in* the hot path would not be.
  $effect(() => {
    syncLook(rs, session.editor, library.catalogue, look.current);
    moved = true;
  });

  // A layout change moves every pane, so what is under the pointer is no longer what it was.
  $effect(() => {
    void panes.cells;
    moved = true;
  });

  /**
   * The baked preview, standing in for the map.
   *
   * `visible = false` rather than removing the world group: the batch, the palette and every buffer in
   * them stay exactly as they are, so coming back out of the preview is one flag rather than a rebuild of
   * the level. The lights go with it — the preview carries the sheet's own, zeroed by the atlas that
   * already contains them, and the editor's rig shining through would light the room twice.
   */
  $effect(() => {
    const preview = bakery.preview;
    rs.world.visible = !preview;
    rs.overlays.visible = !preview;
    rs.lights.visible = !preview;
    moved = true;
    if (!preview) return;
    rs.scene.add(preview.group);
    return () => {
      rs.scene.remove(preview.group);
      moved = true;
    };
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
      if (prefs.gridPlane) placeGridPlane(rs.gridPlane, view, size);
      else rs.gridPlane.visible = false;
      layoutLabels(rs.labels, camera, rect.height);

      // `Renderer` measures a viewport from the *top* left, unlike the old `WebGLRenderer` — both of its
      // backends flip for themselves on the way to the API underneath (`WebGLBackend.updateViewport` calls
      // `gl.viewport(x, height - h - y, …)`, the WebGPU one passes y straight through to a top-down pass).
      // So a rectangle measured from the top is handed over as it stands; flipping it here as well drew
      // every pane into the one mirrored across the middle of the canvas.
      renderer.autoClear = true;
      renderer.setViewport(rect.left, rect.top, rect.width, rect.height);
      renderer.setScissor(rect.left, rect.top, rect.width, rect.height);
      renderer.render(rs.scene, camera);

      const dial = Math.min(84, Math.floor(Math.min(rect.width, rect.height) * 0.4));
      if (prefs.compass && dial >= 44) {
        updateCompass(compass, camera, dial);
        const corner = { x: rect.left + rect.width - dial - 6, y: rect.top + rect.height - dial - 6 };
        renderer.autoClear = false;
        renderer.setViewport(corner.x, corner.y, dial, dial);
        renderer.setScissor(corner.x, corner.y, dial, dial);
        renderer.clearDepth();
        renderer.render(compass.scene, compass.camera);
      }
    }
  }

  // ---------------------------------------------------------------- measuring

  /** what the overlay last showed, so a frame that measures the same thing does not touch the DOM */
  let measured = "";

  /**
   * The dimension overlay, remade after every frame.
   *
   * Every frame, because the thing it measures moves: a drag rewrites the world sixty times a second and
   * the whole point of the overlay is that the numbers move with it. What it must not do is push sixty DOM
   * updates a second through Svelte when *nothing* moved, so the result is compared against the last one and
   * the reactive assignment only happens when it differs. Serialising a handful of guides to compare them is
   * a few microseconds; a spurious re-render of four `<svg>` subtrees is not.
   *
   * The selection is what gets measured, which is also what makes a drag measured for free — every tool that
   * creates or moves something leaves it selected, so dragging a shape out shows the shape's size growing
   * rather than needing the shape tool to report anything.
   */
  function remeasure(): void {
    const box = prefs.measure ? selectionBounds(session.editor.world, session.editor.selection) : undefined;
    const next: Partial<Record<ViewKind, Guide[]>> = {};
    if (box) {
      for (const cell of panes.cells) {
        const found = boundsGuides(box, views[cell.view], sizes[cell.view]);
        if (found.length) next[cell.view] = found;
      }
    }

    const key = JSON.stringify(next);
    if (key === measured) return;
    measured = key;
    guides = next;
  }

  // ---------------------------------------------------------------- picking

  /**
   * What one pane says is under the pointer.
   *
   * Written through here rather than assigned, because only one pane can have the pointer and the readouts
   * of the others have to go with it. A label left behind in the pane the mouse came from claims that pane
   * is hovering something, and two panes hovering at once is a thing that cannot happen.
   */
  function says(view: ViewKind, what: string): void {
    if (readout[view] === what && Object.keys(readout).every((k) => k === view || !readout[k])) return;
    readout = what ? { [view]: what } : {};
  }

  /** what is under the pointer, at most once a frame and only when the pointer or the view has moved */
  async function hover(renderer: THREE.WebGPURenderer): Promise<void> {
    // A gesture in progress is not hovering anything. `toolPane` belongs in this list as much as `drag`
    // does: a tool drag moves the pointer every frame, so every frame paid for a pick pass — a second
    // render of the whole map, a GPU readback to wait on, and a `syncScene` whenever the answer changed —
    // all to highlight something the gesture is not going to act on, because tools read the hit they took
    // at press time. Dragging a shape out was several times slower than it had any reason to be.
    if (picking || drag || splitting || toolPane) return;
    // the preview is a picture, not the map: the batch it would pick against is not being drawn, so every
    // pass would come back empty and spend a GPU round trip finding that out
    if (bakery.preview) return;
    if (!pointer) return;
    const at = pointer;
    if (picked && picked.view === at.view && picked.x === at.x && picked.y === at.y && !moved) return;
    picked = at;
    moved = false;
    picking = true;
    // timed around the await rather than through `perf.time`, because what a pick costs is mostly the wait
    // for the GPU to answer, and a span that stopped at the first `await` would report it as free
    const began = performance.now();
    try {
      // handles are only asked about when the active tool draws some, so the select tool never pays for a
      // second pass and a stray corner can never take a click away from the solid it belongs to
      const found = await pickAt(renderer, picker, rs, cameras[at.view], at.x, at.y, sizes[at.view], {
        handles: Boolean(tools.current.handles),
      });

      if (found.handle) {
        if (setHover(rs, undefined)) syncScene(rs, session.editor, tools.box.dragging);
        setHoverHandle(rs, rs.handles.handles.indexOf(found.handle));
        says(at.view, `${found.handle.kind} of ${found.handle.of}`);
        return;
      }

      setHoverHandle(rs, undefined);
      const id = found.ordinal === undefined ? undefined : idOf(rs.brushes, found.ordinal);
      const hovering = id ? { node: id, face: found.face } : undefined;
      if (setHover(rs, hovering)) syncScene(rs, session.editor, tools.box.dragging);
      says(at.view, id ? `${id} · face ${found.face}` : "");
    } finally {
      picking = false;
      perf.span("pick", performance.now() - began);
    }
  }

  // ---------------------------------------------------------------- the tools

  /**
   * What the last pick pass found, in the shape a tool reads.
   *
   * The pick answers with a solid and a face; the world point is worked out here by meeting the pointer
   * ray with that face's own plane. Exact, free, and it avoids the alternative — reading the depth buffer
   * back, which is another asynchronous round trip in the middle of a gesture that has to feel immediate.
   */
  function hitOf(kind: ViewKind, x: number, y: number): Hit | undefined {
    // a handle answers alone and answers first: it is drawn over the map and it is what the gesture aimed
    // at, so reporting the wall behind it would move the whole solid instead of the corner
    const handle = rs.hoverHandle === undefined ? undefined : rs.handles.handles[rs.hoverHandle];
    if (handle) {
      return {
        handle,
        node: handle.of,
        face: handle.kind === "face" ? handle.part : undefined,
        point: [handle.at[0], handle.at[1], handle.at[2]],
      };
    }

    const found = rs.hover;
    if (!found) return undefined;
    const node = nodeById(session.editor.world, found.node);
    const face = found.face;
    // a patch is a curved surface with no plane to meet, so the point comes from the triangles it was drawn
    // as — which is the same geometry the pick just read, so the two cannot disagree about where it is
    if (node?.kind === "patch") {
      const point = meetSolid(rs.brushes, node.id, rayThrough(views[kind], { x, y }, sizes[kind]));
      return point ? { node: found.node, face, point } : { node: found.node, face };
    }
    if (node?.kind !== "brush" || face === undefined) return { node: found.node, face };
    const plane = node.brush.poly.faces[face]?.plane;
    if (!plane) return { node: found.node, face };
    const origin: [number, number, number] = [plane.n[0] * plane.d, plane.n[1] * plane.d, plane.n[2] * plane.d];
    const point = meetPlane(rayThrough(views[kind], { x, y }, sizes[kind]), { origin, normal: plane.n });
    return { node: found.node, face, point };
  }

  const inputAt = (kind: ViewKind, x: number, y: number, event: PointerEvent | KeyboardEvent): InputState =>
    newInput({
      camera: views[kind],
      size: sizes[kind],
      at: { x, y },
      mods: { shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey, alt: event.altKey },
      button: "button" in event ? event.button : undefined,
      hit: hitOf(kind, x, y),
    });

  /**
   * The input a key press means.
   *
   * The pointer if it is in a pane, and the middle of the active pane if it is not — because a keyboard
   * command that stops working when the mouse is over the tool bar is a keyboard command with a bug.
   */
  function inputFor(event: KeyboardEvent): InputState {
    if (pointer) return inputAt(pointer.view, pointer.x, pointer.y, event);
    const kind = panes.active;
    const size = sizes[kind];
    return inputAt(kind, size.width / 2, size.height / 2, event);
  }

  /** an outcome carried out: everything but the lines, which are the only part this file owns */
  function run(outcome: Outcome | undefined): boolean {
    const decor = tools.apply(outcome);
    if (decor) {
      for (const [key, segments] of Object.entries(decor)) {
        setDecor(rs, key, segments ?? new Float32Array(0));
      }
      moved = true;
    }
    return outcome !== undefined;
  }

  // a tool change puts back whatever the last one was drawing, and changes which handles are shown
  $effect(() => {
    void tools.current;
    clearDecor(rs);
    syncHandles(rs, session.editor, tools.current.handles);
    moved = true;
  });

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

    if (event.button === 0) {
      // the tools own the left button; the pointer is captured so a drag survives leaving the pane
      toolPane = { view: found.cell.view, left: found.left, top: found.top };
      run(tools.box.down(inputAt(found.cell.view, p.x - found.left, p.y - found.top, event), session.editor));
      host.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

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

    if (toolPane) {
      pointer = { view: toolPane.view, x: p.x - toolPane.left, y: p.y - toolPane.top };
      run(tools.box.move(inputAt(toolPane.view, pointer.x, pointer.y, event), session.editor));
      // the status line already says this; saying it again at the cursor is what stops a designer looking
      // away from the thing they are dragging in order to find out how big it is
      const text = session.editor.note ?? "";
      gauge = text ? { view: pointer.view, x: pointer.x, y: pointer.y, text } : undefined;
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
    run(tools.box.move(inputAt(pointer.view, pointer.x, pointer.y, event), session.editor));
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
    if (toolPane) {
      const pane = toolPane;
      toolPane = undefined;
      gauge = undefined;
      const p = at(event);
      run(tools.box.up(inputAt(pane.view, p.x - pane.left, p.y - pane.top, event), session.editor));
      // the pick that was skipped for the whole gesture: what is under the cursor now is very likely not
      // what was under it when the button went down
      moved = true;
    }
  }

  function leave(): void {
    pointer = undefined;
    gauge = undefined;
    setHoverHandle(rs, undefined);
    if (setHover(rs, undefined)) syncScene(rs, session.editor, tools.box.dragging);
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
    const step = Math.max(0.5, view.reach * 0.9) * dt * prefs.flySpeed;
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

  /** the half of the keymap a pane owns: the layouts, framing, and which tool is in hand */
  function runView(id: string): boolean {
    if (id.startsWith("tool.")) {
      tools.use(id.slice("tool.".length) as ToolId);
      return true;
    }
    const layout = LAYOUTS[Number(id.slice("view.layout".length)) - 1];
    if (id.startsWith("view.layout") && layout) {
      panes.setLayout(layout);
      measure();
      return true;
    }
    if (id === "view.maximise") {
      panes.toggleMaximised();
      measure();
      moved = true;
      return true;
    }
    // shift frames every pane at once, which is how you get four views back onto the same thing
    if (id === "view.frame") return frame([panes.active]), true;
    if (id === "view.frameAll") return frame(panes.shown), true;
    return false;
  }

  /**
   * The viewport's keys.
   *
   * `App.svelte` binds window first and answers the document half; a press it took has already been
   * `preventDefault`ed, and that is what this reads to stay out of the way. Escape is the interesting case:
   * it means "leave the group" only once there is nothing selected, so while there is a selection the
   * document declines it and it arrives here, where the tool drops the selection instead.
   */
  function onKeydown(event: KeyboardEvent): void {
    if (typing(event) || event.defaultPrevented) return;
    const key = keyOf(event);

    const command = keys.commandFor(event);
    if (command && runView(command)) {
      event.preventDefault();
      return;
    }

    // a ctrl combo still reaches the tool — ctrl-a is the select tool's "everything" — but nothing else,
    // and never a chord the keymap has already spoken for
    if (event.ctrlKey || event.metaKey) {
      if (!command && run(tools.box.press(key, inputFor(event), session.editor))) event.preventDefault();
      return;
    }

    // the tool's own keys, which are not in the keymap: they are the tool's, they change with it, and
    // several tools spell the same letter differently. `FLY_KEYS` is what keeps flying out of their reach —
    // the keymap drops a reserved chord and `tools.check.ts` refuses a tool that claims one
    if (run(tools.box.press(key, inputFor(event), session.editor))) {
      event.preventDefault();
      return;
    }

    if ((FLY_KEYS as readonly string[]).includes(key)) {
      held.add(key);
      event.preventDefault();
    }
  }

  const onKeyup = (event: KeyboardEvent) => held.delete(keyOf(event));
  const onBlur = () => held.clear();

  // ---------------------------------------------------------------- drawing the overlay

  /** each axis in the colour the compass already taught the eye to read it as */
  const AXIS_INK = [COLOURS.axisX, COLOURS.axisY, COLOURS.axisZ].map(
    (c) => `#${c.toString(16).padStart(6, "0")}`,
  );

  /** half a tick cap: perpendicular to the guide, so the two ends of a measurement are visibly its ends */
  function capOf(guide: Guide): { x: number; y: number } {
    const dx = guide.to.x - guide.from.x;
    const dy = guide.to.y - guide.from.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: (-dy / length) * 4, y: (dx / length) * 4 };
  }
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

      {#if guides[cell.view]}
        <!--
          The dimension overlay. SVG rather than lines in the scene, because a measurement is a screen-space
          thing: the tick caps are the same length however far away the box is, the number is the same size,
          and neither is occluded by the solid it is measuring. Putting it in the world would mean fighting
          the depth buffer to say something the depth buffer has no opinion about.
        -->
        <svg class="guides" viewBox="0 0 {sizes[cell.view].width} {sizes[cell.view].height}">
          {#each guides[cell.view]! as guide, i (i)}
            {@const tick = capOf(guide)}
            <g style:color={AXIS_INK[guide.axis]}>
              <line x1={guide.from.x} y1={guide.from.y} x2={guide.to.x} y2={guide.to.y} />
              <line
                x1={guide.from.x - tick.x} y1={guide.from.y - tick.y}
                x2={guide.from.x + tick.x} y2={guide.from.y + tick.y}
              />
              <line
                x1={guide.to.x - tick.x} y1={guide.to.y - tick.y}
                x2={guide.to.x + tick.x} y2={guide.to.y + tick.y}
              />
              <text x={guide.at.x} y={guide.at.y}>{guide.label}</text>
            </g>
          {/each}
        </svg>
      {/if}

      {#if gauge?.view === cell.view}
        <span class="gauge" style:left="{gauge.x + 16}px" style:top="{gauge.y + 16}px">{gauge.text}</span>
      {/if}
      {#if tools.band?.view === cell.view}
        <!-- the rubber band is measured in pixels and has no depth, so it is a div and not geometry -->
        <div
          class="band"
          style:left="{tools.band.rect.left}px"
          style:top="{tools.band.rect.top}px"
          style:width="{tools.band.rect.right - tools.band.rect.left}px"
          style:height="{tools.band.rect.bottom - tools.band.rect.top}px"
        ></div>
      {/if}
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
    border: 1px solid var(--p2);
    font: var(--mono); color: var(--dim);
  }
  /* the active pane is outlined in the accent: which pane a key goes to is the one thing about this
     layout a designer has to be able to see without looking for it */
  .pane.active { border-color: var(--accent); }
  .title { position: absolute; left: 7px; top: 5px; }
  .over { position: absolute; left: 7px; bottom: 5px; color: var(--text); }
  .band {
    position: absolute; pointer-events: none;
    border: 1px solid var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .guides { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
  .guides line { stroke: currentColor; stroke-width: 1; opacity: 0.85; }
  .guides text {
    fill: currentColor; font: 11px ui-monospace, monospace;
    text-anchor: middle; dominant-baseline: middle;
    /* the numbers are read against a lit map, an unlit one and the grid; a dark halo works on all three */
    paint-order: stroke; stroke: var(--p0); stroke-width: 3px; stroke-linejoin: round;
  }
  .gauge {
    position: absolute; pointer-events: none; white-space: nowrap;
    padding: 2px 6px; border-radius: 5px;
    background: color-mix(in srgb, var(--p0) 85%, transparent);
    color: var(--p9); border: 1px solid var(--border);
  }
  .status { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
  .backend {
    position: absolute; right: 8px; top: 5px; pointer-events: none;
    font: var(--mono); color: var(--dim);
  }
</style>
