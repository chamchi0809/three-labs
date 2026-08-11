import { MAX_CASCADES } from '../constants.ts';
import { WGSL_DEFINES, WGSL_CASCADE_UVW, WGSL_OCT, WGSL_CASCADES } from './common.ts';

/**
 * Ports of godot/.../environment/sdfgi_debug.glsl and sdfgi_debug_probes.glsl.
 *
 * Deviations:
 *  - the packed mat3x4 inv_projection / float[3][3] cam_basis push constants are
 *    plain mat4x4f here; the packing only existed to fit Vulkan's 128-byte limit.
 *  - the per-cascade texture arrays are single packed 3D textures.
 */

export const DEBUG = /* wgsl */ `
${WGSL_DEFINES}${WGSL_CASCADE_UVW}

struct Params {
  grid_size: vec3f,
  max_cascades: u32,
  screen_size: vec2i,
  y_mult: f32,
  z_near: f32,
  inv_projection: mat4x4f,
  cam_basis: mat4x4f,
  cam_origin: vec3f,
  pad: f32,
};
@group(1) @binding(0) var<uniform> params: Params;

${WGSL_CASCADES}
@group(0) @binding(1) var sdf_cascades: texture_3d<f32>;
@group(0) @binding(2) var light_cascades: texture_3d<f32>;
@group(0) @binding(3) var aniso0_cascades: texture_3d<f32>;
@group(0) @binding(4) var aniso1_cascades: texture_3d<f32>;
@group(0) @binding(8) var linear_sampler: sampler;
@group(0) @binding(9) var<uniform> cascades: array<CascadeData, ${MAX_CASCADES}>;
@group(0) @binding(10) var screen_buffer: texture_storage_2d<rgba16float, write>;

fn linear_to_srgb(color: vec3f) -> vec3f {
  let a = vec3f(0.055);
  return select((vec3f(1.0) + a) * pow(color, vec3f(1.0 / 2.4)) - a, 12.92 * color,
      color < vec3f(0.0031308));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let screen_pos = vec2i(gid.xy);
  if (any(screen_pos >= params.screen_size)) { return; }

  var ray_pos = params.cam_origin;
  let uv = (vec2f(screen_pos) + vec2f(0.5)) / vec2f(params.screen_size);
  var ray_dir = vec3f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, params.z_near);
  ray_dir = (params.inv_projection * vec4f(ray_dir, 1.0)).xyz;
  let basis = mat3x3f(params.cam_basis[0].xyz, params.cam_basis[1].xyz, params.cam_basis[2].xyz);
  ray_dir = normalize(basis * ray_dir);

  ray_pos.y *= params.y_mult;
  ray_dir.y *= params.y_mult;
  ray_dir = normalize(ray_dir);

  let pos_to_uvw = 1.0 / params.grid_size;
  let inv_dir = 1.0 / ray_dir;
  var light = vec3f(0.0);

  for (var i = 0u; i < params.max_cascades; i++) {
    var pos = ray_pos - cascades[i].offset;
    pos *= cascades[i].to_cell;

    let t0 = -pos * inv_dir;
    let t1 = (params.grid_size - pos) * inv_dir;
    let tmax = max(t0, t1);
    let max_advance = min(tmax.x, min(tmax.y, tmax.z));

    var advance = 0.0;
    var uvw = vec3f(0.0);
    var hit = false;

    // ponytail: step cap, see directLight.ts.
    for (var s = 0; s < 512 && advance < max_advance; s++) {
      uvw = (pos + ray_dir * advance) * pos_to_uvw;
      let d = textureSampleLevel(sdf_cascades, linear_sampler,
          casc_uvw(i, params.max_cascades, uvw), 0.0).r * 255.0 - 1.7;
      if (d < 0.001) { hit = true; break; }
      advance += d;
    }

    if (!hit) {
      pos += ray_dir * min(advance, max_advance);
      pos /= cascades[i].to_cell;
      pos += cascades[i].offset;
      ray_pos = pos;
      continue;
    }

    const EPSILON = 0.001;
    let c = casc_uvw(i, params.max_cascades, uvw);
    let sx0 = textureSampleLevel(sdf_cascades, linear_sampler, casc_uvw(i, params.max_cascades, uvw + vec3f(EPSILON, 0.0, 0.0)), 0.0).r;
    let sx1 = textureSampleLevel(sdf_cascades, linear_sampler, casc_uvw(i, params.max_cascades, uvw - vec3f(EPSILON, 0.0, 0.0)), 0.0).r;
    let sy0 = textureSampleLevel(sdf_cascades, linear_sampler, casc_uvw(i, params.max_cascades, uvw + vec3f(0.0, EPSILON, 0.0)), 0.0).r;
    let sy1 = textureSampleLevel(sdf_cascades, linear_sampler, casc_uvw(i, params.max_cascades, uvw - vec3f(0.0, EPSILON, 0.0)), 0.0).r;
    let sz0 = textureSampleLevel(sdf_cascades, linear_sampler, casc_uvw(i, params.max_cascades, uvw + vec3f(0.0, 0.0, EPSILON)), 0.0).r;
    let sz1 = textureSampleLevel(sdf_cascades, linear_sampler, casc_uvw(i, params.max_cascades, uvw - vec3f(0.0, 0.0, EPSILON)), 0.0).r;
    let hit_normal = normalize(vec3f(sx0 - sx1, sy0 - sy1, sz0 - sz1));

    let hit_light = textureSampleLevel(light_cascades, linear_sampler, c, 0.0).rgb;
    let aniso0 = textureSampleLevel(aniso0_cascades, linear_sampler, c, 0.0);
    let hit_aniso0 = aniso0.rgb;
    let hit_aniso1 = vec3f(aniso0.a, textureSampleLevel(aniso1_cascades, linear_sampler, c, 0.0).rg);

    light = hit_light * (dot(max(vec3f(0.0), hit_normal * hit_aniso0), vec3f(1.0))
        + dot(max(vec3f(0.0), -hit_normal * hit_aniso1), vec3f(1.0)));
    break;
  }

  textureStore(screen_buffer, screen_pos, vec4f(clamp(linear_to_srgb(light), vec3f(0.0), vec3f(1.0)), 1.0));
}
`;

const PROBE_HEAD = /* wgsl */ `
${WGSL_DEFINES}${WGSL_OCT}${WGSL_CASCADES}

struct Params {
  band_power: u32,
  sections_in_band: u32,
  band_mask: u32,
  section_arc: f32,
  grid_size: vec3f,
  cascade: u32,
  pad: u32,
  y_mult: f32,
  probe_debug_index: u32,
  probe_axis_size: i32,
};
@group(1) @binding(0) var<uniform> params: Params;

@group(0) @binding(1) var<uniform> cascades: array<CascadeData, ${MAX_CASCADES}>;
@group(0) @binding(5) var<uniform> view_projection: mat4x4f;

// https://in4k.untergrund.net/html_articles/hugi_27_-_coding_corner_polaris_sphere_tessellation_101.htm
fn get_sphere_vertex(p_vertex_id: u32) -> vec3f {
  var x_angle = f32(p_vertex_id & 1u) + f32(p_vertex_id >> params.band_power);
  var y_angle = f32((p_vertex_id & params.band_mask) >> 1u)
      + f32((p_vertex_id >> params.band_power) * params.sections_in_band);
  x_angle *= params.section_arc * 0.5; // 180deg x rot, not 360
  y_angle *= -params.section_arc;
  return vec3f(sin(x_angle) * sin(y_angle), cos(x_angle), sin(x_angle) * cos(y_angle));
}
`;

export const DEBUG_PROBES = /* wgsl */ `
${PROBE_HEAD}
@group(0) @binding(2) var lightprobe_texture: texture_2d_array<f32>;
@group(0) @binding(3) var linear_sampler: sampler;

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) normal_interp: vec3f,
  @location(1) @interpolate(flat) probe_index: u32,
};

@vertex
fn vs(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VOut {
  var o: VOut;
  o.probe_index = iid;
  o.normal_interp = get_sphere_vertex(vid);

  var vertex = o.normal_interp * 0.2;
  let probe_cell_size = (params.grid_size.x / f32(params.probe_axis_size - 1))
      / cascades[params.cascade].to_cell;

  let axis = u32(params.probe_axis_size);
  let probe_cell = vec3i(vec3u(iid % axis, iid / (axis * axis), (iid / axis) % axis));

  vertex += (cascades[params.cascade].offset + vec3f(probe_cell) * probe_cell_size)
      / vec3f(1.0, params.y_mult, 1.0);
  o.clip = view_projection * vec4f(vertex, 1.0);
  return o;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  let axis = i32(params.probe_axis_size);
  let pi = i32(i.probe_index);
  var tex_pos = vec2i(pi % axis + axis * ((pi / axis) % axis), pi / (axis * axis));

  var uv = vec2f(tex_pos * (OCT_SIZE + 2) + vec2i(1))
      + octahedron_encode(i.normal_interp) * f32(OCT_SIZE);
  uv /= vec2f(vec2i(axis * axis * (OCT_SIZE + 2), axis * (OCT_SIZE + 2)));

  return textureSampleLevel(lightprobe_texture, linear_sampler, uv, i32(params.cascade), 0.0);
}
`;

export const DEBUG_PROBE_VISIBILITY = /* wgsl */ `
${PROBE_HEAD}
@group(0) @binding(4) var occlusion_texture: texture_3d<f32>;

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) visibility: f32,
};

@vertex
fn vs(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VOut {
  var o: VOut;
  let probe_index = i32(params.probe_debug_index);
  var vertex = get_sphere_vertex(vid) * 0.01;

  let axis = i32(params.probe_axis_size);
  let probe_cell_size = (params.grid_size.x / f32(axis - 1)) / cascades[params.cascade].to_cell;
  let probe_cell = vec3i(probe_index % axis, (probe_index % (axis * axis)) / axis, probe_index / (axis * axis));

  vertex += (cascades[params.cascade].offset + vec3f(probe_cell) * probe_cell_size)
      / vec3f(1.0, params.y_mult, 1.0);

  let probe_voxels = i32(params.grid_size.x) / (axis - 1);
  let diameter = probe_voxels * 2;
  let oi = i32(iid);
  let occluder_pos = vec3i(oi % diameter, oi / (diameter * diameter), (oi / diameter) % diameter);
  let cell_size = 1.0 / cascades[params.cascade].to_cell;
  let occluder_offset = occluder_pos - vec3i(diameter / 2);
  vertex += ((vec3f(occluder_offset) + vec3f(0.5)) * cell_size) / vec3f(1.0, params.y_mult, 1.0);

  let global_cell = probe_cell + cascades[params.cascade].probe_world_offset;
  var occlusion_layer = 0u;
  if ((global_cell.x & 1) != 0) { occlusion_layer |= 1u; }
  if ((global_cell.y & 1) != 0) { occlusion_layer |= 2u; }
  if ((global_cell.z & 1) != 0) { occlusion_layer |= 4u; }

  var tex_pos = probe_cell * probe_voxels + occluder_offset;
  tex_pos.z += i32(params.cascade) * i32(params.grid_size.x);
  if (occlusion_layer >= 4u) {
    tex_pos.x += i32(params.grid_size.x);
    occlusion_layer &= 3u;
  }

  let layer_axis = array<vec4f, 4>(vec4f(1, 0, 0, 0), vec4f(0, 1, 0, 0), vec4f(0, 0, 1, 0), vec4f(0, 0, 0, 1));
  o.visibility = dot(textureLoad(occlusion_texture, tex_pos, 0), layer_axis[occlusion_layer]);
  o.clip = view_projection * vec4f(vertex, 1.0);
  return o;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  return vec4f(1.0, i.visibility, i.visibility, 1.0);
}
`;
