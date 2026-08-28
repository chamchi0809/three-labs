// The floor grid, as line geometry.
//
// M6 replaces this with the renderer proper — a screen-derivative grid that stays one pixel wide at any
// distance, drawn on brush faces the way TrenchBroom draws it. Until the brush kernel exists there is
// nothing to draw it on, and explicit lines are exact: what you see is `gridSize()` and nothing else.
import * as THREE from "three/webgpu";
import { MAJOR_EVERY, gridExtent, isMajor } from "../grid/snap.ts";

// Read as sRGB by the Color constructor, so these are the hex values a theme file would carry.
const MINOR = new THREE.Color(0x2c3037);
const MAJOR = new THREE.Color(0x3f454f);
const AXIS_X = new THREE.Color(0xa04f4f);
const AXIS_Z = new THREE.Color(0x4f6fa0);

/**
 * A grid of `size` metre cells on the XZ plane, reaching {@link gridExtent} either side of the origin.
 *
 * One `LineSegments` with vertex colours rather than three draw calls: the tiers differ only in colour,
 * and the whole thing is rebuilt whenever the size changes anyway.
 */
export function buildGrid(size: number): THREE.LineSegments {
  const extent = gridExtent(size);
  const count = Math.round(extent / size); // cells from the origin to the edge, each way

  const positions: number[] = [];
  const colors: number[] = [];

  const push = (ax: number, az: number, bx: number, bz: number, color: THREE.Color) => {
    positions.push(ax, 0, az, bx, 0, bz);
    colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
  };

  for (let i = -count; i <= count; i++) {
    const offset = i * size;
    // along X at z = offset — the one through the origin is the X axis
    push(-extent, offset, extent, offset, i === 0 ? AXIS_X : isMajor(i, MAJOR_EVERY) ? MAJOR : MINOR);
    // along Z at x = offset — the one through the origin is the Z axis
    push(offset, -extent, offset, extent, i === 0 ? AXIS_Z : isMajor(i, MAJOR_EVERY) ? MAJOR : MINOR);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));

  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true }));
  lines.name = "grid";
  // the grid is scenery, not geometry: it never occludes a brush and never takes a click
  lines.renderOrder = -1;
  lines.raycast = () => {};
  return lines;
}

/** Frees the geometry and material {@link buildGrid} allocated. */
export function disposeGrid(grid: THREE.LineSegments) {
  grid.geometry.dispose();
  (grid.material as THREE.Material).dispose();
}
