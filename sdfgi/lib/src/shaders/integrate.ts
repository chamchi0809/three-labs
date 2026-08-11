import { MAX_CASCADES } from '../constants.ts';
import { WGSL_DEFINES, WGSL_CASCADE_UVW, WGSL_OCT, WGSL_CASCADES, WGSL_HASH } from './common.ts';

/**
 * Port of godot/servers/rendering/renderer_rd/shaders/environment/sdfgi_integrate.glsl
 *
 * Deviations:
 *  - lightprobe_history / lightprobe_average (and their scroll + parent aliases)
 *    are storage BUFFERS, not storage textures: WebGPU only allows read_write
 *    storage textures for r32{uint,sint,float}, and these are rgba16i / rgba32i.
 *    Nothing outside this shader reads them, so the layout is ours to choose.
 *  - lightprobe_texture_data is rgba16float instead of an r32ui RGBE9995 alias.
 *  - the per-cascade texture arrays are single packed 3D textures.
 *  - USE_RADIANCE_OCTMAP_ARRAY is not ported; sky irradiance is always a 2D oct map.
 */

const PARAMS = /* wgsl */ `
struct Params {
  grid_size: vec3f,
  max_cascades: u32,
  probe_axis_size: u32,
  cascade: u32,
  history_index: u32,
  history_size: u32,
  ray_count: u32,
  ray_bias: f32,
  image_size: vec2i,
  world_offset: vec3i,
  sky_flags: u32,
  scroll: vec3i,
  sky_energy: f32,
  sky_color_or_orientation: vec3f,
  y_mult: f32,
  sky_irradiance_border_size: vec2f,
  store_ambient_texture: u32,
  /** this dispatch refreshes probes where flat_index % probe_slices == probe_phase */
  probe_phase: u32,
  probe_slices: u32,
  pad: u32,
};
@group(1) @binding(0) var<uniform> params: Params;

const SKY_FLAGS_MODE_COLOR: u32 = 0x01u;
const SKY_FLAGS_MODE_SKY: u32 = 0x02u;
const SKY_FLAGS_ORIENTATION_SIGN: u32 = 0x04u;

// history is (axis*axis) x (axis*SH_SIZE) x history_size, average drops the layer
fn hidx(p: vec3i) -> u32 {
  let w = i32(params.probe_axis_size * params.probe_axis_size);
  let h = i32(params.probe_axis_size) * SH_SIZE;
  return u32((p.z * h + p.y) * w + p.x);
}
fn aidx(p: vec2i) -> u32 {
  return u32(p.y * i32(params.probe_axis_size * params.probe_axis_size) + p.x);
}
// history samples are clamped to 16 bits and .w is the constant 1.0, so three
// i16 fit in two u32 -- half the memory of the vec4i Godot uses, which is what
// pays for a 30-frame history instead of 10.
fn hpack(v: vec4i) -> vec2u {
  return vec2u((bitcast<u32>(v.x) & 0xFFFFu) | (bitcast<u32>(v.y) << 16u), bitcast<u32>(v.z) & 0xFFFFu);
}
fn hunpack(p: vec2u) -> vec4i {
  return vec4i(bitcast<i32>(p.x << 16u) >> 16u, bitcast<i32>(p.x & 0xFFFF0000u) >> 16u,
      bitcast<i32>(p.y << 16u) >> 16u, i32(1u << HISTORY_BITS));
}
`;

const HEAD = WGSL_DEFINES + WGSL_OCT + PARAMS;

/**
 * Ray pass: one thread per (probe, ray).
 *
 * Godot -- and this file until now -- ran one thread per probe and looped its
 * `ray_count` rays serially. That is 4913 probes / probe_slices threads for the
 * whole dispatch (~1200 with the defaults), i.e. a couple of threads per lane on
 * any real GPU, each stuck in its own dependent chain of SDF fetches. The
 * pass was almost entirely memory latency with nothing to switch to.
 *
 * Splitting the ray march out multiplies the thread count by `ray_count` (32x
 * with the defaults) at identical work per ray, and the accumulate pass below
 * still sums a probe's rays in the original order, so the result is unchanged.
 */
export const RAYS = /* wgsl */ `
${HEAD}${WGSL_CASCADE_UVW}${WGSL_CASCADES}${WGSL_HASH}
@group(0) @binding(1) var sdf_cascades: texture_3d<f32>;
@group(0) @binding(2) var light_cascades: texture_3d<f32>;
@group(0) @binding(3) var aniso0_cascades: texture_3d<f32>;
@group(0) @binding(4) var aniso1_cascades: texture_3d<f32>;
@group(0) @binding(6) var linear_sampler: sampler;
@group(0) @binding(7) var<uniform> cascades: array<CascadeData, ${MAX_CASCADES}>;
@group(0) @binding(15) var sky_irradiance: texture_2d<f32>;
@group(0) @binding(16) var linear_sampler_mipmaps: sampler;
@group(0) @binding(18) var<storage, read_write> ray_light: array<vec4f>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x / params.ray_count;
  let ray_index = gid.x % params.ray_count;

  // one interleaved slice of the probe grid per frame, so a change in lighting
  // reaches the grid as a dither rather than as one whole-grid step.
  // probe_axis_size^2 and probe_axis_size are both odd, so a constant stride
  // walks diagonally through the 3D grid instead of banding along one axis.
  let flat = i32(slot) * i32(params.probe_slices) + i32(params.probe_phase);
  if (flat >= params.image_size.x * params.image_size.y) { return; }
  let pos = vec2i(flat % params.image_size.x, flat / params.image_size.x);

  let probe_cell_size = (params.grid_size.x / f32(params.probe_axis_size - 1u))
      / cascades[params.cascade].to_cell;

  let probe_cell = vec3i(
      pos.x % i32(params.probe_axis_size),
      pos.y,
      pos.x / i32(params.probe_axis_size));

  let probe_pos = cascades[params.cascade].offset + vec3f(probe_cell) * probe_cell_size;
  let pos_to_uvw = 1.0 / params.grid_size;

  // each probe gets a different vogel offset, based on integer world position
  let h3 = hash3(vec3u(params.world_offset + probe_cell));
  let offset = f32(h3.x & 0xFFFFFu) * (2.0 * PI / 1048576.0);

  // for a more homogeneous hemisphere, alternate based on history frames
  let ray_total = params.history_size * params.ray_count;

  {
    var ray_dir = vogel_hemisphere(params.history_index + ray_index * params.history_size,
        ray_total, offset);
    ray_dir.y *= params.y_mult;
    ray_dir = normalize(ray_dir);

    var ray_pos = probe_pos;
    let inv_dir = 1.0 / ray_dir;

    var hit = false;
    var hit_cascade = 0u;
    var uvw = vec3f(0.0);

    let abs_ray_dir = abs(ray_dir);
    ray_pos += ray_dir / max(abs_ray_dir.x, max(abs_ray_dir.y, abs_ray_dir.z))
        * params.ray_bias / cascades[params.cascade].to_cell;

    for (var j = params.cascade; j < params.max_cascades; j++) {
      var p = ray_pos - cascades[j].offset;
      p *= cascades[j].to_cell;
      if (any(p < vec3f(0.0)) || any(p >= params.grid_size)) { continue; }

      let t0 = -p * inv_dir;
      let t1 = (params.grid_size - p) * inv_dir;
      let tmax = max(t0, t1);
      let max_advance = min(tmax.x, min(tmax.y, tmax.z));

      var advance = 0.0;
      // ponytail: step cap, see directLight.ts. Godot's while() is unbounded.
      for (var s = 0; s < 512 && advance < max_advance; s++) {
        uvw = (p + ray_dir * advance) * pos_to_uvw;
        let d = textureSampleLevel(sdf_cascades, linear_sampler,
            casc_uvw(j, params.max_cascades, uvw), 0.0).r * 255.0 - 1.0;
        if (d < 0.05) { hit = true; break; }
        advance += d;
      }

      if (hit) { hit_cascade = j; break; }

      p += ray_dir * max_advance;
      p /= cascades[j].to_cell;
      p += cascades[j].offset;
      ray_pos = p;
    }

    var light = vec4f(0.0);
    if (hit) {
      // Godot loops over cascades here only to keep the texture index uniform;
      // our cascades live in one texture so the index is already uniform.
      const EPSILON = 0.001;
      let c = casc_uvw(hit_cascade, params.max_cascades, uvw);
      let cx0 = casc_uvw(hit_cascade, params.max_cascades, uvw + vec3f(EPSILON, 0.0, 0.0));
      let cx1 = casc_uvw(hit_cascade, params.max_cascades, uvw - vec3f(EPSILON, 0.0, 0.0));
      let cy0 = casc_uvw(hit_cascade, params.max_cascades, uvw + vec3f(0.0, EPSILON, 0.0));
      let cy1 = casc_uvw(hit_cascade, params.max_cascades, uvw - vec3f(0.0, EPSILON, 0.0));
      let cz0 = casc_uvw(hit_cascade, params.max_cascades, uvw + vec3f(0.0, 0.0, EPSILON));
      let cz1 = casc_uvw(hit_cascade, params.max_cascades, uvw - vec3f(0.0, 0.0, EPSILON));
      let hit_normal = normalize(vec3f(
          textureSampleLevel(sdf_cascades, linear_sampler, cx0, 0.0).r - textureSampleLevel(sdf_cascades, linear_sampler, cx1, 0.0).r,
          textureSampleLevel(sdf_cascades, linear_sampler, cy0, 0.0).r - textureSampleLevel(sdf_cascades, linear_sampler, cy1, 0.0).r,
          textureSampleLevel(sdf_cascades, linear_sampler, cz0, 0.0).r - textureSampleLevel(sdf_cascades, linear_sampler, cz1, 0.0).r));

      let hit_light = textureSampleLevel(light_cascades, linear_sampler, c, 0.0).rgb;
      let aniso0 = textureSampleLevel(aniso0_cascades, linear_sampler, c, 0.0);
      let hit_aniso0 = aniso0.rgb;
      let hit_aniso1 = vec3f(aniso0.a, textureSampleLevel(aniso1_cascades, linear_sampler, c, 0.0).rg);

      // one liner magic
      light = vec4f(hit_light * (dot(max(vec3f(0.0), hit_normal * hit_aniso0), vec3f(1.0))
          + dot(max(vec3f(0.0), -hit_normal * hit_aniso1), vec3f(1.0))), 1.0);
    } else if ((params.sky_flags & SKY_FLAGS_MODE_SKY) != 0u) {
      // Reconstruct sky orientation as quaternion and rotate ray_dir before sampling.
      let o = params.sky_color_or_orientation;
      let sky_sign = select(-1.0, 1.0, (params.sky_flags & SKY_FLAGS_ORIENTATION_SIGN) != 0u);
      let sky_quat = vec4f(o, sky_sign * sqrt(1.0 - dot(o, o)));
      var sky_dir = cross(sky_quat.xyz, ray_dir);
      sky_dir = ray_dir + ((sky_dir * sky_quat.w) + cross(sky_quat.xyz, sky_dir)) * 2.0;
      // mip 2 compensates for the low ray count
      light = vec4f(textureSampleLevel(sky_irradiance, linear_sampler_mipmaps,
          vec3_to_oct_with_border(sky_dir, params.sky_irradiance_border_size), 2.0).rgb * params.sky_energy, 0.0);
    } else if ((params.sky_flags & SKY_FLAGS_MODE_COLOR) != 0u) {
      light = vec4f(params.sky_color_or_orientation * params.sky_energy, 0.0);
    }

    ray_light[gid.x] = vec4f(light.rgb, 0.0);
  }
}
`;

/**
 * Accumulate pass: one thread per probe, folding this frame's rays into the SH
 * history exactly as the old fused pass did -- same rays, same order, so the
 * numbers coming out are bit-for-bit what they were.
 *
 * The SH accumulator is per-thread and never crosses lanes (Godot's is a
 * workgroup array only because its group is 2D). Held in registers, this pass is
 * pure ALU over a sequential read of the ray buffer.
 */
export const PROCESS = /* wgsl */ `
${HEAD}${WGSL_HASH}
@group(0) @binding(9) var<storage, read_write> lightprobe_history: array<vec2u>;
@group(0) @binding(10) var<storage, read_write> lightprobe_average: array<vec4i>;
@group(0) @binding(14) var lightprobe_ambient_texture: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(18) var<storage, read> ray_light: array<vec4f>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let flat = i32(gid.x) * i32(params.probe_slices) + i32(params.probe_phase);
  if (flat >= params.image_size.x * params.image_size.y) { return; }
  let pos = vec2i(flat % params.image_size.x, flat / params.image_size.x);

  let probe_cell = vec3i(
      pos.x % i32(params.probe_axis_size),
      pos.y,
      pos.x / i32(params.probe_axis_size));

  var sh_accum: array<vec3f, 16>;
  for (var i = 0; i < SH_SIZE; i++) { sh_accum[i] = vec3f(0.0); }

  let h3 = hash3(vec3u(params.world_offset + probe_cell));
  let offset = f32(h3.x & 0xFFFFFu) * (2.0 * PI / 1048576.0);

  let ray_offset = params.history_index;
  let ray_mult = params.history_size;
  let ray_total = ray_mult * params.ray_count;
  let ray_base = gid.x * params.ray_count;

  for (var i = 0u; i < params.ray_count; i++) {
    var ray_dir = vogel_hemisphere(ray_offset + i * ray_mult, ray_total, offset);
    ray_dir.y *= params.y_mult;
    ray_dir = normalize(ray_dir);

    let light = ray_light[ray_base + i];

    let d2 = ray_dir * ray_dir;
    var sh: array<f32, 16>;
    sh[0] = 0.282095;
    sh[1] = 0.488603 * ray_dir.y;
    sh[2] = 0.488603 * ray_dir.z;
    sh[3] = 0.488603 * ray_dir.x;
    sh[4] = 1.092548 * ray_dir.x * ray_dir.y;
    sh[5] = 1.092548 * ray_dir.y * ray_dir.z;
    sh[6] = 0.315392 * (3.0 * d2.z - 1.0);
    sh[7] = 1.092548 * ray_dir.x * ray_dir.z;
    sh[8] = 0.546274 * (d2.x - d2.y);
    sh[9] = 0.590043 * ray_dir.y * (3.0 * d2.x - d2.y);
    sh[10] = 2.890611 * ray_dir.y * ray_dir.x * ray_dir.z;
    sh[11] = 0.646360 * ray_dir.y * (-1.0 + 5.0 * d2.z);
    sh[12] = 0.373176 * (5.0 * d2.z * ray_dir.z - 3.0 * ray_dir.z);
    sh[13] = 0.457045 * ray_dir.x * (-1.0 + 5.0 * d2.z);
    sh[14] = 1.445305 * (d2.x - d2.y) * ray_dir.z;
    sh[15] = 0.590043 * ray_dir.x * (d2.x - 3.0 * d2.y);

    for (var m = 0; m < SH_SIZE; m++) {
      sh_accum[m] += light.rgb * sh[m];
    }
  }

  for (var i = 0; i < SH_SIZE; i++) {
    let prev_pos = vec3i(pos.x, pos.y * SH_SIZE + i, i32(params.history_index));
    let average_pos = prev_pos.xy;

    let value = vec4f(sh_accum[i], 1.0) * 4.0 / f32(params.ray_count);
    // clamp to 16 bits, so higher values don't break average
    let ivalue = clamp(vec4i(value * f32(1u << HISTORY_BITS)), vec4i(-32768), vec4i(32767));

    let hi = hidx(prev_pos);
    let ai = aidx(average_pos);
    let average = lightprobe_average[ai] - hunpack(lightprobe_history[hi]) + ivalue;

    lightprobe_history[hi] = hpack(ivalue);
    lightprobe_average[ai] = average;

    if (params.store_ambient_texture != 0u && i == 0) {
      var ambient_light = (vec4f(average) / f32(params.history_size)) / f32(1u << HISTORY_BITS);
      ambient_light *= 0.88622; // SHL0
      textureStore(lightprobe_ambient_texture, pos, i32(params.cascade), ambient_light);
    }
  }
}
`;

/**
 * Not in Godot. 32 rays x 30 history frames against a small bright emitter is
 * ~10% shot noise per probe, and probe spacing is ~1 world unit, so it reads as
 * soft blobs the size of the probe grid rather than as grain. Neighbouring
 * probes now draw decorrelated ray sets (see the vogel offset in PROCESS), so
 * averaging a probe with its 6 neighbours cancels that error instead of
 * reinforcing it. The similarity weight is the whole safety story: a probe on
 * the far side of a wall differs by orders of magnitude and drops out, shot
 * noise differs by a few percent and blends.
 */
export const FILTER = /* wgsl */ `
${HEAD}
@group(0) @binding(10) var<storage, read> lightprobe_average: array<vec4i>;
@group(0) @binding(17) var<storage, read_write> lightprobe_average_filtered: array<vec4i>;

const NEIGHBOURS = array<vec3i, 6>(
  vec3i(-1, 0, 0), vec3i(1, 0, 0), vec3i(0, -1, 0),
  vec3i(0, 1, 0), vec3i(0, 0, -1), vec3i(0, 0, 1));

/** L0 is the probe's mean irradiance: enough to tell a wall from shot noise. */
fn probe_l0(p: vec2i) -> f32 {
  let v = vec3f(lightprobe_average[aidx(vec2i(p.x, p.y * SH_SIZE))].rgb);
  return max(dot(v, vec3f(0.2126, 0.7152, 0.0722)), 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec2i(gid.xy);
  if (any(pos >= params.image_size)) { return; }

  let axis = i32(params.probe_axis_size);
  let cell = vec3i(pos.x % axis, pos.y, pos.x / axis);
  let l0 = probe_l0(pos);

  var np = array<vec2i, 6>(vec2i(0), vec2i(0), vec2i(0), vec2i(0), vec2i(0), vec2i(0));
  var w = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  var w_total = 1.0;

  for (var k = 0; k < 6; k++) {
    let n = cell + NEIGHBOURS[k];
    if (any(n < vec3i(0)) || any(n >= vec3i(axis))) { continue; }
    np[k] = vec2i(n.x + n.z * axis, n.y);
    let ln = probe_l0(np[k]);
    let r = min(l0, ln) / max(max(l0, ln), 1e-4);
    w[k] = r * r;
    w_total += w[k];
  }

  let inv = 1.0 / w_total;
  for (var i = 0; i < SH_SIZE; i++) {
    let centre = aidx(vec2i(pos.x, pos.y * SH_SIZE + i));
    var acc = vec4f(lightprobe_average[centre]);
    for (var k = 0; k < 6; k++) {
      if (w[k] <= 0.0) { continue; }
      acc += vec4f(lightprobe_average[aidx(vec2i(np[k].x, np[k].y * SH_SIZE + i))]) * w[k];
    }
    lightprobe_average_filtered[centre] = vec4i(acc * inv);
  }
}
`;

export const STORE = /* wgsl */ `
${HEAD}
@group(0) @binding(8) var lightprobe_texture_data: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(10) var<storage, read> lightprobe_average: array<vec4i>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec2i(gid.xy);
  if (any(pos >= params.image_size)) { return; }

  // octahedral is much faster to read from the screen than spherical harmonics
  let sh_pos = (pos / OCT_SIZE) * vec2i(1, SH_SIZE);
  let oct_pos = (pos / OCT_SIZE) * (OCT_SIZE + 2) + vec2i(1);
  let local_pos = pos % OCT_SIZE;

  let normal = octahedron_decode(vec2f(local_pos) / f32(OCT_SIZE));
  let n2 = normal * normal;

  var c: array<f32, 16>;
  c[0] = 0.282095;
  c[1] = 0.488603 * normal.y;
  c[2] = 0.488603 * normal.z;
  c[3] = 0.488603 * normal.x;
  c[4] = 1.092548 * normal.x * normal.y;
  c[5] = 1.092548 * normal.y * normal.z;
  c[6] = 0.315392 * (3.0 * n2.z - 1.0);
  c[7] = 1.092548 * normal.x * normal.z;
  c[8] = 0.546274 * (n2.x - n2.y);
  c[9] = 0.590043 * normal.y * (3.0 * n2.x - n2.y);
  c[10] = 2.890611 * normal.y * normal.x * normal.z;
  c[11] = 0.646360 * normal.y * (-1.0 + 5.0 * n2.z);
  c[12] = 0.373176 * (5.0 * n2.z * normal.z - 3.0 * normal.z);
  c[13] = 0.457045 * normal.x * (-1.0 + 5.0 * n2.z);
  c[14] = 1.445305 * (n2.x - n2.y) * normal.z;
  c[15] = 0.590043 * normal.x * (n2.x - 3.0 * n2.y);

  // l3 does not contribute to irradiance
  let l_mult = array<f32, 16>(1.0, 2.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0,
      0.25, 0.25, 0.25, 0.25, 0.25,
      0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);

  var irradiance = vec3f(0.0);
  var radiance = vec3f(0.0);

  for (var i = 0; i < SH_SIZE; i++) {
    let average = lightprobe_average[aidx(sh_pos + vec2i(0, i))];
    let sh = (vec4f(average) / f32(params.history_size)) / f32(1u << HISTORY_BITS);
    let m = sh.rgb * c[i] * 4.0;
    irradiance += m * l_mult[i];
    radiance += m;
  }

  // store in octahedral map, replicating into the 1px gutter
  var copy_to = array<vec2i, 4>(vec2i(-2), vec2i(-2), vec2i(-2), vec2i(-2));
  copy_to[0] = oct_pos + local_pos;

  if (all(local_pos == vec2i(0, 0))) {
    copy_to[1] = oct_pos + vec2i(OCT_SIZE - 1, -1);
    copy_to[2] = oct_pos + vec2i(-1, OCT_SIZE - 1);
    copy_to[3] = oct_pos + vec2i(OCT_SIZE, OCT_SIZE);
  } else if (all(local_pos == vec2i(OCT_SIZE - 1, 0))) {
    copy_to[1] = oct_pos + vec2i(0, -1);
    copy_to[2] = oct_pos + vec2i(OCT_SIZE, OCT_SIZE - 1);
    copy_to[3] = oct_pos + vec2i(-1, OCT_SIZE);
  } else if (all(local_pos == vec2i(0, OCT_SIZE - 1))) {
    copy_to[1] = oct_pos + vec2i(-1, 0);
    copy_to[2] = oct_pos + vec2i(OCT_SIZE - 1, OCT_SIZE);
    copy_to[3] = oct_pos + vec2i(OCT_SIZE, -1);
  } else if (all(local_pos == vec2i(OCT_SIZE - 1, OCT_SIZE - 1))) {
    copy_to[1] = oct_pos + vec2i(0, OCT_SIZE);
    copy_to[2] = oct_pos + vec2i(OCT_SIZE, 0);
    copy_to[3] = oct_pos + vec2i(-1, -1);
  } else if (local_pos.y == 0) {
    copy_to[1] = oct_pos + vec2i(OCT_SIZE - local_pos.x - 1, local_pos.y - 1);
  } else if (local_pos.x == 0) {
    copy_to[1] = oct_pos + vec2i(local_pos.x - 1, OCT_SIZE - local_pos.y - 1);
  } else if (local_pos.y == OCT_SIZE - 1) {
    copy_to[1] = oct_pos + vec2i(OCT_SIZE - local_pos.x - 1, local_pos.y + 1);
  } else if (local_pos.x == OCT_SIZE - 1) {
    copy_to[1] = oct_pos + vec2i(local_pos.x + 1, OCT_SIZE - local_pos.y - 1);
  }

  for (var i = 0; i < 4; i++) {
    if (all(copy_to[i] == vec2i(-2))) { continue; }
    textureStore(lightprobe_texture_data, copy_to[i], i32(params.cascade), vec4f(irradiance, 1.0));
    textureStore(lightprobe_texture_data, copy_to[i], i32(params.cascade + params.max_cascades), vec4f(radiance, 1.0));
  }
}
`;

export const SCROLL = /* wgsl */ `
${HEAD}${WGSL_CASCADES}
@group(0) @binding(7) var<uniform> cascades: array<CascadeData, ${MAX_CASCADES}>;
@group(0) @binding(9) var<storage, read> lightprobe_history: array<vec2u>;
@group(0) @binding(10) var<storage, read> lightprobe_average: array<vec4i>;
@group(0) @binding(11) var<storage, read_write> lightprobe_history_scroll: array<vec2u>;
@group(0) @binding(12) var<storage, read_write> lightprobe_average_scroll: array<vec4i>;
@group(0) @binding(13) var<storage, read> lightprobe_average_parent: array<vec4i>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec2i(gid.xy);
  if (any(pos >= params.image_size)) { return; }

  let axis = i32(params.probe_axis_size);
  let probe_cell = vec3i(pos.x % axis, pos.y, pos.x / axis);
  let read_probe = probe_cell - params.scroll;

  if (all(read_probe >= vec3i(0)) && all(read_probe < vec3i(axis))) {
    // can scroll
    let tex_pos = vec2i(read_probe.x + read_probe.z * axis, read_probe.y);

    for (var j = 0u; j < params.history_size; j++) {
      for (var i = 0; i < SH_SIZE; i++) {
        let src = hidx(vec3i(tex_pos.x, tex_pos.y * SH_SIZE + i, i32(j)));
        let dst = hidx(vec3i(pos.x, pos.y * SH_SIZE + i, i32(j)));
        lightprobe_history_scroll[dst] = lightprobe_history[src];
      }
    }
    for (var i = 0; i < SH_SIZE; i++) {
      let src = aidx(vec2i(tex_pos.x, tex_pos.y * SH_SIZE + i));
      let dst = aidx(vec2i(pos.x, pos.y * SH_SIZE + i));
      lightprobe_average_scroll[dst] = lightprobe_average[src];
    }
  } else if (params.cascade < params.max_cascades - 1u) {
    // can't scroll, must look for position in parent cascade
    let cell_to_probe = params.grid_size.x / f32(params.probe_axis_size - 1u);

    let probe_cell_size = cell_to_probe / cascades[params.cascade].to_cell;
    var probe_pos = cascades[params.cascade].offset + vec3f(probe_cell) * probe_cell_size;

    let probe_cell_size_next = cell_to_probe / cascades[params.cascade + 1u].to_cell;
    probe_pos -= cascades[params.cascade + 1u].offset;
    probe_pos /= probe_cell_size_next;

    let probe_posi = vec3i(probe_pos);
    // add up all light, no need to use occlusion here, occlusion works afterwards
    var average_light: array<vec4f, 16>;
    for (var i = 0; i < SH_SIZE; i++) { average_light[i] = vec4f(0.0); }
    var total_weight = 0.0;

    for (var i = 0; i < 8; i++) {
      let offset = probe_posi + ((vec3i(i) >> vec3u(0u, 1u, 2u)) & vec3i(1));
      let trilinear = vec3f(1.0) - abs(probe_pos - vec3f(offset));
      let weight = trilinear.x * trilinear.y * trilinear.z;
      let tex_pos = vec2i(offset.x + offset.z * axis, offset.y);

      for (var j = 0; j < SH_SIZE; j++) {
        let average = lightprobe_average_parent[aidx(vec2i(tex_pos.x, tex_pos.y * SH_SIZE + j))];
        let value = (vec4f(average) / f32(params.history_size)) / f32(1u << HISTORY_BITS);
        average_light[j] += value * weight;
      }
      total_weight += weight;
    }

    if (total_weight > 0.0) { total_weight = 1.0 / total_weight; }

    for (var i = 0; i < SH_SIZE; i++) {
      var ivalue = clamp(vec4i(average_light[i] * total_weight * f32(1u << HISTORY_BITS)),
          vec4i(-32768), vec4i(32767));
      for (var j = 0u; j < params.history_size; j++) {
        lightprobe_history_scroll[hidx(vec3i(pos.x, pos.y * SH_SIZE + i, i32(j)))] = hpack(ivalue);
      }
      ivalue *= vec4i(i32(params.history_size)); // average has all history added up
      lightprobe_average_scroll[aidx(vec2i(pos.x, pos.y * SH_SIZE + i))] = ivalue;
    }
  } else {
    // edge of the highest cascade: keep what is there, it's the closest we have
    for (var j = 0u; j < params.history_size; j++) {
      for (var i = 0; i < SH_SIZE; i++) {
        let dst = hidx(vec3i(pos.x, pos.y * SH_SIZE + i, i32(j)));
        lightprobe_history_scroll[dst] = lightprobe_history[dst];
      }
    }
    for (var i = 0; i < SH_SIZE; i++) {
      let sp = aidx(vec2i(pos.x, pos.y * SH_SIZE + i));
      lightprobe_average_scroll[sp] = lightprobe_average[sp];
    }
  }
}
`;

export const SCROLL_STORE = /* wgsl */ `
${HEAD}
@group(0) @binding(9) var<storage, read_write> lightprobe_history: array<vec2u>;
@group(0) @binding(10) var<storage, read_write> lightprobe_average: array<vec4i>;
@group(0) @binding(11) var<storage, read> lightprobe_history_scroll: array<vec2u>;
@group(0) @binding(12) var<storage, read> lightprobe_average_scroll: array<vec4i>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec2i(gid.xy);
  if (any(pos >= params.image_size)) { return; }

  // do not update probe texture, as these will be updated later
  for (var j = 0u; j < params.history_size; j++) {
    for (var i = 0; i < SH_SIZE; i++) {
      let sp = hidx(vec3i(pos.x, pos.y * SH_SIZE + i, i32(j)));
      lightprobe_history[sp] = lightprobe_history_scroll[sp];
    }
  }
  for (var i = 0; i < SH_SIZE; i++) {
    let sp = aidx(vec2i(pos.x, pos.y * SH_SIZE + i));
    lightprobe_average[sp] = lightprobe_average_scroll[sp];
  }
}
`;
