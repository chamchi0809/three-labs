import {
  Box3,
  type BufferGeometry,
  Color,
  HalfFloatType,
  type Mesh,
  NearestFilter,
  type Node,
  type Object3D,
  type Scene,
  Storage3DTexture,
  Vector3,
  type WebGPURenderer,
} from "three/webgpu";
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  compute,
  float,
  floor,
  instanceIndex,
  instancedArray,
  int,
  max,
  sign,
  storageTexture3D,
  texture3D,
  uint,
  uniform,
  vec3,
  vec4,
} from "three/tsl";

// three does not re-export its node classes as types from `three/webgpu`, and
// reaching into `three/src` for them would couple this package to the library's
// internal file layout. `instancedArray` is an overload set rather than a
// generic, so the element type is pinned by a helper the overload resolves
// against, and the node types are read back off it.
const vec4Array = (count: number) => instancedArray(count, "vec4");
const matrixArray = (count: number) => instancedArray(count * 4, "vec4");
type Vec4Array = ReturnType<typeof vec4Array>;
type MatrixArray = ReturnType<typeof matrixArray>;
type ComputeKernel = ReturnType<typeof compute>;

/**
 * Half-voxel sampling pitch when tessellating a triangle into splat points.
 * Two samples per voxel along each edge is the coarsest spacing at which a
 * triangle cannot skip a voxel it actually crosses: the sample lattice step
 * stays strictly smaller than a voxel. Barycentric grids include the vertices
 * and edges, so slivers and corners are covered without a separate pass.
 */
const SAMPLE_PITCH = 0.5;

/**
 * Ceiling on the barycentric subdivision of a single triangle. A ground quad
 * spanning the whole grid would otherwise emit hundreds of thousands of points
 * on its own.
 */
const MAX_TRIANGLE_STEPS = 512;

/** Rays starting outside the grid are misses, so this only bounds interior travel. */
const MAX_DDA_STEPS = 320;

const DEFAULT_RESOLUTION = 128;
/**
 * 16 bytes each and only the points in use are dispatched, so the cost of the
 * headroom is 64 MB of buffer. Sized for the densest demo scene (Pica Pica
 * needs 3.6M), because the alternative is silently dropping its tail.
 */
const DEFAULT_MAX_POINTS = 1 << 22;

/**
 * Objects the grid can transform. Storage-backed, so the ceiling is memory
 * (4096 mat4 is 1 MB) rather than the 64 KB a uniform binding would cap at —
 * a glTF level runs to hundreds of meshes and the overflow used to be silent.
 */
const MAX_OBJECTS = 4096;

/**
 * Share of the point budget held back for meshes that appear after the build:
 * projectiles, particles, anything spawned mid-play. Re-tessellated only when
 * that set changes, so a still scene pays nothing for it.
 */
const DYNAMIC_SHARE = 1 / 16;

/** Opacity is written as exactly 0 or 1, so anything above the midpoint is a surface. */
const OCCUPIED = 0.5;

export interface VoxelSceneOptions {
  /** Voxels per axis. Memory is `resolution³ × 16` bytes across the two grids. */
  resolution?: number;
  /** Hard cap on splat points; sampling density is scaled down to fit. */
  maxPoints?: number;
  /** Grid padding as a fraction of the scene bounds, so surfaces are not clipped at the edge. */
  padding?: number;
}

interface SurfaceMaterial {
  color?: Color;
  emissive?: Color;
  emissiveIntensity?: number;
}

const materialOf = (mesh: Mesh): SurfaceMaterial | undefined =>
  (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
    | SurfaceMaterial
    | undefined;

/**
 * Visibility as the renderer sees it: hiding a group hides everything under it,
 * and `mesh.visible` alone would keep splatting the children of a hidden group.
 */
const shown = (mesh: Mesh): boolean => {
  for (let o: Object3D | null = mesh; o; o = o.parent) if (!o.visible) return false;
  return true;
};

const emits = (mesh: Mesh): boolean => {
  const source = materialOf(mesh);
  if (!source?.emissive || (source.emissiveIntensity ?? 1) === 0) return false;
  const { r, g, b } = source.emissive;
  return r + g + b > 0;
};

/**
 * A world-space voxelization of the scene, and a DDA ray cast over it.
 *
 * Split Radiance Cascades is defined against a ray cast that reports the hit
 * distance `t` and the radiance leaving the hit — the paper uses OptiX, and
 * says explicitly that tracing is not specific to the algorithm. WebGPU has no
 * hardware ray tracing, so the cast is a grid march instead.
 *
 * Quantizing `t` to a voxel is harmless here because ray splitting only ever
 * compares `t` against the cascade interval bounds, and the shortest of those
 * spans several probe spacings — far coarser than a voxel. The cost is
 * geometric detail below the voxel size, which surfaces as the same
 * over-blurring of hard shadows the paper lists as a known artifact.
 *
 * ponytail: point-splatting fills the grid instead of conservative
 * rasterization. Sub-voxel barycentric sampling is hole-free for the closed
 * surfaces this repo renders, and the CPU tessellation runs once per scene
 * rather than per frame. Upgrade path if geometry ever becomes fully dynamic:
 * three axis-aligned raster passes writing the same storage textures.
 */
export class VoxelScene {
  readonly resolution: number;
  /** World-space size of one voxel; the natural unit for `Δs₀`. */
  voxelSize = 1;
  /** Lower corner of the voxelized region. */
  readonly gridMin = new Vector3();
  /** World-space edge length of the whole grid. */
  gridExtent = 1;
  pointCount = 0;

  private readonly renderer: WebGPURenderer;
  private readonly maxPoints: number;
  private readonly padding: number;

  /** rgb = emissive radiance, a = opacity. */
  private readonly radianceGrid: Storage3DTexture;
  /** rgb = albedo, a = opacity. */
  private readonly albedoGrid: Storage3DTexture;

  private readonly pointPosition: Vec4Array;
  /** Material colours are per mesh, so they are indexed by object, not by point. */
  private readonly objectAlbedo: Vec4Array;
  private readonly objectEmissive: Vec4Array;

  private readonly uMatrices: MatrixArray;
  /** Set when the point buffer itself was rewritten, which no snapshot sees. */
  private splatDirty = true;
  /** Per object: 16 matrix floats, then 4 albedo, then 4 emissive. */
  private readonly splatSnapshot = new Float32Array(MAX_OBJECTS * 24);
  private readonly uGridMin = uniform(new Vector3());
  private readonly uVoxelSize = uniform(1);
  private readonly uPointCount = uniform(0, "uint");

  private readonly clearKernel: ComputeKernel;
  private readonly splatKernel: ComputeKernel;

  /** Every traced mesh: the build's snapshot first, then whatever appeared since. */
  private objects: Mesh[] = [];
  private staticObjects: Mesh[] = [];
  private staticSet = new Set<Mesh>();
  private staticPoints = 0;
  private dynamicObjects: Mesh[] = [];
  private dynamicBudget = 0;
  private built = false;

  constructor(renderer: WebGPURenderer, options: VoxelSceneOptions = {}) {
    this.renderer = renderer;
    this.resolution = Math.max(16, Math.floor(options.resolution ?? DEFAULT_RESOLUTION));
    this.maxPoints = Math.max(1024, Math.floor(options.maxPoints ?? DEFAULT_MAX_POINTS));
    this.dynamicBudget = Math.floor(this.maxPoints * DYNAMIC_SHARE);
    this.padding = options.padding ?? 0.02;

    const n = this.resolution;
    this.radianceGrid = new Storage3DTexture(n, n, n);
    this.radianceGrid.type = HalfFloatType;
    this.radianceGrid.minFilter = NearestFilter;
    this.radianceGrid.magFilter = NearestFilter;
    this.albedoGrid = new Storage3DTexture(n, n, n);
    this.albedoGrid.type = HalfFloatType;
    this.albedoGrid.minFilter = NearestFilter;
    this.albedoGrid.magFilter = NearestFilter;

    this.pointPosition = vec4Array(this.maxPoints);
    this.objectAlbedo = vec4Array(MAX_OBJECTS);
    this.objectEmissive = vec4Array(MAX_OBJECTS);

    this.uMatrices = matrixArray(MAX_OBJECTS);

    // One thread per voxel. Clearing every frame is what lets moving objects
    // leave their old cells behind; a persistent grid would smear them.
    this.clearKernel = compute(Fn(() => {
      const z = instanceIndex.div(uint(n * n));
      const y = instanceIndex.div(uint(n)).mod(uint(n));
      const x = instanceIndex.mod(uint(n));
      const coord = vec3(float(x), float(y), float(z));
      storageTexture3D(this.radianceGrid, coord, vec4(0, 0, 0, 0)).toStack();
      storageTexture3D(this.albedoGrid, coord, vec4(0, 0, 0, 0)).toStack();
    })(), n * n * n);

    // One thread per splat point. Points live in object space, so a moved mesh
    // costs a new matrix rather than a re-tessellation.
    this.splatKernel = compute(Fn(() => {
      const packed = this.pointPosition.element(instanceIndex).toVar();
      // The transform is four vec4 columns rather than a mat4 element: storage
      // arrays of mat4 exist in WGSL but not in three's typed TSL overloads.
      const object = int(packed.w);
      // rgb = albedo, w = 1 while the object is visible. Read up here because a
      // hidden object has to skip the splat, not just write black: the grid's
      // occupancy is this pass's `1` in the alpha channel.
      const surface = this.objectAlbedo.element(object).toVar();
      const column = object.mul(int(4));
      const world = this.uMatrices
        .element(column)
        .xyz.mul(packed.x)
        .add(this.uMatrices.element(column.add(int(1))).xyz.mul(packed.y))
        .add(this.uMatrices.element(column.add(int(2))).xyz.mul(packed.z))
        .add(this.uMatrices.element(column.add(int(3))).xyz);
      const cell = floor(world.sub(this.uGridMin).div(vec3(this.uVoxelSize))).toVar();
      const inside = instanceIndex
        .lessThan(this.uPointCount)
        .and(surface.w.greaterThan(0))
        .and(cell.x.greaterThanEqual(0))
        .and(cell.y.greaterThanEqual(0))
        .and(cell.z.greaterThanEqual(0))
        .and(cell.x.lessThan(float(n)))
        .and(cell.y.lessThan(float(n)))
        .and(cell.z.lessThan(float(n)));
      If(inside, () => {
        const coord = cell;
        const rad = this.objectEmissive.element(object).xyz;
        const alb = surface.xyz;
        // Occupancy lives in the albedo grid, and only emitters touch the
        // radiance grid. A lamp is small, so its voxels are usually shared with
        // the fixture holding it; letting both write radiance would make the
        // light of the whole scene depend on which thread happened to land last.
        storageTexture3D(this.albedoGrid, coord, vec4(alb, 1)).toStack();
        // ponytail: among emitters, last writer still wins a shared voxel. Two
        // lights that close together are the same light at this resolution.
        // Upgrade path: u32 fixed-point atomic accumulation with a count, as the
        // deposit pass already does.
        If(rad.x.add(rad.y).add(rad.z).greaterThan(0), () => {
          storageTexture3D(this.radianceGrid, coord, vec4(rad, 1)).toStack();
        });
      });
    })(), this.maxPoints);
  }

  /** True once {@link build} has found geometry to trace against. */
  get ready(): boolean {
    return this.built && this.pointCount > 0;
  }

  /**
   * Tessellates the scene into splat points and sizes the grid to its bounds.
   * Runs on the CPU, so call it when the scene's geometry changes rather than
   * every frame.
   */
  build(scene: Scene): void {
    scene.updateMatrixWorld(true);

    const meshes: Mesh[] = [];
    const bounds = new Box3();
    scene.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh || !mesh.geometry || !shown(mesh)) return;
      if (!mesh.geometry.getAttribute("position")) return;
      meshes.push(mesh);
      bounds.expandByObject(mesh);
    });
    if (meshes.length > MAX_OBJECTS) {
      console.warn(
        `VoxelScene: scene has ${meshes.length} meshes, tracing the first ${MAX_OBJECTS}.`,
      );
      meshes.length = MAX_OBJECTS;
    }
    // Emitters first. The point budget is spent in traversal order, so a scene
    // that overflows it has to drop dark surfaces rather than the lights
    // everything else is lit by — one late torch dropped is a black level.
    meshes.sort((a, b) => Number(emits(b)) - Number(emits(a)));

    this.objects = meshes;
    this.staticObjects = meshes;
    this.staticSet = new Set(meshes);
    this.dynamicObjects = [];

    if (meshes.length === 0 || bounds.isEmpty()) {
      this.pointCount = 0;
      this.uPointCount.value = 0;
      this.built = false;
      return;
    }

    const size = new Vector3();
    bounds.getSize(size);
    const center = new Vector3();
    bounds.getCenter(center);
    // Cubic, because the DDA's per-axis boundary distance uses a single scalar
    // voxel size.
    this.gridExtent = Math.max(size.x, size.y, size.z, 1e-3) * (1 + this.padding * 2);
    this.voxelSize = this.gridExtent / this.resolution;
    this.gridMin.copy(center).addScalar(-this.gridExtent / 2);
    this.uGridMin.value.copy(this.gridMin);
    this.uVoxelSize.value = this.voxelSize;

    // Two passes: measure what full-density sampling would emit, then coarsen
    // the pitch so the result fits. Coarsening rather than truncating keeps
    // coverage uniform instead of leaving whole objects unsampled.
    const budget = this.maxPoints - this.dynamicBudget;
    const demand = this.countSamples(meshes, 1);
    const scale = demand > budget ? Math.sqrt(budget / demand) : 1;

    this.staticPoints = this.writeSamples(meshes, 0, scale, 0, budget);
    this.pointCount = this.staticPoints;
    this.splatDirty = true;
    this.uPointCount.value = this.pointCount;
    this.built = true;
  }

  /**
   * Refills the grid from the current object transforms, and picks up meshes
   * added or removed since the build. Cheap; call per frame.
   */
  update(scene?: Scene): void {
    if (!this.ready) return;
    if (scene) this.syncDynamic(scene);
    const matrices = this.uMatrices.value.array as Float32Array;
    for (let i = 0; i < this.objects.length; i++) {
      matrices.set(this.objects[i]!.matrixWorld.elements, i * 16);
    }
    this.uMatrices.value.needsUpdate = true;
    this.writeObjectColors();
    // The splat produces the same grid every frame for a scene that has not
    // moved, and it clears and refills all of 128³ to do it. Everything it reads
    // is on the CPU already, so comparing it costs a few thousand floats against
    // a couple of megabytes of GPU traffic — and a scene whose only animation is
    // the camera then pays nothing at all.
    //
    // ponytail: an element-wise compare rather than a version counter, because
    // the transforms are written by three.js and the materials by the app, and
    // neither reports a change. Upgrade path if a scene ever animates every
    // object every frame: the compare becomes the cost and a counter maintained
    // at the write sites is worth the plumbing.
    if (!this.splatInputsChanged()) return;
    this.renderer.compute(this.clearKernel);
    // Dispatched over the points in use, not the buffer's capacity, so a scene
    // far below the budget does not pay for the headroom.
    this.renderer.compute(this.splatKernel, this.pointCount);
  }

  /**
   * Whether anything the splat reads — object transforms, albedo, emissive —
   * differs from the last splat, snapshotting it as it goes.
   */
  private splatInputsChanged(): boolean {
    let changed = this.splatDirty;
    this.splatDirty = false;
    let at = 0;
    for (const [array, stride] of [
      [this.uMatrices.value.array as Float32Array, 16],
      [this.objectAlbedo.value.array as Float32Array, 4],
      [this.objectEmissive.value.array as Float32Array, 4],
    ] as const) {
      for (let i = 0; i < this.objects.length * stride; i++, at++) {
        if (this.splatSnapshot[at] !== array[i]) {
          this.splatSnapshot[at] = array[i]!;
          changed = true;
        }
      }
      // Objects past the live count keep whatever they had; skipping their slots
      // is what keeps a block's offset independent of how many are in use.
      at += (MAX_OBJECTS - this.objects.length) * stride;
    }
    return changed;
  }

  /**
   * Tessellates whatever the scene has gained since the build — projectiles,
   * particles, anything spawned mid-play — into the reserved tail of the point
   * buffer, so it lights and occludes like the rest of the scene.
   *
   * ponytail: any membership change re-tessellates the whole dynamic set rather
   * than editing it in place. It is a few hundred points per mesh and only runs
   * on the frames the set actually changes. Upgrade path if a scene ever spawns
   * continuously: a free list over per-mesh point ranges.
   */
  private syncDynamic(scene: Scene): void {
    const current: Mesh[] = [];
    scene.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh || !mesh.geometry || !shown(mesh)) return;
      if (this.staticSet.has(mesh)) return;
      if (this.staticObjects.length + current.length >= MAX_OBJECTS) return;
      if (!mesh.geometry.getAttribute("position")) return;
      current.push(mesh);
    });

    const unchanged =
      current.length === this.dynamicObjects.length &&
      current.every((mesh, i) => mesh === this.dynamicObjects[i]);
    if (unchanged) return;

    this.dynamicObjects = current;
    this.objects = [...this.staticObjects, ...current];
    // Full density: these are small, and the grid was already sized by the
    // static bounds, so anything spawned outside it is clipped by the splat.
    const added = this.writeSamples(
      current,
      this.staticObjects.length,
      1,
      this.staticPoints,
      this.dynamicBudget,
    );
    this.pointCount = this.staticPoints + added;
    this.splatDirty = true;
    this.uPointCount.value = this.pointCount;
  }

  /**
   * Refreshes every object's albedo and emission. Per frame, because an
   * application dimming or colouring a light expects the light to change, and a
   * few thousand materials is nothing next to re-tessellating them.
   */
  private writeObjectColors(): void {
    const albedo = this.objectAlbedo.value.array as Float32Array;
    const emissive = this.objectEmissive.value.array as Float32Array;
    for (let i = 0; i < this.objects.length; i++) {
      const mesh = this.objects[i]!;
      const source = materialOf(mesh);
      const o = i * 4;
      albedo[o] = source?.color?.r ?? 0.8;
      albedo[o + 1] = source?.color?.g ?? 0.8;
      albedo[o + 2] = source?.color?.b ?? 0.8;
      // Cheaper than dropping the object's points: hiding a light is a per-frame
      // toggle, and re-tessellating the scene for one flag would stall the frame.
      albedo[o + 3] = shown(mesh) ? 1 : 0;
      const intensity = source?.emissiveIntensity ?? 1;
      emissive[o] = (source?.emissive?.r ?? 0) * intensity;
      emissive[o + 1] = (source?.emissive?.g ?? 0) * intensity;
      emissive[o + 2] = (source?.emissive?.b ?? 0) * intensity;
    }
    this.objectAlbedo.value.needsUpdate = true;
    this.objectEmissive.value.needsUpdate = true;
  }

  /**
   * Marches `origin + dir · t` over `t ∈ [tMin, tMax]` and returns
   * `vec4(cell, t)` at the first opaque voxel, or `w < 0` for a miss.
   *
   * `dir` must be unit length, which keeps `t` in world units — ray splitting
   * compares it against the cascade interval bounds directly.
   */
  trace(
    origin: Node<"vec3">,
    dir: Node<"vec3">,
    tMin: Node<"float">,
    tMax: Node<"float">,
  ): Node<"vec4"> {
    return this.traceFn(origin, dir, tMin, tMax) as Node<"vec4">;
  }

  /** Emissive radiance stored at a cell reported by {@link trace}. */
  radianceAt(cell: Node<"vec3">): Node<"vec3"> {
    return texture3D(this.radianceGrid, cell.add(0.5).div(float(this.resolution))).xyz;
  }

  /** The cell a world position falls in, in the coordinates {@link trace} reports. */
  cellAt(world: Node<"vec3">): Node<"vec3"> {
    return floor(world.sub(this.uGridMin).div(vec3(this.uVoxelSize)));
  }

  /** Albedo stored at a cell reported by {@link trace}. */
  albedoAt(cell: Node<"vec3">): Node<"vec3"> {
    return texture3D(this.albedoGrid, cell.add(0.5).div(float(this.resolution))).xyz;
  }

  /** World-space centre of a cell reported by {@link trace}. */
  positionAt(cell: Node<"vec3">): Node<"vec3"> {
    return cell.add(0.5).mul(this.uVoxelSize).add(this.uGridMin);
  }

  dispose(): void {
    this.radianceGrid.dispose();
    this.albedoGrid.dispose();
  }

  /**
   * Amanatides–Woo grid traversal, built once and reused so the loop compiles
   * a single time however many call sites the cascades add.
   */
  private readonly traceFn = Fn(
    ([origin, dir, tMin, tMax]: [
      Node<"vec3">,
      Node<"vec3">,
      Node<"float">,
      Node<"float">,
    ]) => {
      const res = float(this.resolution);
      const start = origin
        .add(dir.mul(vec3(tMin)))
        .sub(this.uGridMin)
        .div(vec3(this.uVoxelSize));
      const cell = floor(start).toVar();
      // ±1 per component, never 0: `sign` returns 0 for a zero component, which
      // would stall that axis instead of parking it. WGSL's componentwise
      // `select` is not reachable through TSL's typed surface, so the sign is
      // repaired arithmetically — `sign(0) + (1 - |sign(0)|)` is 1, and the term
      // vanishes wherever `sign` already returned ±1.
      const rawSign = sign(dir);
      const step = rawSign.add(vec3(1).sub(abs(rawSign))).toVar();
      // A zero direction component gives an infinite boundary distance, which is
      // the correct answer — but the advance would then evaluate `0 · ∞` as NaN,
      // so the magnitude is floored at a value whose boundary distance still
      // never wins the nearest-axis test.
      const safeDir = step.mul(max(abs(dir), vec3(1e-7))).toVar();
      // World distance covered by crossing one voxel along each axis.
      const tDelta = abs(vec3(this.uVoxelSize).div(safeDir)).toVar();
      // World distance from the ray origin to the next boundary on each axis.
      const tNext = cell
        .add(max(step, vec3(0)))
        .sub(start)
        .mul(vec3(this.uVoxelSize))
        .div(safeDir)
        .add(vec3(tMin))
        .toVar();

      const t = float(tMin).toVar();
      const hit = vec4(0, 0, 0, -1).toVar();

      Loop({ start: 0, end: MAX_DDA_STEPS, type: "int", condition: "<" }, () => {
        If(t.greaterThan(tMax), () => {
          Break();
        });
        If(
          cell.x
            .lessThan(0)
            .or(cell.y.lessThan(0))
            .or(cell.z.lessThan(0))
            .or(cell.x.greaterThanEqual(res))
            .or(cell.y.greaterThanEqual(res))
            .or(cell.z.greaterThanEqual(res)),
          () => {
            Break();
          },
        );

        If(texture3D(this.albedoGrid, cell.add(0.5).div(res)).w.greaterThan(OCCUPIED), () => {
          hit.assign(vec4(cell, t));
          Break();
        });

        If(tNext.x.lessThanEqual(tNext.y).and(tNext.x.lessThanEqual(tNext.z)), () => {
          t.assign(tNext.x);
          cell.x.addAssign(step.x);
          tNext.x.addAssign(tDelta.x);
        })
          .ElseIf(tNext.y.lessThanEqual(tNext.z), () => {
            t.assign(tNext.y);
            cell.y.addAssign(step.y);
            tNext.y.addAssign(tDelta.y);
          })
          .Else(() => {
            t.assign(tNext.z);
            cell.z.addAssign(step.z);
            tNext.z.addAssign(tDelta.z);
          });
      });

      return hit;
    },
  );

  private countSamples(meshes: Mesh[], scale: number): number {
    let total = 0;
    this.forEachTriangle(meshes, 0, scale, (steps) => {
      total += ((steps + 1) * (steps + 2)) / 2;
    });
    return total;
  }

  /**
   * Tessellates `meshes` straight into the point buffer at `offset` and returns
   * how many points it wrote. Written in place rather than collected first: a
   * million-point scene is a million short-lived objects otherwise, and the
   * allocation alone stalls the frame that builds it.
   */
  private writeSamples(
    meshes: Mesh[],
    firstObject: number,
    scale: number,
    offset: number,
    budget: number,
  ): number {
    const positions = this.pointPosition.value.array as Float32Array;
    const origin = new Vector3();
    const edge1 = new Vector3();
    const edge2 = new Vector3();
    const p = new Vector3();
    let count = 0;
    const put = (index: number) => {
      const o = (offset + count) * 4;
      positions[o] = p.x;
      positions[o + 1] = p.y;
      positions[o + 2] = p.z;
      positions[o + 3] = index;
      count++;
    };
    this.forEachTriangle(
      meshes,
      firstObject,
      scale,
      (steps, va, vb, vc, index) => {
        if (count >= budget) return;
        origin.copy(va);
        edge1.copy(vb).sub(va);
        edge2.copy(vc).sub(va);
        if (steps === 0) {
          p.copy(origin).addScaledVector(edge1, 1 / 3).addScaledVector(edge2, 1 / 3);
          put(index);
          return;
        }
        for (let i = 0; i <= steps; i++) {
          for (let j = 0; i + j <= steps; j++) {
            p.copy(origin)
              .addScaledVector(edge1, i / steps)
              .addScaledVector(edge2, j / steps);
            put(index);
            if (count >= budget) return;
          }
        }
      },
    );
    // Only the slice that changed: the buffer is tens of megabytes, and a scene
    // spawning projectiles rewrites its dynamic tail every frame.
    this.pointPosition.value.addUpdateRange(offset * 4, count * 4);
    this.pointPosition.value.needsUpdate = true;
    if (count >= budget) {
      console.warn(
        `VoxelScene: point budget (${budget}) exhausted; the tail of the scene is untraced.`,
      );
    }
    return count;
  }

  private forEachTriangle(
    meshes: Mesh[],
    firstObject: number,
    scale: number,
    visit: (
      steps: number,
      a: Vector3,
      b: Vector3,
      c: Vector3,
      objectIndex: number,
    ) => void,
  ): void {
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();

    for (let index = 0; index < meshes.length; index++) {
      const mesh = meshes[index]!;
      const geometry = mesh.geometry as BufferGeometry;
      const position = geometry.getAttribute("position");
      if (!position) continue;
      const indices = geometry.getIndex();
      const triangles = Math.floor((indices ? indices.count : position.count) / 3);
      // The sample pitch is a world-space length, so object-space edges have to
      // be measured through the object's scale.
      const worldScale = mesh.matrixWorld.getMaxScaleOnAxis();

      for (let t = 0; t < triangles; t++) {
        const i0 = indices ? indices.getX(t * 3) : t * 3;
        const i1 = indices ? indices.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = indices ? indices.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(position, i0);
        b.fromBufferAttribute(position, i1);
        c.fromBufferAttribute(position, i2);
        const longest =
          Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) * worldScale;
        const full = Math.ceil(longest / (this.voxelSize * SAMPLE_PITCH));
        // A triangle no longer than one sample pitch is covered by its centroid,
        // and a dense mesh is mostly those: holding the floor at one subdivision
        // would spend three points each and put the budget out of reach of any
        // amount of coarsening.
        const floorSteps = full <= 1 ? 0 : 1;
        const steps = Math.min(
          Math.max(Math.round(full * scale), floorSteps),
          MAX_TRIANGLE_STEPS,
        );
        visit(steps, a, b, c, firstObject + index);
      }
    }
  }
}
