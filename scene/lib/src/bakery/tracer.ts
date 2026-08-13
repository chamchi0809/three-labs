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
  onProgress?: (fraction: number) => void;
  /** aborts between dispatches. The GPU work already queued still finishes. */
  signal?: AbortSignal;
};

/** see-through layers a shadow ray walks before it gives up and calls itself blocked */
const SHADOW_LAYERS = 4;

/** default paths per texel. Exported because the caller divides the accumulator by it. */
export const SAMPLES = 512;

const WORKGROUP = 64;

/** Irradiance per covered texel: 4 floats each, (E.rgb summed over `samples`, occlusion summed the same). */
export async function trace(
  renderer: THREE.WebGPURenderer,
  scene: BakeScene,
  texels: Texels,
  opts: TraceOptions = {},
): Promise<Float32Array> {
  const count = texels.index.length;
  if (count === 0) return new Float32Array(0);

  const samples = Math.max(1, Math.floor(opts.samples ?? SAMPLES));
  const bounces = Math.max(0, Math.floor(opts.bounces ?? 4));
  const batch = Math.min(samples, Math.max(1, Math.floor(opts.batch ?? 32)));
  const diagonal = scene.bounds.getSize(new THREE.Vector3()).length() || 1;
  // `||`, not `??`: 0 is what a sheet writes for "pick one for me", and a bias of 0 self-shadows
  const bias = opts.bias || diagonal * 1e-4;

  // the albedo atlas is read with the lightmap uv of the hit point, so the uv has to ride in the BVH
  const perTexelAlbedo = opts.albedo && opts.lightmapUV ? opts.albedo : undefined;
  const proxy = bvhProxy(scene, perTexelAlbedo && opts.lightmapUV);
  const bvh = new BVHComputeData(proxy, {
    attributes: perTexelAlbedo ? { position: "vec4f", normal: "vec4f", uv: "vec4f" } : { position: "vec4f", normal: "vec4f" },
  });
  bvh.update();

  const area = areaLights(scene);
  const { records, bases } = recordBuffer(scene, area);
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
  const albedo = perTexelAlbedo
    ? storage(new THREE.StorageBufferAttribute(perTexelAlbedo, 1), "uint", perTexelAlbedo.length).toReadOnly()
    : undefined;
  const accum = storage(accumAttribute, "vec4", padded);

  const kernelFn = traceFn({
    bvh,
    surface: vec4Storage(surfaces),
    records: vec4Storage(records),
    bases,
    ...(albedo ? { albedo: { data: albedo, width: texels.width, height: texels.height } } : {}),
    count,
    samples,
    batch,
    bounces,
    bias,
    indirect: Math.max(0, opts.indirect ?? 1),
    aoDistance: opts.aoDistance || diagonal * 0.05,
    lightCount: scene.lights.length,
    emissiveCount: area.count,
    totalArea: area.totalArea,
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
    // the proxy geometries are the bake's biggest allocation and nothing else refers to them; a
    // watch-mode rebake used to leak a full copy of the scene per bake
    bvh.dispose();
    for (const child of proxy.children) (child as THREE.Mesh).geometry.dispose();
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
 * ponytail: its own BVH, built a second time after the atlas' was thrown away — a few seconds against a
 * trace measured in minutes. Thread the BVH through if a bake ever runs probes on their own.
 */
export async function traceProbes(
  renderer: THREE.WebGPURenderer,
  scene: BakeScene,
  opts: TraceOptions = {},
): Promise<ProbeImage[]> {
  if (!scene.probes.length) return [];

  const samples = Math.max(1, Math.floor(opts.samples ?? SAMPLES));
  const bounces = Math.max(0, Math.floor(opts.bounces ?? 4));
  const batch = Math.min(samples, Math.max(1, Math.floor(opts.batch ?? 32)));
  const diagonal = scene.bounds.getSize(new THREE.Vector3()).length() || 1;
  const bias = opts.bias || diagonal * 1e-4;

  const proxy = bvhProxy(scene);
  const bvh = new BVHComputeData(proxy, { attributes: { position: "vec4f", normal: "vec4f" } });
  bvh.update();
  const area = areaLights(scene);
  const { records, bases } = recordBuffer(scene, area);
  const out: ProbeImage[] = [];

  try {
    for (const [at, probe] of scene.probes.entries()) {
      const width = Math.max(4, Math.floor(probe.size));
      const height = Math.max(2, width >> 1);
      const count = width * height;
      const padded = Math.ceil(count / WORKGROUP) * WORKGROUP;
      const accumAttribute = new THREE.StorageBufferAttribute(new Float32Array(padded * 4), 4);
      const accum = storage(accumAttribute, "vec4", padded);
      const kernelFn = probeFn({
        bvh,
        // the direction of every texel, computed on the CPU: one mapping, in probe.ts, shared with the
        // runtime instead of written twice
        surface: vec4Storage(probeDirections(width, height)),
        records: vec4Storage(records),
        bases,
        origin: probe.position,
        count,
        samples,
        batch,
        bounces,
        bias,
        indirect: Math.max(0, opts.indirect ?? 1),
        aoDistance: opts.aoDistance || diagonal * 0.05,
        lightCount: scene.lights.length,
        emissiveCount: area.count,
        totalArea: area.totalArea,
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
          opts.onProgress?.(Math.min(1, (at + (offset + batch) / samples) / scene.probes.length));
        }
        const raw = new Float32Array(await renderer.getArrayBufferAsync(accumAttribute));
        const image = new Float32Array(count * 4);
        for (let i = 0; i < count; i++) {
          for (let k = 0; k < 3; k++) image[i * 4 + k] = raw[i * 4 + k]! / samples;
          image[i * 4 + 3] = 1;
        }
        out.push({ key: probe.key, position: probe.position, width, height, image });
      } finally {
        (kernel as { dispose?: () => void }).dispose?.();
      }
    }
  } finally {
    bvh.dispose();
    for (const child of proxy.children) (child as THREE.Mesh).geometry.dispose();
  }
  return out;
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

/** where each record kind starts in `records`, in vec4s */
type Bases = { material: number; light: number; emissive: number };

type TraceFnArgs = {
  bvh: BVHComputeData;
  /** per texel, two vec4: (position.xyz, _) (normal.xyz, materialId) — one vec4 direction for a probe */
  surface: unknown;
  /** materials, then lights, then emissive triangles — see {@link TraceFnArgs.bases} */
  records: unknown;
  bases: Bases;
  /** the atlas a bounce reads the hit texel's own albedo out of. Without it, the material's mean. */
  albedo?: { data: unknown; width: number; height: number };
  count: number;
  samples: number;
  batch: number;
  bounces: number;
  bias: number;
  indirect: number;
  aoDistance: number;
  lightCount: number;
  emissiveCount: number;
  totalArea: number;
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
  const { bvh, records, bases, albedo } = args;
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

				for ( var layer = 0u; layer < ${SHADOW_LAYERS}u; layer = layer + 1u ) {

					var ray: ${rayStruct};
					ray.origin = at;
					ray.direction = dir;

					var hit: ${rayIntersectionResultStruct};
					if ( ! ${raycast}( ray, &hit ) ) {

						return transmittance;

					}

					travelled += hit.dist;
					// 0.1% slack keeps a light's own geometry from shadowing it
					if ( travelled >= dist * 0.999 - ${f(args.bias)} ) {

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

				// ponytail: a closest-hit query stands in for an any-hit test, so a shadow ray costs a full
				// traversal instead of stopping at the first blocker. Swap in an any-hit shapecast when
				// three-mesh-bvh grows one.
				var hit: ${rayIntersectionResultStruct};
				if ( ! ${raycast}( ray, &hit ) ) {

					return 1.0;

				}

				// 0.1% slack keeps a light's own geometry from shadowing it
				return select( 1.0, 0.0, hit.dist < dist * 0.999 - ${f(args.bias)} );

			}
		`;

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

			if ( ${args.emissiveCount}u > 0u ) {

				irradiance += ${area}( origin, nrm, state );

			}

			return irradiance;

		}
	`;

  // The estimator itself. `startThroughput` is what turns it from one product into the other: 1 leaves
  // the sum as irradiance for the atlas, `albedo/PI` makes it the radiance leaving the surface a probe
  // ray landed on. Bounces are cosine-sampled, so the PI from the estimator cancels the Lambert 1/PI.
  const gather = wgslTagFn/* wgsl */ `
		fn lm_gather( start: vec3f, startNormal: vec3f, startThroughput: vec3f, startU: vec2f, state: ptr<function, u32> ) -> vec4f {

			var pos = start;
			var nrm = startNormal;
			var throughput = startThroughput;
			var u = startU;
			var sum = vec3f( 0.0 );
			var open = 0.0;

			for ( var b = 0u; b <= ${args.bounces}u; b = b + 1u ) {

				sum += throughput * ${direct}( pos, nrm, state );

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
				if ( max( throughput.x, max( throughput.y, throughput.z ) ) < 1e-3 ) {

					break;

				}

				pos = ray.origin + dir * hit.dist;
				nrm = normalize( hit.normal );
				u = vec2f( ${rand}( state ), ${rand}( state ) );

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

			// Cranley-Patterson rotation: each texel walks the same stratified set from its own offset.
			// Seeded from the texel alone, so every dispatch of the same texel continues one sequence.
			var fixedState = ${hash}( index * 9781u + 1u );
			let rotation = vec2f( ${rand}( &fixedState ), ${rand}( &fixedState ) );

			// everything else — soft shadows, which emitter gets picked, the bounce directions — must
			// differ per dispatch, or every batch repeats the same batch-many samples
			var state = ${hash}( index * 9781u + sampleOffset * 6151u + 1u );

			var sum = vec3f( 0.0 );
			var open = 0.0;
			for ( var s = 0u; s < ${args.batch}u; s = s + 1u ) {

				let si = sampleOffset + s;
				let u = vec2f(
					fract( ( f32( si ) + 0.5 ) / ${f(args.samples)} + rotation.x ),
					fract( ${radical}( si ) + rotation.y )
				);

				let path = ${gather}( origin, surfaceNormal, vec3f( 1.0 ), u, &state );
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
function probeFn(args: TraceFnArgs & { origin: [number, number, number] }) {
  const { surface, records } = args;
  const { attributes, raycast, sky, gather, material, emission } = estimator(args);

  return wgslTagFn/* wgsl */ `
		fn lm_probe( index: u32, sampleOffset: u32 ) -> vec4f {

			if ( index >= ${args.count}u ) {

				return vec4f( 0.0 );

			}

			let dir = normalize( ${surface}[ index ].xyz );
			var state = ${hash}( index * 9781u + sampleOffset * 6151u + 1u );

			var sum = vec3f( 0.0 );
			for ( var s = 0u; s < ${args.batch}u; s = s + 1u ) {

				var ray: ${rayStruct};
				ray.origin = ${v3(args.origin)};
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

				let u = vec2f( ${rand}( &state ), ${rand}( &state ) );
				sum += ${records}[ ${emission("id")} ].xyz +
					${gather}( pos, nrm, ${records}[ ${material("id")} ].xyz * ${f(1 / Math.PI)}, u, &state ).xyz;

			}

			return vec4f( sum, 0.0 );

		}
	`;
}

/** One emissive-triangle sample per shading point, picked with probability proportional to area. */
function emissiveNEE(args: TraceFnArgs, visibility: unknown) {
  const { records, bases } = args;
  const emitter = (slot: number) => `${bases.emissive}u + pick * 4u + ${slot}u`;
  return wgslTagFn/* wgsl */ `
		fn lm_area( origin: vec3f, nrm: vec3f, state: ptr<function, u32> ) -> vec3f {

			// ponytail: linear scan of the area CDF. Fine to a few hundred emissive triangles; make it a
			// binary search (or an alias table) past that.
			let pickTarget = ${rand}( state ) * ${f(args.totalArea)};
			var pick = max( ${args.emissiveCount}u, 1u ) - 1u;
			for ( var i = 0u; i < ${args.emissiveCount}u; i = i + 1u ) {

				if ( ${records}[ ${bases.emissive}u + i * 4u ].w >= pickTarget ) {

					pick = i;
					break;

				}

			}

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

			// pdf is 1/totalArea in area measure, so the estimator carries totalArea. The product is an
			// estimate of the emitter's solid angle, which cannot exceed a sphere: without that bound a
			// shading point a millimetre from a panel returns millions and one path poisons the texel —
			// and every bounce that lands there sprays fireflies across the rest of the atlas.
			// ponytail: clamping darkens the first centimetre around an emitter. Sampling the triangle by
			// solid angle instead (Arvo) removes the singularity outright; do that if it ever shows.
			let solidAngle = min( cosLight / distSq * ${f(args.totalArea)}, 2.0 * ${TAU} );
			// the picked triangle's own radiance — a textured emissive panel is a different light per
			// triangle, and the record carries the texel it was sampled at
			return e3.xyz * ( cosSurface * solidAngle * shadow );

		}
	`;
}
