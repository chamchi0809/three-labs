import { MAX_CASCADES } from '../constants.ts';
import { WGSL_DEFINES, WGSL_CASCADE_UVW, WGSL_OCT } from './common.ts';

/**
 * Port of the USE_SDFGI path of
 * godot/servers/rendering/renderer_rd/shaders/environment/gi.glsl.
 *
 * Deviations:
 *  - VoxelGI instances, VRS and half-res are not ported (SDFGI only).
 *  - single view (no XR), and always the sc_use_full_projection_matrix path.
 *  - the per-cascade texture arrays are single packed 3D textures.
 *  - lightprobe_texture layer selection is an explicit array index, because
 *    WGSL takes the layer as an integer argument rather than in the uv.
 *
 * PREPASS below is the G-buffer this pass consumes; three.js does not expose
 * one, so the library renders its own (albedo + view-space normal/roughness
 * + depth) from the geometry it already extracted for voxelization.
 */

export const PREPASS = /* wgsl */ `
struct Pass { view_projection: mat4x4f, view: mat4x4f };
struct Draw {
  model: mat4x4f,
  normal_matrix: mat4x4f,
  albedo: vec4f,
  emission: vec4f, // a = 1 if base color texture bound
  material: vec4f, // r = roughness
};

@group(1) @binding(0) var<uniform> pass_data: Pass;
@group(2) @binding(0) var<uniform> draw: Draw;
@group(3) @binding(0) var base_color_tex: texture_2d<f32>;
@group(3) @binding(1) var base_color_smp: sampler;

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) uv: vec2f,
};
struct FOut {
  @location(0) albedo: vec4f,
  @location(1) normal_roughness: vec4f,
};

@vertex
fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> VOut {
  var o: VOut;
  let world = draw.model * vec4f(position, 1.0);
  o.clip = pass_data.view_projection * world;
  // view-space normal, matching Godot's G-buffer
  // normal_matrix is inverse-transpose, so the product's w is the inverse
  // translation projected onto the normal -- drop it before the view multiply
  // or it drags the camera's translation column into xyz.
  let world_normal = (draw.normal_matrix * vec4f(normal, 0.0)).xyz;
  o.normal = (pass_data.view * vec4f(world_normal, 0.0)).xyz;
  o.uv = uv;
  return o;
}

@fragment
fn fs(i: VOut) -> FOut {
  var albedo = draw.albedo.rgb;
  if (draw.emission.a > 0.5) {
    albedo *= textureSample(base_color_tex, base_color_smp, i.uv).rgb;
  }
  var o: FOut;
  o.albedo = vec4f(albedo, 1.0);
  o.normal_roughness = vec4f(normalize(i.normal) * 0.5 + vec3f(0.5),
      draw.material.r * (127.0 / 255.0));
  return o;
}
`;

export const GI = /* wgsl */ `
${WGSL_DEFINES}${WGSL_CASCADE_UVW}${WGSL_OCT}
const SDFGI_MAX_CASCADES: u32 = ${MAX_CASCADES}u;
const SDFGI_OCT_SIZE: i32 = OCT_SIZE;

struct ProbeCascadeData {
  position: vec3f,
  to_probe: f32,
  probe_world_offset: vec3i,
  to_cell: f32,
  pad: vec3f,
  exposure_normalization: f32,
};

struct Sdfgi {
  grid_size: vec3f,
  max_cascades: u32,
  use_occlusion: u32,
  probe_axis_size: i32,
  probe_to_uvw: f32,
  normal_bias: f32,
  lightprobe_tex_pixel_size: vec3f,
  energy: f32,
  lightprobe_uv_offset: vec3f,
  y_mult: f32,
  occlusion_clamp: vec3f,
  pad3: u32,
  occlusion_renormalize: vec3f,
  pad4: u32,
  cascade_probe_size: vec3f,
  pad5: u32,
  cascades: array<ProbeCascadeData, ${MAX_CASCADES}>,
};

struct SceneData {
  inv_projection: mat4x4f,
  cam_transform: mat4x4f,
  screen_size: vec2i,
  // 1 = full res, 2 = Godot's sc_half_res (gi.glsl pos <<= 1 / pos >>= 1)
  gi_scale: i32,
  pad: u32,
};

@group(0) @binding(1) var sdf_cascades: texture_3d<f32>;
@group(0) @binding(2) var light_cascades: texture_3d<f32>;
@group(0) @binding(5) var occlusion_texture: texture_3d<f32>;
@group(0) @binding(6) var linear_sampler: sampler;
@group(0) @binding(9) var ambient_buffer: texture_storage_2d<rgba16float, write>;
@group(0) @binding(10) var reflection_buffer: texture_storage_2d<rgba16float, write>;
@group(0) @binding(11) var lightprobe_texture: texture_2d_array<f32>;
@group(0) @binding(12) var depth_buffer: texture_depth_2d;
@group(0) @binding(13) var normal_roughness_buffer: texture_2d<f32>;
@group(0) @binding(15) var<uniform> sdfgi: Sdfgi;
@group(1) @binding(0) var<uniform> scene_data: SceneData;

fn reconstruct_position(screen_pos: vec2i) -> vec3f {
  // NDC y points up while row 0 of the depth buffer is the top row.
  let uv = (vec2f(screen_pos) + vec2f(0.5)) / vec2f(scene_data.screen_size);
  var pos = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0,
      textureLoad(depth_buffer, screen_pos, 0), 1.0);
  pos = scene_data.inv_projection * pos;
  return pos.xyz / pos.w;
}

struct Gi { diffuse: vec3f, specular: vec3f };

fn sdfvoxel_gi_process(cascade: u32, cascade_pos_in: vec3f, cam_normal: vec3f,
    cam_specular_normal: vec3f, roughness: f32) -> Gi {
  let cascade_pos = cascade_pos_in + cam_normal * sdfgi.normal_bias;
  let probe_base_pos = vec3i(floor(cascade_pos));

  var tex_pos = vec2i(probe_base_pos.x + probe_base_pos.z * sdfgi.probe_axis_size, probe_base_pos.y);
  tex_pos = tex_pos * (SDFGI_OCT_SIZE + 2) + vec2i(1);

  let diffuse_posf = (vec2f(tex_pos) + octahedron_encode(cam_normal) * f32(SDFGI_OCT_SIZE))
      * sdfgi.lightprobe_tex_pixel_size.xy;
  let specular_posf = (vec2f(tex_pos) + octahedron_encode(cam_specular_normal) * f32(SDFGI_OCT_SIZE))
      * sdfgi.lightprobe_tex_pixel_size.xy;

  var diffuse_accum = vec4f(0.0);
  var specular_accum = vec3f(0.0);

  for (var j = 0u; j < 8u; j++) {
    let offset = vec3i((vec3u(j) >> vec3u(0u, 1u, 2u)) & vec3u(1u));
    let probe_posi = probe_base_pos + offset;

    let probe_pos = vec3f(probe_posi);
    let probe_to_pos = cascade_pos - probe_pos;
    let probe_dir = normalize(-probe_to_pos);
    let trilinear = vec3f(1.0) - abs(probe_to_pos);
    var weight = trilinear.x * trilinear.y * trilinear.z * max(0.005, dot(cam_normal, probe_dir));

    if (sdfgi.use_occlusion != 0u) {
      let occ_indexv = abs((sdfgi.cascades[cascade].probe_world_offset + probe_posi) & vec3i(1)) * vec3i(1, 2, 4);
      let occ_mask = vec4f(vec4i(occ_indexv.x | occ_indexv.y) == vec4i(0, 1, 2, 3));

      var occ_pos = clamp(cascade_pos, probe_pos - sdfgi.occlusion_clamp,
          probe_pos + sdfgi.occlusion_clamp) * sdfgi.probe_to_uvw;
      occ_pos.z += f32(cascade);
      if (occ_indexv.z != 0) { occ_pos.x += 1.0; }
      occ_pos *= sdfgi.occlusion_renormalize;
      weight *= max(dot(textureSampleLevel(occlusion_texture, linear_sampler, occ_pos, 0.0), occ_mask), 0.01);
    }

    var uv = diffuse_posf + vec2f(offset.xy) * sdfgi.lightprobe_uv_offset.xy;
    uv.x += f32(offset.z) * sdfgi.lightprobe_uv_offset.z;
    let diffuse = textureSampleLevel(lightprobe_texture, linear_sampler, uv, i32(cascade), 0.0).rgb;
    diffuse_accum += vec4f(diffuse * weight * sdfgi.cascades[cascade].exposure_normalization, weight);

    var suv = specular_posf + vec2f(offset.xy) * sdfgi.lightprobe_uv_offset.xy;
    suv.x += f32(offset.z) * sdfgi.lightprobe_uv_offset.z;
    var specular = vec3f(0.0);
    if (roughness < 0.99) {
      specular = textureSampleLevel(lightprobe_texture, linear_sampler, suv,
          i32(cascade + sdfgi.max_cascades), 0.0).rgb;
    }
    if (roughness > 0.2) {
      specular = mix(specular,
          textureSampleLevel(lightprobe_texture, linear_sampler, suv, i32(cascade), 0.0).rgb,
          (roughness - 0.2) * 1.25);
    }
    specular_accum += specular * weight * sdfgi.cascades[cascade].exposure_normalization;
  }

  var r: Gi;
  if (diffuse_accum.a > 0.0) {
    r.diffuse = diffuse_accum.rgb / diffuse_accum.a;
    r.specular = specular_accum / diffuse_accum.a;
  } else {
    r.diffuse = vec3f(0.0);
    r.specular = specular_accum;
  }
  return r;
}

struct Result { ambient: vec4f, reflection: vec4f };

fn sdfgi_process(vertex_in: vec3f, normal_in: vec3f, reflection_in: vec3f, roughness: f32) -> Result {
  // make vertex orientation the world one, but still align to camera
  var vertex = vertex_in;
  var normal = normal_in;
  var reflection = reflection_in;
  vertex.y *= sdfgi.y_mult;
  normal.y *= sdfgi.y_mult;
  reflection.y *= sdfgi.y_mult;
  normal = normalize(normal);
  reflection = normalize(reflection);

  let cam_pos = vertex;
  let cam_normal = normal;

  var cascade = 0xFFFFFFFFu;
  var cascade_pos = vec3f(0.0);
  for (var i = 0u; i < sdfgi.max_cascades; i++) {
    cascade_pos = (cam_pos - sdfgi.cascades[i].position) * sdfgi.cascades[i].to_probe;
    if (any(cascade_pos < vec3f(0.0)) || any(cascade_pos >= sdfgi.cascade_probe_size)) { continue; }
    cascade = i;
    break;
  }

  var out: Result;
  if (cascade >= SDFGI_MAX_CASCADES) {
    out.ambient = vec4f(0.0);
    out.reflection = vec4f(0.0);
    return out;
  }

  out.ambient = vec4f(0.0, 0.0, 0.0, 1.0);
  out.reflection = vec4f(0.0, 0.0, 0.0, 1.0);

  var gi = sdfvoxel_gi_process(cascade, cascade_pos, cam_normal, reflection, roughness);
  var diffuse = gi.diffuse;
  var specular = gi.specular;

  {
    let blend_from = (f32(sdfgi.probe_axis_size - 1) / 2.0) - 2.5;
    let blend_to = blend_from + 2.0;

    var inner_pos = cam_pos * sdfgi.cascades[cascade].to_probe;
    var len = length(inner_pos);
    inner_pos = abs(normalize(inner_pos));
    len *= max(inner_pos.x, max(inner_pos.y, inner_pos.z));

    var blend = 0.0;
    if (len >= blend_from) { blend = smoothstep(blend_from, blend_to, len); }

    if (blend > 0.0) {
      if (cascade == sdfgi.max_cascades - 1u) {
        out.ambient.a = 1.0 - blend;
        out.reflection.a = 1.0 - blend;
      } else {
        let cp2 = (cam_pos - sdfgi.cascades[cascade + 1u].position) * sdfgi.cascades[cascade + 1u].to_probe;
        let gi2 = sdfvoxel_gi_process(cascade + 1u, cp2, cam_normal, reflection, roughness);
        diffuse = mix(diffuse, gi2.diffuse, blend);
        specular = mix(specular, gi2.specular, blend);
      }
    }
  }

  out.ambient = vec4f(diffuse, out.ambient.a);

  if (roughness < 0.2) {
    let pos_to_uvw = 1.0 / sdfgi.grid_size;
    var light_accum = vec4f(0.0);
    let blend_size = (sdfgi.grid_size.x / f32(sdfgi.probe_axis_size - 1)) * 0.5;

    var radius_sizes: array<f32, ${MAX_CASCADES}>;
    var rc = 0xFFFFu;
    let base_distance = length(cam_pos);
    for (var i = 0u; i < sdfgi.max_cascades; i++) {
      radius_sizes[i] = (1.0 / sdfgi.cascades[i].to_cell) * (sdfgi.grid_size.x * 0.5 - blend_size);
      if (rc == 0xFFFFu && base_distance < radius_sizes[i]) { rc = i; }
    }
    rc = min(rc, sdfgi.max_cascades - 1u);

    let max_distance = radius_sizes[sdfgi.max_cascades - 1u];
    var ray_pos = cam_pos;
    let ray_dir = reflection;

    {
      var prev_radius = 0.0;
      if (rc > 0u) { prev_radius = radius_sizes[rc - 1u]; }
      let base_blend = (base_distance - prev_radius) / (radius_sizes[rc] - prev_radius);
      let bias = (1.0 + base_blend) * 1.1;
      let abs_ray_dir = abs(ray_dir);
      ray_pos += (ray_dir / max(abs_ray_dir.x, max(abs_ray_dir.y, abs_ray_dir.z)) + cam_normal * 1.4)
          * bias / sdfgi.cascades[rc].to_cell;
    }

    // approximation to roughness so it does not seem like a hard fade
    let softness = 0.2 + min(1.0, roughness * 5.0) * 4.0;
    var i = 0u;
    var found = false;
    // ponytail: 256-iteration cap on Godot's while(true) cone march.
    for (var iter = 0; iter < 256; iter++) {
      if (length(ray_pos) >= max_distance || light_accum.a > 0.99) { break; }
      if (!found && i >= rc && length(ray_pos) < radius_sizes[i]) {
        let next_i = min(i + 1u, sdfgi.max_cascades - 1u);
        rc = max(i, rc); // never go down

        var p = (ray_pos - sdfgi.cascades[i].position) * sdfgi.cascades[i].to_cell * pos_to_uvw;
        var fdistance = textureSampleLevel(sdf_cascades, linear_sampler,
            casc_uvw(i, sdfgi.max_cascades, p), 0.0).r * 255.0 - 1.1;

        var hit_light = vec4f(0.0);
        if (fdistance < softness) {
          // 0.5 approximates the value read being meant for anisotropy
          let a = clamp(1.0 - (fdistance / softness), 0.0, 1.0);
          hit_light = vec4f(textureSampleLevel(light_cascades, linear_sampler,
              casc_uvw(i, sdfgi.max_cascades, p), 0.0).rgb * 0.5 * a, a);
        }
        fdistance /= sdfgi.cascades[i].to_cell;

        if (i < sdfgi.max_cascades - 1u) {
          p = (ray_pos - sdfgi.cascades[next_i].position) * sdfgi.cascades[next_i].to_cell * pos_to_uvw;
          var fdistance2 = textureSampleLevel(sdf_cascades, linear_sampler,
              casc_uvw(next_i, sdfgi.max_cascades, p), 0.0).r * 255.0 - 1.1;

          var hit_light2 = vec4f(0.0);
          if (fdistance2 < softness) {
            let a = clamp(1.0 - (fdistance2 / softness), 0.0, 1.0);
            hit_light2 = vec4f(textureSampleLevel(light_cascades, linear_sampler,
                casc_uvw(next_i, sdfgi.max_cascades, p), 0.0).rgb * 0.5 * a, a);
          }

          var prev_radius = 0.0;
          if (i > 0u) { prev_radius = radius_sizes[i - 1u]; }
          let blend = clamp((length(ray_pos) - prev_radius) / (radius_sizes[i] - prev_radius), 0.0, 1.0);

          fdistance2 /= sdfgi.cascades[next_i].to_cell;
          hit_light = mix(hit_light, hit_light2, blend);
          fdistance = mix(fdistance, fdistance2, blend);
        }

        light_accum += hit_light;
        ray_pos += ray_dir * fdistance;
        found = true;
      }
      i++;
      if (i == sdfgi.max_cascades) { i = 0u; found = false; }
    }

    let light = light_accum.rgb / max(light_accum.a, 0.00001);
    let alpha = min(1.0, light_accum.a);
    let b = min(1.0, roughness * 5.0);
    let sa = 1.0 - b;

    out.reflection.a = alpha * sa + b;
    if (out.reflection.a == 0.0) {
      specular = vec3f(0.0);
    } else {
      specular = (light * alpha * sa + specular * b) / out.reflection.a;
    }
  }

  out.reflection = vec4f(specular * sdfgi.energy, out.reflection.a);
  out.ambient = vec4f(out.ambient.rgb * sdfgi.energy, out.ambient.a);
  return out;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  // gi.glsl main(): half res walks every other full-res texel, then stores at the
  // halved coordinate. Depth/normal stay full res and are point-sampled.
  let pos = vec2i(gid.xy) * scene_data.gi_scale;
  if (any(pos >= scene_data.screen_size)) { return; }

  var ambient = vec4f(0.0);
  var reflection = vec4f(0.0);

  let nr = textureLoad(normal_roughness_buffer, pos, 0);
  var normal = nr.xyz * 2.0 - vec3f(1.0);

  if (dot(normal, normal) > 0.25) {
    normal = normalize(normal);
    let roughness = nr.w / (127.0 / 255.0);

    var vertex = reconstruct_position(pos);
    let m = mat3x3f(scene_data.cam_transform[0].xyz, scene_data.cam_transform[1].xyz,
        scene_data.cam_transform[2].xyz);
    let view = -normalize(m * vertex);
    vertex = m * vertex;
    normal = normalize(m * normal);
    let reflect_dir = normalize(reflect(-view, normal));

    let r = sdfgi_process(vertex, normal, reflect_dir, roughness);
    ambient = r.ambient;
    reflection = r.reflection;
  }

  let out = pos / scene_data.gi_scale;
  textureStore(ambient_buffer, out, ambient);
  textureStore(reflection_buffer, out, reflection);
}
`;

/**
 * Composite. Godot feeds ambient/reflection back into the scene shader's BRDF;
 * this library runs after three.js has already shaded the frame, so it adds
 * `albedo * ambient + reflection * specular_tint` on top with additive blending.
 * ponytail: no Fresnel / GGX split-sum, the specular tint is a constant 0.04
 * dielectric f0. Add a metalness channel to the prepass if metals matter.
 *
 * `linear` picks the encode the additive blend needs: the three.js swapchain
 * holds sRGB-encoded pixels, an HDR render target holds linear ones.
 */
export const composite = (linear: boolean): string => /* wgsl */ `
@group(0) @binding(0) var albedo_buffer: texture_2d<f32>;
@group(0) @binding(1) var ambient_buffer: texture_2d<f32>;
@group(0) @binding(2) var reflection_buffer: texture_2d<f32>;
@group(0) @binding(3) var normal_roughness_buffer: texture_2d<f32>;
@group(0) @binding(4) var linear_sampler: sampler;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let pos = vec2i(frag.xy);
  let nr = textureLoad(normal_roughness_buffer, pos, 0);
  let normal = nr.xyz * 2.0 - vec3f(1.0);
  if (dot(normal, normal) <= 0.25) { return vec4f(0.0); }

  let albedo = textureLoad(albedo_buffer, pos, 0).rgb;
  // Godot's scene shader reads the GI buffers with a plain bilinear fetch so the
  // same code serves full and half res (at full res the sample lands dead centre
  // on the texel). No bilateral upsample -- gi.glsl doesn't have one either.
  let uv = frag.xy / vec2f(textureDimensions(albedo_buffer));
  let ambient = textureSampleLevel(ambient_buffer, linear_sampler, uv, 0.0).rgb;
  let reflection = textureSampleLevel(reflection_buffer, linear_sampler, uv, 0.0).rgb;
  let gi = max(albedo * ambient + reflection * 0.04, vec3f(0.0));
${
  linear
    ? '  return vec4f(gi, 1.0);'
    : `  // Encode-then-add != add-then-encode, but the destination is already
  // sRGB-encoded, so this is the closest the blend unit can get.
  let a = vec3f(0.055);
  let srgb = select((vec3f(1.0) + a) * pow(gi, vec3f(1.0 / 2.4)) - a, 12.92 * gi, gi < vec3f(0.0031308));
  return vec4f(srgb, 1.0);`
}
}
`;

/** the swapchain (sRGB-encoded) variant, kept as a named export for tests */
export const COMPOSITE = composite(false);
