/**
 * What is under the mouse.
 *
 * TrenchBroom ray-casts against its brush geometry. This editor renders instead: the pick pass draws the
 * map with a material that writes identity rather than colour, and a click reads back one pixel. Three
 * reasons that is the better answer here.
 *
 * It agrees with the picture *exactly*. A ray cast is a second implementation of what the rasteriser
 * already did, and the two disagree at silhouettes, on coplanar faces, and anywhere a shader moved a
 * vertex — which M12's height material is going to do constantly. A pixel read cannot disagree, because it
 * is the same triangles through the same matrices.
 *
 * It costs the same at any size. Ten solids and ten thousand are one draw call and one read.
 *
 * And it needs no acceleration structure to keep in step with edits. The octree in `doc/octree.ts` earns
 * its keep for box selection over the whole map; for "what is under this one pixel" it would be a second
 * thing to invalidate for no gain.
 *
 * The trick that makes it cheap is `setViewOffset`: the camera is told to render a one-pixel-wide window
 * of its own frustum, so the pick pass rasterises one pixel of the map rather than a whole frame of it.
 *
 * Handles are the exception, and are hit-tested on the CPU. None of the three reasons above applies to
 * them: a handle is a square of a known size around a point of a known position, so projecting the point
 * and measuring the distance *is* what the rasteriser would do, exactly, with no readback to wait for and
 * no second material to keep in step. There are a few hundred of them at most.
 */
import {
  Color, NearestFilter, RenderTarget, UnsignedByteType, Vector3, type Camera, type Renderer,
} from "three/webgpu";
import { decodePick, pickMaterial } from "./materials.ts";
import { HANDLE_REACH, type Handle, type HandleSet } from "./handles.ts";
import type { RenderScene } from "./scene.ts";

export type Picker = {
  target: RenderTarget;
  /** the material swapped in for the pass, made once — compiling a shader per click is not an option */
  face: ReturnType<typeof pickMaterial>;
  /**
   * A stand-in camera per real camera.
   *
   * The pass narrows the frustum to one pixel, and reading the result back is asynchronous — so the frame
   * loop gets to run while the narrowed camera is still narrowed. Doing it to a copy is what keeps a pick
   * from flashing a one-pixel view of the map across the pane it was taken in.
   */
  proxies: WeakMap<Camera, Camera>;
};

export function newPicker(): Picker {
  const target = new RenderTarget(1, 1, {
    depthBuffer: true,
    // nearest and unsigned-byte both matter: an identity that was filtered or tone-mapped is a different
    // identity, and every pixel written here is a number rather than a colour
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    type: UnsignedByteType,
    generateMipmaps: false,
  });
  return { target, face: pickMaterial(), proxies: new WeakMap() };
}

/** what a pick found: a solid and one of its faces, or one handle, or nothing at all */
export type Pick = {
  ordinal?: number;
  face?: number;
  handle?: Handle;
};

/**
 * The pick under a point, in CSS pixels from the top left of the viewport.
 *
 * Handles are asked about first and answered alone. They are drawn over everything and they are what a
 * drag would grab, so a handle in front of a wall must not report the wall — the alternative is a designer
 * aiming at a corner and moving the whole solid.
 */
export async function pickAt(
  renderer: Renderer,
  picker: Picker,
  rs: RenderScene,
  camera: Camera,
  x: number,
  y: number,
  size: { width: number; height: number },
  options: { handles?: boolean } = {},
): Promise<Pick> {
  if (size.width <= 0 || size.height <= 0) return {};

  if (options.handles) {
    const handle = handleUnder(rs.handles, camera, x, y, size);
    if (handle) return { handle };
  }

  const found = await pass(renderer, picker, rs, camera, x, y, size);
  return found.ordinal > 0 ? { ordinal: found.ordinal, face: found.face } : {};
}

/**
 * The handle nearest a point, if one is near enough to have been aimed at.
 *
 * Nearest rather than topmost: handles are drawn without depth, so "the one in front" is not a question the
 * picture answers, and the centre a designer aimed at is the one they meant. A handle outside the frustum
 * is skipped rather than measured — it was never drawn, so it cannot be what was clicked, and an ortho pane
 * projects things behind it to perfectly plausible pixels.
 */
export function handleUnder(
  set: HandleSet,
  camera: Camera,
  x: number,
  y: number,
  size: { width: number; height: number },
): Handle | undefined {
  let best: Handle | undefined;
  let nearest = HANDLE_REACH * HANDLE_REACH;
  for (let i = 0; i < set.count; i++) {
    at.set(set.position[i * 3]!, set.position[i * 3 + 1]!, set.position[i * 3 + 2]!).project(camera);
    if (at.z < -1 || at.z > 1) continue;
    const dx = (at.x * 0.5 + 0.5) * size.width - x;
    const dy = (-at.y * 0.5 + 0.5) * size.height - y;
    const away = dx * dx + dy * dy;
    if (away < nearest) {
      nearest = away;
      best = set.handles[i];
    }
  }
  return best;
}

/** somewhere to project into; hovering hit-tests every frame, and a hover should allocate nothing */
const at = /*@__PURE__*/ new Vector3();

/**
 * One pick pass.
 *
 * Everything is put back the instant the draw call is recorded — the material, the visibility, the render
 * target. A pick happens in the middle of a frame the user is looking at, and the scene is shared with the
 * loop that is drawing it, so the window in which it is dressed for picking has to be shorter than a frame.
 * The camera is the exception and needs no putting back: the pass narrows a private proxy, never the real
 * one, which is the whole reason {@link Picker.proxies} exists.
 */
async function pass(
  renderer: Renderer,
  picker: Picker,
  rs: RenderScene,
  camera: Camera,
  x: number,
  y: number,
  size: { width: number; height: number },
): Promise<{ ordinal: number; face: number }> {
  const shown = {
    faces: rs.faceMesh.visible,
    edges: rs.edgeLines.visible,
    decor: rs.decorLines.visible,
    handles: rs.handleMesh.visible,
    labels: rs.labels.group.visible,
    grid: rs.gridPlane.visible,
  };
  const faceMaterial = rs.faceMesh.material;

  rs.faceMesh.visible = true;
  // lines, handles and text write no identity, and any of them drawn over a face would occlude what the
  // face said. The grid backdrop is worse than that: it covers the whole pane and would answer every pick
  // with a colour.
  rs.edgeLines.visible = false;
  rs.decorLines.visible = false;
  rs.handleMesh.visible = false;
  rs.labels.group.visible = false;
  rs.gridPlane.visible = false;
  rs.faceMesh.material = picker.face;

  const proxy = proxyFor(picker, camera);
  narrow(proxy, size.width, size.height, Math.floor(x), Math.floor(y));

  const wasTarget = renderer.getRenderTarget();
  const wasClear = renderer.getClearColor(scratch).getHex();
  const wasAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(picker.target);
  renderer.setClearColor(0x000000, 1); // black is "nothing", which is why every id is one-based
  renderer.clear();
  renderer.render(rs.scene, proxy);

  // Put everything back *before* waiting for the pixel, not after. `render` has already read the material
  // and the visibility flags and recorded its commands, so the pass no longer needs them — but the readback
  // resolves a frame or more later, and the animation loop goes on drawing the whole time. Restoring after
  // the await meant every frame in that window drew the map in identity colours with no edges, no labels
  // and no grid, which is the flicker a moving cursor makes: the map blinks for as long as a hover lasts.
  renderer.setRenderTarget(wasTarget);
  renderer.setClearColor(wasClear, wasAlpha);
  rs.faceMesh.material = faceMaterial;
  rs.faceMesh.visible = shown.faces;
  rs.edgeLines.visible = shown.edges;
  rs.decorLines.visible = shown.decor;
  rs.handleMesh.visible = shown.handles;
  rs.labels.group.visible = shown.labels;
  rs.gridPlane.visible = shown.grid;

  const pixels = (await renderer.readRenderTargetPixelsAsync(picker.target, 0, 0, 1, 1)) as Uint8Array;
  return decodePick(pixels);
}

/**
 * The copy of a camera this picker renders through, made once per camera and kept.
 *
 * `copy` rather than `clone` so the proxy is the same object frame after frame — a pick that allocated a
 * camera would allocate one per frame, since hovering picks every frame the mouse is over a pane.
 */
function proxyFor(picker: Picker, camera: Camera): Camera {
  let proxy = picker.proxies.get(camera);
  if (!proxy) {
    proxy = (camera as Camera & { clone(): Camera }).clone();
    picker.proxies.set(camera, proxy);
  }
  proxy.copy(camera as never);
  return proxy;
}

/**
 * A camera told to render one pixel of its own frustum.
 *
 * Both projections have `setViewOffset` and both call `updateProjectionMatrix` themselves, but they do not
 * share a base class that says so — this is the one place that has to admit it, rather than every caller.
 */
function narrow(camera: Camera, width: number, height: number, x: number, y: number): void {
  const c = camera as unknown as {
    setViewOffset(full: number, fullHeight: number, x: number, y: number, w: number, h: number): void;
  };
  c.setViewOffset(width, height, x, y, 1, 1);
}

/** somewhere to put the clear colour while it is being saved; a pick allocates nothing per call */
const scratch = /*@__PURE__*/ new Color();
