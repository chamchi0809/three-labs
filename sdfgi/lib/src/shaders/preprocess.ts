import { OCCLUSION_SIZE } from '../constants.ts';
import { WGSL_DEFINES, WGSL_GRID, NEIGHBOURS26 } from './common.ts';

/**
 * Port of godot/servers/rendering/renderer_rd/shaders/environment/sdfgi_preprocess.glsl
 *
 * Deviations forced by WebGPU (see README):
 *  - r16ui/r32ui `image3D` render targets become storage buffers, because the
 *    voxelizer fragment shader needs imageAtomicOr and WGSL has no texture atomics.
 *  - the 8 r8 `render_occlusion` volumes become one buffer with 4 volumes packed
 *    per u32 (maxStorageTexturesPerShaderStage is 8, MODE_STORE would need 11).
 *  - `dst_sdf` is rgba8unorm (r8unorm is not a WebGPU storage format) and holds
 *    all cascades stacked along z.
 *  - `occlusion_data` is rgba8unorm instead of R16_UINT viewed as R4G4B4A4:
 *    same two-texels-per-voxel layout, 8 bits per volume instead of 4.
 */

const PARAMS = /* wgsl */ `
struct Params {
  scroll: vec3i,
  grid_size: i32,
  probe_offset: vec3i,
  step_size: i32,
  half_size: u32,
  occlusion_index: u32,
  cascade: i32,
  pad: u32,
};
@group(1) @binding(0) var<uniform> params: Params;
`;

const PROCESS_VOXEL = /* wgsl */ `
// ProcessVoxel { position, albedo, light, light_aniso }
struct ProcessVoxel { position: u32, albedo: u32, light: u32, light_aniso: u32 };
struct Dispatch { x: u32, y: u32, z: u32, total_count: u32 };
`;

const OCC_PACK = /* wgsl */ `
fn occ_load(vol: u32, idx: u32) -> f32 {
  let w = render_occlusion[idx * 2u + (vol >> 2u)];
  return f32((w >> ((vol & 3u) * 8u)) & 0xFFu) / 255.0;
}
fn occ_store(vol: u32, idx: u32, v: f32) {
  let i = idx * 2u + (vol >> 2u);
  let sh = (vol & 3u) * 8u;
  let q = u32(clamp(v, 0.0, 1.0) * 255.0 + 0.5);
  render_occlusion[i] = (render_occlusion[i] & ~(0xFFu << sh)) | (q << sh);
}
`;

const HEAD = WGSL_DEFINES + WGSL_GRID + PARAMS;

export const SCROLL = /* wgsl */ `
${HEAD}${PROCESS_VOXEL}
@group(0) @binding(1) var<storage, read_write> dst_albedo: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst_facing: array<u32>;
@group(0) @binding(3) var<storage, read_write> dst_light: array<u32>;
@group(0) @binding(4) var<storage, read_write> dst_light_aniso: array<u32>;
@group(0) @binding(5) var<storage, read> dispatch_data: Dispatch;
@group(0) @binding(6) var<storage, read> src_process_voxels: array<ProcessVoxel>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = i32(gid.x);
  if (u32(index) >= dispatch_data.total_count) { return; }

  let v = src_process_voxels[index];
  let read_pos = vec3i(vec3u(v.position) >> vec3u(0u, 7u, 14u)) & vec3i(0x7F);
  let write_pos = read_pos + params.scroll;
  if (!inside(write_pos, params.grid_size)) { return; }

  let o = gidx(write_pos);
  dst_albedo[o] = ((v.albedo & 0x7FFFu) << 1u) | 1u;
  dst_facing[o] = (v.albedo >> 15u) & 0x3Fu;
  dst_light[o] = v.light & 0x3fffffffu;
  dst_light_aniso[o] = v.light_aniso & 0x3fffffffu;
}
`;

export const SCROLL_OCCLUSION = /* wgsl */ `
${HEAD}
@group(0) @binding(1) var<storage, read_write> render_occlusion: array<u32>;
@group(0) @binding(2) var src_occlusion: texture_3d<f32>;
${OCC_PACK}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec3i(gid);
  if (any(pos >= vec3i(params.grid_size) - abs(params.scroll))) { return; }

  var read_pos = pos + max(vec3i(0), -params.scroll);
  let write_pos = pos + max(vec3i(0), params.scroll);

  read_pos.z += params.cascade * params.grid_size;
  let lo = textureLoad(src_occlusion, read_pos, 0);
  let hi = textureLoad(src_occlusion, read_pos + vec3i(params.grid_size, 0, 0), 0);

  let idx = gidx(write_pos);
  render_occlusion[idx * 2u + 0u] =
      (u32(lo.r * 255.0 + 0.5)) | (u32(lo.g * 255.0 + 0.5) << 8u) |
      (u32(lo.b * 255.0 + 0.5) << 16u) | (u32(lo.a * 255.0 + 0.5) << 24u);
  render_occlusion[idx * 2u + 1u] =
      (u32(hi.r * 255.0 + 0.5)) | (u32(hi.g * 255.0 + 0.5) << 8u) |
      (u32(hi.b * 255.0 + 0.5) << 16u) | (u32(hi.a * 255.0 + 0.5) << 24u);
}
`;

export const JUMP_FLOOD_INITIALIZE = /* wgsl */ `
${HEAD}
@group(0) @binding(1) var<storage, read> src_color: array<u32>;
@group(0) @binding(2) var dst_positions: texture_storage_3d<rgba8uint, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec3i(gid);
  if (any(pos >= vec3i(params.grid_size))) { return; }
  let c = src_color[gidx(pos)];
  var v = vec4u(0u);
  if ((c & 1u) != 0u) { v = vec4u(gid.x, gid.y, gid.z, 255u); }
  textureStore(dst_positions, pos, v);
}
`;

export const JUMP_FLOOD_INITIALIZE_HALF = /* wgsl */ `
${HEAD}
@group(0) @binding(1) var<storage, read> src_color: array<u32>;
@group(0) @binding(2) var dst_positions: texture_storage_3d<rgba8uint, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec3i(gid);
  if (any(pos >= vec3i(params.grid_size))) { return; } // grid_size is already halved here
  let base_pos = pos * 2;

  var closest: array<vec4u, 8>;
  var closest_count = 0;
  for (var i = 0; i < 8; i++) {
    let src_pos = base_pos + bits3(i);
    if ((src_color[gidx(src_pos)] & 1u) != 0u) {
      closest[closest_count] = vec4u(vec3u(src_pos), 255u);
      closest_count++;
    }
  }

  if (closest_count == 0) {
    textureStore(dst_positions, pos, vec4u(0u));
  } else {
    let indexv = (pos & vec3i(1)) * vec3i(1, 2, 4);
    let index = (indexv.x | indexv.y | indexv.z) % closest_count;
    textureStore(dst_positions, pos, closest[index]);
  }
}
`;

export const JUMP_FLOOD = /* wgsl */ `
${HEAD}${NEIGHBOURS26}
@group(0) @binding(1) var src_positions: texture_3d<u32>;
@group(0) @binding(2) var dst_positions: texture_storage_3d<rgba8uint, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec3i(gid);
  var posf = vec3f(pos);
  if (params.half_size != 0u) { posf = posf * 2.0 + vec3f(0.5); }

  var p = textureLoad(src_positions, pos, 0);

  if (params.half_size == 0u && all(p == vec4u(gid, 255u))) {
    textureStore(dst_positions, pos, p);
    return;
  }

  var p_dist = 0.0;
  if (p.w != 0u) { p_dist = distance(posf, vec3f(p.xyz)); }

  for (var i = 0; i < 26; i++) {
    let ofs = pos + offsets26[i] * params.step_size;
    if (!inside(ofs, params.grid_size)) { continue; }
    let q = textureLoad(src_positions, ofs, 0);
    if (q.w == 0u) { continue; }
    let q_dist = distance(posf, vec3f(q.xyz));
    if (p.w == 0u || q_dist < p_dist) {
      p = q;
      p_dist = q_dist;
    }
  }

  textureStore(dst_positions, pos, p);
}
`;

const GROUP_SIZE = 8;

export const JUMP_FLOOD_OPTIMIZED = /* wgsl */ `
${HEAD}
const GROUP_SIZE: i32 = ${GROUP_SIZE};
const GS2: i32 = GROUP_SIZE + 2;
@group(0) @binding(1) var src_positions: texture_3d<u32>;
@group(0) @binding(2) var dst_positions: texture_storage_3d<rgba8uint, write>;

var<workgroup> group_positions: array<vec4u, ${(GROUP_SIZE + 2) ** 3}>;

fn group_store(p: vec3i, v: vec4u) {
  group_positions[u32(p.z * GS2 * GS2 + p.y * GS2 + p.x)] = v;
}
fn group_load(p: vec3i) -> vec4u {
  return group_positions[u32(p.z * GS2 * GS2 + p.y * GS2 + p.x)];
}

const offsets27 = array<vec3i, 27>(
  vec3i(-1,-1,-1), vec3i(-1,-1,0), vec3i(-1,-1,1), vec3i(-1,0,-1), vec3i(-1,0,0),
  vec3i(-1,0,1), vec3i(-1,1,-1), vec3i(-1,1,0), vec3i(-1,1,1), vec3i(0,-1,-1),
  vec3i(0,-1,0), vec3i(0,-1,1), vec3i(0,0,-1), vec3i(0,0,0), vec3i(0,0,1),
  vec3i(0,1,-1), vec3i(0,1,0), vec3i(0,1,1), vec3i(1,-1,-1), vec3i(1,-1,0),
  vec3i(1,-1,1), vec3i(1,0,-1), vec3i(1,0,0), vec3i(1,0,1), vec3i(1,1,-1),
  vec3i(1,1,0), vec3i(1,1,1));

@compute @workgroup_size(${GROUP_SIZE}, ${GROUP_SIZE}, ${GROUP_SIZE})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let group_offset = vec3i(wid) % vec3i(params.step_size);
  let group_pos = group_offset + (vec3i(wid) / vec3i(params.step_size)) * vec3i(GROUP_SIZE * params.step_size);

  if (all(vec3i(lid) < vec3i(GS2 / 2))) {
    let base_pos = vec3i(lid) * 2;
    for (var i = 0; i < 8; i++) {
      let load_pos = base_pos + bits3(i);
      let load_global_pos = group_pos + (load_pos - vec3i(1)) * params.step_size;
      var q = vec4u(0u);
      if (inside(load_global_pos, params.grid_size)) {
        q = textureLoad(src_positions, load_global_pos, 0);
      }
      group_store(load_pos, q);
    }
  }

  workgroupBarrier();

  let global_pos = group_pos + vec3i(lid) * params.step_size;
  if (!inside(global_pos, params.grid_size)) { return; }

  let local_pos = vec3i(lid) + vec3i(1);

  var closest = vec4u(0u);
  var closest_dist = 0.0;
  var posf = vec3f(global_pos);
  if (params.half_size != 0u) { posf = posf * 2.0 + vec3f(0.5); }

  for (var i = 0; i < 27; i++) {
    let point = group_load(local_pos + offsets27[i]);
    if (point.w == 0u) { continue; }
    let d = distance(posf, vec3f(point.xyz));
    if (closest.w == 0u || d < closest_dist) {
      closest = point;
      closest_dist = d;
    }
  }

  textureStore(dst_positions, global_pos, closest);
}
`;

export const JUMP_FLOOD_UPSCALE = /* wgsl */ `
${HEAD}
@group(0) @binding(1) var<storage, read> src_color: array<u32>;
@group(0) @binding(2) var src_positions_half: texture_3d<u32>;
@group(0) @binding(3) var dst_positions: texture_storage_3d<rgba8uint, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec3i(gid);
  if (any(pos >= vec3i(params.grid_size))) { return; }
  let c = src_color[gidx(pos)];
  var v: vec4u;
  if ((c & 1u) != 0u) {
    v = vec4u(gid, 255u);
  } else {
    v = textureLoad(src_positions_half, pos >> vec3u(1u), 0);
    var d = length(vec3f(vec3i(v.xyz) - pos));
    let vbase = vec3i(v.xyz - (v.xyz & vec3u(1u)));
    for (var i = 0; i < 8; i++) {
      let p = vbase + bits3(i);
      let d2 = length(vec3f(p - pos));
      if (d2 < d) {
        if ((src_color[gidx(p)] & 1u) != 0u) {
          v = vec4u(vec3u(p), v.w);
          d = d2;
        }
      }
    }
  }
  textureStore(dst_positions, pos, v);
}
`;

// group_size_offset / group_pos tables are verbatim from sdfgi_preprocess.glsl.
const GROUP_TABLES = /* wgsl */ `
const group_size_offset = array<vec2u, 11>(
  vec2u(1u,0u), vec2u(3u,1u), vec2u(6u,4u), vec2u(10u,10u), vec2u(15u,20u), vec2u(21u,35u),
  vec2u(28u,56u), vec2u(36u,84u), vec2u(42u,120u), vec2u(46u,162u), vec2u(48u,208u));
const group_pos = array<u32, 256>(0u,
  65536u,256u,1u,
  131072u,65792u,512u,65537u,257u,2u,
  196608u,131328u,66048u,768u,131073u,65793u,513u,65538u,258u,3u,
  262144u,196864u,131584u,66304u,1024u,196609u,131329u,66049u,769u,131074u,65794u,514u,65539u,259u,4u,
  327680u,262400u,197120u,131840u,66560u,1280u,262145u,196865u,131585u,66305u,1025u,196610u,131330u,66050u,770u,131075u,65795u,515u,65540u,260u,5u,
  393216u,327936u,262656u,197376u,132096u,66816u,1536u,327681u,262401u,197121u,131841u,66561u,1281u,262146u,196866u,131586u,66306u,1026u,196611u,131331u,66051u,771u,131076u,65796u,516u,65541u,261u,6u,
  458752u,393472u,328192u,262912u,197632u,132352u,67072u,1792u,393217u,327937u,262657u,197377u,132097u,66817u,1537u,327682u,262402u,197122u,131842u,66562u,1282u,262147u,196867u,131587u,66307u,1027u,196612u,131332u,66052u,772u,131077u,65797u,517u,65542u,262u,7u,
  459008u,393728u,328448u,263168u,197888u,132608u,67328u,458753u,393473u,328193u,262913u,197633u,132353u,67073u,1793u,393218u,327938u,262658u,197378u,132098u,66818u,1538u,327683u,262403u,197123u,131843u,66563u,1283u,262148u,196868u,131588u,66308u,1028u,196613u,131333u,66053u,773u,131078u,65798u,518u,65543u,263u,
  459264u,393984u,328704u,263424u,198144u,132864u,459009u,393729u,328449u,263169u,197889u,132609u,67329u,458754u,393474u,328194u,262914u,197634u,132354u,67074u,1794u,393219u,327939u,262659u,197379u,132099u,66819u,1539u,327684u,262404u,197124u,131844u,66564u,1284u,262149u,196869u,131589u,66309u,1029u,196614u,131334u,66054u,774u,131079u,65799u,519u,
  459520u,394240u,328960u,263680u,198400u,459265u,393985u,328705u,263425u,198145u,132865u,459010u,393730u,328450u,263170u,197890u,132610u,67330u,458755u,393475u,328195u,262915u,197635u,132355u,67075u,1795u,393220u,327940u,262660u,197380u,132100u,66820u,1540u,327685u,262405u,197125u,131845u,66565u,1285u,262150u,196870u,131590u,66310u,1030u,196615u,131335u,66055u,775u);
`;

export const OCCLUSION = /* wgsl */ `
${HEAD}${GROUP_TABLES}
const OCCLUSION_SIZE: i32 = ${OCCLUSION_SIZE};
const OCC_HALF_SIZE: i32 = OCCLUSION_SIZE / 2;
const OCC_SIDE: i32 = OCCLUSION_SIZE * 2;
const OCC_STEPS: i32 = OCCLUSION_SIZE * 3 - 2;
const OCC_HALF_STEPS: i32 = OCC_STEPS / 2;

// binding 1 (src_color) is unused by this mode -- Godot's occlusion pass reads
// only the facing bits. layout:'auto' would strip it, so it is not declared.
@group(0) @binding(2) var<storage, read_write> render_occlusion: array<u32>;
@group(0) @binding(3) var<storage, read> src_facing: array<u32>;
${OCC_PACK}

var<workgroup> occlusion_facing: array<u32, ${(OCCLUSION_SIZE * 2) ** 3 / 4}>;

fn get_facing(p: vec3i) -> u32 {
  let ofs = u32(p.z * OCC_SIDE * OCC_SIDE + p.y * OCC_SIDE + p.x);
  let v = occlusion_facing[ofs / 4u];
  return (v >> ((ofs % 4u) * 8u)) & 0xFFu;
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let invocation_idx = lid.x;
  let region = vec3i(wid);

  var region_offset = -vec3i(OCCLUSION_SIZE);
  region_offset += region * OCCLUSION_SIZE * 2;
  region_offset += params.probe_offset * OCCLUSION_SIZE;

  var region_out_of_bounds = false;

  if (any(params.scroll != vec3i(0))) {
    let region_offset_to = region_offset + vec3i(OCCLUSION_SIZE * 2);
    let scroll_mask = vec3u(params.scroll != vec3i(0));
    let scroll_from = select(vec3i(0), vec3i(params.grid_size) + params.scroll, params.scroll < vec3i(0));
    let scroll_to = select(vec3i(params.grid_size), params.scroll, params.scroll > vec3i(0));
    let outv = (vec3u(region_offset_to <= scroll_from) | vec3u(region_offset >= scroll_to)) * scroll_mask;
    if (all(outv == scroll_mask)) { region_out_of_bounds = true; }
  }

  let local_ofs = vec3i(vec3u(
      invocation_idx % u32(OCC_HALF_SIZE),
      (invocation_idx % u32(OCC_HALF_SIZE * OCC_HALF_SIZE)) / u32(OCC_HALF_SIZE),
      invocation_idx / u32(OCC_HALF_SIZE * OCC_HALF_SIZE))) * 4;

  if (!region_out_of_bounds) {
    for (var i = 0; i < 16; i++) {
      let offset = local_ofs + ((vec3i(i * 4) >> vec3u(0u, 2u, 4u)) & vec3i(3));
      var facing_pack = 0u;
      for (var j = 0; j < 4; j++) {
        let foffset = region_offset + offset + vec3i(j, 0, 0);
        if (inside(foffset, params.grid_size)) {
          facing_pack |= src_facing[gidx(foffset)] << u32(j * 8);
        }
      }
      occlusion_facing[u32(offset.z * OCC_SIDE * OCC_SIDE + offset.y * OCC_SIDE + offset.x) / 4u] = facing_pack;
    }
  }

  workgroupBarrier();

  for (var step = 0; step < OCC_STEPS; step++) {
    if (!region_out_of_bounds) {
      let shrink = step >= OCC_HALF_STEPS;
      var occ_step = step;
      if (shrink) { occ_step = OCC_HALF_STEPS - (step - OCC_HALF_STEPS) - 1; }

      if (invocation_idx < group_size_offset[occ_step].x) {
        let pv = group_pos[group_size_offset[occ_step].y + invocation_idx];
        var proc_abs = (vec3i(i32(pv)) >> vec3u(0u, 8u, 16u)) & vec3i(0xFF);
        if (shrink) { proc_abs = vec3i(OCCLUSION_SIZE) - proc_abs - vec3i(1); }

        for (var i = 0; i < 8; i++) {
          let b = bits3(i);
          let proc_sign = b * 2 - vec3i(1);
          let local_offset = vec3i(OCCLUSION_SIZE) + proc_abs * proc_sign - (vec3i(1) - b);
          let offset = local_offset + region_offset;
          if (inside(offset, params.grid_size)) {
            var occ: f32;
            let facing = get_facing(local_offset);
            if (facing != 0u) {
              occ = 0.0;
            } else if (step == 0) {
              occ = 1.0;
            } else {
              let read_dir = -proc_sign;
              var major_axis: vec3i;
              if (proc_abs.x < proc_abs.y) {
                if (proc_abs.z < proc_abs.y) { major_axis = vec3i(0, 1, 0); } else { major_axis = vec3i(0, 0, 1); }
              } else {
                if (proc_abs.z < proc_abs.x) { major_axis = vec3i(1, 0, 0); } else { major_axis = vec3i(0, 0, 1); }
              }

              var avg = 0.0;
              occ = 0.0;

              let read_x = offset + vec3i(read_dir.x, 0, 0) + select(vec3i(0), major_axis * read_dir, proc_abs.x == 0);
              let read_y = offset + vec3i(0, read_dir.y, 0) + select(vec3i(0), major_axis * read_dir, proc_abs.y == 0);
              let read_z = offset + vec3i(0, 0, read_dir.z) + select(vec3i(0), major_axis * read_dir, proc_abs.z == 0);

              if (get_facing(read_x - region_offset) == 0u) {
                if (inside(read_x, params.grid_size)) {
                  occ += occ_load(params.occlusion_index, gidx(read_x));
                  avg += 1.0;
                }
              } else if (proc_abs.x != 0) { avg += 1.0; }

              if (get_facing(read_y - region_offset) == 0u) {
                if (inside(read_y, params.grid_size)) {
                  occ += occ_load(params.occlusion_index, gidx(read_y));
                  avg += 1.0;
                }
              } else if (proc_abs.y != 0) { avg += 1.0; }

              if (get_facing(read_z - region_offset) == 0u) {
                if (inside(read_z, params.grid_size)) {
                  occ += occ_load(params.occlusion_index, gidx(read_z));
                  avg += 1.0;
                }
              } else if (proc_abs.z != 0) { avg += 1.0; }

              if (avg > 0.0) { occ /= avg; }
            }
            occ_store(params.occlusion_index, gidx(offset), occ);
          }
        }
      }
    }
    // Godot's groupMemoryBarrier() covers image writes too; in WGSL the
    // occlusion buffer is storage memory, so workgroupBarrier() alone would let
    // step N read step N-1's stale values.
    storageBarrier();
  }

  // bias solid voxels away
  if (!region_out_of_bounds) {
    for (var i = 0; i < 64; i++) {
      let local_offset = local_ofs + ((vec3i(i) >> vec3u(0u, 2u, 4u)) & vec3i(3));
      let offset = region_offset + local_offset;
      if (!inside(offset, params.grid_size)) { continue; }
      let facing = get_facing(local_offset);
      if (facing == 0u) { continue; }

      var proc_pos = local_offset - vec3i(OCCLUSION_SIZE);
      proc_pos += select(vec3i(0), vec3i(1), proc_pos >= vec3i(0));

      var avg = 0.0;
      var occ = 0.0;

      let read_dir = -sign(proc_pos);
      let read_dir_x = vec3i(read_dir.x, 0, 0);
      let read_dir_y = vec3i(0, read_dir.y, 0);
      let read_dir_z = vec3i(0, 0, read_dir.z);

      let facing_pos = (vec3u(facing) >> vec3u(0u, 1u, 2u)) & vec3u(1u);
      let facing_neg = (vec3u(facing) >> vec3u(3u, 4u, 5u)) & vec3u(1u);
      let read_valid = select(facing_neg, facing_pos, read_dir > vec3i(0)) != vec3u(0u);

      let dirs = array<vec3i, 7>(
        read_dir_x, read_dir_y, read_dir_z,
        read_dir_y + read_dir_z, read_dir_x + read_dir_z, read_dir_x + read_dir_y,
        read_dir);
      let valid = array<bool, 7>(
        read_valid.x, read_valid.y, read_valid.z,
        read_valid.y && read_valid.z, read_valid.x && read_valid.z, read_valid.x && read_valid.y,
        all(read_valid));

      for (var k = 0; k < 7; k++) {
        if (!valid[k]) { continue; }
        var read_offset = local_offset + dirs[k];
        if (get_facing(read_offset) != 0u) { continue; }
        read_offset += region_offset;
        if (inside(read_offset, params.grid_size)) {
          occ += occ_load(params.occlusion_index, gidx(read_offset));
          avg += 1.0;
        }
      }

      if (avg > 0.0) { occ /= avg; }
      occ_store(params.occlusion_index, gidx(offset), occ);
    }
  }

  storageBarrier();
  if (region_out_of_bounds) { return; }

  // scale visibility by the facing masks
  for (var i = 0; i < 64; i++) {
    let local_offset = local_ofs + ((vec3i(i) >> vec3u(0u, 2u, 4u)) & vec3i(3));
    let offset = region_offset + local_offset;
    if (!inside(offset, params.grid_size)) { continue; }
    if (get_facing(local_offset) != 0u) { continue; }

    var proc_pos = local_offset - vec3i(OCCLUSION_SIZE);
    proc_pos += select(vec3i(0), vec3i(1), proc_pos >= vec3i(0));
    let proc_abs = abs(proc_pos);

    let read_dir = sign(proc_pos);
    let read_dir_x = vec3i(read_dir.x, 0, 0);
    let read_dir_y = vec3i(0, read_dir.y, 0);
    let read_dir_z = vec3i(0, 0, read_dir.z);

    var visible = 0.0;
    var occlude_total = 0.0;

    var read_mask = select(vec3u(1u, 2u, 4u), vec3u(8u, 16u, 32u), read_dir > vec3i(0));

    if (proc_abs.x < OCCLUSION_SIZE) {
      var read_offset = local_offset + read_dir_x;
      let m = get_facing(read_offset);
      if (m != 0u) {
        read_offset += region_offset;
        if (inside(read_offset, params.grid_size)) {
          occlude_total += 1.0;
          if ((m & read_mask.x) != 0u) { visible += 1.0; }
        }
      }
    }
    if (proc_abs.y < OCCLUSION_SIZE) {
      var read_offset = local_offset + read_dir_y;
      let m = get_facing(read_offset);
      if (m != 0u) {
        read_offset += region_offset;
        if (inside(read_offset, params.grid_size)) {
          occlude_total += 1.0;
          if ((m & read_mask.y) != 0u) { visible += 1.0; }
        }
      }
    }
    if (proc_abs.z < OCCLUSION_SIZE) {
      var read_offset = local_offset + read_dir_z;
      let m = get_facing(read_offset);
      if (m != 0u) {
        read_offset += region_offset;
        if (inside(read_offset, params.grid_size)) {
          occlude_total += 1.0;
          if ((m & read_mask.z) != 0u) { visible += 1.0; }
        }
      }
    }

    // near the cartesian plane, test the opposite direction too
    read_mask = select(vec3u(1u, 2u, 4u), vec3u(8u, 16u, 32u), read_dir < vec3i(0));

    if (proc_abs.x == 1) {
      var read_offset = local_offset - read_dir_x;
      let m = get_facing(read_offset);
      if (m != 0u) {
        read_offset += region_offset;
        if (inside(read_offset, params.grid_size)) {
          occlude_total += 1.0;
          if ((m & read_mask.x) != 0u) { visible += 1.0; }
        }
      }
    }
    if (proc_abs.y == 1) {
      var read_offset = local_offset - read_dir_y;
      let m = get_facing(read_offset);
      if (m != 0u) {
        read_offset += region_offset;
        if (inside(read_offset, params.grid_size)) {
          occlude_total += 1.0;
          if ((m & read_mask.y) != 0u) { visible += 1.0; }
        }
      }
    }
    if (proc_abs.z == 1) {
      var read_offset = local_offset - read_dir_z;
      let m = get_facing(read_offset);
      if (m != 0u) {
        read_offset += region_offset;
        if (inside(read_offset, params.grid_size)) {
          occlude_total += 1.0;
          if ((m & read_mask.z) != 0u) { visible += 1.0; }
        }
      }
    }

    if (occlude_total > 0.0) {
      let idx = gidx(offset);
      occ_store(params.occlusion_index, idx, occ_load(params.occlusion_index, idx) * visible / occlude_total);
    }
  }
}
`;

export const STORE = /* wgsl */ `
${HEAD}${PROCESS_VOXEL}
@group(0) @binding(1) var src_positions: texture_3d<u32>;
@group(0) @binding(2) var<storage, read> src_albedo: array<u32>;
@group(0) @binding(3) var<storage, read> render_occlusion: array<u32>;
@group(0) @binding(4) var<storage, read> src_light: array<u32>;
@group(0) @binding(5) var<storage, read> src_light_aniso: array<u32>;
@group(0) @binding(6) var<storage, read> src_facing: array<u32>;
@group(0) @binding(7) var dst_sdf: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(8) var dst_occlusion: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(10) var<storage, read_write> dispatch_data: DispatchAtomic;
@group(0) @binding(11) var<storage, read_write> dst_process_voxels: array<ProcessVoxel>;

struct DispatchAtomic { x: atomic<u32>, y: u32, z: u32, total_count: atomic<u32> };

fn occ_load(vol: u32, idx: u32) -> f32 {
  let w = render_occlusion[idx * 2u + (vol >> 2u)];
  return f32((w >> ((vol & 3u) * 8u)) & 0xFFu) / 255.0;
}

var<workgroup> store_positions: array<ProcessVoxel, 64>;
var<workgroup> store_position_count: atomic<u32>;
var<workgroup> store_from_index: u32;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let local = vec3i(lid);
  let pos = vec3i(gid);

  var p = textureLoad(src_positions, pos, 0);

  var solid = false;
  var d: f32;
  if (all(vec3i(p.xyz) == pos)) {
    d = 0.0;
    solid = true;
  } else {
    d = 1.0 + length(vec3f(p.xyz) - vec3f(pos));
  }
  d /= 255.0;
  textureStore(dst_sdf, vec3i(pos.x, pos.y, pos.z + params.cascade * GRID), vec4f(d));

  // STORE OCCLUSION -- two rgba8 texels hold volumes 0..3 and 4..7
  {
    let idx = gidx(pos);
    let lo = vec4f(occ_load(0u, idx), occ_load(1u, idx), occ_load(2u, idx), occ_load(3u, idx));
    let hi = vec4f(occ_load(4u, idx), occ_load(5u, idx), occ_load(6u, idx), occ_load(7u, idx));
    let occ_pos = vec3i(pos.x, pos.y, pos.z + params.cascade * params.grid_size);
    textureStore(dst_occlusion, occ_pos, lo);
    textureStore(dst_occlusion, occ_pos + vec3i(params.grid_size, 0, 0), hi);
  }

  // STORE POSITIONS
  if (all(local == vec3i(0))) { atomicStore(&store_position_count, 0u); }
  workgroupBarrier();

  if (solid) {
    let index = atomicAdd(&store_position_count, 1u);
    var v: ProcessVoxel;
    v.position = u32(pos.x | (pos.y << 7u) | (pos.z << 14u));

    var bit_index = 0u;
    var neighbour_bits = 0u;
    for (var i = -1; i <= 1; i++) {
      for (var j = -1; j <= 1; j++) {
        for (var k = -1; k <= 1; k++) {
          if (i == 0 && j == 0 && k == 0) { continue; }
          let npos = pos + vec3i(i, j, k);
          if (inside(npos, params.grid_size)) {
            let q = textureLoad(src_positions, npos, 0);
            if (all(vec3i(q.xyz) == pos)) { neighbour_bits |= (1u << bit_index); }
          }
          bit_index++;
        }
      }
    }

    let o = gidx(pos);
    let rgb = src_albedo[o];
    let facing = src_facing[o];

    v.albedo = rgb >> 1u;
    v.albedo |= (facing & 0x3Fu) << 15u;
    v.albedo |= neighbour_bits << 21u;
    v.position |= (neighbour_bits >> 11u) << 21u;
    v.light = src_light[o] | ((neighbour_bits >> 22u) << 30u);
    v.light_aniso = src_light_aniso[o] | ((neighbour_bits >> 24u) << 30u);

    store_positions[index] = v;
  }

  workgroupBarrier();

  if (all(local == vec3i(0))) {
    let count = atomicLoad(&store_position_count);
    if (count > 0u) {
      store_from_index = atomicAdd(&dispatch_data.total_count, count);
      let group_count = (store_from_index + count - 1u) / 64u + 1u;
      atomicMax(&dispatch_data.x, group_count);
    }
  }

  workgroupBarrier();

  let read_index = u32(local.z * 16 + local.y * 4 + local.x);
  let write_index = store_from_index + read_index;
  if (read_index < atomicLoad(&store_position_count)) {
    dst_process_voxels[write_index] = store_positions[read_index];
  }

  if (all(pos == vec3i(0))) {
    dispatch_data.y = 1u;
    dispatch_data.z = 1u;
  }
}
`;
