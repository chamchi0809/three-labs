/**
 * Thin WebGPU helpers. Godot uses Vulkan push constants; WebGPU has none, so
 * every "push constant" becomes a 256-byte slot inside one big uniform buffer
 * plus a cached bind group at group(1). Same semantics, no dynamic offsets
 * needed because the offset is baked into the bind group.
 */

const SLOT = 256; // minUniformBufferOffsetAlignment

/** Cursor-based little-endian struct writer (std430-ish, manual padding). */
export class W {
  o = 0;
  /** offsets passed to seek() are relative to this; lets one W write into a slot */
  base = 0;
  v: DataView;
  constructor(v: DataView) {
    this.v = v;
  }
  u32(x: number): W {
    this.v.setUint32(this.o, x >>> 0, true);
    this.o += 4;
    return this;
  }
  i32(x: number): W {
    this.v.setInt32(this.o, x | 0, true);
    this.o += 4;
    return this;
  }
  f32(x: number): W {
    this.v.setFloat32(this.o, x, true);
    this.o += 4;
    return this;
  }
  b32(x: boolean): W {
    return this.u32(x ? 1 : 0);
  }
  f3(x: number, y: number, z: number): W {
    return this.f32(x).f32(y).f32(z);
  }
  i3(x: number, y: number, z: number): W {
    return this.i32(x).i32(y).i32(z);
  }
  pad(words = 1): W {
    this.o += 4 * words;
    return this;
  }
  seek(byteOffset: number): W {
    this.o = this.base + byteOffset;
    return this;
  }
  /** rebase to an absolute byte offset and seek to it */
  at(base: number): W {
    this.base = base;
    this.o = base;
    return this;
  }
}

export interface Pipelineish {
  getBindGroupLayout(index: number): GPUBindGroupLayout;
}

export class ParamPool {
  private buffer: GPUBuffer;
  /** whole-pool CPU mirror: pushes write here and one flush() uploads the lot */
  private stage: ArrayBuffer;
  private stageU8: Uint8Array;
  private w: W;
  private slot = 0;
  private cache = new WeakMap<object, Map<number, GPUBindGroup>>();

  private device: GPUDevice;
  private slots: number;

  constructor(device: GPUDevice, slots = 512) {
    this.device = device;
    this.slots = slots;
    this.buffer = device.createBuffer({
      label: 'sdfgi params',
      size: SLOT * slots,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.stage = new ArrayBuffer(SLOT * slots);
    this.stageU8 = new Uint8Array(this.stage);
    this.w = new W(new DataView(this.stage));
  }

  /** Call once per recorded frame, before any push(). */
  begin(): void {
    this.slot = 0;
  }

  /** Writes a push-constant block and returns the bind group to set at `group`. */
  push(pipeline: Pipelineish, fill: (w: W) => void, group = 1): GPUBindGroup {
    if (this.slot >= this.slots) throw new Error('sdfgi: param pool exhausted');
    const slot = this.slot++;
    const off = slot * SLOT;
    this.stageU8.fill(0, off, off + SLOT);
    fill(this.w.at(off));

    let byPipeline = this.cache.get(pipeline);
    if (!byPipeline) this.cache.set(pipeline, (byPipeline = new Map()));
    const key = slot * 8 + group;
    let bg = byPipeline.get(key);
    if (!bg) {
      bg = this.device.createBindGroup({
        label: `params ${(pipeline as Partial<GPUObjectBase>).label ?? '?'} @group(${group})`,
        layout: pipeline.getBindGroupLayout(group),
        entries: [
          { binding: 0, resource: { buffer: this.buffer, offset: slot * SLOT, size: SLOT } },
        ],
      });
      byPipeline.set(key, bg);
    }
    return bg;
  }

  /** Upload every slot pushed since begin(). Call once, before queue.submit(). */
  flush(): void {
    if (this.slot === 0) return;
    this.device.queue.writeBuffer(this.buffer, 0, this.stage, 0, this.slot * SLOT);
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

export function computePipeline(
  device: GPUDevice,
  label: string,
  code: string,
): GPUComputePipeline {
  return device.createComputePipeline({
    label,
    layout: 'auto',
    compute: { module: device.createShaderModule({ label, code }) },
  });
}

export function storageBuffer(
  device: GPUDevice,
  label: string,
  size: number,
  extra = 0,
): GPUBuffer {
  return device.createBuffer({
    label,
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | extra,
  });
}

export interface Tex3DDesc {
  label: string;
  format: GPUTextureFormat;
  size: [number, number, number];
  storage?: boolean;
}

export function texture3D(device: GPUDevice, d: Tex3DDesc): GPUTexture {
  return device.createTexture({
    label: d.label,
    dimension: '3d',
    format: d.format,
    size: d.size,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      (d.storage === false ? 0 : GPUTextureUsage.STORAGE_BINDING) |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC,
  });
}

export function texture2DArray(
  device: GPUDevice,
  label: string,
  format: GPUTextureFormat,
  width: number,
  height: number,
  layers: number,
): GPUTexture {
  return device.createTexture({
    label,
    dimension: '2d',
    format,
    size: [width, height, layers],
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC,
  });
}

/**
 * Godot calls RD::texture_clear()/buffer_clear() a lot. WebGPU has no texture
 * clear outside of render passes, so we keep one zero-filled staging buffer and
 * copy it in. ponytail: allocates max(bytes) once and grows; a clear compute
 * shader would be faster but this only runs on cascade (re)builds.
 */
export class Zeroer {
  private buf: GPUBuffer | null = null;
  private size = 0;
  private device: GPUDevice;
  constructor(device: GPUDevice) {
    this.device = device;
  }

  private ensure(bytes: number): GPUBuffer {
    if (this.buf && this.size >= bytes) return this.buf;
    this.buf?.destroy();
    this.size = bytes;
    this.buf = this.device.createBuffer({
      label: 'sdfgi zero staging',
      size: bytes,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    new Uint8Array(this.buf.getMappedRange()).fill(0);
    this.buf.unmap();
    return this.buf;
  }

  clearBuffer(enc: GPUCommandEncoder, dst: GPUBuffer, size: number, offset = 0): void {
    enc.copyBufferToBuffer(this.ensure(size), 0, dst, offset, size);
  }

  clearTexture3D(
    enc: GPUCommandEncoder,
    tex: GPUTexture,
    bytesPerTexel: number,
    origin: GPUOrigin3DDict = {},
    size?: [number, number, number],
  ): void {
    const w = size ? size[0] : tex.width;
    const h = size ? size[1] : tex.height;
    const d = size ? size[2] : tex.depthOrArrayLayers;
    const bytesPerRow = Math.ceil((w * bytesPerTexel) / 256) * 256;
    const src = this.ensure(bytesPerRow * h * d);
    enc.copyBufferToTexture(
      { buffer: src, bytesPerRow, rowsPerImage: h },
      { texture: tex, origin },
      [w, h, d],
    );
  }

  destroy(): void {
    this.buf?.destroy();
  }
}
