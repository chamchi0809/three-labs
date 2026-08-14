// The TSL node materials of three's webgpu_geometry_loft example.
//
// A shader graph is not something CSS syntax has any business describing, so the sheet names these by
// registry name instead — `material: porcelainMaterial;` — and the graphs stay here in TypeScript.
//
// All of it is procedural, and it leans on how a loft is parameterised: `uv().x` runs along the loft and
// `uv().y` around each section, so a pattern can follow the geometry.
import { DoubleSide, MeshStandardNodeMaterial } from "three/webgpu";
import {
  bumpMap, color, cos, float, mix, mx_fractal_noise_float, mx_noise_float, mx_worley_noise_float,
  positionLocal, sin, smoothstep, uv, vec3,
} from "three/tsl";

/** large, softly mottled, running under the curtain so its edge is never seen */
export const floorMaterial = new MeshStandardNodeMaterial({ roughness: 1 });
floorMaterial.colorNode = color(0x555577).mul(mx_noise_float(positionLocal.mul(0.4)).mul(0.1).add(0.95));

/** a theater curtain encircling the exhibition */
export const curtainMaterial = new MeshStandardNodeMaterial({ roughness: 0.9, side: DoubleSide });
curtainMaterial.colorNode = color(0x86222e).mul(mx_noise_float(vec3(uv().y.mul(300), uv().x.mul(6), 0)).mul(0.08).add(0.96));

/**
 * Polished marble. The veins meander and branch along the zero crossings of a domain warped fractal
 * noise — a sharp dark core inside a soft halo — over a gently clouded white base.
 */
export const marbleMaterial = (() => {
  const p = positionLocal.mul(0.9);
  const vein = mx_fractal_noise_float(p.add(mx_fractal_noise_float(p.mul(0.4), 3).mul(2)), 4).abs().oneMinus();
  const fine = mx_fractal_noise_float(p.mul(3).add(11), 3).abs().oneMinus();
  const veining = vein.pow(4).mul(0.3).add(vein.pow(12).mul(0.7)).add(fine.pow(14).mul(0.2));
  const clouds = mx_noise_float(p.mul(0.5)).mul(0.5).add(0.5);

  const material = new MeshStandardNodeMaterial();
  material.colorNode = mix(mix(color(0xf4f4f7), color(0xeeeef2), clouds), color(0xd0d0d5), veining);
  material.roughnessNode = veining.mul(0.14).add(0.07);
  material.envMapIntensity = 1.5;
  return material;
})();

/** the coffee set's glaze, with a faint waviness */
export const porcelainMaterial = new MeshStandardNodeMaterial();
porcelainMaterial.roughnessNode = mx_noise_float(positionLocal.mul(6)).mul(0.08).add(0.2);
porcelainMaterial.normalNode = bumpMap(mx_noise_float(positionLocal.mul(2)).mul(0.05));

/** the coffee itself, with a lazy swirl on its surface */
export const liquidMaterial = new MeshStandardNodeMaterial({ roughness: 0.08 });
liquidMaterial.colorNode = mix(color(0x2b1a12), color(0x4a2c1a), mx_noise_float(positionLocal.mul(1.5)).mul(0.5).add(0.5));

/** the glaze pools in throwing rings along the vase's profile */
export const vaseMaterial = (() => {
  const rings = sin(uv().x.mul(160));
  const material = new MeshStandardNodeMaterial({ side: DoubleSide });
  material.colorNode = mix(color(0x2e6f9e), color(0x82b8d8), mx_noise_float(positionLocal.mul(1.2)).mul(0.5).add(0.5));
  material.roughnessNode = rings.mul(0.08).add(0.3);
  material.normalNode = bumpMap(rings.mul(0.012));
  return material;
})();

/** growth bands and fine ridges along the spiral */
export const shellMaterial = new MeshStandardNodeMaterial({ roughness: 0.5, side: DoubleSide });
shellMaterial.colorNode = mix(color(0xc9a87f), color(0xf2e6d8), mx_noise_float(vec3(uv().x.mul(24), 0, 0)).mul(0.5).add(0.5));
shellMaterial.normalNode = bumpMap(sin(uv().x.mul(480)).mul(0.02));

/** sandy terracotta */
export const starMaterial = new MeshStandardNodeMaterial({ roughness: 0.6 });
starMaterial.colorNode = color(0xcc5544).mul(mx_noise_float(positionLocal.mul(3)).mul(0.12).add(0.94));
starMaterial.normalNode = bumpMap(mx_noise_float(positionLocal.mul(50)).mul(0.008));

/** gold, brushed along the ribbon's length */
export const ribbonMaterial = (() => {
  const brush = mx_noise_float(vec3(uv().x.mul(6), uv().y.mul(160), 0));
  const material = new MeshStandardNodeMaterial({ color: 0xffcc44, metalness: 1, side: DoubleSide });
  material.roughnessNode = brush.mul(0.08).add(0.1);
  material.normalNode = bumpMap(brush.mul(0.004));
  material.envMapIntensity = 2.5;
  return material;
})();

/** stripes printed around the tube's body */
export const toothpasteMaterial = (() => {
  const u = uv().x;
  const teal = smoothstep(0.48, 0.5, u).sub(smoothstep(0.6, 0.62, u));
  const red = smoothstep(0.66, 0.68, u).sub(smoothstep(0.72, 0.74, u));
  const material = new MeshStandardNodeMaterial({ roughness: 0.25 });
  material.colorNode = mix(mix(color(0xf2f2f2), color(0x2aa6b8), teal), color(0xd0543a), red);
  return material;
})();

/**
 * The shading follows the same crease function as the geometry, so the narrow creases are darker and
 * rougher than the broad lobes.
 */
export const pumpkinMaterial = (() => {
  const lobe = cos(uv().y.mul(Math.PI * 7)).abs().pow(0.35);
  const material = new MeshStandardNodeMaterial();
  material.colorNode = mix(
    mix(color(0x9c4f16), color(0xe6913d), lobe),
    color(0x8a7a2e), // greener around the stem
    smoothstep(0.88, 1, uv().x).mul(0.6),
  );
  material.roughnessNode = float(0.7).sub(lobe.mul(0.2));
  material.normalNode = bumpMap(mx_noise_float(vec3(uv().y.mul(120), uv().x.mul(5), 0)).mul(0.01));
  return material;
})();

export const pumpkinStemMaterial = new MeshStandardNodeMaterial({ color: 0x667744 });
pumpkinStemMaterial.roughnessNode = mx_noise_float(positionLocal.mul(20)).mul(0.2).add(0.7);

/**
 * The cap's uvs run from under the rim (u 0) over the edge to the top center (u 1), so the red dome with
 * its raised warts and the pale underside with its radial gills share one material.
 */
export const mushroomCapMaterial = (() => {
  const u = uv().x;
  const dome = smoothstep(0.42, 0.58, u);
  const warts = smoothstep(0.18, 0.38, mx_worley_noise_float(positionLocal.mul(2.4))).oneMinus().mul(dome);
  const gills = sin(uv().y.mul(Math.PI * 120)).mul(0.5).add(0.5).mul(dome.oneMinus());

  const material = new MeshStandardNodeMaterial();
  material.colorNode = mix(
    mix(color(0xe8dcc4), color(0xbfae8e), gills),
    mix(color(0xa32d20), color(0xf2e9d8), warts),
    dome,
  );
  material.roughnessNode = float(0.55).sub(dome.mul(0.2)).add(warts.mul(0.25));
  material.normalNode = bumpMap(warts.mul(0.08).sub(gills.mul(0.015)));
  return material;
})();

export const mushroomStemMaterial = new MeshStandardNodeMaterial();
mushroomStemMaterial.colorNode = color(0xe5d5b5).mul(mx_noise_float(vec3(uv().y.mul(24), uv().x.mul(2), 0)).mul(0.1).add(0.94));
mushroomStemMaterial.roughnessNode = mx_noise_float(positionLocal.mul(12)).mul(0.15).add(0.55);

/** hammered copper */
export const gobletMaterial = (() => {
  const dents = mx_worley_noise_float(positionLocal.mul(5));
  const material = new MeshStandardNodeMaterial({ color: 0xb87333, metalness: 1 });
  material.roughnessNode = dents.mul(0.18).add(0.12);
  material.normalNode = bumpMap(dents.mul(0.1));
  material.envMapIntensity = 2;
  return material;
})();

/** the barrier's stanchions */
export const brassMaterial = new MeshStandardNodeMaterial({ color: 0xc9a86a, metalness: 1 });
brassMaterial.roughnessNode = mx_noise_float(positionLocal.mul(10)).mul(0.06).add(0.16);
brassMaterial.envMapIntensity = 2;

/** the barrier's cord — the bump is the twist of it */
export const ropeMaterial = new MeshStandardNodeMaterial({ color: 0x8a2433, roughness: 0.65 });
ropeMaterial.normalNode = bumpMap(sin(uv().x.mul(200).add(uv().y.mul(Math.PI * 2))).mul(0.015));
