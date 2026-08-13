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
import { areaLights, bvhProxy, type BakeScene } from "./scene.ts";
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
  onProgress?: (fraction: number) => void;
};

const WORKGROUP = 64;

/** Irradiance per covered texel: 4 floats each, (E.rgb, samples). */
export async function trace(
  renderer: THREE.WebGPURenderer,
  scene: BakeScene,
  texels: Texels,
  opts: TraceOptions = {},
): Promise<Float32Array> {
  const count = texels.index.length;
  if (count === 0) return new Float32Array(0);

  const samples = Math.max(1, Math.floor(opts.samples ?? 512));
  const bounces = Math.max(0, Math.floor(opts.bounces ?? 4));
  const batch = Math.min(samples, Math.max(1, Math.floor(opts.batch ?? 32)));
  const diagonal = scene.bounds.getSize(new THREE.Vector3()).length() || 1;
  const bias = opts.bias ?? diagonal * 1e-4;

  // the albedo atlas is read with the lightmap uv of the hit point, so the uv has to ride in the BVH
  const perTexelAlbedo = opts.albedo && opts.lightmapUV ? opts.albedo : undefined;
  const bvh = new BVHComputeData(bvhProxy(scene, perTexelAlbedo && opts.lightmapUV), {
    attributes: perTexelAlbedo ? { position: "vec4f", normal: "vec4f", uv: "vec4f" } : { position: "vec4f", normal: "vec4f" },
  });
  bvh.update();

  const area = areaLights(scene);
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

  // one buffer for every fixed record of the bake. A compute stage is only guaranteed 8 storage
  // buffers and the BVH already claims four, so materials/lights/emitters share one and index it
  // from a base offset — three separate bindings blew the limit the moment an albedo atlas appeared.
  const materials = materialBuffer(scene);
  const lights = lightBuffer(scene);
  const bases = { material: 0, light: materials.length / 4, emissive: (materials.length + lights.length) / 4 };
  const records = new Float32Array(materials.length + lights.length + area.data.length);
  records.set(materials);
  records.set(lights, materials.length);
  records.set(area.data, materials.length + lights.length);

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
    albedo,
    atlas: { width: texels.width, height: texels.height },
    count,
    samples,
    batch,
    bounces,
    bias,
    indirect: Math.max(0, opts.indirect ?? 1),
    lightCount: scene.lights.length,
    emissiveCount: area.count,
    totalArea: area.totalArea,
    sky: scene.sky,
  });

  const sampleOffset = uniform(0, "uint");
  const kernel = Fn(() => {
    accum.element(instanceIndex).addAssign(kernelFn(instanceIndex, sampleOffset));
  })().computeKernel([WORKGROUP]);

  for (let offset = 0; offset < samples; offset += batch) {
    sampleOffset.value = offset;
    await renderer.computeAsync(kernel, padded);
    // one dispatch per batch keeps any single compute pass short enough not to trip a device timeout
    await drain(renderer);
    opts.onProgress?.(Math.min(1, (offset + batch) / samples));
  }

  const raw = new Float32Array(await renderer.getArrayBufferAsync(accumAttribute));
  bvh.dispose();
  return raw.subarray(0, count * 4);
}

function vec4Storage(data: Float32Array) {
  // length 1 makes TSL collapse the buffer to a bare struct instead of an array; four slots also
  // keep the widest stride (a light) in bounds when a bake has none of that kind of record at all
  const padded = data.length >= 16 ? data : new Float32Array(16);
  padded.set(data);
  return storage(new THREE.StorageBufferAttribute(padded, 4), "vec4", padded.length / 4).toReadOnly();
}

function materialBuffer(scene: BakeScene): Float32Array {
  const out = new Float32Array(Math.max(1, scene.materials.length) * 8);
  scene.materials.forEach((m, i) => {
    out.set(m.albedo, i * 8);
    out.set(m.emissive, i * 8 + 4);
    // the spare w of the emissive slot: 1 = emits out of the front face only
    out[i * 8 + 7] = m.oneSided ? 1 : 0;
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
  bvh: BVHComputeData;
  /** per texel, two vec4: (position.xyz, _) (normal.xyz, materialId) */
  surface: unknown;
  /** materials, then lights, then emissive triangles — see {@link TraceFnArgs.bases} */
  records: unknown;
  /** where each record kind starts in `records`, in vec4s */
  bases: { material: number; light: number; emissive: number };
  albedo: unknown;
  atlas: { width: number; height: number };
  count: number;
  samples: number;
  batch: number;
  bounces: number;
  bias: number;
  indirect: number;
  lightCount: number;
  emissiveCount: number;
  totalArea: number;
  sky: BakeScene["sky"];
};

/**
 * Builds `lm_trace( index, sampleOffset ) -> vec4f`, returning the summed irradiance of `batch`
 * paths. Everything fixed for the bake — counts, bias, sky — is interpolated in as a literal, so
 * the only shader input that changes between dispatches is the sample offset.
 */
function traceFn(args: TraceFnArgs) {
  const { bvh, surface, records, bases, albedo } = args;
  const raycast = bvh.fns.raycastFirstHit;
  const attributes = bvh.storage.attributes;
  /** `records` index of material `expr`'s first (albedo) or second (emissive) vec4 */
  const material = (expr: string, slot: 0 | 1) => `${bases.material}u + ( ${expr} ) * 2u + ${slot}u`;

  // The reflectance a bounce picks up. With an albedo atlas that is the texel the hit lands in —
  // interpolate the lightmap uv the BVH carries and look it up — and the material's own mean wherever
  // the atlas has nothing (no uv0, no decodable image, an emitter quad, a hit outside every chart).
  // Both versions have the same signature, so the call site is one line either way.
  const reflectance = albedo
    ? wgslTagFn/* wgsl */ `
			fn lm_albedo( indices: vec4u, bary: vec3f, id: u32 ) -> vec3f {

				let mean = ${records}[ ${material("id", 0)} ].xyz;
				let uv =
					${attributes}[ indices.x ].uv.xy * bary.x +
					${attributes}[ indices.y ].uv.xy * bary.y +
					${attributes}[ indices.z ].uv.xy * bary.z;
				if ( uv.x < 0.0 ) {

					return mean;

				}

				let x = min( u32( clamp( uv.x, 0.0, 1.0 ) * ${f(args.atlas.width)} ), ${args.atlas.width - 1}u );
				let y = min( u32( clamp( uv.y, 0.0, 1.0 ) * ${f(args.atlas.height)} ), ${args.atlas.height - 1}u );
				let texel = unpack4x8unorm( ${albedo}[ y * ${args.atlas.width}u + x ] );
				return select( mean, texel.xyz, texel.w > 0.5 );

			}
		`
    : wgslTagFn/* wgsl */ `
			fn lm_albedo( indices: vec4u, bary: vec3f, id: u32 ) -> vec3f {

				return ${records}[ ${material("id", 0)} ].xyz;

			}
		`;

  const occluded = wgslTagFn/* wgsl */ `
		fn lm_occluded( origin: vec3f, dir: vec3f, dist: f32 ) -> bool {

			var ray: ${rayStruct};
			ray.origin = origin;
			ray.direction = dir;

			// ponytail: a closest-hit query stands in for an any-hit test, so a shadow ray costs a full
			// traversal instead of stopping at the first blocker. Swap in an any-hit shapecast when
			// three-mesh-bvh grows one.
			var hit: ${rayIntersectionResultStruct};
			if ( ! ${raycast}( ray, &hit ) ) {

				return false;

			}

			// 0.1% slack keeps a light's own geometry from shadowing it
			return hit.dist < dist * 0.999 - ${f(args.bias)};

		}
	`;

  const sky = wgslTagFn/* wgsl */ `
		fn lm_sky( dir: vec3f ) -> vec3f {

			let t = clamp( dot( dir, ${v3(args.sky.axis)} ) * 0.5 + 0.5, 0.0, 1.0 );
			return mix( ${v3(args.sky.down)}, ${v3(args.sky.up)}, vec3f( t ) );

		}
	`;

  const area = emissiveNEE(args, occluded);

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

				if ( ${occluded}( origin, toLight, dist ) ) {

					continue;

				}

				irradiance += c0.xyz * ( atten * cosine );

			}

			if ( ${args.emissiveCount}u > 0u ) {

				irradiance += ${area}( origin, nrm, state );

			}

			return irradiance;

		}
	`;

  return wgslTagFn/* wgsl */ `
		fn lm_trace( index: u32, sampleOffset: u32 ) -> vec4f {

			if ( index >= ${args.count}u ) {

				return vec4f( 0.0 );

			}

			let origin = ${surface}[ index * 2u ].xyz;
			let surfaceNormal = ${surface}[ index * 2u + 1u ].xyz;

			var state = ${hash}( index * 9781u + 1u );
			// Cranley-Patterson rotation: each texel walks the same stratified set from its own offset
			let rotation = vec2f( ${rand}( &state ), ${rand}( &state ) );

			var sum = vec3f( 0.0 );
			for ( var s = 0u; s < ${args.batch}u; s = s + 1u ) {

				let si = sampleOffset + s;
				var u = vec2f(
					fract( ( f32( si ) + 0.5 ) / ${f(args.samples)} + rotation.x ),
					fract( ${radical}( si ) + rotation.y )
				);

				var pos = origin;
				var nrm = surfaceNormal;
				var throughput = vec3f( 1.0 );

				for ( var b = 0u; b <= ${args.bounces}u; b = b + 1u ) {

					sum += throughput * ${direct}( pos, nrm, &state );

					let dir = ${cosineSample}( nrm, u );
					var ray: ${rayStruct};
					ray.origin = pos + nrm * ${f(args.bias)};
					ray.direction = dir;

					var hit: ${rayIntersectionResultStruct};
					if ( ! ${raycast}( ray, &hit ) ) {

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
					u = vec2f( ${rand}( &state ), ${rand}( &state ) );

				}

			}

			return vec4f( sum, f32( ${args.batch}u ) );

		}
	`;
}

/** One emissive-triangle sample per shading point, picked with probability proportional to area. */
function emissiveNEE(args: TraceFnArgs, occluded: unknown) {
  const { records, bases } = args;
  const emitter = (slot: number) => `${bases.emissive}u + pick * 3u + ${slot}u`;
  // the emissive vec4 of the material the picked triangle carries in its third corner's w. Only the
  // subscript: a `${records}` outside a top-level tag argument is stringified before it is a function.
  const emission = `${bases.material}u + u32( e2.w + 0.5 ) * 2u + 1u`;
  return wgslTagFn/* wgsl */ `
		fn lm_area( origin: vec3f, nrm: vec3f, state: ptr<function, u32> ) -> vec3f {

			// ponytail: linear scan of the area CDF. Fine to a few hundred emissive triangles; make it a
			// binary search (or an alias table) past that.
			let pickTarget = ${rand}( state ) * ${f(args.totalArea)};
			var pick = max( ${args.emissiveCount}u, 1u ) - 1u;
			for ( var i = 0u; i < ${args.emissiveCount}u; i = i + 1u ) {

				if ( ${records}[ ${bases.emissive}u + i * 3u ].w >= pickTarget ) {

					pick = i;
					break;

				}

			}

			let e0 = ${records}[ ${emitter(0)} ];
			let e1 = ${records}[ ${emitter(1)} ];
			let e2 = ${records}[ ${emitter(2)} ];

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
			let oneSided = ${records}[ ${emission} ].w > 0.5;
			let cosLight = select( abs( facing ), max( facing, 0.0 ), oneSided );
			if ( cosSurface <= 0.0 || cosLight <= 0.0 || ${occluded}( origin, toLight, dist ) ) {

				return vec3f( 0.0 );

			}

			// pdf is 1/totalArea in area measure, so the estimator carries totalArea. The product is an
			// estimate of the emitter's solid angle, which cannot exceed a sphere: without that bound a
			// shading point a millimetre from a panel returns millions and one path poisons the texel —
			// and every bounce that lands there sprays fireflies across the rest of the atlas.
			// ponytail: clamping darkens the first centimetre around an emitter. Sampling the triangle by
			// solid angle instead (Arvo) removes the singularity outright; do that if it ever shows.
			let solidAngle = min( cosLight / distSq * ${f(args.totalArea)}, 2.0 * ${TAU} );
			let radiance = ${records}[ ${emission} ].xyz;
			return radiance * ( cosSurface * solidAngle );

		}
	`;
}
