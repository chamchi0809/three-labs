// Direct port of the SDFGI constants in godot/servers/rendering/renderer_rd/environment/gi.h
export const MAX_CASCADES = 8;
export const CASCADE_SIZE = 128;
export const PROBE_DIVISOR = 16;
export const PROBE_AXIS_COUNT = PROBE_DIVISOR + 1; // 17
export const ANISOTROPY_SIZE = 6;
export const MAX_DYNAMIC_LIGHTS = 128;
export const MAX_STATIC_LIGHTS = 1024;
export const LIGHTPROBE_OCT_SIZE = 6;
export const SH_SIZE = 16;
export const HISTORY_BITS = 10;

/** `#define OCCLUSION_SIZE` in sdfgi_preprocess.glsl (gi.cpp:3643). */
export const OCCLUSION_SIZE = CASCADE_SIZE / PROBE_DIVISOR; // 8
/** cells covered by one probe on each axis */
export const PROBE_CELLS = CASCADE_SIZE / PROBE_DIVISOR; // 8

export const DIRTY_ALL = -1;

export const LIGHT_TYPE_DIRECTIONAL = 0;
export const LIGHT_TYPE_OMNI = 1;
export const LIGHT_TYPE_SPOT = 2;

export const SKY_FLAGS_MODE_COLOR = 0x01;
export const SKY_FLAGS_MODE_SKY = 0x02;
export const SKY_FLAGS_ORIENTATION_SIGN = 0x04;

/** SDFGI::update_light(): frames_to_update_light -> process_increment */
export const FRAMES_TO_UPDATE_LIGHT = [1, 2, 4, 8, 16];
/** RenderForwardClustered: history_frames_to_converge */
export const HISTORY_FRAMES_TO_CONVERGE = [5, 10, 15, 20, 25, 30];
/** y_scale_mode -> y_mult (gi.cpp:423) */
export const Y_SCALE = [2.0, 1.5, 1.0];
