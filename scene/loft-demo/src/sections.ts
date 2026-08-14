// The cross sections every `loftGeometry()` in the sheet is skinned through, ported from three's
// webgpu_geometry_loft example.
//
// Vertex math is not something a declarative sheet can say, so the tables live here and reach the sheet
// through `loadScene`'s registry — the sheet still names `loftGeometry` itself, and still decides which
// ends get capped.
import { MathUtils, SplineCurve, Vector2, Vector3 } from "three/webgpu";

/** what `LoftGeometry` skins: a list of rings, all with the same number of points */
export type Sections = Vector3[][];

/** one ring of `segments` points at (radius, height), wound around the y axis */
const ring = (radius: number, y: number, segments: number): Vector3[] =>
  Array.from({ length: segments }, (_, j) => {
    const angle = (j / segments) * Math.PI * 2;
    return new Vector3(Math.sin(angle) * radius, y, Math.cos(angle) * radius);
  });

/** revolves a smoothed 2d profile (x = radius, y = height) into circular sections, like a lathe */
const revolved = (profile: Vector2[], divisions: number, segments: number): Sections =>
  new SplineCurve(profile).getPoints(divisions).map((p) => ring(p.x, p.y, segments));

const v2 = (x: number, y: number) => new Vector2(x, y);

/**
 * A stepped plinth, a tapered shaft and a cornice; revolved **without** smoothing, one ring per profile
 * point. The doubled points split the vertex normals, which is what keeps those turnings crisp.
 */
export const pedestalSections = (radius: number, height: number): Sections =>
  [
    v2(0.2, 0),
    v2(radius * 1.06, 0),
    v2(radius * 1.06, height * 0.1),
    v2(radius * 1.06, height * 0.1),
    v2(radius * 0.98, height * 0.16),
    v2(radius * 0.94, height * 0.55),
    v2(radius * 0.97, height * 0.84),
    v2(radius * 1.04, height * 0.88),
    v2(radius * 1.04, height * 0.97),
    v2(radius * 1.04, height * 0.97),
    v2(radius * 0.98, height),
    v2(radius * 0.98, height),
    v2(radius * 0.5, height - 0.004),
    v2(0.2, height),
  ].map((p) => ring(p.x, p.y, 48));

/** from the bottom center, up the egg shaped outer wall, over the lip and back down the inner wall */
export const cupSections = revolved([
  v2(0.2, 0), v2(0.7, 0.04), v2(1.05, 0.1), v2(1.75, 0.55), v2(2.25, 1.45), v2(2.36, 2.2), v2(2.3, 3.1),
  v2(2.22, 3.82), v2(2.18, 3.95), v2(2.06, 3.8), v2(2.18, 2.2), v2(1.5, 0.75), v2(0.9, 0.55), v2(0.2, 0.62),
], 120, 64);

/** from the bottom center, out along the underside, around the thin rim and back across the dished top */
export const saucerSections = revolved([
  v2(0.2, 0), v2(1.3, 0.08), v2(2.6, 0.35), v2(3.7, 0.8), v2(4.2, 1), v2(3.4, 0.68), v2(2, 0.3), v2(1, 0.18), v2(0.2, 0.26),
], 120, 64);

/**
 * An ear shaped loop swept along a spline, slightly tapering; the ends slim down so they stay buried
 * inside the thin cup wall.
 */
export const handleSections = (() => {
  const path = new SplineCurve([v2(2.2, 3.3), v2(2.9, 3.45), v2(3.6, 2.85), v2(3.65, 1.95), v2(3, 1.2), v2(1.78, 1.05)]);
  const divisions = 60;
  const points = path.getPoints(divisions);
  return points.map((point, i) => {
    const t = i / divisions;
    const tangent = path.getTangent(t);
    const scale = (1 - 0.25 * t)
      * (0.28 + 0.72 * MathUtils.smoothstep(t, 0, 0.12))
      * (0.28 + 0.72 * (1 - MathUtils.smoothstep(t, 0.88, 1)));
    const a = 0.22 * scale; // in the plane of the loop
    const b = 0.27 * scale; // across the loop
    return Array.from({ length: 16 }, (_, j) => {
      const phi = (j / 16) * Math.PI * 2;
      const radial = a * Math.cos(phi);
      return new Vector3(point.x - radial * tangent.y, point.y + radial * tangent.x, b * Math.sin(phi));
    });
  });
})();

/** a full belly, a slender waist and a flared lip */
export const vaseSections = revolved([
  v2(0.2, 0), v2(1.05, 0.05), v2(1.5, 0.3), v2(2.1, 1.4), v2(2.2, 2.3), v2(1.8, 3.6),
  v2(1.2, 4.8), v2(0.85, 5.8), v2(0.72, 6.6), v2(0.8, 7.3), v2(1.1, 7.9), v2(1.3, 8.2),
], 100, 48);

/** circular sections that grow while sweeping along a logarithmic spiral */
export const shellSections: Sections = (() => {
  const turns = 3;
  const growth = 0.18;
  const scale = Math.exp(growth * turns * Math.PI * 2);
  return Array.from({ length: 151 }, (_, i) => {
    const angle = turns * Math.PI * 2 * (i / 150);
    const e = Math.exp(growth * angle) / scale;
    const pathRadius = 3 * e;
    const sectionRadius = 2.4 * e;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    return Array.from({ length: 32 }, (_, j) => {
      const phi = (j / 32) * Math.PI * 2;
      const r = pathRadius + sectionRadius * Math.cos(phi);
      return new Vector3(r * sin, 4.5 * (1 - e) + sectionRadius * Math.sin(phi), r * cos);
    });
  });
})();

/** non-circular sections that rotate and scale along the loft */
export const starSections: Sections = Array.from({ length: 61 }, (_, i) => {
  const t = i / 60;
  const twist = (t * Math.PI) / 3;
  const scale = 1 - 0.35 * Math.sin(t * Math.PI);
  return Array.from({ length: 96 }, (_, j) => {
    const angle = (j / 96) * Math.PI * 2;
    const radius = (2.4 + 0.7 * Math.cos(5 * angle)) * scale;
    return new Vector3(Math.sin(angle + twist) * radius, t * 10, Math.cos(angle + twist) * radius);
  });
});

/** open two-point sections — a ribbon, which is what `closed: false` is for */
export const ribbonSections: Sections = Array.from({ length: 121 }, (_, i) => {
  const t = i / 120;
  const angle = t * Math.PI * 2 * 2.5;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  return [new Vector3(3 * sin, t * 7.5, 3 * cos), new Vector3(3 * sin, t * 7.5 + 2, 3 * cos)];
});

/** a cap, a shoulder, and a body whose circular sections flatten into a wide crimped seam at the top */
export const toothpasteSections: Sections = Array.from({ length: 81 }, (_, i) => {
  const t = i / 80;
  const radius = 0.5 + 0.28 * MathUtils.smoothstep(t, 0.08, 0.2);
  const crimp = MathUtils.smoothstep(t, 0.3, 0.95);
  const width = radius * (1 - crimp) + 1.15 * crimp;
  const depth = radius * (1 - crimp) + 0.05 * crimp;
  return Array.from({ length: 48 }, (_, j) => {
    const angle = (j / 48) * Math.PI * 2;
    return new Vector3(Math.sin(angle) * width, t * 4.2, Math.cos(angle) * depth);
  });
});

/** a squashed sphere with broad lobes split by narrow creases, and a sunken hollow around the stem */
export const pumpkinSections: Sections = Array.from({ length: 61 }, (_, i) => {
  const t = i / 60;
  const angle = Math.PI * (0.03 + 0.94 * t);
  const radius = 1.85 * Math.pow(Math.sin(angle), 0.62);
  const creases = 0.15 * Math.sin(Math.PI * t);
  const y = 2.05 * t - 0.75 * MathUtils.smoothstep(t, 0.8, 1);
  return Array.from({ length: 96 }, (_, j) => {
    const theta = (j / 96) * Math.PI * 2;
    const lobe = Math.pow(Math.abs(Math.cos(3.5 * theta)), 0.35);
    const r = radius * (1 - creases + creases * lobe);
    return new Vector3(Math.sin(theta) * r, y, Math.cos(theta) * r);
  });
});

/** a ribbed stalk, flared at its base, that rises out of the hollow and leans over */
export const pumpkinStemSections: Sections = Array.from({ length: 31 }, (_, i) => {
  const t = i / 30;
  const radius = 0.2 - 0.09 * t + 0.14 * Math.pow(1 - t, 4);
  const lean = 0.45 * t * t;
  return Array.from({ length: 32 }, (_, j) => {
    const angle = (j / 32) * Math.PI * 2;
    const r = radius * (0.92 + 0.13 * Math.pow(Math.abs(Math.cos(2.5 * angle)), 0.5));
    return new Vector3(lean + Math.sin(angle) * r, 1.3 + 1.15 * t, Math.cos(angle) * r);
  });
});

/** from under the rim, around the edge and over the dome — a cap that folds under itself */
export const mushroomCapSections = revolved([
  v2(0.35, 2.02), v2(1.1, 2), v2(1.65, 2.15), v2(1.78, 2.4), v2(1.5, 2.85), v2(0.95, 3.18), v2(0.2, 3.32),
], 80, 48);

export const mushroomStemSections = revolved([
  v2(0.2, 0), v2(0.55, 0.05), v2(0.45, 0.9), v2(0.4, 1.7), v2(0.42, 2.3),
], 60, 32);

/** a foot, a thin stem, and a bowl that folds back down inside */
export const gobletSections = revolved([
  v2(0.2, 0), v2(1.25, 0.05), v2(1.35, 0.2), v2(0.6, 0.5), v2(0.28, 0.9), v2(0.24, 1.7), v2(0.7, 2.15),
  v2(1.15, 2.8), v2(1.28, 3.5), v2(1.27, 3.62), v2(1.16, 3.5), v2(0.95, 2.85), v2(0.45, 2.25), v2(0.2, 2.32),
], 140, 48);

/** a flat disc base, a slender pole and a small ball finial */
export const stanchionSections = revolved([
  v2(0.16, 0), v2(0.42, 0.04), v2(0.46, 0.12), v2(0.28, 0.22), v2(0.08, 0.38), v2(0.06, 1),
  v2(0.06, 1.85), v2(0.11, 1.95), v2(0.19, 2.08), v2(0.2, 2.2), v2(0.11, 2.3), v2(0.04, 2.34),
], 80, 24);

/** a cord sagging between two stanchions, with both ends buried in their poles */
export const ropeSections = (length: number): Sections => {
  const sag = 0.9;
  return Array.from({ length: 41 }, (_, i) => {
    const t = i / 40;
    const x = (t - 0.5) * length;
    const y = -sag * 4 * t * (1 - t);
    // the in-plane tangent orients the rings along the curve
    const tx = length;
    const ty = -sag * 4 * (1 - 2 * t);
    const tl = Math.sqrt(tx * tx + ty * ty);
    return Array.from({ length: 16 }, (_, j) => {
      const phi = (j / 16) * Math.PI * 2;
      const radial = 0.08 * Math.cos(phi);
      return new Vector3(x - (radial * ty) / tl, y + (radial * tx) / tl, 0.08 * Math.sin(phi));
    });
  });
};

/** rows of pleated rings hanging from above; the folds deepen and drift sideways as they fall */
export const curtainSections: Sections = Array.from({ length: 31 }, (_, i) => {
  const t = i / 30;
  const y = -5 + 25 * t;
  return Array.from({ length: 480 }, (_, j) => {
    const s = j / 480;
    const folds = (1.2 - 0.5 * t) * Math.sin(s * Math.PI * 2 * 48 + t * 2);
    const sway = 0.5 * Math.sin(s * Math.PI * 2 * 5 + t * 3);
    const theta = s * Math.PI * 2;
    const r = 55 + folds + sway;
    return new Vector3(Math.sin(theta) * r, y, Math.cos(theta) * r);
  });
});
