/**
 * node --experimental-strip-types src/sdfgi.test.ts
 *
 * ponytail: the only unit-testable part of the port is the cascade scroll
 * bookkeeping (update / get_pending_region_data). Everything else needs a GPU.
 * These two are also the parts that silently corrupt the volume if wrong: the
 * pending regions must exactly tile the cells the scroll did NOT preserve, with
 * no overlap (double-voxelized) and no gap (stale voxels).
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SDFGI } from './sdfgi.ts';
import { CASCADE_SIZE, PROBE_CELLS } from './constants.ts';
import { PROCESS } from './shaders/integrate.ts';

const G = CASCADE_SIZE;
const Y_MULT = 1.5;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function makeGi(numCascades: number, minCellSize: number): Any {
  const gi: Any = Object.create(SDFGI.prototype);
  gi.yMult = Y_MULT;
  gi.numCascades = numCascades;
  gi.serveCursor = 0;
  gi.frame = 0;
  gi.lastScrollFrame = -1e9;
  // these tests are about which cascade is served, not how often -- the pacing
  // gets its own case below
  gi.options = { scrollInterval: 1 };
  gi.cascades = Array.from({ length: numCascades }, (_, i) => ({
    cellSize: minCellSize * 2 ** i,
    position: new THREE.Vector3(),
    dirty: new THREE.Vector3(),
    dirtyAll: false,
    queued: false,
    queuedPos: new THREE.Vector3(),
    queuedDirty: new THREE.Vector3(),
    queuedDirtyAll: false,
  }));
  return gi;
}

/** what render() does per frame: scroll bookkeeping, then serve one cascade */
function frame(gi: Any, pos: THREE.Vector3) {
  gi.update(pos);
  gi.dequeueCascade();
  gi.frame++;
}

/** what render() does after the regions are voxelized */
function clearDirty(gi: Any) {
  gi.cascades.forEach((c: Any) => {
    c.dirtyAll = false;
    c.dirty.set(0, 0, 0);
  });
}

function busyCascades(gi: Any): number {
  return gi.cascades.filter((c: Any) => c.dirtyAll || c.dirty.lengthSq() > 0).length;
}

function regionsOf(gi: Any) {
  const out = [];
  for (let i = 0; ; i++) {
    const r = gi.pendingRegion(i);
    if (!r) break;
    out.push(r);
    assert.ok(i < 64, 'pendingRegion did not terminate');
  }
  return out;
}

function checkTiling(gi: Any, label: string) {
  const byCascade = new Map<number, Any[]>();
  for (const r of regionsOf(gi)) {
    // every region must sit inside the volume
    for (const a of ['x', 'y', 'z'] as const) {
      assert.ok(r.size[a] > 0, `${label}: empty region on ${a}`);
      assert.ok(r.from[a] >= 0 && r.from[a] + r.size[a] <= G, `${label}: region out of bounds`);
    }
    const list = byCascade.get(r.cascade) ?? [];
    list.push(r);
    byCascade.set(r.cascade, list);
  }

  for (let i = 0; i < gi.cascades.length; i++) {
    const c = gi.cascades[i];
    const list = byCascade.get(i) ?? [];
    const expected = c.dirtyAll
      ? G * G * G
      : G * G * G - (G - Math.abs(c.dirty.x)) * (G - Math.abs(c.dirty.y)) * (G - Math.abs(c.dirty.z));

    let volume = 0;
    for (const r of list) volume += r.size.x * r.size.y * r.size.z;
    assert.equal(volume, expected, `${label}: cascade ${i} covers ${volume}, want ${expected}`);

    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const overlap = (['x', 'y', 'z'] as const).every(
          (k) =>
            list[a].from[k] < list[b].from[k] + list[b].size[k] &&
            list[b].from[k] < list[a].from[k] + list[a].size[k],
        );
        assert.ok(!overlap, `${label}: cascade ${i} regions ${a}/${b} overlap`);
      }
    }

    // world bounds must agree with the cell range (y is stored pre-divided)
    for (const r of list) {
      const bx = (r.from.x - (G >> 1) + c.position.x) * c.cellSize;
      const by = ((r.from.y - (G >> 1) + c.position.y) * c.cellSize) / Y_MULT;
      assert.ok(Math.abs(r.boundsMin.x - bx) < 1e-6, `${label}: bounds.x mismatch`);
      assert.ok(Math.abs(r.boundsMin.y - by) < 1e-6, `${label}: bounds.y mismatch`);
      assert.ok(Math.abs(r.boundsSize.x - r.size.x * c.cellSize) < 1e-6, `${label}: size.x mismatch`);
    }
  }
}

// fresh cascade set: cascade 0 builds now, the rest queue one frame at a time
{
  const gi = makeGi(4, 0.2);
  const origin = new THREE.Vector3(0, 0, 0);
  gi.placeCascades(origin);
  assert.equal(regionsOf(gi).length, 1, 'startup must not build every cascade at once');
  checkTiling(gi, 'create');
  const built = [0];
  for (let f = 0; f < 3; f++) {
    clearDirty(gi);
    frame(gi, origin);
    const regions = regionsOf(gi);
    assert.equal(regions.length, 1, `create frame ${f}: expected one cascade`);
    assert.deepEqual([regions[0].size.x, regions[0].size.y, regions[0].size.z], [G, G, G]);
    checkTiling(gi, `create frame ${f}`);
    built.push(regions[0].cascade);
  }
  assert.deepEqual([...built].sort(), [0, 1, 2, 3], 'startup skipped a cascade');
  clearDirty(gi);
  frame(gi, origin);
  assert.equal(regionsOf(gi).length, 0, 'startup build did not settle');
}

// scrolls of every shape, forward and backward, across all cascades
for (const [x, y, z] of [
  [0, 0, 0],
  [3, 0, 0],
  [-3, 0, 0],
  [3, 2, 0],
  [3, 2, -5],
  [-7, -4, 9],
  [0.3, 0.1, 0.2],
  [60, 0, 0], // far enough to force DIRTY_ALL on the near cascades
  [400, 400, 400],
]) {
  const gi = makeGi(4, 0.2);
  gi.placeCascades(new THREE.Vector3(0, 0, 0));
  clearDirty(gi);
  const target = new THREE.Vector3(x, y, z);

  // A DIRTY_ALL on one axis aborts the drag loop before the remaining axes are
  // caught up (Godot does the same), and only one cascade is served per frame,
  // so convergence takes several frames -- but it must converge, and stay put.
  let steps = 0;
  for (;;) {
    frame(gi, target);
    checkTiling(gi, `scroll ${x},${y},${z} step ${steps}`);
    assert.ok(busyCascades(gi) <= 1, `scroll ${x},${y},${z}: ${busyCascades(gi)} cascades in one frame`);
    if (regionsOf(gi).length === 0 && !gi.cascades.some((c: Any) => c.queued)) break;
    clearDirty(gi);
    assert.ok(++steps <= 16, `scroll ${x},${y},${z}: did not converge`);
  }
  const settled = gi.cascades.map((c: Any) => c.position.clone());
  frame(gi, target);
  assert.equal(regionsOf(gi).length, 0, `scroll ${x},${y},${z}: not idempotent`);
  gi.cascades.forEach((c: Any, i: number) =>
    assert.ok(c.position.equals(settled[i]), 'cascade drifted while stationary'),
  );
}

// drag margin: the camera can move within +/- 8 cells of cascade 0 without work
{
  const gi = makeGi(1, 0.2);
  gi.placeCascades(new THREE.Vector3(0, 0, 0));
  gi.cascades[0].dirtyAll = false;
  frame(gi, new THREE.Vector3(8 * 0.2, 0, 0));
  assert.equal(regionsOf(gi).length, 0, 'moved inside the drag margin but scrolled');
  frame(gi, new THREE.Vector3(9 * 0.2, 0, 0));
  assert.equal(regionsOf(gi).length, 1, 'moved past the drag margin but did not scroll');
  assert.equal(gi.cascades[0].dirty.x, -16, 'scroll step must be drag_margin * 2');
  // and the scroll stays a whole number of probes, or the probe history scroll
  // in preprocessCascade() would land between probes
  assert.equal(Math.abs(gi.cascades[0].dirty.x % PROBE_CELLS), 0, 'scroll must be probe-aligned');
}

// pacing: a rebuild is expensive, so serving two of them on consecutive frames
// is what halves the frame rate while the camera moves
{
  const gi = makeGi(4, 0.2);
  gi.options.scrollInterval = 4;
  gi.placeCascades(new THREE.Vector3(0, 0, 0));
  clearDirty(gi);
  const far = new THREE.Vector3(40, 0, 0);
  const servedOn: number[] = [];
  for (let f = 0; f < 16; f++) {
    frame(gi, far);
    if (busyCascades(gi) > 0) servedOn.push(f);
    clearDirty(gi);
  }
  assert.deepEqual(servedOn, [0, 4, 8, 12], 'scrollInterval did not space the rebuilds out');
}

// time slicing: four cascades scrolling at once are served one frame at a time,
// and a queued cascade must not move until its volume has scrolled with it
{
  const gi = makeGi(4, 0.2);
  gi.placeCascades(new THREE.Vector3(0, 0, 0));
  clearDirty(gi);
  const far = new THREE.Vector3(40, 0, 0); // past the drag margin of every cascade
  gi.update(far);
  assert.equal(gi.cascades.filter((c: Any) => c.queued).length, 4, 'all four should queue');
  const frozen = gi.cascades.map((c: Any) => c.position.clone());
  gi.cascades.forEach((c: Any, i: number) =>
    assert.ok(c.position.equals(frozen[i]) && c.position.x === 0, 'queued cascade moved early'),
  );

  const served: number[] = [];
  for (let f = 0; f < 4; f++) {
    frame(gi, far);
    assert.equal(busyCascades(gi), 1, `frame ${f}: expected exactly one cascade rebuilding`);
    served.push(gi.cascades.findIndex((c: Any) => c.dirtyAll || c.dirty.lengthSq() > 0));
    clearDirty(gi);
  }
  assert.deepEqual([...served].sort(), [0, 1, 2, 3], 'round robin starved a cascade');
}


// probe history packs three signed values into two u32; a value that does not
// survive the round trip corrupts the running average for the whole history
// window, silently and forever.
{
  const hpack = (v: number[]) => [((v[0] & 0xffff) | (v[1] << 16)) >>> 0, (v[2] & 0xffff) >>> 0];
  const hunpack = (p: number[]) => [(p[0] << 16) >> 16, p[0] >> 16, (p[1] << 16) >> 16];
  const range = [-32768, -32767, -1, 0, 1, 32766, 32767];
  for (const a of range) {
    for (const b of range) {
      const v = [a, b, a];
      assert.deepEqual(hunpack(hpack(v)), v, `history pack round trip failed for ${v}`);
    }
  }
  assert.match(
    PROCESS,
    /clamp\(vec4i\(value \* f32\(1u << HISTORY_BITS\)\), vec4i\(-32768\), vec4i\(32767\)\)/,
    'PROCESS no longer clamps history to the 16 bits hpack() can hold',
  );
}

console.log('sdfgi region bookkeeping: ok');
