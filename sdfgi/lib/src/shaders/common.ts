import { CASCADE_SIZE, LIGHTPROBE_OCT_SIZE, SH_SIZE, HISTORY_BITS } from '../constants.ts';

/** Constants injected into every WGSL module (Godot injects them as #defines). */
export const WGSL_DEFINES = /* wgsl */ `
const GRID: i32 = ${CASCADE_SIZE};
const OCT_SIZE: i32 = ${LIGHTPROBE_OCT_SIZE};
const SH_SIZE: i32 = ${SH_SIZE};
const HISTORY_BITS: u32 = ${HISTORY_BITS}u;
const PI: f32 = 3.14159265;
`;

/** Linear index into the full-resolution 128^3 render buffers. */
export const WGSL_GRID = /* wgsl */ `
fn gidx(p: vec3i) -> u32 {
  return u32(p.z * GRID * GRID + p.y * GRID + p.x);
}
fn bits3(i: i32) -> vec3i {
  return vec3i((i >> 0u) & 1, (i >> 1u) & 1, (i >> 2u) & 1);
}
fn inside(p: vec3i, g: i32) -> bool {
  return all(p >= vec3i(0)) && all(p < vec3i(g));
}
`;

/**
 * Godot keeps one texture per cascade and binds them as `texture3D x[8]`.
 * WGSL has no binding arrays, so every cascaded volume is a single 3D texture
 * of depth GRID * cascade_count and the z coordinate is remapped here. The
 * clamp reproduces per-cascade CLAMP_TO_EDGE that separate textures gave free.
 */
export const WGSL_CASCADE_UVW = /* wgsl */ `
fn casc_uvw(cascade: u32, max_cascades: u32, uvw: vec3f) -> vec3f {
  let e = 0.5 / f32(GRID);
  let z = (f32(cascade) + clamp(uvw.z, e, 1.0 - e)) / f32(max_cascades);
  return vec3f(clamp(uvw.x, e, 1.0 - e), clamp(uvw.y, e, 1.0 - e), z);
}
`;

export const WGSL_OCT = /* wgsl */ `
fn octahedron_wrap(v: vec2f) -> vec2f {
  let s = vec2f(select(-1.0, 1.0, v.x >= 0.0), select(-1.0, 1.0, v.y >= 0.0));
  return (vec2f(1.0) - abs(v.yx)) * s;
}
fn octahedron_encode(n_in: vec3f) -> vec2f {
  var n = n_in / (abs(n_in.x) + abs(n_in.y) + abs(n_in.z));
  var r = select(octahedron_wrap(n.xy), n.xy, n.z >= 0.0);
  return r * 0.5 + vec2f(0.5);
}
fn octahedron_decode(f_in: vec2f) -> vec3f {
  let f = f_in * 2.0 - vec2f(1.0);
  var n = vec3f(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  let t = clamp(-n.z, 0.0, 1.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}
// oct_inc.glsl: vec3_to_oct_with_border()
fn vec3_to_oct_with_border(n: vec3f, border: vec2f) -> vec2f {
  return octahedron_encode(n) * (vec2f(1.0) - border * 2.0) + border;
}
`;

/** RGBE codecs from sdfgi_direct_light.glsl / sdfgi_integrate.glsl. */
export const WGSL_RGBE = /* wgsl */ `
struct Rgbe { s: vec3u, e: u32 };
fn rgbe_split(color: vec3f) -> Rgbe {
  let pow2to9 = 512.0;
  let B = 15.0;
  let N = 9.0;
  let LN2 = 0.6931471805599453;
  let c = clamp(color, vec3f(0.0), vec3f(65408.0));
  let cMax = max(c.r, max(c.g, c.b));
  let expp = max(-B - 1.0, floor(log(cMax) / LN2)) + 1.0 + B;
  let sMax = floor((cMax / pow(2.0, expp - B - N)) + 0.5);
  var exps = expp + 1.0;
  if (0.0 <= sMax && sMax < pow2to9) { exps = expp; }
  let s = floor((c / vec3f(pow(2.0, exps - B - N))) + vec3f(0.5));
  return Rgbe(vec3u(s), u32(exps));
}
fn rgbe_encode(color: vec3f) -> u32 {
  let r = rgbe_split(color);
  return (r.s.x & 0x1FFu) | ((r.s.y & 0x1FFu) << 9u) | ((r.s.z & 0x1FFu) << 18u) | ((r.e & 0x1Fu) << 27u);
}
fn rgbe8985_encode(color: vec3f) -> u32 {
  let r = rgbe_split(color);
  return ((r.s.x & 0x1FFu) >> 1u) | ((r.s.y & 0x1FFu) << 8u) | (((r.s.z & 0x1FFu) >> 1u) << 17u) | ((r.e & 0x1Fu) << 25u);
}
fn rgbe8985_decode(rgbe: u32) -> vec3f {
  let r = f32((rgbe & 0xffu) << 1u);
  let g = f32((rgbe >> 8u) & 0x1ffu);
  let b = f32(((rgbe >> 17u) & 0xffu) << 1u);
  let e = f32((rgbe >> 25u) & 0x1Fu);
  return vec3f(r, g, b) * pow(2.0, e - 15.0 - 9.0);
}
`;

export const WGSL_HASH = /* wgsl */ `
const GOLDEN_ANGLE: f32 = 2.39996323;
fn vogel_hemisphere(p_index: u32, p_count: u32, p_offset: f32) -> vec3f {
  let r = sqrt(f32(p_index) + 0.5) / sqrt(f32(p_count));
  let theta = f32(p_index) * GOLDEN_ANGLE + p_offset;
  let y = cos(r * PI * 0.5);
  let l = sin(r * PI * 0.5);
  return vec3f(l * cos(theta), l * sin(theta), y * (f32(p_index & 1u) * 2.0 - 1.0));
}
fn hash3(x_in: vec3u) -> vec3u {
  var x = ((x_in >> vec3u(16u)) ^ x_in) * vec3u(0x45d9f3bu);
  x = ((x >> vec3u(16u)) ^ x) * vec3u(0x45d9f3bu);
  return (x >> vec3u(16u)) ^ x;
}
`;

/** CascadeData UBO shared by direct_light / integrate / gi / debug. */
export const WGSL_CASCADES = /* wgsl */ `
struct CascadeData {
  offset: vec3f,
  to_cell: f32,
  probe_world_offset: vec3i,
  pad: u32,
  pad2: vec4f,
};
`;

export const ANISO_DIR = /* wgsl */ `
const aniso_dir = array<vec3f, 6>(
  vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0),
  vec3f(-1.0, 0.0, 0.0), vec3f(0.0, -1.0, 0.0), vec3f(0.0, 0.0, -1.0));
`;

export const NEIGHBOURS26 = /* wgsl */ `
const offsets26 = array<vec3i, 26>(
  vec3i(-1,-1,-1), vec3i(-1,-1,0), vec3i(-1,-1,1), vec3i(-1,0,-1), vec3i(-1,0,0),
  vec3i(-1,0,1), vec3i(-1,1,-1), vec3i(-1,1,0), vec3i(-1,1,1), vec3i(0,-1,-1),
  vec3i(0,-1,0), vec3i(0,-1,1), vec3i(0,0,-1), vec3i(0,0,1), vec3i(0,1,-1),
  vec3i(0,1,0), vec3i(0,1,1), vec3i(1,-1,-1), vec3i(1,-1,0), vec3i(1,-1,1),
  vec3i(1,0,-1), vec3i(1,0,0), vec3i(1,0,1), vec3i(1,1,-1), vec3i(1,1,0), vec3i(1,1,1));
`;
