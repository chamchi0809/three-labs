// Sanity check for the Split Radiance Cascades layout in src/SplitRC.ts:
// `pnpm --filter @rc25d/radiance-cascades check`.
//
// Every invariant here fails silently on a GPU. A direction index off by one
// samples a neighbouring cone, a probe key that does not commute with the
// cascade step splits one probe into two, and both come out as plausible light.
// ponytail: the formulas are mirrored rather than imported, because the
// originals are TSL node graphs that only exist inside a shader. Keep the two in
// step; the blocks are named after the code they mirror.

import { readFileSync } from "node:fs";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function near(a: number, b: number, message: string, eps = 1e-9): void {
  check(Math.abs(a - b) < eps, `${message}: ${a} vs ${b}`);
}

/**
 * One method's source, from its signature to the next one. Checks that a kernel
 * *stopped* doing something need the bound: without it they read to the end of
 * the file and pass on any later method's text.
 */
function bodyOf(source: string, method: string): string {
  const start = source.indexOf(`private ${method}(`);
  check(start >= 0, `${method} is gone; a check mirrors it`);
  const end = source.indexOf("\n  private ", start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

/** Mirrors the `fade` helper: Perlin's quintic. */
const fade = (f: number) => f * f * f * (f * (f * 6 - 15) + 10);

const CASCADES = 4;
const THETA_0 = 4;
const T0_OVER_DS0 = 2.4;
const LENGTH_SCALE = 4;
const SPACING_SCALE = 2;
const COORD_BITS = 9;
const COORD_BIAS = 1 << (COORD_BITS - 1);
const COORD_MASK = (1 << COORD_BITS) - 1;
const LOD_BITS = 4;
const IRRADIANCE_INNER = 6;
const IRRADIANCE_SIZE = IRRADIANCE_INNER + 2;
const R2_A1 = 3242174889;
const R2_A2 = 2447445413;

const theta = (n: number) => THETA_0 * 2 ** n;
const directions = (n: number) => 2 * theta(n) ** 2;

// --- Cascade scaling (§3.2). Mirrors buildLayout.
{
  let near_ = 0;
  let length = 1;
  const t: number[] = [];
  for (let n = 0; n < CASCADES; n++) {
    t.push(near_ + length);
    near_ += length;
    length *= LENGTH_SCALE;
  }

  // t₋₁ = 0 by convention, and every cascade's near bound is the one below it's
  // far bound — the intervals tile [0, t_{N−1}) with no gap and no overlap.
  const nearOf = (n: number) => (n === 0 ? 0 : t[n - 1]!);
  for (let n = 0; n < CASCADES; n++) {
    check(nearOf(n) < t[n]!, `cascade ${n} interval is empty`);
    if (n > 0) near(nearOf(n), t[n - 1]!, `cascade ${n} leaves a gap below it`);
  }
  // Interval n is l times interval n−1.
  for (let n = 1; n < CASCADES; n++) {
    near(
      t[n]! - nearOf(n),
      (t[n - 1]! - nearOf(n - 1)) * LENGTH_SCALE,
      `cascade ${n} length scaling`,
    );
  }
  // Closed form tₙ = t₀(l^{n+1} − 1)/(l − 1).
  for (let n = 0; n < CASCADES; n++) {
    near(
      t[n]!,
      (LENGTH_SCALE ** (n + 1) - 1) / (LENGTH_SCALE - 1),
      `cascade ${n} closed form`,
    );
  }

  // The reason for K = 4, l = 4. |Ω_In| directions spread over the sphere sit
  // 2√(π/|Ω_In|) radians apart, so across an interval of length t₀·lⁿ the
  // angular error is Δωₙ = 2·t₀·lⁿ·√(π/(32·Kⁿ)). With l = 4 and K = 4 that is
  // 2·t₀·2ⁿ·√(π/32) — it scales as 2ⁿ, exactly like Δsₙ. Prior work aimed for a
  // constant Δω with l = 2; equalising the two errors instead is what §3.2 and
  // Appendix A credit with removing most of the artifacts.
  const ds0 = 1;
  const t0 = T0_OVER_DS0 * ds0;
  const intervalLength = (n: number) => t0 * LENGTH_SCALE ** n;
  const angular = (n: number) =>
    2 * intervalLength(n) * Math.sqrt(Math.PI / directions(n));
  const spatial = (n: number) => ds0 * SPACING_SCALE ** n;
  for (let n = 1; n < CASCADES; n++) {
    near(
      angular(n) / angular(n - 1),
      SPACING_SCALE,
      `cascade ${n}: Δω does not scale like Δs`,
      1e-12,
    );
  }
  // §7's t₀ ≈ 1.6Δs₀ is the calibration that turns "same growth rate" into
  // Δωₙ = Δsₙ outright. What must hold at *any* t₀ is that the ratio is the same
  // at every cascade — that is the §3.2 property, and it is what t₀ cannot break.
  const CALIBRATED_T0 = 1 / (2 * Math.sqrt(Math.PI / directions(0)));
  near(CALIBRATED_T0, 1.596, "the §7 calibration is no longer ≈1.6Δs₀", 0.01);
  for (let n = 0; n < CASCADES; n++) {
    near(
      angular(n) / spatial(n),
      t0 / CALIBRATED_T0,
      `cascade ${n}: Δω/Δs differs from cascade 0's`,
      1e-9,
    );
  }
  // And why this t₀ overshoots the calibration: interval n *begins* at t_{n−1}·t₀
  // while its probes are Δsₙ apart. A cascade that begins inside its own spacing
  // holds light its neighbouring probes see in different directions, so
  // interpolating between them mixes two answers instead of blurring one — and
  // the bound where light crosses into it is a sphere around the light.
  for (let n = 1; n < CASCADES; n++) {
    check(
      t[n - 1]! * t0 >= spatial(n) * 1.1,
      `cascade ${n} begins at ${(t[n - 1]! * t0).toFixed(1)}Δs₀, inside its own ${spatial(n)}Δs₀ spacing`,
    );
  }
  check(
    t[0]! * CALIBRATED_T0 < spatial(1),
    "the calibrated t₀ already clears cascade 1's spacing; T0_OVER_DS0 has nothing to buy",
  );
  // The interval lengths are what scale by l; the cutoffs tₙ that β and J are
  // defined against are their running sum, so tₙ/t_{n−1} only approaches l.
  near(intervalLength(0), t0, "cascade 0 interval is not t₀");
  check(
    t[1]! / t[0]! > t[2]! / t[1]! &&
      t[2]! / t[1]! > t[3]! / t[2]! &&
      t[3]! / t[2]! > LENGTH_SCALE,
    "cumulative cutoffs should approach l from above",
  );

  // Branching factor K = 4: four directions of cascade n+1 per direction of n.
  for (let n = 1; n < CASCADES; n++) {
    check(
      directions(n) === directions(n - 1) * 4,
      `cascade ${n} is not a 4-way branch`,
    );
  }
}

// --- Direction set (Algorithm 2). Mirrors encodeDir/decodeDir/directionIndex.
{
  const decodeDir = (u: number, v: number): [number, number, number] => {
    const phi = u * Math.PI * 2;
    const z = v * 2 - 1;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return [r * Math.cos(phi), r * Math.sin(phi), z];
  };
  const encodeDir = (w: [number, number, number]): [number, number] => {
    const phi = Math.atan2(w[1], w[0]);
    const frac = phi / (Math.PI * 2) - Math.floor(phi / (Math.PI * 2));
    return [frac, (w[2] + 1) / 2];
  };

  for (let n = 0; n < CASCADES; n++) {
    const T = theta(n);
    const seen = new Set<number>();
    for (let v = 0; v < T; v++) {
      for (let u = 0; u < 2 * T; u++) {
        const w = decodeDir((u + 0.5) / (2 * T), (v + 0.5) / T);
        near(
          Math.hypot(...w),
          1,
          `cascade ${n} direction (${u},${v}) is not a unit vector`,
          1e-12,
        );

        // directionIndex must map a direction back to the cell it came from,
        // which is what makes mₙ(ω) the nearest element of Ω_In.
        const [eu, ev] = encodeDir(w);
        const iu = Math.min(Math.floor(eu * 2 * T), 2 * T - 1);
        const iv = Math.min(Math.floor(ev * T), T - 1);
        check(
          iu === u && iv === v,
          `cascade ${n}: (${u},${v}) round-trips to (${iu},${iv})`,
        );

        const index = v * 2 * T + u;
        check(
          !seen.has(index),
          `cascade ${n} direction index ${index} collides`,
        );
        seen.add(index);
        check(
          index < directions(n),
          `cascade ${n} direction index ${index} out of range`,
        );
      }
    }
    check(seen.size === directions(n), `cascade ${n} does not fill |Ω_In|`);
  }

  // Equal area: the v axis is uniform in z, so every row of cells covers the
  // same band of solid angle. This is the property the 2Θ×Θ shape buys — a
  // uniform grid in (φ, z) is uniform on the sphere.
  for (let v = 0; v + 1 < theta(0); v++) {
    const bandA = 2 / theta(0);
    const bandB = 2 / theta(0);
    near(bandA, bandB, "rows do not cover equal solid angle");
  }

  // The parent map mₙ(ω_{n+1,u,v}) = ω_{n,⌊u/2⌋,⌊v/2⌋}: four children per
  // parent, and the merge's child enumeration must reproduce exactly those.
  for (let n = 0; n + 1 < CASCADES; n++) {
    const T = theta(n);
    const U = theta(n + 1);
    const childrenOf = new Map<number, number[]>();
    for (let v = 0; v < U; v++) {
      for (let u = 0; u < 2 * U; u++) {
        const parent = Math.floor(v / 2) * 2 * T + Math.floor(u / 2);
        (
          childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!
        ).push(v * 2 * U + u);
      }
    }
    check(
      childrenOf.size === directions(n),
      `cascade ${n}: parent map is not onto Ω_In`,
    );
    for (const [parent, children] of childrenOf) {
      check(
        children.length === 4,
        `cascade ${n} direction ${parent} has ${children.length} children`,
      );
      // Mirrors buildMerge's unrolled child enumeration.
      const pu = parent % (2 * T);
      const pv = Math.floor(parent / (2 * T));
      const enumerated = [0, 1, 2, 3].map((c) => {
        const cu = pu * 2 + (c & 1);
        const cv = pv * 2 + ((c >> 1) & 1);
        return cv * 2 * U + cu;
      });
      check(
        enumerated
          .slice()
          .sort((a, b) => a - b)
          .join() ===
          children
            .slice()
            .sort((a, b) => a - b)
            .join(),
        `cascade ${n} direction ${parent}: merge enumerates the wrong children`,
      );
    }
  }
}

// --- Probe grid (§3.2, §4). Mirrors nearestCoord/probePosition/writeNeighbours.
{
  const spacing = (n: number, lod: number) => SPACING_SCALE ** n * 2 ** lod;
  const nearestCoord = (x: number, n: number, lod: number) =>
    Math.floor(x / spacing(n, lod));
  const probePosition = (v: number, n: number, lod: number) =>
    (v + 0.5) * spacing(n, lod);

  // Probes sit on Δsₙ(v + ½), the half-integer offset §3.2 uses to spread
  // interpolation error rather than stack it on the grid lines.
  for (let n = 0; n < CASCADES; n++) {
    near(
      probePosition(0, n, 0),
      spacing(n, 0) / 2,
      `cascade ${n} probe is not offset by half a cell`,
    );
  }

  // Nearest commutes with the cascade step, which is what lets a ray address
  // its probe in any cascade directly instead of walking the parent chain.
  for (let lod = 0; lod < 3; lod++) {
    for (let n = 0; n + 1 < CASCADES; n++) {
      for (let i = -40; i < 40; i++) {
        const x = i * 0.317 + 0.0001;
        const direct = nearestCoord(x, n + 1, lod);
        const stepped = nearestCoord(
          probePosition(nearestCoord(x, n, lod), n, lod),
          n + 1,
          lod,
        );
        check(
          direct === stepped,
          `lod ${lod} cascade ${n}→${n + 1} at x=${x}: Nearest does not commute (${direct} vs ${stepped})`,
        );
      }
    }
  }

  // The probe containing a position is one of its eight trilinear neighbours,
  // so the parent link and the interpolation stencil address the same probes.
  for (let n = 0; n + 1 < CASCADES; n++) {
    for (let i = -20; i < 20; i++) {
      const x = i * 0.713 + 0.05;
      const s = spacing(n + 1, 0);
      const corner = Math.floor(x / s - 0.5);
      const parent = nearestCoord(x, n + 1, 0);
      check(
        parent === corner || parent === corner + 1,
        `cascade ${n}: parent ${parent} is outside the stencil [${corner}, ${corner + 1}]`,
      );
    }
  }

  // Trilinear weights partition unity, so the sparse renormalisation is a no-op
  // when every neighbour exists.
  for (let i = 0; i < 16; i++) {
    const f = [
      0.11 * i - Math.floor(0.11 * i),
      0.37 * i - Math.floor(0.37 * i),
      0.59 * i - Math.floor(0.59 * i),
    ];
    let total = 0;
    for (let c = 0; c < 8; c++) {
      const w =
        (c & 1 ? f[0]! : 1 - f[0]!) *
        ((c >> 1) & 1 ? f[1]! : 1 - f[1]!) *
        ((c >> 2) & 1 ? f[2]! : 1 - f[2]!);
      check(w >= 0, "trilinear weight is negative");
      total += w;
    }
    near(total, 1, "trilinear weights do not partition unity", 1e-12);
  }
}

// --- LOD selection and overlap (§4.1). Mirrors lodBlend/lodFor.
{
  const LOD_OVERLAP = 0.5;
  const LOD_COUNT = 4;
  const band = -Math.log2(LOD_OVERLAP);
  check(
    new RegExp(`const LOD_OVERLAP = ${LOD_OVERLAP};`).test(
      readFileSync(new URL("src/SplitRC.ts", import.meta.url), "utf8"),
    ),
    `LOD_OVERLAP is no longer ${LOD_OVERLAP}; this block mirrors it`,
  );
  const chebyshev = (p: number[]) =>
    Math.max(Math.abs(p[0]!), Math.abs(p[1]!), Math.abs(p[2]!));

  const blend = (distance: number) => {
    const level = Math.log2(Math.max(distance, 1));
    const base = Math.min(Math.max(Math.floor(level), 0), LOD_COUNT - 1);
    const next = Math.min(base + 1, LOD_COUNT - 1);
    const ramp = Math.min(Math.max((level - base - (1 - band)) / band, 0), 1);
    return { lod: base, next, weight: next === base ? 0 : fade(ramp) };
  };

  // Chebyshev rather than Euclidean: the boundary is a cube aligned to the probe
  // grid, so a probe never straddles two LODs along a single axis.
  check(
    chebyshev([3, 1, 1]) === 3,
    "Chebyshev distance is not the max component",
  );
  check(
    chebyshev([2, 2, 2]) === 2,
    "Chebyshev distance is not the max component",
  );

  // A full octave, so no shell has an interior where one LOD answers alone.
  // That interior is the artifact: the two LODs reconstruct at filter widths a
  // factor of two apart (GATHER_RADIUS is in cells), so their answers differ by
  // a roughly constant amount, and two flat regions at different levels read as
  // a step no matter how smoothly the join between them is faded.
  check(band >= 1, "the overlap band is narrower than an octave; shells will read as flat steps");
  for (let i = 1; i < 32; i++) {
    const d = 1 + i / 32;
    check(blend(d).weight > 0, `distance ${d} sits inside a shell with no second LOD to blend`);
  }

  // Inside a LOD's own range there is no blending, and the band ends exactly
  // where the next LOD begins.
  near(blend(1).weight, 0, "LOD 0 blends at its own start");
  near(
    blend(2 * LOD_OVERLAP).weight,
    0,
    "the overlap band starts too early",
    1e-12,
  );
  check(
    blend(2 * LOD_OVERLAP + 1e-6).weight > 0,
    "the overlap band never opens",
  );
  near(
    blend(2 - 1e-9).weight,
    1,
    "the overlap band does not close at the next LOD",
    1e-6,
  );

  // The weight is monotone across the band and the pair of LODs it blends is
  // always adjacent, which is what makes the blend hide the seam.
  // Sampled up to but not including the boundary: at distance 2 the base LOD
  // itself steps up and the weight restarts from 0, which is the handover.
  let previous = -1;
  for (let i = 0; i < 64; i++) {
    const d = 2 * LOD_OVERLAP + ((2 - 2 * LOD_OVERLAP) * i) / 64;
    const { lod, next, weight } = blend(d);
    check(
      next === lod + 1,
      `distance ${d}: blending non-adjacent LODs ${lod} and ${next}`,
    );
    check(
      weight >= previous - 1e-12,
      `distance ${d}: blend weight is not monotone`,
    );
    previous = weight;
  }

  // The top LOD has no partner, so it must never ask for one.
  const top = blend(2 ** (LOD_COUNT + 2));
  check(
    top.lod === LOD_COUNT - 1 && top.weight === 0,
    "the top LOD blends past the end of the chain",
  );

  // Stochastic resolution reproduces the blend in expectation, which is what
  // lets probes and rays commit to one LOD each.
  for (const d of [1.85, 1.9, 1.95, 1.99]) {
    const { weight } = blend(d);
    let high = 0;
    const samples = 4096;
    for (let i = 1; i <= samples; i++) {
      // The same R2 dither the kernels use.
      if ((Math.imul(i, R2_A2 | 0) >>> 0) / 2 ** 32 < weight) high++;
    }
    near(
      high / samples,
      weight,
      `distance ${d}: dithered LOD does not match the blend`,
      0.02,
    );
  }
}

// --- Grid suppression. Mirrors fade/GATHER_KERNEL/gatherIrradiance and
// buildProbeFilter.
//
// All of it exists to stop the probe lattice from being visible, and all of it
// fails the same silent way: still a picture, still lit, still with one square
// per cell. So the checks are about shape rather than output — a kernel that is
// round, that closes inside the stencil that carries it, and a probe filter
// that is not asked to do the part it cannot.
{
  near(fade(0), 0, "fade moves the lower end of the interval");
  near(fade(1), 1, "fade moves the upper end of the interval");
  near(fade(0.5), 0.5, "fade is not symmetric about its midpoint");
  for (let i = 1; i < 64; i++) {
    const f = i / 64;
    check(fade(f) > fade((i - 1) / 64), `fade is not monotone at ${f}`);
  }

  // The point of the quintic over a linear ramp, and over the smoothstep: both
  // the slope and the curvature vanish at the ends. Every use here is a weight
  // being handed off at one of those ends.
  const d1 = (f: number, h = 1e-5) => (fade(f + h) - fade(f - h)) / (2 * h);
  const d2 = (f: number, h = 1e-4) =>
    (fade(f + h) - 2 * fade(f) + fade(f - h)) / h ** 2;
  for (const end of [0, 1]) {
    near(d1(end), 0, `fade has slope at ${end}`, 1e-8);
    near(d2(end), 0, `fade has curvature at ${end}`, 1e-3);
  }

  // --- The reconstruction kernel. Mirrors GATHER_RADIUS/GATHER_KERNEL.
  const GATHER_RADIUS = 1.5;
  const kernel = (d: number) => fade(Math.min(Math.max(1 - d, 0), 1));
  const dist = (a: number[], b: number[]) =>
    Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  const weightAt = (cell: number[], at: number[]) =>
    kernel(dist(cell, at) / GATHER_RADIUS);

  // Round, not boxy. The tent this replaced weighted the eight corners of a cube
  // and so had the lattice's own symmetry; a weight in the distance alone gives
  // every direction the same profile, which is what leaves the eye no corner to
  // find. Checked as: equal distance, equal weight, whatever the direction.
  const at = [0.2, -0.1, 0.35];
  for (const r of [0.4, 0.9, 1.4]) {
    const axis = weightAt([at[0]! + r, at[1]!, at[2]!], at);
    const diagonal = weightAt(
      [
        at[0]! + r / Math.sqrt(3),
        at[1]! + r / Math.sqrt(3),
        at[2]! + r / Math.sqrt(3),
      ],
      at,
    );
    near(axis, diagonal, `the kernel is not radial at distance ${r}`, 1e-12);
  }

  // Closes inside the stencil it is carried by. gatherIrradiance visits the 3×3×3
  // cells around the *nearest* one, so the stencil jumps a cell whenever the
  // position crosses a half-cell boundary; a probe still holding weight as it
  // falls out takes its contribution with it, which is a tear at exactly the
  // spacing the whole exercise is trying to hide. A position sits at most half a
  // cell from the nearest centre in each axis, so the nearest excluded cell is
  // 1.5 away — hence the radius, and hence no slack to spend.
  check(GATHER_RADIUS <= 1.5, "the kernel reaches outside the 3x3x3 stencil");
  near(kernel(1), 0, "the kernel does not close at its radius");
  for (const excess of [0, 1e-6, 0.1, 1]) {
    near(
      kernel(1 + excess),
      0,
      `the kernel is nonzero ${excess} past its radius`,
    );
  }
  // The worst case for the handoff: a position exactly on a half-cell boundary,
  // where two stencils are equally valid. Every cell one stencil holds and the
  // other does not must already weigh nothing, or the two disagree.
  for (const axis of [0, 1, 2]) {
    const boundary = [0, 0, 0];
    boundary[axis] = 0.5;
    for (let i = 0; i < 27; i++) {
      const offset = [(i % 3) - 1, (Math.floor(i / 3) % 3) - 1, Math.floor(i / 9) - 1];
      // The cell this offset names in the stencil the position is leaving, but
      // not in the one it is entering.
      const leaving = offset[axis] === -1;
      if (!leaving) continue;
      near(
        weightAt(offset, boundary),
        0,
        `the stencil drops cell ${offset} while it still has weight`,
      );
    }
  }

  // Wide enough to be worth 27 lookups: a full cell away still counts for
  // something, or the extra ring is paid for and unused.
  check(
    weightAt([1, 0, 0], [0, 0, 0]) > 0.05,
    "the kernel is too narrow to reach the ring it pays for",
  );

  // --- The probe filter. Mirrors buildProbeFilter.
  //
  // As its effect on one spatial frequency: a pass replaces a probe by
  // (c·self + Σ six neighbours)/(c + 6), which multiplies a mode of frequency k
  // by this factor. Along the lattice diagonal, where the neighbours reinforce.
  const PROBE_FILTER_CENTRE = 6;
  const PROBE_FILTER_PASSES = 1;
  const factor = (k: number) =>
    (PROBE_FILTER_CENTRE + 6 * Math.cos(k)) / (PROBE_FILTER_CENTRE + 6);

  // Nothing may grow, and a constant field must come through untouched — a
  // filter that dimmed the scene would be chased as a lighting bug.
  near(factor(0), 1, "the probe filter does not preserve a constant field");
  for (let i = 0; i <= 64; i++) {
    const k = (Math.PI * i) / 64;
    check(
      Math.abs(factor(k)) <= 1 + 1e-12,
      `the probe filter amplifies frequency ${k}`,
    );
  }
  // The checkerboard is the mode a centre weight of 0 returns negated instead of
  // damping. At 6 it is annihilated, which is what makes the pass idempotent
  // enough to be safe rather than what makes it wide.
  near(factor(Math.PI), 0, "the probe filter no longer kills the checkerboard");

  // One pass, and the count is not a knob to turn up. The filter renormalises
  // over the neighbours that exist, so its kernel follows the local occupancy,
  // and occupancy along a surface crossing the lattice at an angle is a periodic
  // staircase. Iterating feeds that period back into itself: the reported
  // symptom was stripes that sharpened with every added pass. Width belongs to
  // GATHER_RADIUS, whose kernel is a fixed shape in world space and has no
  // occupancy to pick up.
  check(
    PROBE_FILTER_PASSES === 1,
    "more than one probe-filter pass; iterating this kernel stripes (see the constant)",
  );

  const source = readFileSync(
    new URL("src/SplitRC.ts", import.meta.url),
    "utf8",
  );
  for (const [name, value] of [
    ["PROBE_FILTER_CENTRE", PROBE_FILTER_CENTRE],
    ["PROBE_FILTER_PASSES", PROBE_FILTER_PASSES],
    ["GATHER_RADIUS", GATHER_RADIUS],
  ] as const) {
    check(
      new RegExp(`const ${name} = ${value};`).test(source),
      `${name} is no longer ${value}; this block mirrors it`,
    );
  }
  check(
    /function fade[\s\S]*?f\.mul\(f\.mul\(6\)\.sub\(15\)\)\.add\(10\)/.test(
      source,
    ),
    "fade is no longer the quintic this block mirrors",
  );
  // The gather must stay radial. A weight rebuilt from per-axis factors is a
  // tent again however it is spelled, so the distance has to be there.
  check(
    /gatherIrradiance[\s\S]*?const distance = length\(delta\)[\s\S]*?GATHER_KERNEL\(distance\./.test(
      source,
    ),
    "gatherIrradiance no longer weights by distance",
  );
}

// --- LODs agreeing on brightness, not just meeting smoothly. Mirrors the
// backface weight in gatherIrradiance and the per-LOD t₀ in buildTrace.
//
// Blending across the overlap band makes the seam continuous; it does nothing
// about the two sides being at different average brightness, which is what is
// actually left to see once the seam is gone. Both terms below are LOD-scaled
// errors: they are zero at LOD 0 and grow with the spacing, so each one shows
// up as a set of shells around the camera, each brighter than the one inside.
{
  const source = readFileSync(new URL("src/SplitRC.ts", import.meta.url), "utf8");
  const GATHER_RADIUS = 1.5;
  const GATHER_BACKFACE = 0.02;
  check(
    new RegExp(`const GATHER_BACKFACE = ${GATHER_BACKFACE};`).test(source),
    `GATHER_BACKFACE is no longer ${GATHER_BACKFACE}; this block mirrors it`,
  );

  // --- The backface weight itself.
  const facing = (cosine: number) => ((cosine + 1) / 2) ** 2 + GATHER_BACKFACE;
  check(facing(-1) > 0, "a fully backfacing probe weighs zero; the gather can divide by zero");
  check(
    facing(1) / facing(-1) > 20,
    "a probe through the wall keeps more than a twentieth of a probe in front of it",
  );
  for (let i = 1; i <= 64; i++) {
    const c = -1 + (2 * i) / 64;
    check(facing(c) > facing(c - 2 / 64), `the backface weight is not monotone at cos ${c}`);
  }
  // Squared, not linear: the slope vanishes as a probe crosses the plane, so a
  // probe sliding behind a surface fades out instead of stepping.
  near((facing(-1 + 1e-5) - facing(-1)) / 1e-5, 0, "the backface weight steps at the plane", 1e-4);

  // --- What it is for: a surface with probes on both sides of it.
  //
  // A plane at y = 0 with the shaded point on it. Every probe below is on the
  // far side of whatever the surface is part of, so its irradiance belongs to
  // another room. How far the stencil reaches through is 1.5 cells — a fixed
  // number of cells but a *world* distance that doubles with the LOD, so the
  // set of rooms it reaches into changes from shell to shell even though the
  // weights do not. Bounding the leak is what makes the shells agree.
  const GATHER_BIAS = 0.5;
  const GATHER_CULL = 0.05;
  for (const [name, value] of [
    ["GATHER_BIAS", GATHER_BIAS],
    ["GATHER_CULL", GATHER_CULL],
  ] as const) {
    check(
      new RegExp(`const ${name} = ${value};`).test(source),
      `${name} is no longer ${value}; this block mirrors it`,
    );
  }
  const kernel = (d: number) => fade(Math.min(Math.max(1 - d, 0), 1));
  /**
   * The gather at a point on a plane sitting `height` cells into its own lattice
   * cell, normal +y, in cell space as in the shader. `seeded` is which layers
   * hold probes: "all" is a wall with a lit room behind it, "own" is a flat
   * floor, where §4 has put probes in exactly one layer.
   */
  const gather = (height: number, bias: number, cull: number, seeded: "all" | "own") => {
    const grid = [0.37 - 0.5, height - 0.5, 0.71 - 0.5];
    const nearest = grid.map((v) => Math.floor(v + 0.5));
    const layer = Math.floor(height);
    let total = 0;
    let behind = 0;
    let visited = 0;
    for (let i = 0; i < 27; i++) {
      const offset = [(i % 3) - 1, (Math.floor(i / 3) % 3) - 1, Math.floor(i / 9) - 1];
      const cell = nearest.map((v, a) => v + offset[a]!);
      const delta = cell.map((v, a) => v - grid[a]!);
      const distance = Math.hypot(...delta);
      const cosine = Math.min(Math.max((delta[1]! + bias) / (distance + 1e-4), -1), 1);
      const w = kernel(distance / GATHER_RADIUS) * facing(cosine);
      if (w <= cull) continue;
      if (seeded === "own" && cell[1] !== layer) continue;
      visited++;
      total += w;
      // Through the surface, not merely below the shaded point: a probe within
      // half a cell is in the surface's own layer and *is* the answer.
      if (delta[1]! < -0.5) behind += w;
    }
    return { total, visited, leak: total > 0 ? behind / total : 0 };
  };
  /** Over every height the floor can land at, since nothing in the solver picks it. */
  const sweep = (bias: number, cull: number) => {
    let low = Infinity;
    let high = 0;
    let fewest = 27;
    let leak = 0;
    let cells = 0;
    for (let i = 0; i < 100; i++) {
      const own = gather(i / 100, bias, cull, "own");
      low = Math.min(low, own.total);
      high = Math.max(high, own.total);
      fewest = Math.min(fewest, own.visited);
      const all = gather(i / 100, bias, cull, "all");
      leak = Math.max(leak, all.leak);
      cells += all.visited / 100;
    }
    return { range: high / low, fewest, leak, cells };
  };

  const biased = sweep(GATHER_BIAS, GATHER_CULL);
  // The disease. Unbiased, a floor that happens to sit high in its cell has its
  // whole probe layer behind it, and the stencil culls down to one probe — or,
  // at this cull, to none, which is the black patch.
  check(
    sweep(0, GATHER_CULL).fewest === 0,
    "an unbiased plane test no longer empties the stencil; this block guards nothing",
  );
  check(
    sweep(0, GATHER_BACKFACE).range > 20,
    "an unbiased plane test no longer collapses over the floor height",
  );
  // The cure, over the same sweep.
  check(biased.fewest >= 3, `the biased gather falls to ${biased.fewest} probes at some height`);
  check(
    biased.range < 6,
    `the surviving weight still ranges ${biased.range.toFixed(0)}:1 over the floor height`,
  );
  // And it pays for itself: a culled cell skips a hashmap walk and four
  // irradiance taps, which is what a cell in that loop actually costs.
  check(
    biased.cells < sweep(GATHER_BIAS, GATHER_BACKFACE).cells * 0.7,
    `the cull consults ${biased.cells.toFixed(1)} cells a pixel; the bias is not paid for`,
  );
  // The price, stated so it cannot creep: the bias lifts every cosine, so light
  // now crosses a wall with probes on both sides.
  check(sweep(0, GATHER_BACKFACE).leak < 0.02, "the unbiased plane test already leaked");
  check(biased.leak < 0.25, `through-wall leak is ${(biased.leak * 100).toFixed(0)}%`);

  check(
    /gatherIrradiance[\s\S]*?\.add\(GATHER_BIAS\)[\s\S]*?facing\.mul\(facing\)\.add\(GATHER_BACKFACE\)[\s\S]*?greaterThan\(GATHER_CULL\)/.test(
      source,
    ),
    "the gather no longer weights probes by which side of the surface they are on",
  );

  // --- Combining the two LODs.
  //
  // Now that the band is a full octave, most of it is places where only one of
  // the two grids was ever seeded. Mixing two *normalised* answers there blends
  // toward black, which would trade the step for a darker artifact covering
  // more of the screen. Summing unnormalised and dividing once makes an empty
  // LOD contribute nothing to either side of the fraction.
  const combine = (a: number[], b: number[], w: number) => {
    const sum = a[0]! * (1 - w) + b[0]! * w;
    const total = a[1]! * (1 - w) + b[1]! * w;
    return total > 1e-6 ? sum / total : 0;
  };
  const lit: [number, number] = [7 * 2.5, 2.5]; // value 7, standing on weight 2.5
  const dim: [number, number] = [3 * 1.25, 1.25];
  const empty: [number, number] = [0, 0];
  // Strictly inside the band, an empty LOD leaves the other one's answer intact
  // — not dimmed by (1 − w), which is what a mix of normalised values would do.
  for (const w of [0.01, 0.25, 0.5, 0.75, 0.99]) {
    near(combine(lit, empty, w), 7, `an empty far LOD pulls the answer at weight ${w}`);
    near(combine(empty, lit, w), 7, `an empty near LOD pulls the answer at weight ${w}`);
    // Both present: the answer stays between them, never outside.
    const mixed = combine(lit, dim, w);
    check(mixed <= 7 + 1e-12 && mixed >= 3 - 1e-12, `the blend overshoots at weight ${w}`);
  }
  // Only at the ends, where the band hands over outright, does an empty LOD win
  // — and there `lodBlend` has already stepped `lod` itself, so it is the same
  // "no probe here" the single-LOD path has always returned black for.
  near(combine(lit, empty, 1), 0, "weight 1 still reads the LOD it handed off from");
  near(combine(lit, dim, 0), 7, "weight 0 does not give the near LOD");
  near(combine(lit, dim, 1), 3, "weight 1 does not give the far LOD");
  check(
    /gathered\.xyz\.div\(gathered\.w\)/.test(bodyOf(source, "buildGather")),
    "the composite normalises each LOD separately again; an empty one will darken the blend",
  );

  // --- t₀ per LOD.
  //
  // c0's interval has to be a fixed fraction of the probe cell, or a coarse
  // probe partitions its own cell as if it were a fine one: every hit inside
  // the cell is handed to a cascade too high, and the high cascades are the
  // ones whose probe budget runs out (probeCapacity >> 2n) and fall back to sky.
  const far: number[] = [];
  for (let n = 0; n < CASCADES; n++) far.push((far.at(-1) ?? 0) + LENGTH_SCALE ** n);
  /** Which cascade takes a hit `cells` probe cells away, for a given `t0`. */
  const cascadeOf = (cells: number, spacing: number, t0: number) =>
    far.findIndex((f) => cells * spacing <= t0 * f);

  // The measurement that matters is in cells, because the probe is a cell wide:
  // a hit half a cell away is near-field to its probe whatever the LOD, so it
  // belongs to the same cascade at every LOD. With t₀ fixed it does not.
  for (const cells of [0.5, 1, 4]) {
    for (const lod of [1, 2, 3]) {
      const spacing = 2 ** lod;
      check(
        cascadeOf(cells, spacing, T0_OVER_DS0 * spacing) === cascadeOf(cells, 1, T0_OVER_DS0),
        `a hit ${cells} cells away changes cascade at LOD ${lod}`,
      );
    }
  }
  // And that it did, before — a fixed t₀ pushes the same hit two cascades up by
  // LOD 3, into the levels holding a sixteenth and a sixty-fourth of the probes.
  check(
    cascadeOf(0.5, 8, T0_OVER_DS0) - cascadeOf(0.5, 1, T0_OVER_DS0) >= 1,
    "a fixed t0 no longer misplaces a near-field hit; this block has nothing to guard",
  );
  // `uT0` is a knob on the multiple, which is fine; what must not come back is a
  // t₀ that does not scale with the LOD's own spacing.
  check(
    /const t0 = this\.spacingOf\(0, lod\)\.mul\(this\.uT0\)/.test(source) &&
      /uT0 = uniform\(T0_OVER_DS0\)/.test(source),
    "buildTrace no longer derives t0 from the LOD's own spacing",
  );
}

// --- Probe key (§6). Mirrors packKey/unpackCoord/lodOf.
{
  const packKey = (x: number, y: number, z: number, lod: number) => {
    const b = (v: number) => Math.min(COORD_MASK, Math.max(0, v + COORD_BIAS));
    return (
      ((b(x) +
        (b(y) << COORD_BITS) +
        (b(z) << (COORD_BITS * 2)) +
        (lod << (COORD_BITS * 3))) |
        (1 << 31)) >>>
      0
    );
  };
  const unpack = (key: number) => ({
    x: (key & COORD_MASK) - COORD_BIAS,
    y: ((key >>> COORD_BITS) & COORD_MASK) - COORD_BIAS,
    z: ((key >>> (COORD_BITS * 2)) & COORD_MASK) - COORD_BIAS,
    lod: (key >>> (COORD_BITS * 3)) & ((1 << LOD_BITS) - 1),
  });

  check(
    COORD_BITS * 3 + LOD_BITS <= 31,
    "key does not fit alongside the occupied marker",
  );

  const seen = new Set<number>();
  for (const x of [-COORD_BIAS, -37, -1, 0, 1, 42, COORD_BIAS - 1]) {
    for (const y of [-COORD_BIAS, 0, COORD_BIAS - 1]) {
      for (const z of [-COORD_BIAS, 0, COORD_BIAS - 1]) {
        for (let lod = 0; lod < 1 << LOD_BITS; lod++) {
          const key = packKey(x, y, z, lod);
          // A key is never zero, so zero can mean "empty slot" in the hashmap.
          check(key !== 0, `key for (${x},${y},${z},${lod}) is zero`);
          check(!seen.has(key), `key collision at (${x},${y},${z},${lod})`);
          seen.add(key);
          const back = unpack(key);
          check(
            back.x === x && back.y === y && back.z === z && back.lod === lod,
            `key round-trip failed for (${x},${y},${z},${lod})`,
          );
        }
      }
    }
  }
}

// --- Algorithm 3 (§5.1). Mirrors the countRays/offset kernels.
{
  // A three-level toy hierarchy: probe counts per cascade, and each probe's
  // parent one cascade up.
  const parents = [
    [0, 0, 1, 1, 2], // cascade 0 → cascade 1
    [0, 0, 1], //       cascade 1 → cascade 2
  ];
  const rays = [
    [3, 1, 4, 1, 5],
    [0, 0, 0],
    [0, 0],
  ];

  // Count bottom-up.
  for (let n = 0; n + 1 < rays.length; n++) {
    rays[n]!.forEach((count, p) => {
      rays[n + 1]![parents[n]![p]!] += count;
    });
  }
  check(
    rays[2]!.reduce((a, b) => a + b, 0) === 14,
    "ray counts do not reach the top intact",
  );

  // Hand out offsets top-down. atomicAdd makes the order arbitrary, so the test
  // is that the segments are disjoint and contiguous however they interleave.
  const cursor = rays.map((level) => level.slice());
  let global = 0;
  const offsets = rays.map((level) => level.map(() => 0));
  const top = rays.length - 1;
  for (let p = 0; p < rays[top]!.length; p++) {
    offsets[top]![p] = global;
    cursor[top]![p] = global;
    global += rays[top]![p]!;
  }
  for (let n = rays.length - 2; n >= 0; n--) {
    // Reverse order on purpose: the result must not depend on it.
    for (let p = rays[n]!.length - 1; p >= 0; p--) {
      const parent = parents[n]![p]!;
      offsets[n]![p] = cursor[n + 1]![parent]!;
      cursor[n + 1]![parent]! += rays[n]![p]!;
      cursor[n]![p] = offsets[n]![p]!;
    }
  }

  const covered = new Set<number>();
  rays[0]!.forEach((count, p) => {
    for (let i = 0; i < count; i++) {
      const index = offsets[0]![p]! + i;
      check(!covered.has(index), `sequence index ${index} handed out twice`);
      covered.add(index);
    }
  });
  check(covered.size === 14, "the sequence is not fully covered");
  for (let i = 0; i < 14; i++)
    check(covered.has(i), `sequence index ${i} was skipped`);

  // Probes sharing a parent get contiguous, adjacent segments — the property
  // §5.1 needs so that a parent's directions are covered evenly.
  for (let n = 0; n + 1 < rays.length; n++) {
    const byParent = new Map<number, number[]>();
    rays[n]!.forEach((count, p) => {
      if (count === 0) return;
      const list = byParent.get(parents[n]![p]!) ?? [];
      list.push(offsets[n]![p]!);
      byParent.set(parents[n]![p]!, list);
    });
    for (const [parent, starts] of byParent) {
      const span = Math.max(...starts) - Math.min(...starts);
      check(
        span < rays[n + 1]![parent]!,
        `cascade ${n} parent ${parent} segments are not contiguous`,
      );
    }
  }
}

// --- R2 sampling (§5.1). Mirrors the r2 helper.
{
  const r2 = (i: number): [number, number] =>
    [Math.imul(i, R2_A1 | 0) >>> 0, Math.imul(i, R2_A2 | 0) >>> 0].map(
      (v) => v / 4294967296,
    ) as [number, number];

  const PHI2 = 1.324717957244746;
  near(R2_A1 / 4294967296, 1 / PHI2, "R2 α₁ is not 1/φ₂", 1e-9);
  near(R2_A2 / 4294967296, 1 / PHI2 ** 2, "R2 α₂ is not 1/φ₂²", 1e-9);

  // The whole point over uniform random (§5.1): k samples must cover close to k
  // distinct directions. Uniform random covers only k(1 − 1/e) ≈ 0.632k and
  // needs O(k log k) draws for the rest — a coupon-collector cost the higher
  // cascades, with exponentially more buckets, cannot pay.
  const randomExpectation = 1 - Math.exp(-1);
  for (let n = 0; n < CASCADES; n++) {
    const T = theta(n);
    const k = directions(n);
    const buckets = new Set<number>();
    for (let i = 0; i < k; i++) {
      const [u, v] = r2(i);
      buckets.add(
        Math.min(Math.floor(v * T), T - 1) * 2 * T +
          Math.min(Math.floor(u * 2 * T), 2 * T - 1),
      );
    }
    check(
      buckets.size > randomExpectation * k * 1.05,
      `cascade ${n}: ${k} R2 samples cover ${buckets.size}/${k} directions, no better than random`,
    );
  }

  // Offsetting into the sequence must not degrade it — probes get contiguous
  // segments starting at arbitrary offsets, not always at zero.
  for (const offset of [1, 977, 65536, 3000000000]) {
    const k = directions(1);
    const T = theta(1);
    const buckets = new Set<number>();
    for (let i = 0; i < k; i++) {
      const [u, v] = r2((offset + i) >>> 0);
      buckets.add(
        Math.min(Math.floor(v * T), T - 1) * 2 * T +
          Math.min(Math.floor(u * 2 * T), 2 * T - 1),
      );
    }
    check(
      buckets.size > randomExpectation * k * 1.05,
      `offset ${offset}: coverage falls to ${buckets.size}/${k}`,
    );
  }

  // Large indices must stay exact: the u32 product is modular arithmetic, so
  // frac(i·α) is computed without the float cancellation i·α would suffer.
  for (const i of [1, 1023, 100003, 16777217, 4000000000]) {
    const [u] = r2(i);
    check(u >= 0 && u < 1, `R2 out of range at i=${i}`);
    const naive = (i * (R2_A1 / 4294967296)) % 1;
    if (i < 1 << 20)
      near(u, naive, `R2 disagrees with the direct form at i=${i}`, 1e-6);
  }
}

// --- Direction-bin splatting. Mirrors directionIndex's elevation axis.
{
  const T = theta(0);
  /** `z` at the centre of elevation bin `v`, under the equal-area map `v = (z+1)/2`. */
  const centre = (v: number) => ((Math.min(Math.max(v, 0), T - 1) + 0.5) / T) * 2 - 1;

  // What the irradiance integral ends up weighting a small light by: the cosine
  // at the *bin's* centre, not the light's own. A flat floor's normal is +z, so
  // this is the whole of the visible error.
  const nearest = (z: number) => centre(Math.min(Math.floor(((z + 1) / 2) * T), T - 1));
  // Uniform sub-bin jitter before the floor: `floor(x + j)` with `j ∈ [−0.5, 0.5)`
  // lands in `floor(x − 0.5)` and the bin above it, with the tent weights.
  const splat = (z: number) => {
    const t = ((z + 1) / 2) * T - 0.5;
    const lo = Math.floor(t);
    const f = t - lo;
    return centre(lo) * (1 - f) + centre(lo + 1) * f;
  };

  // In expectation the splat is not an approximation of the direction, it is the
  // direction — linear interpolation between evenly spaced centres is exact for
  // the identity. Away from the poles, where there is no bin above to lean on.
  for (let i = 1; i < 400; i++) {
    const z = -1 + 1 / T + (i / 400) * (2 - 2 / T);
    near(splat(z), z, `splatting shifts elevation ${z.toFixed(3)}`, 1e-12);
  }

  // And the thing that draws the circles: a step of a whole bin width in the
  // weight, at a fixed elevation from the light, i.e. on a circle around it.
  let jumpNearest = 0;
  let jumpSplat = 0;
  const STEPS = 20000;
  for (let i = 1; i < STEPS; i++) {
    const a = -1 + (2 * (i - 1)) / STEPS;
    const b = -1 + (2 * i) / STEPS;
    jumpNearest = Math.max(jumpNearest, Math.abs(nearest(b) - nearest(a)));
    jumpSplat = Math.max(jumpSplat, Math.abs(splat(b) - splat(a)));
  }
  near(jumpNearest, 2 / T, "quantised elevation does not step by a bin width", 1e-9);
  check(
    jumpSplat < 4 / STEPS,
    `splatting still steps: ${jumpSplat.toFixed(6)} per ${(2 / STEPS).toFixed(6)} of z`,
  );

  const source = readFileSync(new URL("src/SplitRC.ts", import.meta.url), "utf8");
  check(
    /const u = uint\(floor\(uv\.x\.mul\(wide\)\.add\(jitter\.x\)\.add\(wide\)\)\)\.mod/.test(
      source,
    ) && /floor\(uv\.y\.mul\(info\.theta\)\.add\(jitter\.y\)\)/.test(source),
    "directionIndex no longer jitters the bin, so a light quantises to a bin centre",
  );
  check(
    /const binJitter = stream\.yz\.sub\(0\.5\)/.test(source) &&
      /directionIndex\(dir, n, binJitter\)/.test(source),
    "the deposit no longer passes a sub-bin offset to directionIndex",
  );
}

// --- Octahedral irradiance border (§6). Mirrors buildBorder.
{
  // A border texel must resolve to the interior texel that is its true
  // octahedral neighbour, so a bilinear tap at the edge reads across the fold
  // instead of clamping to itself.
  const edge = IRRADIANCE_INNER - 1;
  const source = (tx: number, ty: number) => {
    let ix = Math.min(edge, Math.max(0, tx - 1));
    let iy = Math.min(edge, Math.max(0, ty - 1));
    if (tx === 0 || tx === IRRADIANCE_SIZE - 1) iy = edge - iy;
    if (ty === 0 || ty === IRRADIANCE_SIZE - 1) ix = edge - ix;
    return [ix, iy] as const;
  };

  for (let ty = 0; ty < IRRADIANCE_SIZE; ty++) {
    for (let tx = 0; tx < IRRADIANCE_SIZE; tx++) {
      const onBorder =
        tx === 0 ||
        ty === 0 ||
        tx === IRRADIANCE_SIZE - 1 ||
        ty === IRRADIANCE_SIZE - 1;
      if (!onBorder) continue;
      const [ix, iy] = source(tx, ty);
      check(
        ix >= 0 && ix <= edge && iy >= 0 && iy <= edge,
        `border (${tx},${ty}) reads outside the interior`,
      );
      const corner =
        (tx === 0 || tx === IRRADIANCE_SIZE - 1) &&
        (ty === 0 || ty === IRRADIANCE_SIZE - 1);
      if (corner) {
        // A corner is the antipode of the diagonally opposite interior corner.
        check(
          (ix === 0 || ix === edge) && (iy === 0 || iy === edge),
          `corner (${tx},${ty}) does not read a corner`,
        );
      }
    }
  }

  // Each side border reads its own adjacent interior column, mirrored along the
  // other axis: that is where the octahedral map folds, so a bilinear tap
  // straddling the edge blends across the fold instead of duplicating the edge.
  for (let ty = 1; ty <= IRRADIANCE_INNER; ty++) {
    const [lx, ly] = source(0, ty);
    const [rx, ry] = source(IRRADIANCE_SIZE - 1, ty);
    check(
      lx === 0 && rx === edge,
      `row ${ty} borders do not read their adjacent column`,
    );
    check(
      ly === edge - (ty - 1) && ry === ly,
      `row ${ty} is not mirrored across the fold`,
    );
  }
  for (let tx = 1; tx <= IRRADIANCE_INNER; tx++) {
    const [bx, by] = source(tx, 0);
    const [tx2, ty2] = source(tx, IRRADIANCE_SIZE - 1);
    check(
      by === 0 && ty2 === edge,
      `column ${tx} borders do not read their adjacent row`,
    );
    check(
      bx === edge - (tx - 1) && tx2 === bx,
      `column ${tx} is not mirrored across the fold`,
    );
  }
}

// --- Merge (Eq. 6). Mirrors buildMerge's compositing.
{
  const merge = (j: number, beta: number, i: number) => j + beta * i;

  // merge is premultiplied-alpha compositing with α = 1 − β, so it is
  // associative: merging a chain of intervals gives the same answer whichever
  // end you start from. The whole cascade walk depends on this.
  const chain = [
    { j: 0.2, beta: 0.5 },
    { j: 0.4, beta: 0.25 },
    { j: 0.1, beta: 1.0 },
  ];
  const tail = 0.9;
  let fromFar = tail;
  for (let n = chain.length - 1; n >= 0; n--)
    fromFar = merge(chain[n]!.j, chain[n]!.beta, fromFar);

  let accJ = 0;
  let accBeta = 1;
  for (const { j, beta } of chain) {
    accJ += accBeta * j;
    accBeta *= beta;
  }
  near(fromFar, merge(accJ, accBeta, tail), "merge is not associative");

  // An opaque interval (β = 0) blocks everything beyond it, and a transparent
  // one (J = 0, β = 1) — what a ray that passed straight through deposits — is
  // the identity.
  near(
    merge(0.7, 0, 123),
    0.7,
    "an opaque interval leaks light from beyond it",
  );
  near(merge(0, 1, 0.42), 0.42, "a transparent interval is not the identity");

  // --- The cascade handoff band. Mirrors CASCADE_OVERLAP in buildTrace.
  //
  // The band exists to move where a hit is *stored* without changing what it is
  // worth, so the check is that the split is exact for every split point. Get
  // this wrong and the seam it was meant to hide becomes a bright or dark ring
  // at the same place — a plausible-looking one, since it still falls off with
  // distance like light.
  const CASCADE_OVERLAP = 0.35;
  const L = 0.83;
  for (let i = 0; i <= 16; i++) {
    const a = i / 16;
    // Lower cascade keeps a·L and passes (1 − a) of whatever is above it; the
    // upper one holds the hit whole and stops the ray there.
    const upper = merge(L, 0, 999);
    near(
      merge(a * L, 1 - a, upper),
      L,
      `the handoff loses radiance at a = ${a}`,
      1e-12,
    );
  }
  // Cascades below the pair still see a closed ray, whatever the split: their
  // β = 1 passes the composited value down untouched.
  near(merge(0, 1, L), L, "the handoff does not survive a pass-through below it");

  // --- ...but a bin is not a ray, which is why the split is a coin and not a
  // fraction. A bin stores mean(J) and mean(β) and composes them once, so a ray
  // that hands up part of itself lends its β to every *other* ray in the bin as
  // well. Two rays are enough to see it: one hitting inside the band, one
  // passing the pair entirely and reaching a far field F.
  /** A bin: independent means of J and β, composited against `above` once. */
  const bin = (rays: Array<[j: number, beta: number]>, above: number) =>
    merge(
      rays.reduce((s, r) => s + r[0], 0) / rays.length,
      rays.reduce((s, r) => s + r[1], 0) / rays.length,
      above,
    );
  const F = 0.11;
  const passing: [number, number] = [0, 1];
  const truth = (L + F) / 2;
  for (let i = 1; i <= 16; i++) {
    const a = i / 16;
    // Whole rays. Kept: the lower cascade absorbs, and the upper never hears of
    // the ray — it ended before the upper's interval. Handed: the lower sees
    // straight through and the upper borrows it whole. Both are exact, so every
    // mixture of them is, and `a` only decides how they mix.
    const kept = bin([[L, 0], passing], bin([passing], F));
    const handed = bin([passing, passing], bin([[L, 0], passing], F));
    near(kept, truth, "keeping the hit whole biases the bin");
    near(handed, truth, "handing the hit up whole biases the bin");
    near(a * kept + (1 - a) * handed, truth, `the coin biases the bin at a = ${a}`, 1e-12);

    // The fraction, for contrast: aL kept with β = 1 − a, against an upper that
    // borrows the hit whole regardless. Wrong everywhere except a = 0, worst at
    // a = 1 where the hit is deposited twice — which is the band's inner edge,
    // a hard step at a fixed distance from the light.
    const fractional = bin([[a * L, 1 - a], passing], bin([[L, 0], passing], F));
    check(
      Math.abs(fractional - truth) > 1e-3,
      `the fraction is already exact at a = ${a}; this block guards nothing`,
    );
  }

  // The two sides name the same interval of t only because both are the same
  // fraction of the shared bound — the lower cascade's band is (OVERLAP·far,
  // far], the upper's is (OVERLAP·near, near], and near = far is what the
  // cascade-scaling block above checks. One constant for both is what keeps them
  // from drifting into a gap where a hit is deposited twice, or not at all.
  check(
    CASCADE_OVERLAP > 0 && CASCADE_OVERLAP < 1,
    "the handoff band is empty or swallows the whole interval",
  );
  // And the band must stay inside the interval that owns it. Reaching below the
  // near bound puts a discontinuity there — held whole on one side, split on the
  // other — which is the same ring at a different radius, not one fewer ring.
  // The bound is `t` from the cascade-scaling block: near_n = t_{n−1}, far_n = t_n.
  for (let n = 1; n < CASCADES; n++) {
    const far = (LENGTH_SCALE ** (n + 1) - 1) / (LENGTH_SCALE - 1);
    const nearBound = (LENGTH_SCALE ** n - 1) / (LENGTH_SCALE - 1);
    check(
      CASCADE_OVERLAP * far > nearBound,
      `cascade ${n}'s handoff band reaches below its own near bound`,
    );
  }
  // Wide enough to be worth having: a shell that only dissolves over the last
  // few percent of an interval is still a shell.
  check(
    CASCADE_OVERLAP < 0.5,
    "the handoff band covers less than half the interval; the shell will still read",
  );

  const source = readFileSync(
    new URL("src/SplitRC.ts", import.meta.url),
    "utf8",
  );
  check(
    new RegExp(`const CASCADE_OVERLAP = ${CASCADE_OVERLAP};`).test(source),
    `CASCADE_OVERLAP is no longer ${CASCADE_OVERLAP}; this block mirrors it`,
  );
  // The upper side has to take the hit whole. Depositing a·L on one side and
  // (1 − a)·L on the other is the natural-looking spelling and it is wrong:
  // β = 1 − a on the lower cascade already scales what comes from above.
  check(
    /borrowed[\s\S]*?emit\.assign\(radiance\);[\s\S]*?beta\.assign\(float\(0\)\);/.test(
      source,
    ),
    "the borrowing cascade no longer takes the hit whole",
  );
  check(
    /const keep =[\s\S]*?\.greaterThan\(pick\)/.test(source),
    "the handoff is a fraction again, not a coin; the bin bias above is back",
  );
  check(
    !/radiance\.mul\(handoff\)/.test(source),
    "buildTrace deposits a fraction of the hit radiance again",
  );
  // And the two sides must read the same coin, or the band both double-counts
  // and drops hits instead of just biasing them.
  check(
    /\.and\(keeps\[n - 1\]!\.not\(\)\)/.test(source),
    "the borrowing cascade no longer checks whether the one below let the ray go",
  );
  // The coin must not track the ray's direction, or a hemisphere of every probe
  // hands up and the other keeps.
  check(
    /private r3\([\s\S]*?R2_A3[\s\S]*?\}/.test(source) && /const pick = stream\.x/.test(source),
    "the handoff coin is no longer drawn from its own generator",
  );
}

// --- Pre-averaged parent cones and the missing-parent prior (buildAverage,
// buildMerge). The merge reads one averaged value per trilinear neighbour where
// it used to read four cones; the average has to be over exactly the same four,
// and the eight weights still have to sum to 1.
{
  const source = readFileSync(
    new URL("src/SplitRC.ts", import.meta.url),
    "utf8",
  );
  // buildAverage enumerates children the same way buildMerge did — the block
  // above already checks that enumeration against the parent map, so this only
  // has to check the arithmetic that replaced the inline `.mul(0.25)`.
  const CHILDREN = 4;
  const cones = [0.2, 0.5, 0.1, 0.4];
  const weights = [0.42, 0.14, 0.14, 0.05, 0.14, 0.05, 0.05, 0.01];
  const total = weights.reduce((a, b) => a + b, 0);
  const normalised = weights.map((w) => w / total);
  const inline = normalised.reduce(
    (acc, w) => acc + cones.reduce((s, c) => s + c, 0) * w * 0.25,
    0,
  );
  const preAveraged = normalised.reduce(
    (acc, w) => acc + (cones.reduce((s, c) => s + c, 0) / CHILDREN) * w,
    0,
  );
  near(preAveraged, inline, "pre-averaging changes the merged cone", 1e-12);
  near(
    preAveraged,
    cones.reduce((s, c) => s + c, 0) / CHILDREN,
    "normalised neighbour weights no longer sum to 1",
    1e-12,
  );

  // The one case the old spelling got wrong. Renormalising over the probes that
  // exist leaves every weight at 0 when *none* exists, which only happens when
  // the cascade above ran out of capacity — and `above = 0` then tells the probe
  // there is nothing beyond its own interval at all. Capacity runs out over a
  // region, so the result is a dark patch whose edge reads as a cascade seam.
  const aboveFor = (present: boolean[]) => {
    const kept = weights.map((w, i) => (present[i] ? w : 0));
    const sum = kept.reduce((a, b) => a + b, 0);
    const SKY = 0.3;
    if (sum <= 0) return SKY; // the fallback under test
    return kept.reduce((acc, w) => acc + (w / sum) * 1, 0);
  };
  near(aboveFor(weights.map(() => true)), 1, "a full stencil is not the identity");
  near(
    aboveFor([false, false, false, false, false, false, false, true]),
    1,
    "a single surviving parent is not renormalised to 1",
  );
  near(
    aboveFor(weights.map(() => false)),
    0.3,
    "a parentless probe falls back to black instead of the sky",
  );
  check(
    /covered\.lessThanEqual\(0\)[\s\S]{0,80}above\.assign\(this\.uSky\)/.test(
      source,
    ),
    "the merge no longer falls back to the sky when no parent probe exists",
  );
  // The merge kernel is at WebGPU's eight-storage-buffers-per-stage limit, which
  // is why the history lookup moved out of it. Putting it back costs two buffers
  // and the kernel stops compiling on some backends rather than misbehaving.
  check(
    !bodyOf(source, "buildMerge").includes("lookupHistory"),
    "the merge resolves history again; it has no storage-buffer slots for it",
  );
}

// --- Per-probe work hoisted out of per-texel and per-direction kernels. Each of
// these was correct and quietly did the same lookup 32 or 64 times; the shapes
// they depend on are what this block pins.
{
  const source = readFileSync(
    new URL("src/SplitRC.ts", import.meta.url),
    "utf8",
  );
  const constant = (name: string) => {
    const found = new RegExp(`const ${name} = (\\d+)`).exec(source);
    check(found !== null, `${name} is gone; this block mirrors it`);
    return Number(found![1]);
  };
  const IRRADIANCE_SIZE = constant("IRRADIANCE_INNER") + 2;
  const IRRADIANCE_TEXELS = IRRADIANCE_SIZE * IRRADIANCE_SIZE;
  const THETA_0 = constant("THETA_0");
  const directions0 = 2 * THETA_0 * THETA_0;

  // buildIrradiance caches a probe's cones in workgroup memory and reads them
  // back after one barrier. That is only a probe's worth of cones if a workgroup
  // is exactly a probe's worth of texels — otherwise threads read another
  // probe's cache, which is wrong rather than slow. It passes the size
  // explicitly for that reason.
  check(
    /const IRRADIANCE_TEXELS = IRRADIANCE_SIZE \* IRRADIANCE_SIZE;/.test(source),
    "IRRADIANCE_TEXELS is no longer the octahedral tile",
  );
  check(
    /info\.probeCapacity \* IRRADIANCE_TEXELS,\s*\/\/[\s\S]*?\[IRRADIANCE_TEXELS\],/.test(
      source,
    ),
    "buildIrradiance no longer pins its workgroup size to one probe",
  );
  // The cache holds one entry per c0 direction and is filled by the first
  // `directions` threads of the workgroup, so it must fit inside a workgroup.
  check(
    directions0 <= IRRADIANCE_TEXELS,
    `c0 has ${directions0} directions but only ${IRRADIANCE_TEXELS} threads to load them`,
  );
  // WebGPU's floor for workgroup storage is 16384 bytes; a vec3 costs 16.
  check(
    directions0 * 16 <= 16384,
    "the cone cache is over WebGPU's workgroup storage floor",
  );
  // The barrier has to be reached by every invocation, so it cannot sit inside
  // the `live` branch — `local` is uniform across the workgroup but the compiler
  // is not told that.
  check(
    /\n {8}workgroupBarrier\(\);/.test(source),
    "the irradiance barrier is no longer at the top level of the kernel",
  );

  // buildProbeNeighbours resolves six neighbours per probe; the filter reads
  // them per texel. Six is the lattice's face count and the two have to agree.
  check(
    /probeNeighbour = uintArray\(this\.layout\[0\]!\.probeCapacity \* 6\)/.test(
      source,
    ),
    "probeNeighbour is no longer six entries per c0 probe",
  );
  check(
    !bodyOf(source, "buildProbeFilterPass").includes("this.lookup("),
    "the probe filter walks the hashmap again, once per texel",
  );

  // The gather's cost is per gathered pixel, so the divisor has to come from the
  // output size rather than be fixed — that is the whole point of the budget.
  const GI_PIXELS = /const GI_PIXELS = (\d+) \* (\d+);/.exec(source);
  check(GI_PIXELS !== null, "GI_PIXELS is gone; the gather is unbudgeted");
  const budget = Number(GI_PIXELS![1]) * Number(GI_PIXELS![2]);
  const scaleFor = (w: number, h: number) =>
    Math.max(1, Math.ceil(Math.sqrt((w * h) / budget)));
  for (const [w, h] of [
    [3840, 2160],
    [2560, 1440],
    [1920, 1080],
    [1280, 720],
    [640, 360],
  ]) {
    const scale = scaleFor(w!, h!);
    const gathered = Math.ceil(w! / scale) * Math.ceil(h! / scale);
    check(
      gathered <= budget * 1.02,
      `${w}x${h}: gather runs at ${gathered} pixels, over the ${budget} budget`,
    );
    // And not so far under it that the picture is thrown away for nothing: one
    // divisor coarser is what the next step down would cost.
    check(
      scale === 1 || gathered * 4 > budget,
      `${w}x${h}: divisor ${scale} is a step coarser than the budget needs`,
    );
  }
}

// --- Splat skipping (VoxelScene#splatInputsChanged). Mirrors the snapshot's
// layout and the four transitions it has to catch. Getting this wrong is the
// worst kind of bug in here: the grid silently keeps a stale scene, and stale
// geometry lights and occludes exactly like real geometry.
{
  const MAX_OBJECTS = 4096;
  const BLOCKS: [number, number][] = [
    [0, 16],
    [MAX_OBJECTS * 16, 4],
    [MAX_OBJECTS * 20, 4],
  ];
  check(
    BLOCKS[2]![0] + MAX_OBJECTS * BLOCKS[2]![1] === MAX_OBJECTS * 24,
    "the snapshot's three blocks do not fill it",
  );

  // The mirror: one snapshot, three source arrays, compared over the live count.
  const snapshot = new Float32Array(MAX_OBJECTS * 24);
  const sources = BLOCKS.map(([, stride]) => new Float32Array(MAX_OBJECTS * stride));
  let dirty = true;
  let count = 0;
  const changed = (): boolean => {
    let result = dirty;
    dirty = false;
    for (let b = 0; b < BLOCKS.length; b++) {
      const [base, stride] = BLOCKS[b]!;
      for (let i = 0; i < count * stride; i++) {
        if (snapshot[base + i] !== sources[b]![i]) {
          snapshot[base + i] = sources[b]![i]!;
          result = true;
        }
      }
    }
    return result;
  };

  count = 3;
  check(changed(), "the first frame does not splat");
  check(!changed(), "a scene that did not move splats again");
  sources[0]![16 * 1 + 12] = 5; // object 1 moved
  check(changed(), "a moved object does not re-splat");
  check(!changed(), "the move is re-splatted a second time");
  sources[2]![4 * 2 + 1] = 0.7; // object 2's emissive
  check(changed(), "a material change does not re-splat");
  check(!changed(), "the material change is re-splatted a second time");

  // The case the compare cannot see: the point buffer was rewritten under
  // unchanged transforms, which is what `splatDirty` is for.
  dirty = true;
  check(changed(), "a re-tessellation does not force a splat");

  // And the case the blocks' fixed bases are for: a change past the live count
  // is invisible now but must not be mistaken for unchanged once it is live.
  sources[0]![16 * 7 + 12] = 9;
  check(!changed(), "an object past the live count re-splats");
  count = 8;
  check(changed(), "an object that became live does not re-splat");
}

// --- Voxel point budget (VoxelScene). The static build and the per-frame
// dynamic tail write into one buffer at different offsets; an overlap would
// have runtime-spawned geometry silently overwrite the level around it.
{
  const DYNAMIC_SHARE = 1 / 16;
  for (const maxPoints of [1024, 1 << 16, 1 << 22, 3_000_000]) {
    const dynamicBudget = Math.floor(maxPoints * DYNAMIC_SHARE);
    const staticBudget = maxPoints - dynamicBudget;
    // Worst case: the static pass fills its budget and the dynamic pass then
    // fills the tail from that offset.
    const highest = staticBudget + dynamicBudget;
    check(
      dynamicBudget >= 1,
      `maxPoints ${maxPoints}: no room reserved for dynamic meshes`,
    );
    check(
      highest <= maxPoints,
      `maxPoints ${maxPoints}: dynamic tail writes past the buffer`,
    );
  }
}

// --- Debug views (SPLIT_DEBUG_VIEWS vs buildComposite). The composite shader
// switches on a view's index in that list, so a view added without a branch —
// or a branch numbered out of order — silently renders the lit frame instead.
{
  const source = readFileSync(
    new URL("src/SplitRC.ts", import.meta.url),
    "utf8",
  );
  const list =
    /SPLIT_DEBUG_VIEWS = \[([\s\S]*?)\] as const/.exec(source)?.[1] ?? "";
  const views = [...list.matchAll(/'([a-zA-Z]+)'|"([a-zA-Z]+)"/g)].map(
    (m) => m[1] ?? m[2],
  );
  const branches = [...source.matchAll(/mode\.equal\(int\((\d+)\)\)/g)].map(
    (m) => Number(m[1]),
  );
  check(views.length > 1, "SPLIT_DEBUG_VIEWS did not parse");
  check(
    views[0] === "composite",
    "composite must be index 0: it is the shader's Else",
  );
  check(
    branches.join() ===
      views
        .slice(1)
        .map((_, i) => i + 1)
        .join(),
    `debug branches [${branches}] do not match views 1..${views.length - 1}`,
  );
}

// --- inspectPixel's CPU mirrors (packKeyCpu/hashSlotCpu vs packKey/hashKeyToSlot).
// The inspector resolves a pixel's probe indices on the CPU, so its arithmetic
// has to be the shader's. Drift here does not fail loudly: it reports a real
// probe belonging to some other cell.
{
  const source = readFileSync(
    new URL("src/SplitRC.ts", import.meta.url),
    "utf8",
  );
  const body = (name: string): string => {
    const at = source.indexOf(name);
    check(at >= 0, `${name} is gone from SplitRC.ts`);
    const open = source.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) return source.slice(open, i);
    }
    throw new Error(`${name} is unbalanced`);
  };
  // Comments stripped: these checks are about the arithmetic, and a comment that
  // names a spelling in order to warn against it would otherwise read as the
  // spelling itself.
  const code = (name: string): string =>
    body(name)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
  // Zeros dropped: the CPU mirrors are full of `>>> 0` the shader does not need,
  // u32 arithmetic being the shader's default rather than something to restore.
  const constants = (text: string) =>
    [...text.matchAll(/\b\d{2,}\b/g)]
      .map((m) => Number(m[0]))
      .sort((a, b) => a - b)
      .join();

  check(
    constants(code("const hashKeyToSlot")) ===
      constants(code("function hashSlotCpu")),
    "hashSlotCpu no longer avalanches like hashKeyToSlot",
  );
  for (const name of ["COORD_BIAS", "COORD_MASK", "COORD_BITS"]) {
    check(
      code("function packKeyCpu").includes(name),
      `packKeyCpu stopped using ${name}`,
    );
    check(
      code("const packKey").includes(name),
      `packKey stopped using ${name}`,
    );
  }
  for (const name of ["const packKey", "function packKeyCpu"]) {
    check(
      code(name).includes("KEY_OCCUPIED"),
      `${name} no longer marks the key as occupied`,
    );
    // Not a signed shift by 31. JavaScript's shift is signed, so that spelling is
    // −2147483648, and passing the negative to TSL's `uint()` dropped the bit on
    // the GPU while the CPU mirror kept it — the two then agreed on no key at all,
    // and inspectPixel reported every cell missing while the solve was fine.
    check(
      !/1\s*<<\s*31/.test(code(name)),
      `${name} marks the key with a signed shift`,
    );
  }
  check(
    /const KEY_OCCUPIED = 0x80000000/.test(source),
    "KEY_OCCUPIED is no longer the unsigned bit-31 literal",
  );
}

console.log("splitrc.check: ok");
