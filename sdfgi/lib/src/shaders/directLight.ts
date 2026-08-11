import { MAX_CASCADES } from '../constants.ts';
import {
  WGSL_DEFINES,
  WGSL_CASCADE_UVW,
  WGSL_OCT,
  WGSL_CASCADES,
  WGSL_RGBE,
  ANISO_DIR,
  NEIGHBOURS26,
} from './common.ts';

/**
 * Port of godot/servers/rendering/renderer_rd/shaders/environment/sdfgi_direct_light.glsl
 *
 * Deviations:
 *  - LIGHT_TYPE_AREA (LTC) is not ported; the Light struct drops its area fields.
 *  - sdf_cascades[8] is one packed 3D texture (WGSL has no binding arrays).
 *  - dst_light is rgba16float rather than an r32ui alias of E5B9G9R9.
 *  - dst_aniso1 is rgba8unorm (rg8unorm is not a WebGPU storage format).
 */

const HEAD = /* wgsl */ `
${WGSL_DEFINES}${WGSL_CASCADE_UVW}${WGSL_OCT}${WGSL_CASCADES}${WGSL_RGBE}${ANISO_DIR}

struct ProcessVoxel { position: u32, albedo: u32, light: u32, light_aniso: u32 };
struct Dispatch { x: u32, y: u32, z: u32, total_count: u32 };

struct Light {
  color: vec3f,
  energy: f32,
  direction: vec3f,
  has_shadow: u32,
  position: vec3f,
  attenuation: f32,
  ltype: u32,
  cos_spot_angle: f32,
  inv_spot_attenuation: f32,
  radius: f32,
};

struct Params {
  grid_size: vec3f,
  max_cascades: u32,
  cascade: u32,
  light_count: u32,
  process_offset: u32,
  process_increment: u32,
  probe_axis_size: i32,
  bounce_feedback: f32,
  y_mult: f32,
  use_occlusion: u32,
};
@group(1) @binding(0) var<uniform> params: Params;

@group(0) @binding(1) var sdf_cascades: texture_3d<f32>;
@group(0) @binding(2) var linear_sampler: sampler;
@group(0) @binding(4) var<storage, read> dispatch_data: Dispatch;
@group(0) @binding(9) var<uniform> cascades: array<CascadeData, ${MAX_CASCADES}>;
@group(0) @binding(10) var<storage, read> lights: array<Light>;

fn get_omni_attenuation(dist: f32, inv_range: f32, decay: f32) -> f32 {
  var nd = dist * inv_range;
  nd *= nd;
  nd *= nd;
  nd = max(1.0 - nd, 0.0);
  nd *= nd;
  return nd * pow(max(dist, 0.0001), -decay);
}
`;

function body(dynamic: boolean): string {
  return /* wgsl */ `
@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  var voxel_index = gid.x;
  if (params.process_increment > 1u) {
    voxel_index *= params.process_increment;
    voxel_index += params.process_offset;
  }
  if (voxel_index >= dispatch_data.total_count) { return; }

  let voxel_position = process_voxels[voxel_index].position;
  let positioni = vec3i((vec3u(voxel_position) >> vec3u(0u, 7u, 14u)) & vec3u(0x7Fu));

  var position = vec3f(positioni) + vec3f(0.5);
  position /= cascades[params.cascade].to_cell;
  position += cascades[params.cascade].offset;

  let voxel_albedo = process_voxels[voxel_index].albedo;
  let albedo = vec3f((vec3u(voxel_albedo >> 10u, voxel_albedo >> 5u, voxel_albedo)) & vec3u(0x1Fu)) / f32(0x1F);
  var light_accum = array<vec3f, 6>(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
  let valid_aniso = (voxel_albedo >> 15u) & 0x3Fu;

${dynamic ? BOUNCE : ''}

  // previously stored light (rgbe8985) redistributed over the 6 aniso axes
  {
    let l = rgbe8985_decode(process_voxels[voxel_index].light);
    let aniso = process_voxels[voxel_index].light_aniso;
    for (var i = 0u; i < 6u; i++) {
      let strength = f32((aniso >> (i * 5u)) & 0x1Fu) / f32(0x1F);
      light_accum[i] += l * strength;
    }
  }

  // Raytrace light
  let pos_to_uvw = 1.0 / params.grid_size;

  for (var i = 0u; i < params.light_count; i++) {
    var attenuation = 1.0;
    var direction = vec3f(0.0);
    var light_distance = 1e20;
    let texture_color = vec3f(1.0);
    var skip = false;

    let lt = lights[i].ltype;
    if (lt == 0u) { // DIRECTIONAL
      direction = -lights[i].direction;
    } else { // OMNI / SPOT
      let rel_vec = lights[i].position - position;
      direction = normalize(rel_vec);
      light_distance = length(rel_vec);
      attenuation = get_omni_attenuation(light_distance, 1.0 / lights[i].radius, lights[i].attenuation);
      if (lt == 2u) { // SPOT
        let cos_spot_angle = lights[i].cos_spot_angle;
        let cos_angle = dot(-direction, lights[i].direction);
        if (cos_angle < cos_spot_angle) {
          skip = true;
        } else {
          let scos = max(cos_angle, cos_spot_angle);
          let spot_rim = max(0.0001, (1.0 - scos) / (1.0 - cos_spot_angle));
          attenuation *= 1.0 - pow(spot_rim, lights[i].inv_spot_attenuation);
        }
      }
    }

    if (skip || attenuation < 0.001) { continue; }

    var hit = false;
    var ray_pos = position;
    let ray_dir = direction;
    let inv_dir = 1.0 / ray_dir;

    // this is how to properly bias outgoing rays
    let cell_size = 1.0 / cascades[params.cascade].to_cell;
    ray_pos += sign(direction) * cell_size * 0.48;
    ray_pos += ray_dir * 0.4 * cell_size;

    for (var j = params.cascade; j < params.max_cascades; j++) {
      var pos = ray_pos - cascades[j].offset;
      pos *= cascades[j].to_cell;
      let local_distance = light_distance * cascades[j].to_cell;

      if (any(pos < vec3f(0.0)) || any(pos >= params.grid_size)) { continue; }

      let t0 = -pos * inv_dir;
      let t1 = (params.grid_size - pos) * inv_dir;
      let tmax = max(t0, t1);
      var max_advance = min(tmax.x, min(tmax.y, tmax.z));
      max_advance = min(local_distance, max_advance);

      var advance = 0.0;
      var occlusion = 1.0;

      // ponytail: 512-step cap. Godot's while() is unbounded; a WGSL infinite
      // loop hangs the device. Raise it if very thin geometry under-marches.
      for (var s = 0; s < 512 && advance < max_advance; s++) {
        let uvw = (pos + ray_dir * advance) * pos_to_uvw;
        let d = textureSampleLevel(sdf_cascades, linear_sampler,
            casc_uvw(j, params.max_cascades, uvw), 0.0).r * 255.0 - 1.0;
        if (d < 0.001) { hit = true; break; }
        occlusion = min(occlusion, d);
        advance += d;
      }

      if (hit) {
        attenuation *= occlusion;
        break;
      }
      if (advance >= local_distance) { break; }

      pos += ray_dir * max_advance;
      pos /= cascades[j].to_cell;
      pos += cascades[j].offset;
      light_distance -= max_advance / cascades[j].to_cell;
      ray_pos = pos;
    }

    if (!hit) {
      let light = albedo * lights[i].color * texture_color * lights[i].energy * attenuation;
      for (var j = 0; j < 6; j++) {
        if ((valid_aniso & (1u << u32(j))) != 0u) {
          light_accum[j] += max(0.0, dot(aniso_dir[j], direction)) * light;
        }
      }
    }
  }

  // Store the light
  var lumas = array<f32, 6>();
  var light_total = vec3f(0.0);
  for (var i = 0; i < 6; i++) {
    light_total += light_accum[i];
    lumas[i] = max(light_accum[i].r, max(light_accum[i].g, light_accum[i].b));
  }
  // ponytail: Godot divides by luma_total unguarded and NaNs on black voxels.
  let luma_total = max(max(light_total.r, max(light_total.g, light_total.b)), 1e-9);

${dynamic ? STORE_DYNAMIC : STORE_STATIC}
}
`;
}

const BOUNCE = /* wgsl */ `
  // Add indirect light first, in order to save computation resources
  if (params.bounce_feedback > 0.001) {
    var feedback: vec3f;
    if (params.bounce_feedback < 1.0) {
      feedback = albedo * params.bounce_feedback;
    } else {
      feedback = mix(albedo, vec3f(1.0), params.bounce_feedback - 1.0);
    }
    let pos = (vec3f(positioni) + vec3f(0.5)) * f32(params.probe_axis_size - 1) / params.grid_size;
    let probe_base_pos = vec3i(pos);

    var tex_pos = vec2i(probe_base_pos.x + probe_base_pos.z * params.probe_axis_size, probe_base_pos.y);
    tex_pos = tex_pos * (OCT_SIZE + 2) + vec2i(1);
    let base_tex_posf = vec2f(tex_pos);
    let tex_pixel_size = 1.0 / vec2f(vec2i(
        (OCT_SIZE + 2) * params.probe_axis_size * params.probe_axis_size,
        (OCT_SIZE + 2) * params.probe_axis_size));
    let probe_uv_offset = vec3f(vec3i(OCT_SIZE + 2, OCT_SIZE + 2, (OCT_SIZE + 2) * params.probe_axis_size))
        * tex_pixel_size.xyx;
    let occ_scale = vec3f(0.5, 1.0, 1.0 / f32(params.max_cascades));

    // Godot loops corner-major, so the occlusion fetch and the octahedral encode
    // -- neither of which depends on the corner -- are redone for all 8 corners.
    // Aniso-major instead: the encode is once per axis, and the fetch is twice
    // (the corner only picks which of the two packed occlusion volumes to read).
    // 48 fetches + 48 encodes become at most 12 + 6, same values in the same
    // accumulation order.
    for (var k = 0u; k < 6u; k++) {
      if ((valid_aniso & (1u << k)) == 0u) { continue; }
      let n = aniso_dir[k];
      let uv_base = (base_tex_posf + octahedron_encode(n) * f32(OCT_SIZE)) * tex_pixel_size;

      var occ_even = vec4f(0.0);
      var occ_odd = vec4f(0.0);
      if (params.use_occlusion != 0u) {
        var occ_pos = (vec3f(positioni) + n + vec3f(0.5)) / params.grid_size;
        occ_pos.z += f32(params.cascade);
        occ_even = textureSampleLevel(occlusion_texture, linear_sampler, occ_pos * occ_scale, 0.0);
        occ_odd = textureSampleLevel(occlusion_texture, linear_sampler,
            (occ_pos + vec3f(1.0, 0.0, 0.0)) * occ_scale, 0.0);
      }

      var acc = vec3f(0.0);
      var weight_accum = 0.0;

      for (var jj = 0u; jj < 8u; jj++) {
        let offset = vec3i((vec3u(jj) >> vec3u(0u, 1u, 2u)) & vec3u(1u));
        let probe_posi = probe_base_pos + offset;
        let probe_to_pos = pos - vec3f(probe_posi);
        let probe_dir = normalize(-probe_to_pos);
        let trilinear = vec3f(1.0) - abs(probe_to_pos);

        var weight = trilinear.x * trilinear.y * trilinear.z * max(0.0, dot(n, probe_dir));

        if (weight > 0.0 && params.use_occlusion != 0u) {
          let occ_indexv = abs((cascades[params.cascade].probe_world_offset + probe_posi) & vec3i(1)) * vec3i(1, 2, 4);
          let occ_mask = vec4f(vec4i(occ_indexv.x | occ_indexv.y) == vec4i(0, 1, 2, 3));
          weight *= dot(select(occ_even, occ_odd, occ_indexv.z != 0), occ_mask);
        }

        if (weight > 0.0) {
          var uv = uv_base + vec2f(offset.xy) * probe_uv_offset.xy;
          uv.x += f32(offset.z) * probe_uv_offset.z;
          let indirect_light = textureSampleLevel(lightprobe_texture, linear_sampler, uv, i32(params.cascade), 0.0).rgb;
          acc += indirect_light * weight;
          weight_accum += weight;
        }
      }

      if (weight_accum > 0.0) {
        light_accum[k] = acc / weight_accum * feedback;
      }
    }
  }
`;

const STORE_DYNAMIC = /* wgsl */ `
  let aniso0 = vec4f(lumas[0], lumas[1], lumas[2], lumas[3]) / luma_total;
  let aniso1 = vec4f(lumas[4] / luma_total, lumas[5] / luma_total, 0.0, 0.0);
  let zofs = vec3i(0, 0, i32(params.cascade) * GRID);

  textureStore(dst_aniso0, positioni + zofs, aniso0);
  textureStore(dst_aniso1, positioni + zofs, aniso1);
  textureStore(dst_light, positioni + zofs, vec4f(light_total, 1.0));

  // also fill neighbors, so light interpolation during the indirect pass works
  let neighbors = (voxel_albedo >> 21u)
      | ((voxel_position >> 21u) << 11u)
      | ((process_voxels[voxel_index].light >> 30u) << 22u)
      | ((process_voxels[voxel_index].light_aniso >> 30u) << 24u);

  for (var i = 0u; i < 26u; i++) {
    if ((neighbors & (1u << i)) != 0u) {
      let np = positioni + offsets26[i] + zofs;
      textureStore(dst_light, np, vec4f(light_total, 1.0));
      textureStore(dst_aniso0, np, aniso0);
      textureStore(dst_aniso1, np, aniso1);
    }
  }
`;

const STORE_STATIC = /* wgsl */ `
  // self-save: RGBE8985 back into the process voxel, keeping the 2 neighbour bits
  var light = process_voxels[voxel_index].light & (3u << 30u);
  light |= rgbe8985_encode(light_total);
  process_voxels[voxel_index].light = light;

  var light_aniso = process_voxels[voxel_index].light_aniso & (3u << 30u);
  for (var i = 0; i < 6; i++) {
    light_aniso |= min(31u, u32((lumas[i] / luma_total) * 31.0)) << u32(i * 5);
  }
  process_voxels[voxel_index].light_aniso = light_aniso;
`;

export const PROCESS_DYNAMIC = /* wgsl */ `
${HEAD}${NEIGHBOURS26}
@group(0) @binding(5) var<storage, read> process_voxels: array<ProcessVoxel>;
@group(0) @binding(6) var dst_light: texture_storage_3d<rgba16float, write>;
@group(0) @binding(7) var dst_aniso0: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(8) var dst_aniso1: texture_storage_3d<rgba8unorm, write>;
// only the bounce (dynamic) pass reads these back
@group(0) @binding(11) var lightprobe_texture: texture_2d_array<f32>;
@group(0) @binding(12) var occlusion_texture: texture_3d<f32>;
${body(true)}
`;

export const PROCESS_STATIC = /* wgsl */ `
${HEAD}
@group(0) @binding(5) var<storage, read_write> process_voxels: array<ProcessVoxel>;
${body(false)}
`;
