/**
 * A {@link View} as a camera the renderer can be handed.
 *
 * The split is deliberate: `view.ts` is the model and knows no three.js, this is the adaptor and knows no
 * input. Everything here is assignment — the camera object is a cache of the view, rebuilt from it every
 * frame rather than being a second place the truth lives. That is what makes it safe for four panes to
 * share one scene: nothing about where a pane is looking survives outside its `View`.
 */
import { Matrix4, OrthographicCamera, PerspectiveCamera, Vector3, type Object3D } from "three/webgpu";
import { ORTHO_BACK, basisOf, eyeOf, type Size, type View, type ViewKind } from "./view.ts";

export type ViewCamera = PerspectiveCamera | OrthographicCamera;

export const newCamera = (kind: ViewKind): ViewCamera =>
  kind === "3d" ? new PerspectiveCamera(60, 1, 0.05, 2000) : new OrthographicCamera(-1, 1, 1, -1, 0.01, 4096);

/**
 * The camera brought up to date with the view and the pane it is drawn into.
 *
 * The near and far planes are derived from the reach rather than fixed, because a viewport that can be
 * inside a doorway one moment and holding a whole level the next cannot have one depth range that suits
 * both — a fixed near of 0.05 metres over a two-kilometre far plane is where z-fighting on coplanar faces
 * comes from, and coplanar faces are what brush editors are made of.
 */
export function applyCamera(camera: ViewCamera, view: View, size: Size): void {
  const aspect = size.width / Math.max(size.height, 1);
  const eye = eyeOf(view);
  const { up } = basisOf(view);

  if (camera instanceof PerspectiveCamera) {
    camera.fov = view.fov;
    camera.aspect = aspect;
    camera.near = Math.max(0.02, view.reach / 4000);
    camera.far = Math.max(1000, view.reach * 40);
    camera.up.set(0, 1, 0);
  } else {
    const halfHeight = view.reach / 2;
    const halfWidth = halfHeight * aspect;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.near = 0.01;
    camera.far = ORTHO_BACK * 4;
    camera.up.set(up[0], up[1], up[2]);
  }

  camera.position.set(eye[0], eye[1], eye[2]);
  camera.lookAt(target.set(view.target[0], view.target[1], view.target[2]));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

/**
 * How far the grid should still be drawn, in metres.
 *
 * The grid fades out towards the far plane so it does not alias into noise at the horizon; an
 * orthographic eye sits a kilometre back by construction and would fade its own grid away entirely, so it
 * is given a reach that outruns that.
 */
export const gridReach = (view: View): number =>
  view.kind === "3d" ? Math.max(1000, view.reach * 40) : ORTHO_BACK * 8;

/**
 * The grid backdrop stretched across a 2D pane's frustum.
 *
 * It is a unit quad, so placing it is a basis, a position and a scale — turned to face the camera, put at
 * the plane through the pivot, and made a little larger than the pane so that rounding never leaves a bare
 * strip at an edge. In the 3D pane it is simply hidden: there the grid belongs on the surfaces.
 */
export function placeGridPlane(plane: Object3D, view: View, size: Size): void {
  if (view.kind === "3d") {
    plane.visible = false;
    return;
  }
  const { right, up, forward } = basisOf(view);
  basis.makeBasis(
    axisA.set(right[0], right[1], right[2]),
    axisB.set(up[0], up[1], up[2]),
    axisC.set(-forward[0], -forward[1], -forward[2]),
  );
  plane.quaternion.setFromRotationMatrix(basis);
  plane.position.set(view.target[0], view.target[1], view.target[2]);
  const height = view.reach * 1.1;
  plane.scale.set((height * size.width) / Math.max(size.height, 1), height, 1);
  plane.visible = true;
  plane.updateMatrixWorld();
}

/** scratch: a camera update happens four times a frame and should allocate nothing */
const target = /*@__PURE__*/ new Vector3();
const axisA = /*@__PURE__*/ new Vector3();
const axisB = /*@__PURE__*/ new Vector3();
const axisC = /*@__PURE__*/ new Vector3();
const basis = /*@__PURE__*/ new Matrix4();
