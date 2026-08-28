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
 */
import {
  Color, NearestFilter, RenderTarget, UnsignedByteType, type Camera, type Renderer,
} from "three/webgpu";
import { decodePick, handlePickMaterial, pickMaterial } from "./materials.ts";
import { handleAt, type Handle } from "./handles.ts";
import type { RenderScene } from "./scene.ts";

export type Picker = {
  target: RenderTarget;
  /** the materials swapped in for the pass, made once — compiling a shader per click is not an option */
  face: ReturnType<typeof pickMaterial>;
  handle: ReturnType<typeof handlePickMaterial>;
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
  return { target, face: pickMaterial(), handle: handlePickMaterial(), proxies: new WeakMap() };
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

  if (options.handles && rs.handles.count > 0) {
    const found = await pass(renderer, picker, rs, camera, x, y, size, "handles");
    const handle = handleAt(rs.handles, found.ordinal);
    if (handle) return { handle };
  }

  const found = await pass(renderer, picker, rs, camera, x, y, size, "faces");
  return found.ordinal > 0 ? { ordinal: found.ordinal, face: found.face } : {};
}

/**
 * One pass of one thing.
 *
 * Everything is put back afterwards — the materials, the visibility, the render target and the camera's
 * view offset. A pick happens in the middle of a frame the user is looking at, and a pass that left any of
 * that changed would be visible as a flicker.
 */
async function pass(
  renderer: Renderer,
  picker: Picker,
  rs: RenderScene,
  camera: Camera,
  x: number,
  y: number,
  size: { width: number; height: number },
  what: "faces" | "handles",
): Promise<{ ordinal: number; face: number }> {
  const shown = {
    faces: rs.faceMesh.visible,
    edges: rs.edgeLines.visible,
    decor: rs.decorLines.visible,
    handles: rs.handlePoints.visible,
    labels: rs.labels.group.visible,
    grid: rs.gridPlane.visible,
  };
  const faceMaterial = rs.faceMesh.material;
  const handleMaterial = rs.handlePoints.material;

  rs.faceMesh.visible = what === "faces";
  rs.handlePoints.visible = what === "handles";
  // lines and text write no identity, and a line drawn over a face would occlude what the face said. The
  // grid backdrop is worse than that: it covers the whole pane and would answer every pick with a colour.
  rs.edgeLines.visible = false;
  rs.decorLines.visible = false;
  rs.labels.group.visible = false;
  rs.gridPlane.visible = false;
  rs.faceMesh.material = picker.face;
  rs.handlePoints.material = picker.handle;

  const proxy = proxyFor(picker, camera);
  narrow(proxy, size.width, size.height, Math.floor(x), Math.floor(y));

  const wasTarget = renderer.getRenderTarget();
  const wasClear = renderer.getClearColor(scratch).getHex();
  const wasAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(picker.target);
  renderer.setClearColor(0x000000, 1); // black is "nothing", which is why every id is one-based
  renderer.clear();
  renderer.render(rs.scene, proxy);

  const pixels = (await renderer.readRenderTargetPixelsAsync(picker.target, 0, 0, 1, 1)) as Uint8Array;

  renderer.setRenderTarget(wasTarget);
  renderer.setClearColor(wasClear, wasAlpha);
  rs.faceMesh.material = faceMaterial;
  rs.handlePoints.material = handleMaterial;
  rs.faceMesh.visible = shown.faces;
  rs.edgeLines.visible = shown.edges;
  rs.decorLines.visible = shown.decor;
  rs.handlePoints.visible = shown.handles;
  rs.labels.group.visible = shown.labels;
  rs.gridPlane.visible = shown.grid;

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
