/**
 * Where a material sits on a patch.
 *
 * The same four knobs a brush face has — material, offset, scale, rotation — so the material tool and the
 * face inspector can drive a patch with the gestures they already have. What is different is the space the
 * numbers are in, and it is worth being clear about it because it is the reason this file is short.
 *
 * A brush face has no natural origin: its uv axes are world axes, so the offset that puts a material where
 * the designer wants it depends on where in the map the wall happens to be. That is why every operation in
 * `brush/uv.ts` goes through `keeping()`, which pins a world point and solves for the offset again — turn a
 * face and the material turns about the middle of the wall rather than about the world origin a hundred
 * metres away.
 *
 * A patch has an origin. Its uv is measured along the surface itself, from the corner at `grid[0][0]`,
 * in metres of surface — `(s + offset) / scale`, then turned. So the corner is a place on the surface the
 * designer is looking at, scaling about it keeps it pinned, and turning about it turns the material about
 * a corner of the thing being turned. No anchor has to be invented and none has to be solved for.
 *
 * Two of the face operations have no patch here at all. `fit` and `justify` need the face's outline in tile
 * coordinates, and a patch's outline is whatever the tessellator makes of the curvature; `paraxial` versus
 * `parallel` is a choice of axes, and a patch's axes are the surface's own and cannot be anything else. The
 * inspector says so rather than offering buttons that would quietly do nothing.
 */
import type { Vec2 } from "tscene";
import type { Patch, PatchUv } from "./patch.ts";

/** the uv changed, the grid and the material untouched — the shape every operation below returns */
export const withPatchUv = (patch: Patch, over: Partial<PatchUv>): Patch => ({
  ...patch,
  uv: { ...patch.uv, ...over },
});

/** the material a patch is made of, or the default when the name is empty */
export const withPatchMaterial = (patch: Patch, material: string | undefined): Patch => {
  if (material) return { ...patch, material };
  const { material: _gone, ...rest } = patch;
  return rest;
};

export const resetPatchUv = (patch: Patch): Patch =>
  withPatchUv(patch, { offset: [0, 0], scale: [1, 1], rotation: 0 });

/** the material slid along the surface, in metres of surface */
export const nudgePatchUv = (patch: Patch, by: Vec2): Patch =>
  withPatchUv(patch, { offset: [patch.uv.offset[0] + by[0], patch.uv.offset[1] + by[1]] });

/** turned about the surface's own corner, which is the origin its uv is measured from */
export const rotatePatchUv = (patch: Patch, radians: number): Patch =>
  withPatchUv(patch, { rotation: patch.uv.rotation + radians });

/** the tile size multiplied — bigger metres per tile is a bigger material on the surface */
export const scalePatchUv = (patch: Patch, by: Vec2): Patch =>
  withPatchUv(patch, {
    scale: [(patch.uv.scale[0] || 1) * (by[0] || 1), (patch.uv.scale[1] || 1) * (by[1] || 1)],
  });

/** the tile size set outright, in metres of surface per tile */
export const setPatchUvScale = (patch: Patch, scale: Vec2): Patch =>
  withPatchUv(patch, { scale: [scale[0] || 1, scale[1] || 1] });

/**
 * The material mirrored, by running one of the tile axes backwards.
 *
 * A negative scale rather than a flag, because that is what it is: `(s + offset) / -scale` is the same
 * surface read the other way, and the runtime needs no notion of flipping to draw it.
 */
export const flipPatchUv = (patch: Patch, axis: "u" | "v"): Patch =>
  withPatchUv(patch, {
    scale: axis === "u"
      ? [-(patch.uv.scale[0] || 1), patch.uv.scale[1]!]
      : [patch.uv.scale[0]!, -(patch.uv.scale[1] || 1)],
  });
