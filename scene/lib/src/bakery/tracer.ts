// The path tracer. three-mesh-bvh owns the acceleration structure and the ray/triangle test; this
// file is the estimator on top of it, written as raw WGSL and driven from a TSL compute kernel.
//
// It integrates *irradiance* E = ∫ L cosθ dω, because that is what three's `lightMap` slot wants:
// MeshStandardNodeMaterial does `irradiance += lightMap.rgb * lightMapIntensity` and then applies
// albedo/π itself. Bounces are cosine-sampled, so the π from the estimator and the 1/π from the
// Lambert BRDF cancel and each bounce is just a multiply by the hit surface's albedo.
//
// Direct lighting is next-event estimation only — analytic for delta lights, area sampling for
// emissive triangles — and emission is never added on a bounce hit, so nothing is counted twice and
// there is no MIS weight to get wrong.
import * as THREE from "three/webgpu";
import { Fn, instanceIndex, storage, uniform } from "three/tsl";
import { BVHComputeData, rayIntersectionResultStruct, rayStruct, wgslTagFn } from "three-mesh-bvh/webgpu";
import { drain } from "./headless.ts";
import { probeDirections } from "./probe.ts";
import { areaLights, bvhProxy, type AreaLights, type BakeScene } from "./scene.ts";
import type { Texels } from "./raster.ts";

export type TraceOptions = {
  /** total paths per texel. This is the only real quality knob. */
  samples?: number;
  /** diffuse bounces after the first hit — 4 is plenty indoors, 2 outdoors */
  bounces?: number;
  /** paths per dispatch. Lower it if the driver kills long compute passes. */
  batch?: number;
  /** ray origin offset along the normal. Defaults to 1e-4 of the scene diagonal. */
  bias?: number;
  /**
   * gain on everything past the first bounce — 1 is physical, >1 the usual cheat for a flat-looking
   * interior. Direct light and the sky seen straight from a texel are untouched.
   */
  indirect?: number;
  /** per bake mesh, the atlas uv the unwrap produced — what a bounce is looked up in `albedo` with */
  lightmapUV?: Float32Array[];
  /** albedo per atlas texel, packed RGBA8, alpha = covered. Without it every bounce uses the material's mean. */
  albedo?: Uint32Array;
  /**
   * how far an ambient-occlusion ray looks for a blocker. Defaults to 5% of the scene diagonal —
   * a room-sized default; raise it for a landscape, lower it for a prop.
   */
  aoDistance?: number;
  /**
   * a {@link TraceContext} to trace against instead of building one. A bake builds a single context and
   * hands it to both the atlas trace and the probes; called on their own, each builds and frees its own.
   */
  context?: TraceContext;
  onProgress?: (fraction: number) => void;
  /** aborts between dispatches. The GPU work already queued still finishes. */
  signal?: AbortSignal;
};

/** see-through layers a shadow ray walks before it gives up and calls itself blocked */
const SHADOW_LAYERS = 4;

/** default paths per texel. Exported because the caller divides the accumulator by it. */
export const SAMPLES = 512;

const WORKGROUP = 64;

/**
 * The Russian roulette policy: the first bounce it may kill a path at, and the smallest survival
 * probability it will roll. Both exist because the textbook policy — roll from the first bounce at
 * `q = throughput` — is a bad trade on a real scene, and measurably so. Sponza's interior is lit by
 * nothing but bounces, and stone at albedo ~0.5 makes that policy a coin flip at every one of them:
 * against a 4096-sample reference, the darkest three quarters of the atlas came back at 74.8% rms
 * where killing nothing scored 30.2%. Doubling every surviving path's weight four times over is what
 * the round blotches in the arcades were. Waiting two bounces and never rolling below a quarter costs
 * 40% of the roulette's speedup and buys all of that back: 30.8% rms, 13% faster than not rolling at
 * all, and the best noise-per-second of the nine policies measured (`docs/bakery.md`).
 */
const RR = { start: 2, floor: 0.25 };

/** where each record kind starts in {@link TraceContext.records}, in vec4s */
export type Bases = { material: number; light: number; emissive: number };

/**
 * The BVH, the record buffer and the albedo atlas: everything about a scene that neither the atlas
 * trace nor the probes change. Building one walks every triangle of the scene and uploads it, so a bake
 * builds a single context and hands it to both stages rather than paying for it twice.
 */
export type TraceContext = {
  bvh: BVHComputeData;
  /** the proxy meshes the BVH was built from — world space, the bake meshes and then the emitter quads */
  proxy: THREE.Group;
  /** materials, then lights, then emissive triangles, in one read-only storage buffer */
  records: unknown;
  bases: Bases;
  /** emissive triangles in `records`. 0 turns next-event estimation off entirely. */
  emissiveCount: number;
  /** the atlas a bounce reads the hit texel's own albedo out of, when the bake built one */
  albedo?: { data: unknown; width: number; height: number };
  /** frees the BVH and the proxy geometries. Whoever built the context calls it. */
  dispose(): void;
};

export type PrepareOptions = Pick<TraceOptions, "lightmapUV" | "albedo"> & {
  /** the atlas {@link TraceOptions.albedo} is packed in. Required with it, ignored without. */
  width?: number;
  height?: number;
};

/** Builds a {@link TraceContext}. Call `dispose()` on the result when the last stage using it is done. */
export function prepareTrace(scene: BakeScene, opts: PrepareOptions = {}): TraceContext {
  // the albedo atlas is read with the lightmap uv of the hit point, so the uv has to ride in the BVH
  const perTexelAlbedo = opts.albedo && opts.lightmapUV ? opts.albedo : undefined;
  const proxy = bvhProxy(scene, perTexelAlbedo && opts.lightmapUV);
  const bvh = new BVHComputeData(proxy, {
    attributes: perTexelAlbedo ? { position: "vec4f", normal: "vec4f", uv: "vec4f" } : { position: "vec4f", normal: "vec4f" },
  });
  bvh.update();

  const area = areaLights(scene);
  const { records, bases } = recordBuffer(scene, area);
  return {
    bvh,
    proxy,
    records: vec4Storage(records),
    bases,
    emissiveCount: area.count,
    ...(perTexelAlbedo
      ? {
          albedo: {
            data: storage(new THREE.StorageBufferAttribute(perTexelAlbedo, 1), "uint", perTexelAlbedo.length).toReadOnly(),
            width: opts.width ?? 1,
            height: opts.height ?? 1,
          },
        }
      : {}),
    dispose() {
      // the proxy geometries are the bake's biggest allocation and nothing else refers to them; a
      // watch-mode rebake used to leak a full copy of the scene per bake
      bvh.dispose();
      for (const child of proxy.children) (child as THREE.Mesh).geometry.dispose();
    },
  };
}

/** Irradiance per covered texel: 4 floats each, (E.rgb summed over `samples`, occlusion summed the same). */
export async function trace(
  renderer: THREE.WebGPURenderer,
  scene: BakeScene,
  texels: Texels,
  opts: TraceOptions = {},
): Promise<Float32Array> {
  const count = texels.index.length;
  if (count === 0) return new Float32Array(0);
  // the stage has started, and a caller timing it from the first batch instead would miss the setup
  opts.onProgress?.(0);

  const samples = Math.max(1, Math.floor(opts.samples ?? SAMPLES));
  const bounces = Math.max(0, Math.floor(opts.bounces ?? 4));
  const batch = Math.min(samples, Math.max(1, Math.floor(opts.batch ?? 32)));
  const diagonal = scene.bounds.getSize(new THREE.Vector3()).length() || 1;
  // `||`, not `??`: 0 is what a sheet writes for "pick one for me", and a bias of 0 self-shadows
  const bias = opts.bias || diagonal * 1e-4;

  const context =
    opts.context ??
    prepareTrace(scene, { lightmapUV: opts.lightmapUV, albedo: opts.albedo, width: texels.width, height: texels.height });
  const padded = Math.ceil(count / WORKGROUP) * WORKGROUP;

  // compacted texel inputs, position and normal interleaved; the accumulator is padded so the tail
  // workgroup's writes land in slack
  const surfaces = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 4; k++) {
      surfaces[i * 8 + k] = texels.position[texels.index[i] * 4 + k];
      surfaces[i * 8 + 4 + k] = texels.normal[texels.index[i] * 4 + k];
    }
  }

  const accumAttribute = new THREE.StorageBufferAttribute(new Float32Array(padded * 4), 4);
  const accum = storage(accumAttribute, "vec4", padded);

  const kernelFn = traceFn({
    context,
    surface: vec4Storage(surfaces),
    count,
    samples,
    batch,
    bounces,
    bias,
    indirect: Math.max(0, opts.indirect ?? 1),
    aoDistance: opts.aoDistance || diagonal * 0.05,
    lightCount: scene.lights.length,
    // a shadow ray only has to walk layers when something is actually see-through
    seeThrough: scene.materials.some((m) => (m.coverage ?? 1) < 1),
    sky: scene.sky,
  });

  const sampleOffset = uniform(0, "uint");
  const kernel = Fn(() => {
    accum.element(instanceIndex).addAssign(kernelFn(instanceIndex, sampleOffset));
  })().computeKernel([WORKGROUP]);

  try {
    for (let offset = 0; offset < samples; offset += batch) {
      opts.signal?.throwIfAborted();
      sampleOffset.value = offset;
      await renderer.computeAsync(kernel, padded);
      // one dispatch per batch keeps any single compute pass short enough not to trip a device timeout
      await drain(renderer);
      opts.onProgress?.(Math.min(1, (offset + batch) / samples));
    }
    const raw = new Float32Array(await renderer.getArrayBufferAsync(accumAttribute));
    return raw.subarray(0, count * 4);
  } finally {
    if (!opts.context) context.dispose();
    (kernel as { dispose?: () => void }).dispose?.();
  }
}

/** One baked reflection probe: radiance in every direction, equirect, bottom row first like the atlas. */
export type ProbeImage = {
  key: string;
  position: [number, number, number];
  width: number;
  height: number;
  /** linear radiance, RGBA, `width * height * 4`. Alpha is 1 — every texel of a probe is covered. */
  image: Float32Array;
};

/**
 * The radiance around each of `scene.probes`, as an equirect per probe. Same estimator as the atlas —
 * the difference is only where a path starts: a probe shoots one ray per texel and gathers what the
 * surface it lands on sends back, which is radiance rather than irradiance and includes the emission
 * the lightmap deliberately leaves out.
 *
 * Every probe goes in one dispatch. The origin rides in the surface buffer beside the direction rather
 * than being interpolated into the shader, so the kernel is compiled once instead of once per probe:
 * pica's fifteen used to spend three quarters of a minute in the driver before casting a single ray,
 * and 120k texels in flight saturate a GPU that 8k left mostly idle.
 */
export async function traceProbes(
  renderer: THREE.WebGPURenderer,
  scene: BakeScene,
  opts: TraceOptions = {},
): Promise<ProbeImage[]> {
  if (!scene.probes.length) return [];
  opts.onProgress?.(0);

  const samples = Math.max(1, Math.floor(opts.samples ?? SAMPLES));
  const bounces = Math.max(0, Math.floor(opts.bounces ?? 4));
  const batch = Math.min(samples, Math.max(1, Math.floor(opts.batch ?? 32)));
  const diagonal = scene.bounds.getSize(new THREE.Vector3()).length() || 1;
  const bias = opts.bias || diagonal * 1e-4;

  // where each probe's texels sit in the one buffer the dispatch runs over
  let total = 0;
  const layout = scene.probes.map((probe) => {
    const width = Math.max(4, Math.floor(probe.size));
    const height = Math.max(2, width >> 1);
    const at = { key: probe.key, position: probe.position, width, height, offset: total };
    total += width * height;
    return at;
  });

  // two vec4 per texel, the same shape the atlas trace uses: (direction.xyz, _) (origin.xyz, _). The
  // directions come from probe.ts, so there is one mapping shared with the runtime rather than two.
  const surfaces = new Float32Array(total * 8);
  for (const probe of layout) {
    const directions = probeDirections(probe.width, probe.height);
    for (let i = 0; i < probe.width * probe.height; i++) {
      const d = (probe.offset + i) * 8;
      for (let k = 0; k < 3; k++) {
        surfaces[d + k] = directions[i * 4 + k]!;
        surfaces[d + 4 + k] = probe.position[k]!;
      }
    }
  }

  const context = opts.context ?? prepareTrace(scene);
  const padded = Math.ceil(total / WORKGROUP) * WORKGROUP;
  const accumAttribute = new THREE.StorageBufferAttribute(new Float32Array(padded * 4), 4);
  const accum = storage(accumAttribute, "vec4", padded);
  const kernelFn = probeFn({
    context,
    surface: vec4Storage(surfaces),
    count: total,
    samples,
    batch,
    bounces,
    bias,
    indirect: Math.max(0, opts.indirect ?? 1),
    aoDistance: opts.aoDistance || diagonal * 0.05,
    lightCount: scene.lights.length,
    seeThrough: scene.materials.some((m) => (m.coverage ?? 1) < 1),
    sky: scene.sky,
  });

  const sampleOffset = uniform(0, "uint");
  const kernel = Fn(() => {
    accum.element(instanceIndex).addAssign(kernelFn(instanceIndex, sampleOffset));
  })().computeKernel([WORKGROUP]);

  try {
    for (let offset = 0; offset < samples; offset += batch) {
      opts.signal?.throwIfAborted();
      sampleOffset.value = offset;
      await renderer.computeAsync(kernel, padded);
      await drain(renderer);
      opts.onProgress?.(Math.min(1, (offset + batch) / samples));
    }
    const raw = new Float32Array(await renderer.getArrayBufferAsync(accumAttribute));
    return layout.map(({ key, position, width, height, offset }) => {
      const image = new Float32Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        for (let k = 0; k < 3; k++) image[i * 4 + k] = raw[(offset + i) * 4 + k]! / samples;
        image[i * 4 + 3] = 1;
      }
      return { key, position, width, height, image };
    });
  } finally {
    if (!opts.context) context.dispose();
    (kernel as { dispose?: () => void }).dispose?.();
  }
}

/**
 * Materials, then lights, then emissive triangles, in one buffer. A compute stage is only guaranteed 8
 * storage buffers and the BVH already claims four, so the fixed records of the bake share one and index
 * it from a base offset — three separate bindings blew the limit the moment an albedo atlas appeared.
 */
function recordBuffer(scene: BakeScene, area: AreaLights): { records: Float32Array; bases: Bases } {
  const materials = materialBuffer(scene);
  const lights = lightBuffer(scene);
  const bases = { material: 0, light: materials.length / 4, emissive: (materials.length + lights.length) / 4 };
  const records = new Float32Array(materials.length + lights.length + area.data.length);
  records.set(materials);
  records.set(lights, materials.length);
  records.set(area.data, materials.length + lights.length);
  return { records, bases };
}

function vec4Storage(data: Float32Array) {
  // length 1 makes TSL collapse the buffer to a bare struct instead of an array; four slots also
  // keep the widest stride (a light) in bounds when a bake has none of that kind of record at all
  const padded = data.length >= 16 ? data : new Float32Array(16);
  padded.set(data);
  return storage(new THREE.StorageBufferAttribute(padded, 4), "vec4", padded.length / 4).toReadOnly();
}

/**
 * Two vec4 per material: (albedo.rgb, coverage) and (emissive radiance.rgb, 0).
 *
 * The emission is the material's mean, not the per-triangle radiance the area-light list carries — it is
 * only read by a probe looking straight at an emitter, where a diffuse texel would double-count it.
 */
function materialBuffer(scene: BakeScene): Float32Array {
  const out = new Float32Array(Math.max(1, scene.materials.length) * 8);
  scene.materials.forEach((m, i) => {
    out.set(m.albedo, i * 8);
    out[i * 8 + 3] = m.coverage ?? 1;
    out.set(m.emissive, i * 8 + 4);
  });
  return out;
}

function lightBuffer(scene: BakeScene): Float32Array {
  const out = new Float32Array(Math.max(1, scene.lights.length) * 16);
  scene.lights.forEach((l, i) => {
    const o = i * 16;
    out.set([...l.color, l.kind], o);
    out.set([...l.position, l.radius], o + 4);
    out.set([...l.direction, l.distance], o + 8);
    out.set([l.decay, l.cosOuter, l.cosInner, 0], o + 12);
  });
  return out;
}

/** WGSL float literal. `toExponential` never produces an integer without an exponent, which WGSL rejects. */
const f = (x: number) => (Number.isFinite(x) ? x.toExponential(9) : "0.0");
const v3 = (c: readonly number[]) => `vec3f( ${f(c[0])}, ${f(c[1])}, ${f(c[2])} )`;

const TAU = "6.283185307179586";
const PI = "3.141592653589793";

// WGSL module-scope declarations are order independent, so these can be written in reading order and
// pulled in wherever they are interpolated.

const hash = wgslTagFn/* wgsl */ `
	fn lm_hash( v: u32 ) -> u32 {

		var x = v * 747796405u + 2891336453u;
		x = ( ( x >> ( ( x >> 28u ) + 4u ) ) ^ x ) * 277803737u;
		return ( x >> 22u ) ^ x;

	}
`;

const rand = wgslTagFn/* wgsl */ `
	fn lm_rand( state: ptr<function, u32> ) -> f32 {

		*state = ${hash}( *state );
		return f32( *state ) * 2.3283064365386963e-10;

	}
`;

/** Radical inverse base 2 — the second dimension of the Hammersley set used to stratify bounce 0. */
const radical = wgslTagFn/* wgsl */ `
	fn lm_radical( bitsIn: u32 ) -> f32 {

		var bits = ( bitsIn << 16u ) | ( bitsIn >> 16u );
		bits = ( ( bits & 0x55555555u ) << 1u ) | ( ( bits & 0xAAAAAAAAu ) >> 1u );
		bits = ( ( bits & 0x33333333u ) << 2u ) | ( ( bits & 0xCCCCCCCCu ) >> 2u );
		bits = ( ( bits & 0x0F0F0F0Fu ) << 4u ) | ( ( bits & 0xF0F0F0F0u ) >> 4u );
		bits = ( ( bits & 0x00FF00FFu ) << 8u ) | ( ( bits & 0xFF00FF00u ) >> 8u );
		return f32( bits ) * 2.3283064365386963e-10;

	}
`;

/** Duff et al. branchless orthonormal basis; column 2 is the normal. */
const basis = wgslTagFn/* wgsl */ `
	fn lm_basis( n: vec3f ) -> mat3x3f {

		let s = select( -1.0, 1.0, n.z >= 0.0 );
		let a = -1.0 / ( s + n.z );
		let b = n.x * n.y * a;
		return mat3x3f(
			vec3f( 1.0 + s * n.x * n.x * a, s * b, -s * n.x ),
			vec3f( b, s + n.y * n.y * a, -n.y ),
			n
		);

	}
`;

const cosineSample = wgslTagFn/* wgsl */ `
	fn lm_cosine( n: vec3f, u: vec2f ) -> vec3f {

		let r = sqrt( u.x );
		let phi = ${TAU} * u.y;
		let local = vec3f( r * cos( phi ), r * sin( phi ), sqrt( max( 0.0, 1.0 - u.x ) ) );
		return normalize( ${basis}( n ) * local );

	}
`;

const sphereSample = wgslTagFn/* wgsl */ `
	fn lm_sphere( state: ptr<function, u32> ) -> vec3f {

		let z = ${rand}( state ) * 2.0 - 1.0;
		let phi = ${TAU} * ${rand}( state );
		let r = sqrt( max( 0.0, 1.0 - z * z ) );
		return vec3f( r * cos( phi ), r * sin( phi ), z );

	}
`;

const coneSample = wgslTagFn/* wgsl */ `
	fn lm_cone( dir: vec3f, angle: f32, state: ptr<function, u32> ) -> vec3f {

		let cosMax = cos( angle );
		let cz = 1.0 - ${rand}( state ) * ( 1.0 - cosMax );
		let sz = sqrt( max( 0.0, 1.0 - cz * cz ) );
		let phi = ${TAU} * ${rand}( state );
		return normalize( ${basis}( dir ) * vec3f( sz * cos( phi ), sz * sin( phi ), cz ) );

	}
`;

type TraceFnArgs = {
  /** the scene: BVH, records, albedo atlas — everything neither stage changes */
  context: TraceContext;
  /** per texel, two vec4: (position.xyz, _) (normal.xyz, materialId) — (direction.xyz, _) (origin.xyz, _) for a probe */
  surface: unknown;
  count: number;
  samples: number;
  batch: number;
  bounces: number;
  bias: number;
  indirect: number;
  aoDistance: number;
  lightCount: number;
  /** any material with coverage < 1 — without one a shadow ray is a plain opaque test */
  seeThrough: boolean;
  sky: BakeScene["sky"];
};

/**
 * The pieces every path of the bake shares, with `lm_gather` as the estimator itself: from a point and a
 * normal, the light arriving there over `bounces` cosine-sampled bounces, scaled by a throughput the
 * caller picks. 1 makes it the irradiance a lightmap texel wants; `albedo/π` makes the same sum the
 * radiance leaving that surface, which is what a probe texel wants.
 *
 * Everything fixed for the bake — counts, bias, sky — is interpolated in as a literal, so the only
 * shader input that changes between dispatches is the sample offset.
 */
function estimator(args: TraceFnArgs) {
  const { bvh, records, bases, albedo } = args.context;
  const raycast = bvh.fns.raycastFirstHit;
  const attributes = bvh.storage.attributes;
  /** `records` index of material `expr`'s first vec4 — (albedo.rgb, coverage) */
  const material = (expr: string) => `${bases.material}u + ( ${expr} ) * 2u`;
  /** and its second — (emissive radiance.rgb, 0), which only a probe looking at an emitter reads */
  const emission = (expr: string) => `${bases.material}u + ( ${expr} ) * 2u + 1u`;

  // The reflectance a bounce picks up. With an albedo atlas that is the texel the hit lands in —
  // interpolate the lightmap uv the BVH carries and look it up — and the material's own mean wherever
  // the atlas has nothing (no uv0, no decodable image, an emitter quad, a hit outside every chart).
  // Both versions have the same signature, so the call site is one line either way.
  const reflectance = albedo
    ? wgslTagFn/* wgsl */ `
			fn lm_albedo( indices: vec4u, bary: vec3f, id: u32 ) -> vec3f {

				let mean = ${records}[ ${material("id")} ].xyz;
				let uv =
					${attributes}[ indices.x ].uv.xy * bary.x +
					${attributes}[ indices.y ].uv.xy * bary.y +
					${attributes}[ indices.z ].uv.xy * bary.z;
				if ( uv.x < 0.0 ) {

					return mean;

				}

				let x = min( u32( clamp( uv.x, 0.0, 1.0 ) * ${f(albedo.width)} ), ${albedo.width - 1}u );
				let y = min( u32( clamp( uv.y, 0.0, 1.0 ) * ${f(albedo.height)} ), ${albedo.height - 1}u );
				let texel = unpack4x8unorm( ${albedo.data}[ y * ${albedo.width}u + x ] );
				return select( mean, texel.xyz, texel.w > 0.5 );

			}
		`
    : wgslTagFn/* wgsl */ `
			fn lm_albedo( indices: vec4u, bary: vec3f, id: u32 ) -> vec3f {

				return ${records}[ ${material("id")} ].xyz;

			}
		`;

  // How much of a shadow ray survives to the light: 1 clear, 0 blocked. Glass, a scrim and a fence
  // texture all used to cast the shadow of a solid wall — three's own renderer at least fades a
  // transparent shadow, and a baked one was darker than the realtime it replaced.
  // ponytail: one coverage per material, no alpha lookup per hit, and at most SHADOW_LAYERS layers
  // before the ray gives up and reports black. Sample the alpha map here if a leaf card ever needs it.
  const visibility = args.seeThrough
    ? wgslTagFn/* wgsl */ `
			fn lm_visibility( origin: vec3f, dir: vec3f, dist: f32 ) -> f32 {

				var transmittance = 1.0;
				var travelled = 0.0;
				// not \`from\`: WGSL reserves it
				var at = origin;
				// 0.1% slack keeps a light's own geometry from shadowing it
				let reach = dist * 0.999 - ${f(args.bias)};

				for ( var layer = 0u; layer < ${SHADOW_LAYERS}u; layer = layer + 1u ) {

					var ray: ${rayStruct};
					ray.origin = at;
					ray.direction = dir;

					// bounded at what is left of the way to the light, which turns the closest-hit query
					// into an any-hit test and stops the traversal walking the scene behind the light
					var hit: ${rayIntersectionResultStruct};
					hit.didHit = true;
					hit.dist = reach - travelled;
					if ( ! ${raycast}( ray, &hit ) ) {

						return transmittance;

					}

					// the id in its own statement: \`attributes\` is a node, and only the wgsl tag knows how
					// to print one — inside a plain template string it stringifies to [object Object]
					let id = u32( ${attributes}[ hit.indices.x ].normal.w + 0.5 );
					transmittance *= 1.0 - ${records}[ ${material("id")} ].w;
					if ( transmittance < 1e-3 ) {

						return 0.0;

					}

					// step past the surface just hit, or the next traversal finds it again
					travelled += hit.dist + ${f(args.bias)};
					at = ray.origin + dir * ( hit.dist + ${f(args.bias)} );

				}

				return 0.0;

			}
		`
    : wgslTagFn/* wgsl */ `
			fn lm_visibility( origin: vec3f, dir: vec3f, dist: f32 ) -> f32 {

				var ray: ${rayStruct};
				ray.origin = origin;
				ray.direction = dir;

				// A closest-hit query bounded at the light is an any-hit test: the traversal culls every
				// node and triangle at or past \`hit.dist\`, and only ever writes a hit that beats it, so
				// what it returns is exactly "something blocks before the light". Seeding it costs two
				// stores and saves walking the whole scene behind the blocker.
				// 0.1% slack keeps a light's own geometry from shadowing it; a directional light passes
				// 1e30 and gets the unbounded traversal it always had.
				var hit: ${rayIntersectionResultStruct};
				hit.didHit = true;
				hit.dist = dist * 0.999 - ${f(args.bias)};
				return select( 1.0, 0.0, ${raycast}( ray, &hit ) );

			}
		`;

  /** true when {@link lm_sky} is black in every direction, so an escaping ray brings nothing back */
  const darkSky = ([...args.sky.up, ...args.sky.down] as number[]).every((v) => v <= 0);

  const sky = wgslTagFn/* wgsl */ `
		fn lm_sky( dir: vec3f ) -> vec3f {

			let t = clamp( dot( dir, ${v3(args.sky.axis)} ) * 0.5 + 0.5, 0.0, 1.0 );
			return mix( ${v3(args.sky.down)}, ${v3(args.sky.up)}, vec3f( t ) );

		}
	`;

  const area = emissiveNEE(args, visibility);

  // three's own falloff, verbatim: getDistanceAttenuation() plus the windowing term
  const direct = wgslTagFn/* wgsl */ `
		fn lm_direct( pos: vec3f, nrm: vec3f, state: ptr<function, u32> ) -> vec3f {

			var irradiance = vec3f( 0.0 );
			let origin = pos + nrm * ${f(args.bias)};

			for ( var i = 0u; i < ${args.lightCount}u; i = i + 1u ) {

				let c0 = ${records}[ ${bases.light}u + i * 4u ];
				let c1 = ${records}[ ${bases.light}u + i * 4u + 1u ];
				let c2 = ${records}[ ${bases.light}u + i * 4u + 2u ];
				let c3 = ${records}[ ${bases.light}u + i * 4u + 3u ];
				let kind = u32( c0.w + 0.5 );
				let radius = c1.w;

				var toLight = vec3f( 0.0 );
				var dist = 1e30;
				var atten = 1.0;

				if ( kind == 0u ) {

					// directional: radius is an angular radius, so jitter the direction in a cone
					toLight = -c2.xyz;
					if ( radius > 0.0 ) {

						toLight = ${coneSample}( toLight, radius, state );

					}

				} else {

					var lightPos = c1.xyz;
					if ( radius > 0.0 ) {

						lightPos += ${sphereSample}( state ) * radius;

					}

					let delta = lightPos - origin;
					dist = length( delta );
					if ( dist < 1e-6 ) {

						continue;

					}

					toLight = delta / dist;
					atten = 1.0 / max( pow( dist, c3.x ), 0.01 );

					let cutoff = c2.w;
					if ( cutoff > 0.0 ) {

						let window = clamp( 1.0 - pow( dist / cutoff, 4.0 ), 0.0, 1.0 );
						atten *= window * window;

					}

					if ( kind == 2u ) {

						atten *= smoothstep( c3.y, c3.z, dot( -toLight, c2.xyz ) );

					}

				}

				let cosine = dot( nrm, toLight );
				if ( cosine <= 0.0 || atten <= 0.0 ) {

					continue;

				}

				let shadow = ${visibility}( origin, toLight, dist );
				if ( shadow <= 0.0 ) {

					continue;

				}

				irradiance += c0.xyz * ( atten * cosine * shadow );

			}

			if ( ${args.context.emissiveCount}u > 0u ) {

				irradiance += ${area}( origin, nrm, state );

			}

			return irradiance;

		}
	`;

  // The estimator itself. `startThroughput` is what turns it from one product into the other: 1 leaves
  // the sum as irradiance for the atlas, `albedo/PI` makes it the radiance leaving the surface a probe
  // ray landed on. Bounces are cosine-sampled, so the PI from the estimator cancels the Lambert 1/PI.
  const gather = wgslTagFn/* wgsl */ `
		fn lm_gather( start: vec3f, startNormal: vec3f, startThroughput: vec3f, seed: u32, si: u32, state: ptr<function, u32> ) -> vec4f {

			var pos = start;
			var nrm = startNormal;
			var throughput = startThroughput;
			var sum = vec3f( 0.0 );
			var open = 0.0;
			// Padded replication: every bounce walks the same stratified Hammersley set, each from its own
			// Cranley-Patterson offset. \`seed\` is the texel and nothing else, so the offsets come out the
			// same for every sample of it and the set stays stratified across the whole bake; independent
			// offsets per bounce are what keeps one bounce's directions from tracking another's.
			//
			// Only bounce 0 used to be stratified and the rest drew plain uniforms, which is backwards for
			// a scene lit by bounces: sponza's interior sees no sun at all, so every photon it gets came
			// through two or more of the unstratified ones.
			var offsets = ${hash}( seed );
			// the roulette below asks how far this path has dimmed, not how bright the product being
			// estimated is — without this a probe's albedo/PI start would kill nearly every path at once
			let rrScale = 1.0 / max( 1e-6, max( startThroughput.x, max( startThroughput.y, startThroughput.z ) ) );

			for ( var b = 0u; b <= ${args.bounces}u; b = b + 1u ) {

				sum += throughput * ${direct}( pos, nrm, state );
${darkSky ? `
				// The ray leaving the last shading point has exactly two jobs: carry the occlusion test on
				// the first bounce, and collect the sky when it escapes. A scene with no ambient, no
				// hemisphere and no sky gradient owes it neither, and what it hits is never read — the
				// throughput past this point goes nowhere. Sponza's four bounces cast five gather rays for
				// four bounces' worth of light; this is the fifth.
				if ( b == ${args.bounces}u && b > 0u ) {

					break;

				}
` : ""}
				let rotation = vec2f( ${rand}( &offsets ), ${rand}( &offsets ) );
				let u = vec2f(
					fract( ( f32( si ) + 0.5 ) / ${f(args.samples)} + rotation.x ),
					fract( ${radical}( si ) + rotation.y )
				);
				let dir = ${cosineSample}( nrm, u );
				var ray: ${rayStruct};
				ray.origin = pos + nrm * ${f(args.bias)};
				ray.direction = dir;

				var hit: ${rayIntersectionResultStruct};
				let anyHit = ${raycast}( ray, &hit );

				// ambient occlusion rides along on the first bounce ray: the directions are already
				// cosine-distributed, so the mean of "nothing within aoDistance" *is* cosine-weighted
				// openness — a second set of rays would only add noise and cost
				if ( b == 0u && ( ! anyHit || hit.dist > ${f(args.aoDistance)} ) ) {

					open += 1.0;

				}

				if ( ! anyHit ) {

					// nothing more to hit: the escaping ray sees the sky. cos-pdf cancels to a bare PI.
					sum += throughput * ${PI} * ${sky}( dir );
					break;

				}

				// bounce radiance is albedo/PI * E, and the PI from the estimator cancels the 1/PI.
				// the indirect gain rides in on the first bounce, so it scales everything gathered
				// past this point and nothing before it.
				let material = u32( ${attributes}[ hit.indices.x ].normal.w + 0.5 );
				throughput *= ${reflectance}( hit.indices, hit.barycoord, material ) * select( 1.0, ${f(args.indirect)}, b == 0u );
				let survival = max( throughput.x, max( throughput.y, throughput.z ) ) * rrScale;
				if ( survival < 1e-3 ) {

					break;

				}

				// Russian roulette: end the path with probability 1 - q and scale the survivors by 1/q,
				// which leaves the estimate unchanged in expectation. A dark room used to pay for every
				// one of its bounces to add a percent; now it stops early and the budget goes to the
				// paths that still carry something. See {@link RR} for why it waits, and for the floor.
				if ( b >= ${RR.start}u && b < ${args.bounces}u ) {

					let q = min( 1.0, max( ${f(RR.floor)}, survival ) );
					if ( ${rand}( state ) >= q ) {

						break;

					}

					throughput /= q;

				}

				pos = ray.origin + dir * hit.dist;
				nrm = normalize( hit.normal );

			}

			return vec4f( sum, open );

		}
	`;

  return { attributes, raycast, sky, gather, material, emission };
}

/**
 * `lm_trace( index, sampleOffset ) -> vec4f`: the irradiance of one atlas texel summed over `batch`
 * cosine-sampled paths, with the occlusion those same paths measured in `.w`.
 */
function traceFn(args: TraceFnArgs) {
  const { surface } = args;
  const { gather } = estimator(args);

  return wgslTagFn/* wgsl */ `
		fn lm_trace( index: u32, sampleOffset: u32 ) -> vec4f {

			if ( index >= ${args.count}u ) {

				return vec4f( 0.0 );

			}

			let origin = ${surface}[ index * 2u ].xyz;
			let surfaceNormal = ${surface}[ index * 2u + 1u ].xyz;

			// the stratified directions are seeded from the texel alone, so every dispatch of the same
			// texel continues one sequence — see the rotations in lm_gather. Everything else, soft
			// shadows and which emitter gets picked, must differ per dispatch or every batch repeats
			// the same batch-many samples.
			var state = ${hash}( index * 9781u + sampleOffset * 6151u + 1u );

			var sum = vec3f( 0.0 );
			var open = 0.0;
			for ( var s = 0u; s < ${args.batch}u; s = s + 1u ) {

				let path = ${gather}( origin, surfaceNormal, vec3f( 1.0 ), index * 9781u + 1u, sampleOffset + s, &state );
				sum += path.xyz;
				open += path.w;

			}

			return vec4f( sum, open );

		}
	`;
}

/**
 * `lm_probe( index, sampleOffset ) -> vec4f`: the radiance arriving at the probe from the direction of
 * one equirect texel, summed over `batch` paths. Unlike a lightmap texel this one adds the emission of
 * what it looks at — a reflection of a lamp has to show the lamp.
 *
 * ponytail: one ray per texel, down its centre, with no jitter inside it — the primary hit aliases where
 * a silhouette crosses a texel. Everything a probe is read through (PMREM, then a roughness lobe) blurs
 * far wider than one texel; jitter the direction here if a mirror-flat metal ever shows the stair steps.
 */
function probeFn(args: TraceFnArgs) {
  const { surface } = args;
  const { records } = args.context;
  const { attributes, raycast, sky, gather, material, emission } = estimator(args);

  return wgslTagFn/* wgsl */ `
		fn lm_probe( index: u32, sampleOffset: u32 ) -> vec4f {

			if ( index >= ${args.count}u ) {

				return vec4f( 0.0 );

			}

			let dir = normalize( ${surface}[ index * 2u ].xyz );
			// the probe this texel belongs to rides beside the direction, so every probe of the scene
			// runs in one dispatch of one compiled kernel. Not \`from\`: WGSL reserves it.
			let eye = ${surface}[ index * 2u + 1u ].xyz;
			var state = ${hash}( index * 9781u + sampleOffset * 6151u + 1u );

			var sum = vec3f( 0.0 );
			for ( var s = 0u; s < ${args.batch}u; s = s + 1u ) {

				var ray: ${rayStruct};
				ray.origin = eye;
				ray.direction = dir;

				var hit: ${rayIntersectionResultStruct};
				if ( ! ${raycast}( ray, &hit ) ) {

					sum += ${sky}( dir );
					continue;

				}

				let id = u32( ${attributes}[ hit.indices.x ].normal.w + 0.5 );
				let pos = ray.origin + dir * hit.dist;
				// a probe sees as many back faces as front ones, and nothing says which way a modeller
				// left the normal of a surface it was never meant to be behind
				var nrm = normalize( hit.normal );
				if ( dot( nrm, dir ) > 0.0 ) {

					nrm = -nrm;

				}

				sum += ${records}[ ${emission("id")} ].xyz +
					${gather}( pos, nrm, ${records}[ ${material("id")} ].xyz * ${f(1 / Math.PI)}, index * 9781u + 1u, sampleOffset + s, &state ).xyz;

			}

			return vec4f( sum, 0.0 );

		}
	`;
}

/**
 * One emissive-triangle sample per shading point, picked in constant time with probability proportional
 * to area * luminance — a dim square metre and a bright one no longer get the same share of the samples.
 */
function emissiveNEE(args: TraceFnArgs, visibility: unknown) {
  const { records, bases, emissiveCount } = args.context;
  // lm_area is compiled even for a scene with no emitters, where its `if` is simply never taken
  const count = Math.max(1, emissiveCount);
  const emitter = (slot: number) => `${bases.emissive}u + pick * 4u + ${slot}u`;
  return wgslTagFn/* wgsl */ `
		fn lm_area( origin: vec3f, nrm: vec3f, state: ptr<function, u32> ) -> vec3f {

			// Vose's alias table, built on the CPU: pick a bin uniformly, then toss one coin between that
			// bin and its alias. Two loads whatever the emitter count, where the cumulative-area scan it
			// replaced averaged half of them — pica's 3,864 emissive triangles were most of its trace.
			let bin = min( u32( ${rand}( state ) * ${f(count)} ), ${count - 1}u );
			let entry = ${records}[ ${bases.emissive}u + bin * 4u ];
			// not \`alias\`: WGSL reserves it
			let other = ${records}[ ${bases.emissive}u + bin * 4u + 1u ];
			let pick = select( u32( other.w + 0.5 ), bin, ${rand}( state ) < entry.w );

			let e0 = ${records}[ ${emitter(0)} ];
			let e1 = ${records}[ ${emitter(1)} ];
			let e2 = ${records}[ ${emitter(2)} ];
			let e3 = ${records}[ ${emitter(3)} ];

			var s = ${rand}( state );
			var t = ${rand}( state );
			if ( s + t > 1.0 ) {

				s = 1.0 - s;
				t = 1.0 - t;

			}

			let edge0 = e1.xyz - e0.xyz;
			let edge1 = e2.xyz - e0.xyz;
			let samplePoint = e0.xyz + edge0 * s + edge1 * t;
			let delta = samplePoint - origin;
			let distSq = dot( delta, delta );
			let dist = sqrt( distSq );
			if ( dist < 1e-6 ) {

				return vec3f( 0.0 );

			}

			let toLight = delta / dist;
			let cosSurface = dot( nrm, toLight );
			// an emissive mesh material emits both ways, like an unculled MeshStandardMaterial; a
			// RectAreaLight's quad only shines out of its front face, and says so in emissive.w
			let facing = -dot( normalize( cross( edge0, edge1 ) ), toLight );
			let cosLight = select( abs( facing ), max( facing, 0.0 ), e2.w > 0.5 );
			if ( cosSurface <= 0.0 || cosLight <= 0.0 ) {

				return vec3f( 0.0 );

			}

			let shadow = ${visibility}( origin, toLight, dist );
			if ( shadow <= 0.0 ) {

				return vec3f( 0.0 );

			}

			// e3.w is 1/pdf in area measure — totalWeight/luminance for the triangle that was picked,
			// which with one radiance across the set is exactly the total area the old area-proportional
			// pick divided by. The product estimates the emitter set's solid angle, which cannot exceed a
			// sphere: without that bound a shading point a millimetre from a panel returns millions, one
			// path poisons the texel, and every bounce that lands there sprays fireflies across the atlas.
			// ponytail: two things ride on this clamp. It darkens the first centimetre around an emitter,
			// and "the set's solid angle" is only what the product is when the pick is area-proportional —
			// weighted by power, a dim emitter carries a larger 1/pdf and so meets the ceiling sooner and
			// bakes darker for it. Both go away together if the triangle is sampled by solid angle instead
			// (Arvo): no singularity, so no clamp, so nothing left for the weights to interact with.
			// Clamping the triangle's own solid angle rather than the set's is not the fix — it is the
			// right quantity but far too loose a bound, and pica comes back with fireflies at 300x.
			let solidAngle = min( cosLight / distSq * e3.w, 2.0 * ${TAU} );
			// the picked triangle's own radiance — a textured emissive panel is a different light per
			// triangle, and the record carries the texel it was sampled at
			return e3.xyz * ( cosSurface * solidAngle * shadow );

		}
	`;
}
