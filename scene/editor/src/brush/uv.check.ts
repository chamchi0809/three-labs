// Where a material sits, and whether it stays there. Every failure here is a seam a level designer
// spends an afternoon nudging by hand.
// Run with: node --experimental-strip-types src/brush/uv.check.ts
import assert from "node:assert/strict";
import type { Vec2, Vec3 } from "tscene";
import { report, test } from "../check.ts";
import {
  DEFAULT_FACE, brushOf, faceCentre, faceNormal, facePolygon, moveFace, moveVertices, transformBrush,
  type Brush,
} from "./brush.ts";
import { cuboid, wedge } from "./builder.ts";
import {
  copyFace, copyUv, faceBasis, fitUv, flipUv, isTranslation, justifyUv, lockUv, lockUvToPlanes, nudgeUv,
  pinAxes, resetUv, rotateUv, scaleUv, setUvAt, setUvScale, transformLocked, uvBounds, uvOf, withFace,
  worldAt,
} from "./uv.ts";
import { distance, dot, rotation, scaling, translation, type Mat4 } from "./vec.ts";

const near = (a: number, b: number, why: string) => assert.ok(Math.abs(a - b) < 1e-9, `${why}: ${a} is not ${b}`);
const nearUv = (a: Vec2, b: Vec2, why: string) =>
  assert.ok(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9, `${why}: [${a}] is not [${b}]`);

/** a four-by-two-by-three room corner, big enough that every axis is a different number */
const room = (): Brush => brushOf(cuboid({ min: [0, 0, 0], max: [4, 2, 3] }));
const TOP = 2; // +y in the face order `cuboid` builds
const FRONT = 4; // +z
const EAST = 0; // +x

/**
 * Every corner of every face landing on the same part of its material after the move — which is the
 * whole of what uv lock promises.
 *
 * The corners are found by vertex index rather than by their place in the loop, because a mirror
 * reverses every loop: the same corners in the other order, which a positional comparison would read as
 * a wall whose material had been shuffled.
 */
const sameUv = (before: Brush, after: Brush) => {
  before.poly.faces.forEach((f, i) =>
    f.loop.forEach((c) =>
      nearUv(uvOf(after, i, after.poly.vertices[c]!), uvOf(before, i, before.poly.vertices[c]!), `face ${i} corner ${c}`),
    ),
  );
};

test("a default face maps world metres straight onto tiles", () => {
  const b = room();
  // the +z face's paraxial axes are world x and y, so a point's uv is just its x and y
  nearUv(uvOf(b, FRONT, [1.5, 0.5, 3]), [1.5, 0.5], "the front wall");
  nearUv(uvOf(b, TOP, [1.5, 2, 0.5]), [1.5, -0.5], "the ceiling, whose v runs backwards");
});

test("a tile coordinate names the point it came from, on every face of a slanted solid", () => {
  const b = brushOf(wedge({ min: [0, 0, 0], max: [4, 2, 3] })!);
  for (let i = 0; i < b.poly.faces.length; i++) {
    for (const p of [...facePolygon(b, i), faceCentre(b, i)]) {
      const back = worldAt(b, i, uvOf(b, i, p));
      assert.ok(distance(back, p) < 1e-9, `face ${i}: [${back}] is not [${p}]`);
    }
  }
});

test("the round trip survives a stated pair of axes, and a scale, and a rotation", () => {
  let b = room();
  b = withFace(b, FRONT, { uv: { kind: "parallel", u: [0.6, 0.8, 0] as Vec3, v: [-0.8, 0.6, 0] as Vec3 } });
  b = setUvScale(b, FRONT, [1.7, 0.4]);
  b = rotateUv(b, FRONT, 0.3);
  b = nudgeUv(b, FRONT, [0.9, -2.2]);
  for (const p of facePolygon(b, FRONT)) {
    const back = worldAt(b, FRONT, uvOf(b, FRONT, p));
    assert.ok(distance(back, p) < 1e-9, `[${back}] is not [${p}]`);
  }
});

// ---------------------------------------------------------------- the operations

test("a fitted face is exactly one tile across, whichever way its axes point", () => {
  for (const face of [FRONT, EAST, TOP]) {
    const b = fitUv(room(), face);
    const { min, max } = uvBounds(b, face);
    nearUv(min, [0, 0], `face ${face} starts at the corner of the tile`);
    nearUv(max, [1, 1], `face ${face} ends at the far corner`);
  }
});

test("fitting keeps the rotation it was given rather than snapping the material upright", () => {
  const b = fitUv(rotateUv(room(), FRONT, 0.4), FRONT);
  near(b.faces[FRONT]!.rotation, 0.4, "the rotation");
  const { min, max } = uvBounds(b, FRONT);
  nearUv(min, [0, 0], "still fitted");
  nearUv(max, [1, 1], "still fitted");
});

test("justify pushes the material against the side it names", () => {
  const b = room();
  const at = (side: Parameters<typeof justifyUv>[2]) => uvBounds(justifyUv(b, EAST, side), EAST);
  near(at("left").min[0], 0, "left");
  near(at("right").max[0], 1, "right");
  near(at("bottom").min[1], 0, "bottom");
  near(at("top").max[1], 1, "top");
  const c = at("centre");
  near(c.min[0] + c.max[0], 1, "centred across");
  const m = at("middle");
  near(m.min[1] + m.max[1], 1, "centred down");
});

test("justifying one axis leaves the other where it was", () => {
  const b = room();
  const before = uvBounds(b, EAST);
  const after = uvBounds(justifyUv(b, EAST, "left"), EAST);
  near(after.min[1], before.min[1], "the vertical is untouched");
});

test("rotating, scaling and flipping all turn about the middle of the face", () => {
  const b = room();
  const centre = faceCentre(b, FRONT);
  const was = uvOf(b, FRONT, centre);
  nearUv(uvOf(rotateUv(b, FRONT, 0.7), FRONT, centre), was, "rotated");
  nearUv(uvOf(scaleUv(b, FRONT, [2, 3]), FRONT, centre), was, "scaled");
  nearUv(uvOf(flipUv(b, FRONT, "u"), FRONT, centre), was, "flipped");
});

test("a bigger tile is fewer tiles across the same wall", () => {
  const b = room();
  const before = uvBounds(b, FRONT);
  const after = uvBounds(scaleUv(b, FRONT, [2, 2]), FRONT);
  near(after.max[0] - after.min[0], (before.max[0] - before.min[0]) / 2, "half as many tiles across");
  near(after.max[1] - after.min[1], (before.max[1] - before.min[1]) / 2, "half as many down");
});

test("a flip mirrors the face about its middle and nothing else", () => {
  const b = flipUv(room(), FRONT, "u");
  const centre = uvOf(b, FRONT, faceCentre(b, FRONT));
  const corners = facePolygon(b, FRONT).map((p) => uvOf(b, FRONT, p));
  const mirrored = facePolygon(b, FRONT).map((p) => uvOf(room(), FRONT, p));
  for (let i = 0; i < corners.length; i++) {
    near(corners[i]![0], 2 * centre[0] - mirrored[i]![0], "u is mirrored");
    near(corners[i]![1], mirrored[i]![1], "v is untouched");
  }
});

test("a point can be pinned to a tile coordinate, which is what dragging in the uv editor is", () => {
  const b = room();
  const p = facePolygon(b, FRONT)[0]!;
  nearUv(uvOf(setUvAt(b, FRONT, p, [0, 0]), FRONT, p), [0, 0], "pinned to the corner of the tile");
  nearUv(uvOf(setUvAt(b, FRONT, p, [0.25, -3]), FRONT, p), [0.25, -3], "pinned anywhere");
});

test("reset undoes anything at all", () => {
  let b = room();
  b = rotateUv(scaleUv(nudgeUv(b, FRONT, [3, 4]), FRONT, [7, 0.5]), FRONT, 1.1);
  b = withFace(b, FRONT, { uv: { kind: "parallel" } });
  assert.deepEqual(resetUv(b, FRONT).faces[FRONT], { ...DEFAULT_FACE, offset: [0, 0], scale: [1, 1] });
});

test("copying takes the alignment, and copying the face takes the material too", () => {
  let b = withFace(room(), EAST, { material: "brick", offset: [1, 2], scale: [3, 4], rotation: 0.5 });
  b = withFace(b, FRONT, { material: "stone" });
  const alignment = copyUv(b, EAST, FRONT).faces[FRONT]!;
  assert.equal(alignment.material, "stone", "the material stayed");
  assert.deepEqual([alignment.offset, alignment.scale, alignment.rotation], [[1, 2], [3, 4], 0.5]);
  assert.equal(copyFace(b, EAST, FRONT).faces[FRONT]!.material, "brick", "the material came too");
});

test("copied numbers are copies, not the same arrays", () => {
  const b = copyUv(withFace(room(), EAST, { offset: [1, 2] }), EAST, FRONT);
  assert.notEqual(b.faces[EAST]!.offset, b.faces[FRONT]!.offset);
});

test("pinning the axes changes the words in the sheet and nothing on the wall", () => {
  const b = rotateUv(room(), FRONT, 0.4);
  const pinned = pinAxes(b, FRONT);
  assert.equal(pinned.faces[FRONT]!.uv.kind, "parallel");
  for (const p of facePolygon(b, FRONT)) nearUv(uvOf(pinned, FRONT, p), uvOf(b, FRONT, p), "unmoved");
});

// ---------------------------------------------------------------- uv lock

const locked = (b: Brush, m: Mat4) => {
  const moved = transformBrush(b, m);
  assert.ok(moved.brush, moved.problems.join("; "));
  return lockUv(b, moved.brush!, m);
};

test("without the lock, moving a brush slides the material over it", () => {
  const b = room();
  const moved = transformBrush(b, translation([1, 0, 0])).brush!;
  const p = faceCentre(b, FRONT);
  assert.notDeepEqual(uvOf(moved, FRONT, [p[0] + 1, p[1], p[2]]), uvOf(b, FRONT, p));
});

test("a locked move leaves every corner of every face on the same part of its material", () => {
  const b = room();
  const m = translation([3.7, -1.2, 0.5]);
  sameUv(b, locked(b, m));
});

test("a moved wall is still a paraxial wall, so the room stays in agreement with itself", () => {
  const after = locked(room(), translation([3.7, -1.2, 0.5]));
  for (const f of after.faces) assert.equal(f.uv.kind, "paraxial", "still derived from the world axes");
});

test("a locked rotation states the axes, because paraxial cannot describe them", () => {
  const b = room();
  const m = rotation([0, 1, 0], 0.5, [2, 1, 1.5]);
  const after = locked(b, m);
  sameUv(b, after);
  for (const f of after.faces) assert.equal(f.uv.kind, "parallel", "the axes are written out");
});

test("a locked scale grows the tile with the wall", () => {
  const b = fitUv(room(), FRONT);
  const after = locked(b, scaling([2, 2, 2]));
  near(after.faces[FRONT]!.scale[0], b.faces[FRONT]!.scale[0] * 2, "twice the metres per tile");
  const bounds = uvBounds(after, FRONT);
  nearUv(bounds.min, [0, 0], "still fitted");
  nearUv(bounds.max, [1, 1], "still fitted");
});

test("a locked mirror keeps the material on the wall it was on", () => {
  const b = room();
  const m = scaling([-1, 1, 1], [2, 1, 1.5]);
  sameUv(b, locked(b, m));
});

test("a lock through a stated pair of axes carries them round with the brush", () => {
  const b = pinAxes(room(), FRONT);
  const m = rotation([0, 1, 0], Math.PI / 2, [2, 1, 1.5]);
  const after = locked(b, m);
  const axes = faceBasis(after, FRONT);
  // the front wall now faces +x, and its u came round with it
  near(dot(axes.u, [0, 0, -1]), 1, "u turned a quarter with the wall");
});

test("transformLocked is the transform and the lock in one", () => {
  const b = room();
  const m = translation([1, 2, 3]);
  const one = transformLocked(b, m).brush!;
  assert.deepEqual(one.faces, locked(b, m).faces);
});

test("an edit with no matrix behind it locks per face, from where each one used to point", () => {
  const b = fitUv(room(), FRONT);
  // the top of the front wall pulled back, tilting it: a vertex drag, not a transform
  const top = b.poly.faces[FRONT]!.loop.filter((c) => b.poly.vertices[c]![1]! > 1);
  const dragged = lockUvToPlanes(b, moveVertices(b, top, [0, 0, -0.02]));
  assert.ok(dragged.brush, dragged.problems.join("; "));
  const after = dragged.brush!;
  const front = dragged.from!.indexOf(FRONT);
  assert.ok(front >= 0, "the front wall is still recognisably the front wall");
  // the material turned with the wall: its axes still lie in the face, and a tile is still a tile
  const { u, v } = faceBasis(after, front);
  const n = faceNormal(after, front);
  near(dot(u, n), 0, "u lies in the tilted face");
  near(dot(v, n), 0, "v lies in the tilted face");
  assert.deepEqual(after.faces[front]!.scale, b.faces[FRONT]!.scale, "the tile is the same size");
  // and it did not jump: a small tilt moves the material by a correspondingly small amount
  const drift = uvOf(after, front, faceCentre(after, front));
  const was = uvOf(b, FRONT, faceCentre(b, FRONT));
  assert.ok(Math.hypot(drift[0] - was[0], drift[1] - was[1]) < 1e-3, `the middle held: [${drift}] vs [${was}]`);
  // and the walls that did not tilt were not perturbed at all
  dragged.from!.forEach((was, i) => {
    if (was !== FRONT && was >= 0) assert.deepEqual(after.faces[i], b.faces[was], `face ${was} was left alone`);
  });
});

test("a face that did not tilt is left exactly alone, to the last bit", () => {
  const b = fitUv(room(), FRONT);
  const slid = lockUvToPlanes(b, moveFace(b, FRONT, 0.37));
  assert.deepEqual(slid.brush!.faces, b.faces);
});

test("a move is recognised as a move, and anything else is not", () => {
  assert.ok(isTranslation(translation([1, 2, 3])));
  assert.ok(!isTranslation(rotation([0, 1, 0], 0.01)));
  assert.ok(!isTranslation(scaling([1, 1, 1.001])));
  assert.ok(!isTranslation(scaling([-1, -1, 1])), "two mirrors keep the volume but move the axes");
});

report("uv");
