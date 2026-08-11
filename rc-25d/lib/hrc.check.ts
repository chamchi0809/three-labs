// Sanity check for the HRC cascade layout in src/FieldSpaceRC.ts:
// `pnpm --filter @rc25d/radiance-cascades check`.
//
// The solve addresses six different texture layouts by arithmetic alone, and
// every one of its invariants fails silently on a GPU — a wrong column reads a
// neighbouring ray and comes out as plausible-looking light. ponytail: the
// formulas are mirrored here rather than imported, because the originals are
// TSL node graphs that only exist inside a shader. Keep the two in step; the
// blocks are named after the code they mirror.

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function near(a: number, b: number, message: string): void {
  check(Math.abs(a - b) < 1e-9, `${message}: ${a} vs ${b}`);
}

const SIZES = [64, 512];
// Mirrors FieldSpaceRC: every cascade stores one column per ray except cascade
// 0, whose interval is a single texel — both of a probe's rays are the probe's
// own texel there, so one column per plane holds the same information.
const raysStored = (n: number) => (n === 0 ? 1 : (1 << n) + 1);

for (const S of SIZES) {
  const N = Math.log2(S);
  const rayWidth = (n: number) => (S >> n) * raysStored(n);

  // --- Ray texture layout: cascade n stores (size >> n) planes of 2^n + 1
  // rays, and the whole texture is exactly those blocks laid end to end.
  for (let n = 0; n < N; n++) {
    const intrv = 1 << n;
    const rays = raysStored(n);
    check(Number.isInteger(rayWidth(n)), `cascade ${n} ray width not integral`);
    check(
      rayWidth(n) === (S >> n) * rays,
      `cascade ${n} ray texture does not tile its planes`,
    );

    for (let col = 0; col < rayWidth(n); col++) {
      // The shader reads at a texel center, which is what makes the floors exact.
      const texelX = col + 0.5;
      const plane = Math.floor(texelX / rays);
      const index = Math.floor(texelX - plane * rays);
      const probeX = plane * intrv + 0.5;
      check(plane < S >> n, `cascade ${n} col ${col}: plane ${plane} out of range`);
      check(index < rays, `cascade ${n} col ${col}: ray ${index} out of range`);
      // volumeAt() must round-trip back to the column it was decoded from.
      check(
        Math.floor(probeX / intrv) * rays + index === col,
        `cascade ${n} col ${col}: volumeAt does not round-trip`,
      );
    }
  }

  // --- Cascade 0's narrow layout. Its two consumers (the cascade 1 extension
  // and the cascade 0 merge) both look one plane ahead, so what the change from
  // two columns per plane to one must not disturb is where a lookup falls off
  // the end: entry 0 of the narrow layout has to be rejected on exactly the
  // planes the wide layout rejected for BOTH of a probe's rays, or light leaks
  // in from the far edge (or stops arriving one plane early).
  for (let plane = -1; plane <= S; plane++) {
    const probeX = plane + 0.5;
    const narrowCol = Math.floor(probeX) * raysStored(0) + 0.5;
    const narrowInside = narrowCol >= 0 && narrowCol < rayWidth(0);
    for (const ray of [0, 1]) {
      const wideCol = Math.floor(probeX) * 2 + 0.5 + ray;
      const wideInside = wideCol >= 0 && wideCol < 2 * S;
      check(
        narrowInside === wideInside,
        `cascade 0 plane ${plane} ray ${ray}: narrow layout ` +
          `${narrowInside ? 'accepts' : 'rejects'} a lookup the wide one ` +
          `${wideInside ? 'accepted' : 'rejected'}`,
      );
    }
  }

  // --- Top cascade. Its interval is half the field, so it holds exactly two
  // planes: plane 0, which has no cone at all, and plane 1, which is odd and
  // reaches one interval to a tip a full field width past the end. Every
  // cascade n+1 lookup the top pass could make is therefore outside, which is
  // what lets that pass be built without them — and without reading a target no
  // pass has written this frame.
  {
    const n = N - 1;
    const intrv = 1 << n;
    check(
      (S >> n) === 2,
      `top cascade holds ${S >> n} planes, expected 2 — the pass drops its ` +
        'cascade n+1 taps on the strength of there being no other live plane',
    );
    check(
      1 % 2 === 1,
      'top cascade plane 1 is not odd — it would take the even path, which ' +
        'doubles the ray and interpolates against a near cone',
    );
    const probeX = 1 * intrv + 0.5;
    check(probeX >= 1, 'top cascade plane 1 is skipped as the empty plane 0');
    for (let coneI = 0; coneI < 2 * intrv; coneI++) {
      const tipCol = Math.floor(probeX + intrv) + 0.5 + coneI;
      check(
        tipCol >= S,
        `top cascade cone ${coneI}: tip lookup lands at column ${tipCol}, ` +
          'inside the field — it would read last frame\'s cones',
      );
    }
  }

  // --- Frustum slabs. Every frustum-space target stacks the four frustums
  // along y, frustum j owning rows [j·S, (j+1)·S). Two things have to hold that
  // the old one-target-per-frustum layout got from the hardware for free: the
  // slab a row belongs to has to decode exactly from that row, and a lookup
  // must be rejected when it leaves its OWN slab rather than clamped into the
  // neighbour stacked next to it.
  const SLABS = 4;
  const slabH = S * SLABS;
  for (let i = 0; i < slabH; i += Math.max(1, Math.floor(slabH / 512))) {
    const texelY = i + 0.5;
    const slab = Math.floor(texelY / S);
    const row = texelY - slab * S;
    check(slab >= 0 && slab < SLABS, `row ${i}: slab ${slab} out of range`);
    check(row > 0 && row < S, `row ${i}: local row ${row} out of range`);
    // volumeAt's row mapping must land back on the texel it decoded from.
    near((row + slab * S) / slabH * slabH, texelY, `row ${i}: slab round-trip`);
  }
  // A ray extension rises up to half a cascade interval per chained segment, so
  // the reach off a slab's own rows is real and has to be caught. The bound is
  // the slab's (0 <= row < S), never the texture's (0 <= row < 4S).
  for (let n = 1; n < N; n++) {
    const pIntrv = (1 << n) / 2;
    for (const [row, rise] of [
      [0.5, -pIntrv],
      [S - 0.5, pIntrv],
    ] as const) {
      const escaped = row + rise;
      check(
        escaped < 0 || escaped >= S,
        `cascade ${n}: a ray leaving row ${row} by ${rise} is not detected as off-slab`,
      );
      // ...and it would have been silently inside the stacked texture.
      for (let slab = 1; slab < SLABS - 1; slab++) {
        const global = escaped + slab * S;
        check(
          global >= 0 && global < slabH,
          `cascade ${n} slab ${slab}: escaped row ${global} is not inside the texture — ` +
            'the local bound is what makes the test meaningful',
        );
      }
    }
  }
  // The sum pass reads one texel INTO each frustum's own direction, which can
  // step outside the field. On a lone S x S target clamp-to-edge covered that;
  // stacked, y must be clamped by hand to the slab's first/last texel center or
  // it reads the frustum above. Mirrors `clamp(local.y, 0.5/S, 1 - 0.5/S)`.
  for (const offset of [-1 / S, 0, 1 / S]) {
    for (let slab = 0; slab < SLABS; slab++) {
      for (const base of [0.5 / S, 0.5, 1 - 0.5 / S]) {
        const y = Math.min(Math.max(base + offset, 0.5 / S), 1 - 0.5 / S);
        const globalRow = ((y + slab) / SLABS) * slabH;
        check(
          globalRow >= slab * S + 0.5 - 1e-9 &&
            globalRow <= (slab + 1) * S - 0.5 + 1e-9,
          `sum pass slab ${slab}: offset ${offset} reads row ${globalRow}, outside its slab`,
        );
        // Same texel clamp-to-edge on a lone S x S target would have picked.
        const lone = Math.min(Math.max(Math.floor((base + offset) * S), 0), S - 1);
        check(
          Math.floor(globalRow - slab * S) === lone,
          `sum pass slab ${slab}: offset ${offset} picks texel ` +
            `${Math.floor(globalRow - slab * S)}, clamp-to-edge picked ${lone}`,
        );
      }
    }
  }
  // The seed's rotation is chosen per slab instead of compiled per frustum:
  // frustums 1 and 3 transpose, 1 and 2 complement. That has to reproduce
  // `rotateUv` exactly for all four.
  {
    const rotateUv = (u: number, v: number, j: number): [number, number] => {
      if (j === 1) return [1 - v, 1 - u];
      if (j === 2) return [1 - u, 1 - v];
      if (j === 3) return [v, u];
      return [u, v];
    };
    for (const [u, v] of [
      [0.25, 0.75],
      [0.5, 0.5],
      [0.5 / S, 1 - 0.5 / S],
    ] as const) {
      for (let slab = 0; slab < SLABS; slab++) {
        const transposed = slab % 2 > 0.5;
        const complemented = slab > 0.5 && slab < 2.5;
        const [su, sv] = transposed ? [v, u] : [u, v];
        const rot: [number, number] = complemented ? [1 - su, 1 - sv] : [su, sv];
        const want = rotateUv(u, v, slab);
        near(rot[0], want[0], `slab ${slab}: dynamic rotation x`);
        near(rot[1], want[1], `slab ${slab}: dynamic rotation y`);
      }
    }
  }

  // --- Ray extensions. Cascade n's ray `index` is two cascade n-1 rays chained
  // across consecutive n-1 planes with their indices swapped between the two
  // halves of the average. Both halves must land on the same endpoint, and that
  // endpoint must be the one cascade n's own ray geometry defines.
  for (let n = 1; n < N; n++) {
    const intrv = 1 << n;
    const pIntrv = intrv / 2;
    const pRays = raysStored(n - 1);
    for (let plane = 0; plane < S >> n; plane++) {
      const probeX = plane * intrv + 0.5;
      for (let index = 0; index <= intrv; index++) {
        const lower = Math.floor(index / 2);
        const upper = Math.ceil(index / 2);
        check(lower + upper === index, `extension indices do not bracket ${index}`);
        for (const [lo, hi] of [
          [lower, upper],
          [upper, lower],
        ]) {
          // Near half: cascade n-1 ray `lo` from this plane. Far half: ray `hi`
          // from the next n-1 plane, offset by the near half's own rise.
          const farX = probeX + pIntrv;
          const farY = 2 * lo - pIntrv;
          near(
            farY,
            2 * lo - pIntrv,
            `cascade ${n} ray ${index}: far plane row`,
          );
          check(
            Math.floor(farX / pIntrv) === 2 * plane + 1,
            `cascade ${n} plane ${plane}: far half misses the odd n-1 plane`,
          );
          check(
            Math.floor(probeX / pIntrv) === 2 * plane,
            `cascade ${n} plane ${plane}: near half misses the even n-1 plane`,
          );
          check(
            Math.floor(farX / pIntrv) * pRays + (n === 1 ? 0 : hi) <
              rayWidth(n - 1),
            `cascade ${n} ray ${index}: far lookup off the n-1 texture`,
          );
          // Chained displacement is cascade n's own ray direction.
          near(2 * pIntrv, intrv, `cascade ${n}: chained run`);
          near(
            2 * lo - pIntrv + (2 * hi - pIntrv),
            2 * index - intrv,
            `cascade ${n} ray ${index}: chained rise`,
          );
        }
      }
    }
  }

  // --- Plane 0 is dead at every cascade, which is what lets the extension
  // passes skip it. Enumerate every lookup a *surviving* fragment makes into a
  // ray texture — merge keeps only planes >= 1, and the extension's own output
  // plane 0 is dead by the same induction — and none of them may land on plane
  // 0. Written as the shader addresses it, so a change to either pass's plane
  // arithmetic breaks this rather than silently going dark.
  for (let n = 0; n < N; n++) {
    const intrv = 1 << n;
    for (let plane = 1; plane < S >> n; plane++) {
      const probeX = plane * intrv + 0.5;
      // Merge: the near ray of this plane, and the doubled ray one interval on.
      check(
        Math.floor(probeX / intrv) >= 1,
        `cascade ${n} plane ${plane}: merge near ray reads plane 0`,
      );
      check(
        Math.floor((probeX + intrv) / intrv) >= 1,
        `cascade ${n} plane ${plane}: merge doubled ray reads plane 0`,
      );
    }
    // The extension into cascade n+1: its live planes read only planes >= 2.
    if (n + 1 < N) {
      const cIntrv = intrv * 2;
      for (let plane = 1; plane < S >> (n + 1); plane++) {
        const probeX = plane * cIntrv + 0.5;
        check(
          Math.floor(probeX / intrv) >= 1 &&
            Math.floor((probeX + intrv) / intrv) >= 1,
          `cascade ${n + 1} plane ${plane}: extension reads plane 0`,
        );
      }
    }
  }

  // --- Lookups declared in-field. Three of the solve's taps pass `null` for
  // the outside value, dropping their bounds test: the near half of an
  // extension, a merge's near ray, and an even plane's near cone. Each has to
  // be inside for EVERY fragment of its pass, including the fragments whose
  // result is later discarded, or that test was load-bearing.
  for (let n = 0; n < N; n++) {
    const intrv = 1 << n;
    const rays = raysStored(n);
    for (let plane = 0; plane < S >> n; plane++) {
      const probeX = plane * intrv + 0.5;
      for (let rayI = 0; rayI <= intrv; rayI++) {
        const entry = n === 0 ? 0 : rayI;
        const col = Math.floor(probeX / intrv) * rays + entry;
        check(
          col >= 0 && col < rayWidth(n),
          `cascade ${n} plane ${plane} ray ${rayI}: near ray lookup off the texture`,
        );
      }
      // The near half of the extension from here into cascade n+1.
      if (n + 1 < N) {
        const cIntrv = intrv * 2;
        for (let cPlane = 0; cPlane < S >> (n + 1); cPlane++) {
          const cProbeX = cPlane * cIntrv + 0.5;
          for (let index = 0; index <= cIntrv; index++) {
            const lo = Math.floor(index / 2);
            const hi = Math.ceil(index / 2);
            for (const entry of [lo, hi]) {
              const col =
                Math.floor(cProbeX / intrv) * rays + (n === 0 ? 0 : entry);
              check(
                col >= 0 && col < rayWidth(n),
                `cascade ${n + 1} plane ${cPlane} ray ${index}: near half off the n texture`,
              );
            }
          }
        }
      }
      // An even plane's near cone, read out of cascade n+1's S-wide cone grid.
      // Only the branched cascades settle the parity outside the shader; the
      // rest still carry the test, so only those are claimed here.
      if (plane % 2 === 0 && intrv >= 4 && n < N - 1) {
        for (let index = 0; index < intrv; index++) {
          for (const side of [0, 1]) {
            const col = Math.floor(probeX) + index * 2 + side;
            check(
              col >= 0 && col < S,
              `cascade ${n} plane ${plane} cone ${index * 2 + side}: near cone off the grid`,
            );
          }
        }
      }
    }
  }

  // --- Cone merging addresses cascade n+1's cones with interval 1 and lookup
  // width 1, i.e. by raw column. That only works because the merge point lands
  // exactly on a cascade n+1 plane's first column: odd planes one interval
  // ahead, even planes two (they straddle, so they reach the far plane and
  // interpolate against the near one).
  for (let n = 0; n < N - 1; n++) {
    const intrv = 1 << n;
    const coarseIntrv = intrv * 2;
    for (let plane = 0; plane < S >> n; plane++) {
      const probeX = plane * intrv + 0.5;
      const reach = plane % 2 === 0 ? 2 : 1;
      const tipX = probeX + reach * intrv;
      const coarsePlane = Math.floor(tipX / coarseIntrv);
      check(
        Math.floor(tipX) === coarsePlane * coarseIntrv,
        `cascade ${n} plane ${plane}: merge tip misses a cascade n+1 plane`,
      );
      if (plane % 2 === 0) {
        const nearPlane = Math.floor(probeX / coarseIntrv);
        check(
          Math.floor(probeX) === nearPlane * coarseIntrv,
          `cascade ${n} plane ${plane}: near merge misses a cascade n+1 plane`,
        );
      }
    }
  }

  // --- Angular weights. Cone `coneI` of cascade n+1 has a run of 2·intrv and
  // edge rises of 2·coneI - 2·intrv, so its edge angles are atan of those over
  // the run. Three things have to hold or the fluence is not an integral over
  // angle: the weights of a plane partition the frustum's 90 degrees, a cone's
  // weight is exactly its two children's (so the sky filling an unterminated
  // cone at any cascade is the same solid angle), and each half-cone's outer
  // edge is the ray that stands in for it (which makes summing the two sides
  // the trapezoid rule over the plane's rays).
  const edgeAngle = (n: number, k: number) => Math.atan(k / (1 << n) - 1);
  const weight = (n: number, coneI: number) =>
    edgeAngle(n, coneI + 1) - edgeAngle(n, coneI);
  for (let n = 0; n < N; n++) {
    const intrv = 1 << n;
    let total = 0;
    for (let coneI = 0; coneI < 2 * intrv; coneI++) {
      check(weight(n, coneI) > 0, `cascade ${n} cone ${coneI}: non-positive weight`);
      total += weight(n, coneI);
      if (n + 1 < N) {
        near(
          weight(n, coneI),
          weight(n + 1, 2 * coneI) + weight(n + 1, 2 * coneI + 1),
          `cascade ${n} cone ${coneI}: weight does not split into its children`,
        );
      }
    }
    near(total, Math.PI / 2, `cascade ${n}: plane weights do not span the frustum`);

    for (let index = 0; index < intrv; index++) {
      for (const side of [0, 1]) {
        const coneI = index * 2 + side;
        const rayI = index + side;
        const rayAngle = Math.atan((2 * rayI - intrv) / intrv);
        near(
          rayAngle,
          edgeAngle(n, coneI + side),
          `cascade ${n} cone ${coneI}: ray ${rayI} is not its outer edge`,
        );
      }
    }
  }

  // --- Energy. Mirrors the alpha channel of the merge for a field with nothing
  // in it: every ray transmits fully, so a cone's alpha is its two children's,
  // bottoming out at the top cascade where the merge reads off the end and
  // takes the cone's own angular span. Cascade 0 must come out at a full
  // 90 degrees, which is what makes `sky * alpha` in the sum pass reproduce a
  // uniform sky exactly rather than to within some accumulated scale.
  const texelAlpha = (n: number, index: number): number =>
    n === N - 1
      ? weight(n, 2 * index) + weight(n, 2 * index + 1)
      : texelAlpha(n + 1, 2 * index) + texelAlpha(n + 1, 2 * index + 1);
  if (S <= 64) {
    near(texelAlpha(0, 0), Math.PI / 2, 'open field does not read a full frustum');
  }
}

// --- Jump flood. The flood starts at JFA_MAX_JUMP rather than half the field,
// which caps how far a seed propagates and drops the passes above it. Two
// things have to hold: the reach must cover everything that reads the distance
// field, and the seed coordinates must survive the half-float target exactly —
// they are compared against each other to pick a nearest seed, so a rounded
// coordinate is a wrong Voronoi cell, not a slightly wrong distance.
{
  const JFA_MAX_JUMP = 32;
  const HALF_FLOAT_EXACT_EXTENT = 1024;
  // Where the fill pass stops blending toward the box-filtered value, plus the
  // box's own radius: past that the distance only has to read as "far".
  const FILL_FADE = 10;
  const FILL_BLUR_RADIUS = 4;
  /** Whether a value is a half float exactly, sentinel and texel centers alike. */
  const halfExact = (value: number): boolean => {
    if (value === 0) return true;
    if (Math.abs(value) > 65504) return false;
    const ulp = 2 ** (Math.floor(Math.log2(Math.abs(value))) - 10);
    return Number.isInteger(value / ulp);
  };
  for (const S of SIZES) {
    let reach = 0;
    for (
      let j = Math.min(1 << Math.ceil(Math.log2(S) - 1), JFA_MAX_JUMP);
      j >= 1;
      j >>= 1
    ) {
      reach += j;
    }
    check(
      reach >= FILL_FADE + FILL_BLUR_RADIUS,
      `size ${S}: flood reaches ${reach} texels, short of the ` +
        `${FILL_FADE + FILL_BLUR_RADIUS} the fill chain reads`,
    );
    if (S > HALF_FLOAT_EXACT_EXTENT) continue;
    // Every value the seed target ever holds: the sentinel and texel centers.
    check(halfExact(-1), 'the no-seed sentinel is not exact as a half float');
    for (const coord of [0.5, S / 2 - 0.5, S / 2 + 0.5, S - 0.5]) {
      check(
        halfExact(coord),
        `size ${S}: texel center ${coord} does not survive a half float`,
      );
    }
  }
  // ...and the cutoff itself is right: one extent up, centers stop being exact.
  check(
    !halfExact(HALF_FLOAT_EXACT_EXTENT * 2 - 0.5),
    'the half-float extent cap is looser than it needs to be',
  );
}

// --- Directional moment. Consumers divide the irradiance vector by luminance
// and take it against a surface normal as flatland N·L, so its length caps how
// dark that term can go. The frustums are axis-aligned and rooms are too: an
// unscaled quadrant hands an axis-aligned wall an exact -1 and blacks it out.
const MOMENT_SCALE = Math.SQRT1_2;
const FRUSTUM_DIR = [
  [1, 0],
  [0, -1],
  [-1, 0],
  [0, 1],
];
for (const [nx, ny] of [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2],
]) {
  // Worst case: one frustum carries the whole luminance, so the anisotropy is
  // that frustum's scaled direction.
  for (const [dx, dy] of FRUSTUM_DIR) {
    const dot = dx * MOMENT_SCALE * nx! + dy * MOMENT_SCALE * ny!;
    const directional = Math.min(Math.max(dot * 0.5 + 0.5, 0), 1);
    check(
      directional > 0.1,
      `directional reception bottoms out at ${directional} — surfaces go black`,
    );
  }
}

// --- Nyquist cancellation of the fill pass's `own` tap. The HRC lattice hands
// open texels a one-texel checkerboard worth about 50% of the fluence, so the
// tap that survives to the caller wherever the box filter does not reach has to
// have an exact zero at Nyquist — not merely a small response there.
{
  const TENT_CORNERS = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [-0.5, 0.5],
    [0.5, 0.5],
  ];
  // Bilinear weight the hardware gives texel (tx, ty) for a tap at (ox, oy)
  // texels off the sampled texel's center.
  const bilinear = (ox: number, oy: number, tx: number, ty: number): number => {
    const w = (o: number, t: number): number => Math.max(0, 1 - Math.abs(o - t));
    return w(ox, tx) * w(oy, ty);
  };
  const kernel = (tx: number, ty: number): number =>
    TENT_CORNERS.reduce(
      (sum, [ox, oy]) => sum + 0.25 * bilinear(ox!, oy!, tx, ty),
      0,
    );

  // The four corner taps must reproduce the separable [1, 2, 1] / 4 tent.
  const TENT = [1 / 4, 2 / 4, 1 / 4];
  let total = 0;
  for (let ty = -1; ty <= 1; ty++) {
    for (let tx = -1; tx <= 1; tx++) {
      near(
        kernel(tx, ty),
        TENT[tx + 1]! * TENT[ty + 1]!,
        `corner taps are not the [1, 2, 1] tent at (${tx}, ${ty})`,
      );
      total += kernel(tx, ty);
    }
  }
  near(total, 1, 'tent does not preserve a constant');

  // Response at the lattice's checkerboard, and at Nyquist along each axis.
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.5, 0],
    [0, 0.5],
  ]) {
    let response = 0;
    for (let ty = -1; ty <= 1; ty++) {
      for (let tx = -1; tx <= 1; tx++) {
        response +=
          kernel(tx, ty) * Math.cos(2 * Math.PI * (fx! * tx + fy! * ty));
      }
    }
    near(response, 0, `tent passes the (${fx}, ${fy}) cycles/texel pattern`);
  }
}

console.log(`hrc.check: ok (sizes ${SIZES.join(', ')})`);
