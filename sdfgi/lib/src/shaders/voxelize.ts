import { WGSL_DEFINES, WGSL_GRID, WGSL_RGBE, ANISO_DIR } from './common.ts';

/**
 * Port of the MODE_RENDER_SDF path of
 * godot/.../shaders/forward_clustered/scene_forward_clustered.glsl (fragment,
 * line 2903) plus the 3-axis orthographic setup of
 * RenderForwardClustered::_render_sdfgi().
 *
 * Deviations:
 *  - the four r16ui/r32ui image3D grids are storage buffers, because
 *    imageAtomicOr on geom_facing has no WGSL texture equivalent.
 *  - sdf_to_bounds maps WORLD -> bounds-local instead of view -> bounds-local;
 *    Godot only goes through view space because that is where its G-buffer
 *    vertex already lives. Same result, one matrix less.
 *  - no alpha scissor / no material shaders: albedo comes from a base color
 *    factor times an optional base color texture.
 */
export const VOXELIZE = /* wgsl */ `
${WGSL_DEFINES}${WGSL_GRID}${WGSL_RGBE}${ANISO_DIR}

struct Pass {
  view_projection: mat4x4f,
  sdf_to_bounds: mat4x4f,
  sdf_offset: vec3i,
  pad0: u32,
  sdf_size: vec3i,
  pad1: u32,
};
struct Draw {
  model: mat4x4f,
  normal_matrix: mat4x4f,
  albedo: vec4f,
  emission: vec4f, // rgb = emission, a = 1 if base color texture is bound
};

@group(0) @binding(0) var<storage, read_write> albedo_volume_grid: array<u32>;
@group(0) @binding(1) var<storage, read_write> geom_facing_grid: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> emission_grid: array<u32>;
@group(0) @binding(3) var<storage, read_write> emission_aniso_grid: array<u32>;
@group(1) @binding(0) var<uniform> pass_data: Pass;
@group(2) @binding(0) var<uniform> draw: Draw;
@group(3) @binding(0) var base_color_tex: texture_2d<f32>;
@group(3) @binding(1) var base_color_smp: sampler;

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
};

@vertex
fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> VOut {
  var o: VOut;
  let world = draw.model * vec4f(position, 1.0);
  o.clip = pass_data.view_projection * world;
  o.world = world.xyz;
  o.normal = (draw.normal_matrix * vec4f(normal, 0.0)).xyz;
  o.uv = uv;
  return o;
}

@fragment
fn fs(i: VOut) {
  let local_pos = (pass_data.sdf_to_bounds * vec4f(i.world, 1.0)).xyz;
  let grid_pos = pass_data.sdf_offset + vec3i(local_pos * vec3f(pass_data.sdf_size));
  if (!inside(grid_pos, GRID)) { return; }
  let gi = gidx(grid_pos);

  var albedo = draw.albedo.rgb;
  if (draw.emission.a > 0.5) {
    albedo *= textureSampleLevel(base_color_tex, base_color_smp, i.uv, 0.0).rgb;
  }

  var albedo16 = 0x1u; // solid flag
  albedo16 |= clamp(u32(albedo.r * 31.0), 0u, 31u) << 11u;
  albedo16 |= clamp(u32(albedo.g * 31.0), 0u, 31u) << 6u;
  albedo16 |= clamp(u32(albedo.b * 31.0), 0u, 31u) << 1u;
  albedo_volume_grid[gi] = albedo16;

  let cam_normal = normalize(i.normal);

  var facing_bits = 0u;
  var closest_dist = -1e20;
  for (var k = 0u; k < 6u; k++) {
    let d = dot(cam_normal, aniso_dir[k]);
    if (d > closest_dist) {
      closest_dist = d;
      facing_bits = 1u << k;
    }
  }
  atomicOr(&geom_facing_grid[gi], facing_bits);

  let emission = draw.emission.rgb;
  if (length(emission) > 0.001) {
    var lumas: array<f32, 6>;
    var light_total = vec3f(0.0);
    for (var k = 0; k < 6; k++) {
      let light = emission * max(0.0, dot(cam_normal, aniso_dir[k]));
      light_total += light;
      lumas[k] = max(light.r, max(light.g, light.b));
    }
    // ponytail: epsilon guard; Godot divides unguarded and NaNs on back-faces.
    let luma_total = max(max(light_total.r, max(light_total.g, light_total.b)), 1e-9);

    var light_aniso = 0u;
    for (var k = 0; k < 6; k++) {
      light_aniso |= min(31u, u32((lumas[k] / luma_total) * 31.0)) << u32(k * 5);
    }

    emission_grid[gi] = rgbe8985_encode(light_total);
    emission_aniso_grid[gi] = light_aniso;
  }
}
`;
