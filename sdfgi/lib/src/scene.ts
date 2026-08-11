import * as THREE from 'three';

/**
 * Godot hands the SDFGI voxelizer its own RenderGeometryInstance list. three.js
 * has no equivalent, so we flatten the scene once into plain WebGPU buffers that
 * both the voxelizer and the GI prepass draw from.
 *
 * ponytail: static snapshot of the geometry. A mesh that only *moves* is handled
 * by syncTransforms(); adding or removing one still needs setScene() again.
 */

/** Draw uniform slot, shared by shaders/voxelize.ts (Draw) and shaders/apply.ts (Draw). */
export const DRAW_STRIDE = 256;

export interface Draw {
  vertices: GPUBuffer;
  indices: GPUBuffer | null;
  count: number;
  slot: number;
  texture: GPUTexture;
  /** the source mesh, so syncTransforms() can re-read its world matrix */
  mesh: THREE.Mesh;
  min: THREE.Vector3;
  max: THREE.Vector3;
}

export interface ExtractedScene {
  draws: Draw[];
  drawBuffer: GPUBuffer;
  /**
   * Re-upload the model and normal matrices of every mesh that has moved since
   * the snapshot, and report whether any had. The G-buffer prepass draws from
   * these, so without it an animated mesh gets its GI painted at the pose it
   * was extracted at -- a ghost of itself, beside where it actually is.
   */
  syncTransforms(): boolean;
  dispose(): void;
}

/** position(3f) normal(3f) uv(2f) */
export const VERTEX_STRIDE = 32;

export const VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' },
  ],
};

function whiteTexture(device: GPUDevice): GPUTexture {
  const tex = device.createTexture({
    label: 'sdfgi white',
    size: [1, 1],
    format: 'rgba8unorm-srgb',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: tex }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);
  return tex;
}

function uploadTexture(device: GPUDevice, tex: THREE.Texture): GPUTexture | null {
  const img = tex.image as ImageBitmap | HTMLImageElement | HTMLCanvasElement | undefined;
  if (!img || !img.width || !img.height) return null;
  const gpu = device.createTexture({
    label: `sdfgi albedo ${tex.name || tex.uuid}`,
    size: [img.width, img.height],
    format: 'rgba8unorm-srgb',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  // ponytail: no mipmaps. Voxelization samples at voxel density, so aliasing is
  // invisible; the prepass can shimmer. Generate mips if that ever shows.
  device.queue.copyExternalImageToTexture(
    { source: img, flipY: tex.flipY },
    { texture: gpu },
    [img.width, img.height],
  );
  return gpu;
}

export function extractScene(device: GPUDevice, scene: THREE.Object3D): ExtractedScene {
  scene.updateMatrixWorld(true);

  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.visible && m.geometry?.attributes.position) meshes.push(m);
  });

  const white = whiteTexture(device);
  const owned: GPUTexture[] = [white];
  const texCache = new Map<string, GPUTexture>();
  const buffers: GPUBuffer[] = [];

  const drawData = new Float32Array((meshes.length * DRAW_STRIDE) / 4);
  const draws: Draw[] = [];

  const normalMatrix = new THREE.Matrix4();
  const box = new THREE.Box3();

  meshes.forEach((mesh, slot) => {
    const g = mesh.geometry;
    if (!g.attributes.normal) g.computeVertexNormals();
    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
    const uv = g.attributes.uv;

    const inter = new Float32Array(pos.count * 8);
    for (let i = 0; i < pos.count; i++) {
      inter[i * 8 + 0] = pos.getX(i);
      inter[i * 8 + 1] = pos.getY(i);
      inter[i * 8 + 2] = pos.getZ(i);
      inter[i * 8 + 3] = nrm.getX(i);
      inter[i * 8 + 4] = nrm.getY(i);
      inter[i * 8 + 5] = nrm.getZ(i);
      inter[i * 8 + 6] = uv ? uv.getX(i) : 0;
      inter[i * 8 + 7] = uv ? uv.getY(i) : 0;
    }
    const vertices = device.createBuffer({
      label: `sdfgi vtx ${mesh.name}`,
      size: inter.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertices, 0, inter);
    buffers.push(vertices);

    let indices: GPUBuffer | null = null;
    let count = pos.count;
    if (g.index) {
      // WebGPU has no uint8 index format; widen everything to uint32.
      const src = g.index.array as ArrayLike<number>;
      const data = new Uint32Array(src.length);
      for (let i = 0; i < src.length; i++) data[i] = src[i];
      indices = device.createBuffer({
        label: `sdfgi idx ${mesh.name}`,
        size: data.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(indices, 0, data);
      buffers.push(indices);
      count = data.length;
    }

    // ponytail: multi-material meshes take material[0]. glTF splits by material
    // already; add a per-group draw loop if a hand-built scene needs it.
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
      THREE.MeshStandardMaterial;

    let texture = white;
    if (mat.map) {
      const hit = texCache.get(mat.map.uuid);
      if (hit) {
        texture = hit;
      } else {
        const up = uploadTexture(device, mat.map);
        if (up) {
          texCache.set(mat.map.uuid, up);
          owned.push(up);
          texture = up;
        }
      }
    }

    normalMatrix.copy(mesh.matrixWorld).invert().transpose();
    const emissive = (mat.emissive ?? new THREE.Color(0, 0, 0)).clone()
      .multiplyScalar(mat.emissiveIntensity ?? 1);

    const o = (slot * DRAW_STRIDE) / 4;
    drawData.set(mesh.matrixWorld.elements, o);
    drawData.set(normalMatrix.elements, o + 16);
    drawData.set([mat.color.r, mat.color.g, mat.color.b, 1], o + 32);
    drawData.set([emissive.r, emissive.g, emissive.b, texture === white ? 0 : 1], o + 36);
    drawData.set([mat.roughness ?? 1, mat.metalness ?? 0, 0, 0], o + 40);

    box.setFromBufferAttribute(pos as THREE.BufferAttribute).applyMatrix4(mesh.matrixWorld);
    draws.push({
      vertices,
      indices,
      count,
      slot,
      texture,
      mesh,
      min: box.min.clone(),
      max: box.max.clone(),
    });
  });

  const drawBuffer = device.createBuffer({
    label: 'sdfgi draws',
    size: Math.max(DRAW_STRIDE, drawData.byteLength),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(drawBuffer, 0, drawData);

  // Float64, so a matrix that has not changed compares equal: three keeps its
  // elements at double precision, and a Float32Array copy would round them and
  // read as moved on every frame.
  const lastMatrix = draws.map((d) => Float64Array.from(d.mesh.matrixWorld.elements));
  // model (16f) then normal_matrix (16f) -- the first 128 bytes of a Draw slot
  const transform = new Float32Array(32);

  return {
    draws,
    drawBuffer,
    syncTransforms() {
      let moved = false;
      for (const d of draws) {
        const e = d.mesh.matrixWorld.elements;
        const last = lastMatrix[d.slot]!;
        let same = true;
        for (let i = 0; i < 16; i++) {
          if (last[i] !== e[i]) {
            same = false;
            break;
          }
        }
        if (same) continue;
        last.set(e);
        moved = true;
        // ponytail: draw.min/max stay at the snapshot pose. They only cull
        // voxelization, and a prop spinning in place stays inside its own box;
        // recompute them here if something ever travels across the level.
        normalMatrix.copy(d.mesh.matrixWorld).invert().transpose();
        transform.set(e, 0);
        transform.set(normalMatrix.elements, 16);
        device.queue.writeBuffer(drawBuffer, d.slot * DRAW_STRIDE, transform);
      }
      return moved;
    },
    dispose() {
      drawBuffer.destroy();
      for (const b of buffers) b.destroy();
      for (const t of owned) t.destroy();
    },
  };
}
