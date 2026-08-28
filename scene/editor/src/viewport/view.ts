/**
 * Where a viewport is looking from.
 *
 * TrenchBroom's four panes are one 3D view and three orthographic ones, and the reason it works is that
 * they are the *same* camera model with the projection swapped: pan, zoom, focus and frame all mean the
 * same thing in all four, so a designer's hands do not have to change gear when the mouse crosses a
 * splitter. This file is that model — a plain value, no three.js objects, no DOM — and {@link applyCamera}
 * is the one place it is turned into a camera the renderer can use.
 *
 * Keeping it a value rather than a controller is what makes "frame the selection in every view" a map over
 * four numbers instead of four controllers agreeing with each other. It is also what makes it checkable:
 * `view.check.ts` runs the whole thing under bare node.
 */
import type { Vec3 } from "tscene";
import type { Bounds } from "../brush/builder.ts";

export type ViewKind = "3d" | "top" | "front" | "side";

export const VIEW_KINDS: ViewKind[] = ["3d", "top", "front", "side"];

/** what a pane is called, and — for the 2D ones — which plane of the world it shows */
export const VIEW_TITLES: Record<ViewKind, string> = {
  "3d": "3D",
  top: "top · xz",
  front: "front · xy",
  side: "side · zy",
};

export type View = {
  kind: ViewKind;
  /** what the view is looking at: the pivot in 3D, the centre of the window in 2D */
  target: Vec3;
  /**
   * 3D: metres from the pivot to the eye. 2D: metres of world visible from the top of the pane to the
   * bottom. Both are "how much of the world am I seeing", which is why zoom and frame are one function.
   */
  reach: number;
  /** 3D only. Radians around +Y, measured from +Z, so 0 looks north up the −Z axis. */
  yaw: number;
  /** 3D only. Radians above the horizon, clamped just short of straight down. */
  pitch: number;
  /** 3D only, degrees. */
  fov: number;
};

/** an orthonormal frame for a view: which way is screen-right, screen-up, and into the screen */
export type Basis = { right: Vec3; up: Vec3; forward: Vec3 };

/**
 * The three orthographic frames.
 *
 * Chosen so every one of them is right-handed with the world — screen-right cross screen-up points back
 * at the viewer — because a 2D view that mirrors the world is one where a designer drags a wall east and
 * watches it go west. Top puts −Z up the screen, which is the convention every map editor since Doom has
 * used for "north".
 */
const PLANES: Record<Exclude<ViewKind, "3d">, Basis> = {
  top: { right: [1, 0, 0], up: [0, 0, -1], forward: [0, -1, 0] },
  front: { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] },
  side: { right: [0, 0, -1], up: [0, 1, 0], forward: [-1, 0, 0] },
};

/** how close to straight up or down the 3D view may get; exactly there the yaw stops meaning anything */
const PITCH_LIMIT = Math.PI / 2 - 0.01;

export const MIN_REACH = 0.05;
export const MAX_REACH = 4096;

export function newView(kind: ViewKind): View {
  return {
    kind,
    target: [0, 1.5, 0],
    reach: kind === "3d" ? 24 : 24,
    yaw: Math.PI * 0.2,
    pitch: 0.5,
    fov: 60,
  };
}

// ---------------------------------------------------------------- the frame

/** which way is right, up and forward for this view — computed from yaw and pitch in 3D, fixed in 2D */
export function basisOf(view: View): Basis {
  if (view.kind !== "3d") return PLANES[view.kind];
  const back = eyeDirection(view);
  const forward: Vec3 = [-back[0], -back[1], -back[2]];
  // right is horizontal by construction: rolling a 3D viewport is a thing nobody has ever wanted
  const right: Vec3 = [Math.cos(view.yaw), 0, -Math.sin(view.yaw)];
  return { right, up: cross(right, forward), forward };
}

/** the unit vector from the pivot towards the eye */
function eyeDirection(view: View): Vec3 {
  const c = Math.cos(view.pitch);
  return [c * Math.sin(view.yaw), Math.sin(view.pitch), c * Math.cos(view.yaw)];
}

/** where the camera actually is. In 2D it is pulled a long way back, so nothing is ever behind it. */
export function eyeOf(view: View): Vec3 {
  if (view.kind === "3d") {
    const d = eyeDirection(view);
    return [
      view.target[0] + d[0] * view.reach,
      view.target[1] + d[1] * view.reach,
      view.target[2] + d[2] * view.reach,
    ];
  }
  const { forward } = PLANES[view.kind];
  return [
    view.target[0] - forward[0] * ORTHO_BACK,
    view.target[1] - forward[1] * ORTHO_BACK,
    view.target[2] - forward[2] * ORTHO_BACK,
  ];
}

/** how far behind the target an orthographic eye sits, and therefore how much depth range it spans */
export const ORTHO_BACK = 1024;

// ---------------------------------------------------------------- navigating

/**
 * The view slid sideways by a screen delta, in CSS pixels.
 *
 * The delta is converted through {@link metresPerPixel} rather than by a fixed factor, so a pan drags the
 * world with the cursor: the point under the mouse when the drag started is the point under it now. That
 * is the only pan that feels like anything but a guess.
 */
export function panView(view: View, dx: number, dy: number, size: Size): View {
  const scale = metresPerPixel(view, size);
  const { right, up } = basisOf(view);
  const target: Vec3 = [
    view.target[0] - (right[0] * dx - up[0] * dy) * scale,
    view.target[1] - (right[1] * dx - up[1] * dy) * scale,
    view.target[2] - (right[2] * dx - up[2] * dy) * scale,
  ];
  return { ...view, target };
}

/**
 * Zoom, one wheel notch at a time.
 *
 * `at`, if given, is the point on screen to keep still — zooming towards the cursor rather than the middle
 * of the pane, which is the difference between navigating a map and chasing it. In 3D the eye moves along
 * its own line of sight and the pivot stays put until the eye would pass through it.
 */
export function zoomView(view: View, notches: number, size: Size, at?: Point): View {
  const factor = Math.pow(0.85, notches);
  const reach = clamp(view.reach * factor, MIN_REACH, MAX_REACH);
  if (view.kind === "3d") return { ...view, reach };

  const zoomed = { ...view, reach };
  if (!at) return zoomed;
  // keep the world point under the cursor where it is: pan by however far it moved
  const before = pointOnPlane(view, at, size);
  const after = pointOnPlane(zoomed, at, size);
  return {
    ...zoomed,
    target: [
      zoomed.target[0] + before[0] - after[0],
      zoomed.target[1] + before[1] - after[1],
      zoomed.target[2] + before[2] - after[2],
    ],
  };
}

/** the 3D view turned around its pivot; a no-op in 2D, where there is nothing to turn */
export function orbitView(view: View, dx: number, dy: number): View {
  if (view.kind !== "3d") return view;
  return {
    ...view,
    yaw: view.yaw - dx * ORBIT_SPEED,
    pitch: clamp(view.pitch + dy * ORBIT_SPEED, -PITCH_LIMIT, PITCH_LIMIT),
  };
}

/**
 * Free look: the eye stays where it is and the view turns around it.
 *
 * This is the one that matters when a designer is standing inside a room they are building, and it is
 * implemented as "orbit, then push the pivot back under the eye" so that everything downstream — framing,
 * panning, the pivot the next orbit uses — keeps working off the same target.
 */
export function lookView(view: View, dx: number, dy: number): View {
  if (view.kind !== "3d") return view;
  const eye = eyeOf(view);
  const turned = orbitView(view, dx, dy);
  const d = eyeDirection(turned);
  return {
    ...turned,
    target: [eye[0] - d[0] * turned.reach, eye[1] - d[1] * turned.reach, eye[2] - d[2] * turned.reach],
  };
}

const ORBIT_SPEED = 0.006;

/**
 * The view moved bodily through the world, in metres along its own axes: WASD in the 3D pane, and the
 * same motion a 2D pan makes. Both the eye and the pivot move, which is what keeps a fly from turning
 * into an orbit.
 */
export function flyView(view: View, along: { right?: number; up?: number; forward?: number }): View {
  const basis = basisOf(view);
  const target: Vec3 = [...view.target];
  for (const key of ["right", "up", "forward"] as const) {
    const metres = along[key];
    if (!metres) continue;
    const axis = basis[key];
    for (let i = 0; i < 3; i++) target[i] += axis[i]! * metres;
  }
  return { ...view, target };
}

// ---------------------------------------------------------------- framing

/**
 * The view backed off far enough to hold `box`, without turning.
 *
 * Direction is deliberately untouched: "focus on selection" means look at that thing from here, not from
 * wherever the editor thinks is nice. A designer who has lined a view up and then framed something has not
 * asked to lose the alignment.
 */
export function frameView(view: View, box: Bounds | undefined, size: Size, margin = 1.25): View {
  if (!box || !Number.isFinite(box.min[0])) return view;
  const target: Vec3 = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
  const half: Vec3 = [
    Math.max((box.max[0] - box.min[0]) / 2, 1e-3),
    Math.max((box.max[1] - box.min[1]) / 2, 1e-3),
    Math.max((box.max[2] - box.min[2]) / 2, 1e-3),
  ];
  const aspect = size.width / Math.max(size.height, 1);

  if (view.kind === "3d") {
    const radius = Math.hypot(half[0], half[1], half[2]);
    const vertical = (view.fov * Math.PI) / 180;
    // the tighter of the two half-angles is the one that decides the distance
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
    const angle = Math.min(vertical, horizontal) / 2;
    return { ...view, target, reach: clamp((radius / Math.sin(angle)) * margin, MIN_REACH, MAX_REACH) };
  }

  const { right, up } = basisOf(view);
  const across = extent(half, right) * 2;
  const down = extent(half, up) * 2;
  const reach = Math.max(down, across / Math.max(aspect, 1e-3)) * margin;
  return { ...view, target, reach: clamp(reach, MIN_REACH, MAX_REACH) };
}

/** how far a half-extent box reaches along an axis, which for an axis-aligned box is one component */
const extent = (half: Vec3, axis: Vec3): number =>
  Math.abs(half[0] * axis[0]) + Math.abs(half[1] * axis[1]) + Math.abs(half[2] * axis[2]);

// ---------------------------------------------------------------- screen and world

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/**
 * Metres per CSS pixel at the pivot.
 *
 * In 2D this is exact everywhere, because an orthographic projection has no depth foreshortening. In 3D it
 * is exact only in the plane through the pivot — which is the plane a pan and a drag both work in, so it is
 * the right approximation and not merely a convenient one.
 */
export function metresPerPixel(view: View, size: Size): number {
  const height = Math.max(size.height, 1);
  if (view.kind !== "3d") return view.reach / height;
  return (2 * Math.tan(((view.fov * Math.PI) / 180) / 2) * view.reach) / height;
}

/** the world point a screen point falls on, in the plane through the pivot */
export function pointOnPlane(view: View, at: Point, size: Size): Vec3 {
  const scale = metresPerPixel(view, size);
  const dx = at.x - size.width / 2;
  const dy = at.y - size.height / 2;
  const { right, up } = basisOf(view);
  return [
    view.target[0] + (right[0] * dx - up[0] * dy) * scale,
    view.target[1] + (right[1] * dx - up[1] * dy) * scale,
    view.target[2] + (right[2] * dx - up[2] * dy) * scale,
  ];
}

export type Ray = { origin: Vec3; direction: Vec3 };

/**
 * The ray through a screen point.
 *
 * Picking does not need this — it reads a pixel — but every tool that drags in the world does: a vertex
 * moved along a plane, a solid dropped onto a floor, the depth a clip point sits at. In 2D the ray is the
 * view's own forward from a point on the near plane, which is the whole reason a 2D view is easier to
 * build in than a 3D one.
 */
export function rayThrough(view: View, at: Point, size: Size): Ray {
  const on = pointOnPlane(view, at, size);
  const { forward } = basisOf(view);
  if (view.kind !== "3d") {
    return {
      origin: [
        on[0] - forward[0] * ORTHO_BACK,
        on[1] - forward[1] * ORTHO_BACK,
        on[2] - forward[2] * ORTHO_BACK,
      ],
      direction: forward,
    };
  }
  const eye = eyeOf(view);
  const direction = normal([on[0] - eye[0], on[1] - eye[1], on[2] - eye[2]]);
  return { origin: eye, direction };
}

/**
 * A world point put back on the screen — the inverse of {@link pointOnPlane}, and the only thing a tool
 * needs that a pick pass cannot answer.
 *
 * A rubber band asks "is this solid inside the rectangle I dragged", and there is no pixel to read for a
 * question about a box rather than a point. Projecting the box's corners answers it in both kinds of pane
 * with one piece of arithmetic, which is worth more here than the frustum clipping it replaces.
 *
 * `undefined` means the point is behind the eye, where a perspective projection would put it on screen
 * mirrored — a rubber band that swallowed what was behind the designer would be a very strange tool.
 */
export function projectPoint(view: View, p: Vec3, size: Size): Point | undefined {
  const { right, up, forward } = basisOf(view);
  const eye = eyeOf(view);
  const d: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const across = dot(d, right);
  const along = dot(d, up);

  if (view.kind !== "3d") {
    const scale = metresPerPixel(view, size);
    return { x: size.width / 2 + across / scale, y: size.height / 2 - along / scale };
  }

  const depth = dot(d, forward);
  if (depth <= 1e-6) return undefined;
  const half = Math.tan(((view.fov * Math.PI) / 180) / 2);
  const aspect = size.width / Math.max(size.height, 1);
  return {
    x: (across / (depth * half * aspect) / 2 + 0.5) * size.width,
    y: (0.5 - along / (depth * half) / 2) * size.height,
  };
}

// ---------------------------------------------------------------- odds and ends

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function normal(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
