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

  const bvh = new BVHComputeData(bvhProxy(scene), {
    attributes: { position: "vec4f", normal: "vec4f" },
  });
  bvh.update();

  const area = areaLights(scene);
  const padded = Math.ceil(count / WORKGROUP) * WORKGROUP;

  // compacted texel inputs; the accumulator is padded so the tail workgroup's writes land in slack
  const positions = new Float32Array(count * 4);
  const normals = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 4; k++) {
      positions[i * 4 + k] = texels.position[texels.index[i] * 4 + k];
      normals[i * 4 + k] = texels.normal[texels.index[i] * 4 + k];
    }
  }

  const accumAttribute = new THREE.StorageBufferAttribute(new Float32Array(padded * 4), 4);
  const texelPos = vec4Storage(positions);
  const texelNrm = vec4Storage(normals);
  const materials = vec4Storage(materialBuffer(scene));
  const lights = vec4Storage(lightBuffer(scene));
  const emissive = vec4Storage(area.data);
  const accum = storage(accumAttribute, "vec4", padded);

  const kernelFn = traceFn({
    bvh,
    texelPos,
    texelNrm,
    materials,
    lights,
    emissive,
    count,
    samples,
    batch,
    bounces,
    bias,
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
  texelPos: unknown;
  texelNrm: unknown;
  materials: unknown;
  lights: unknown;
  emissive: unknown;
  count: number;
  samples: number;
  batch: number;
  bounces: number;
  bias: number;
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
  const { bvh, texelPos, texelNrm, materials, lights, emissive } = args;
  const raycast = bvh.fns.raycastFirstHit;

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

				let c0 = ${lights}[ i * 4u ];
				let c1 = ${lights}[ i * 4u + 1u ];
				let c2 = ${lights}[ i * 4u + 2u ];
				let c3 = ${lights}[ i * 4u + 3u ];
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

			let origin = ${texelPos}[ index ].xyz;
			let surfaceNormal = ${texelNrm}[ index ].xyz;

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

					// bounce radiance is albedo/PI * E, and the PI from the estimator cancels the 1/PI
					let material = u32( ${bvh.storage.attributes}[ hit.indices.x ].normal.w + 0.5 );
					throughput *= ${materials}[ material * 2u ].xyz;
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
  const { emissive, materials } = args;
  return wgslTagFn/* wgsl */ `
		fn lm_area( origin: vec3f, nrm: vec3f, state: ptr<function, u32> ) -> vec3f {

			// ponytail: linear scan of the area CDF. Fine to a few hundred emissive triangles; make it a
			// binary search (or an alias table) past that.
			let pickTarget = ${rand}( state ) * ${f(args.totalArea)};
			var pick = max( ${args.emissiveCount}u, 1u ) - 1u;
			for ( var i = 0u; i < ${args.emissiveCount}u; i = i + 1u ) {

				if ( ${emissive}[ i * 3u ].w >= pickTarget ) {

					pick = i;
					break;

				}

			}

			let e0 = ${emissive}[ pick * 3u ];
			let e1 = ${emissive}[ pick * 3u + 1u ];
			let e2 = ${emissive}[ pick * 3u + 2u ];

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
			// emission is two sided, like an unculled MeshStandardMaterial
			let cosLight = abs( dot( normalize( cross( edge0, edge1 ) ), toLight ) );
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
			let radiance = ${materials}[ u32( e2.w + 0.5 ) * 2u + 1u ].xyz;
			return radiance * ( cosSurface * solidAngle );

		}
	`;
}
