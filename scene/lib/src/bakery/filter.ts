// Post-passes on the baked atlas. Both are cheap CPU loops over an image that is already converged;
// they exist to remove the two artefacts sampling alone cannot fix: residual MC noise inside a chart,
// and black bleed at a chart's edge once the GPU filters the texture bilinearly.
import type { Texels } from "./raster.ts";

/**
 * Edge-aware box blur. Neighbours only contribute when they sit on the same surface — same normal,
 * within a texel or so in world space — so shadow terminators and creases survive.
 */
export function denoise(image: Float32Array, texels: Texels, radius = 1, normalThreshold = 0.9): void {
  const { width, height, mask, position, normal } = texels;
  const out = new Float32Array(image.length);
  // a texel's world footprint, used as the distance cutoff between neighbours on the same plane
  const footprint = texelSize(texels) * 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      if (!mask[at]) continue;
      const c = at * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let weight = 0;

      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const other = ny * width + nx;
          if (!mask[other]) continue;
          const o = other * 4;
          const alignment =
            normal[c] * normal[o] + normal[c + 1] * normal[o + 1] + normal[c + 2] * normal[o + 2];
          if (alignment < normalThreshold) continue;
          const dist = Math.hypot(
            position[c] - position[o],
            position[c + 1] - position[o + 1],
            position[c + 2] - position[o + 2],
          );
          if (dist > footprint) continue;
          r += image[o];
          g += image[o + 1];
          b += image[o + 2];
          weight++;
        }
      }

      out[c] = r / weight;
      out[c + 1] = g / weight;
      out[c + 2] = b / weight;
      out[c + 3] = image[c + 3];
    }
  }
  image.set(out);
}

/**
 * Grows the lit region outward by `radius` texels, averaging whatever is already lit. Without this a
 * bilinear tap just outside a chart reads black and every chart gets a dark rim.
 */
export function dilate(image: Float32Array, mask: Uint8Array, width: number, height: number, radius = 4): Uint8Array {
  const grown = Uint8Array.from(mask);
  for (let pass = 0; pass < radius; pass++) {
    const added: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = y * width + x;
        if (grown[at]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const other = ny * width + nx;
            if (!grown[other]) continue;
            r += image[other * 4];
            g += image[other * 4 + 1];
            b += image[other * 4 + 2];
            n++;
          }
        }
        if (!n) continue;
        image[at * 4] = r / n;
        image[at * 4 + 1] = g / n;
        image[at * 4 + 2] = b / n;
        image[at * 4 + 3] = 1;
        added.push(at);
      }
    }
    if (!added.length) break;
    // marked after the pass so growth spreads one ring at a time
    for (const at of added) grown[at] = 1;
  }
  return grown;
}

/**
 * World size of one texel. The median, not the mean: horizontally adjacent texels from two different
 * charts can be metres apart and would drag an average anywhere.
 */
function texelSize(texels: Texels): number {
  const { width, height, mask, position } = texels;
  const steps: number[] = [];
  // ponytail: a sampled median. Every row would sort a million entries for a number that only sets a
  // blur cutoff; raise the row count if a scene ever shows the sampling.
  const stride = Math.max(1, Math.floor(height / 128));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x + 1 < width; x++) {
      const a = y * width + x;
      const b = a + 1;
      if (!mask[a] || !mask[b]) continue;
      steps.push(
        Math.hypot(
          position[a * 4] - position[b * 4],
          position[a * 4 + 1] - position[b * 4 + 1],
          position[a * 4 + 2] - position[b * 4 + 2],
        ),
      );
    }
  }
  if (!steps.length) return 0;
  steps.sort((p, q) => p - q);
  return steps[steps.length >> 1];
}
