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

/** A probe and how much of `position`'s reflection is its. The weights of a blend sum to 1. */
export type ProbeWeight = { index: number; weight: number };

/** A placed probe as {@link probeWeights} needs it. `influence` 0 or absent means unbounded. */
export type PlacedProbe = { position: readonly number[]; influence?: number };

/**
 * The probes `position` reflects: the two nearest that reach it, weighted, nearest first. Empty when
 * every probe's influence volume excludes it — which is what an author who sets `influence` at all is
 * asking for, and why the default is unbounded.
 *
 * The weight is inverse distance times a linear falloff to each probe's own edge. Distance alone is
 * what makes a mesh sitting on a probe reflect that probe and not half of its neighbour; the falloff
 * is what stops a probe from vanishing abruptly at the boundary of its volume. With no influence set
 * anywhere the falloffs are all 1, so the two nearest split the reflection as `d1/(d0+d1)` — the
 * Voronoi cells this used to hand out, with the seam between two cells softened into a gradient.
 */
export function probeWeights(position: readonly number[], probes: readonly PlacedProbe[]): ProbeWeight[] {
  let near = -1;
  let next = -1;
  let nearDistance = Infinity;
  let nextDistance = Infinity;
  probes.forEach((probe, i) => {
    let squared = 0;
    for (let k = 0; k < 3; k++) squared += (position[k]! - probe.position[k]!) ** 2;
    const distance = Math.sqrt(squared);
    const reach = probe.influence ?? 0;
    if (reach > 0 && distance > reach) return;
    if (distance < nearDistance) {
      [next, nextDistance] = [near, nearDistance];
      [near, nearDistance] = [i, distance];
    } else if (distance < nextDistance) {
      [next, nextDistance] = [i, distance];
    }
  });
  if (near < 0) return [];

  const strength = (i: number, distance: number) => {
    const reach = probes[i]!.influence ?? 0;
    const falloff = reach > 0 ? Math.max(0, 1 - distance / reach) : 1;
    // a mesh standing exactly on a probe would divide by zero, and it is that probe's anyway
    return falloff / Math.max(distance, 1e-6);
  };
  const a = strength(near, nearDistance);
  const b = next < 0 ? 0 : strength(next, nextDistance);
  // both fall to zero only when the nearest probe sits exactly on its own edge; it is still the answer
  if (!(a + b > 0) || b <= 0) return [{ index: near, weight: 1 }];
  return [
    { index: near, weight: a / (a + b) },
    { index: next, weight: b / (a + b) },
  ];
}
