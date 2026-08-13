// Reflection probes: where they sit, which one a mesh reflects, and how a direction maps to a texel.
//
// A lightmap is irradiance on a surface, which a metal has no lobe to receive — so the specular half of
// the bake is a separate product, laid out the way every other baker lays it out: a point in open space
// the author placed, captured as radiance in every direction, and picked per object at runtime. Browser
// safe; the tracer reads the same directions this file hands out.

/**
 * The direction texel `(x, y)` of a `width x height` equirect looks along, from its centre.
 *
 * The inverse of three's `equirectUV` — `u = atan2(z, x) / 2π + 0.5`, `v = asin(y) / π + 0.5` — which is
 * what `PMREMGenerator.fromEquirectangular` samples the map with, so this is the mapping the runtime
 * undoes. Row 0 looks straight down, and the writer flips the atlas on the way to the file, so the EXR's
 * last scanline is the one under the probe.
 */
export function probeDirection(x: number, y: number, width: number, height: number): [number, number, number] {
  const theta = ((x + 0.5) / width - 0.5) * Math.PI * 2;
  const phi = ((y + 0.5) / height - 0.5) * Math.PI;
  const r = Math.cos(phi);
  return [r * Math.cos(theta), Math.sin(phi), r * Math.sin(theta)];
}

/** {@link probeDirection} for every texel, 4 floats each — the buffer the probe kernel indexes. */
export function probeDirections(width: number, height: number): Float32Array {
  const out = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dir = probeDirection(x, y, width, height);
      out.set(dir, (y * width + x) * 4);
    }
  }
  return out;
}

/**
 * Which probe `position` reflects: the nearest one, or -1 when there are none.
 *
 * ponytail: nearest centre, so the probes partition the scene into Voronoi cells with no say from the
 * author beyond where they put them. An influence volume per probe (Unity's box, Unreal's sphere) and a
 * blend between the two nearest are the upgrade; both need a second field in the manifest, not a
 * different shape here.
 */
export function nearestProbe(position: readonly number[], probes: readonly { position: readonly number[] }[]): number {
  let best = -1;
  let bestDistance = Infinity;
  probes.forEach((probe, i) => {
    let distance = 0;
    for (let k = 0; k < 3; k++) distance += (position[k]! - probe.position[k]!) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  });
  return best;
}
