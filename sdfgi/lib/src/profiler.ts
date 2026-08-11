/**
 * GPU timing for the SDFGI passes, via WebGPU timestamp queries.
 *
 * Every pass writes a begin/end pair into one query set; after submit the set is
 * resolved into a readback buffer and mapped. Readback lags the frame by however
 * long mapAsync takes, which is fine for a HUD but not for frame pacing.
 *
 * ponytail: one label per pass, and a pass called twice in a frame overwrites
 * its own slot rather than summing. Sum in `read()` if a pass ever needs it.
 *
 * The pass that writes to the swapchain reads far too high: its begin timestamp
 * lands before the GPU blocks on image acquire, so it swallows the present
 * stall. Compare passes against each other, not against the frame time.
 */
export class Profiler {
  enabled = false;
  /** last resolved GPU time per pass, in milliseconds */
  readonly ms: Record<string, number> = {};

  private device: GPUDevice;
  private querySet: GPUQuerySet | null = null;
  private resolve: GPUBuffer | null = null;
  private readback: GPUBuffer[] = [];
  private labels: string[] = [];
  private slots = new Map<string, number>();
  private capacity: number;

  constructor(device: GPUDevice, capacity = 16) {
    this.device = device;
    this.capacity = capacity;
    if (!device.features.has('timestamp-query')) return;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: capacity * 2 });
    this.resolve = device.createBuffer({
      label: 'sdfgi query resolve',
      size: capacity * 2 * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
  }

  get available(): boolean {
    return this.querySet !== null;
  }

  /** spread into a beginRenderPass/beginComputePass descriptor */
  pass(label: string): { timestampWrites?: GPUComputePassTimestampWrites } {
    if (!this.enabled || !this.querySet) return {};
    let slot = this.slots.get(label);
    if (slot === undefined) {
      if (this.slots.size >= this.capacity) return {};
      slot = this.slots.size;
      this.slots.set(label, slot);
      this.labels[slot] = label;
    }
    return {
      timestampWrites: {
        querySet: this.querySet,
        beginningOfPassWriteIndex: slot * 2,
        endOfPassWriteIndex: slot * 2 + 1,
      },
    };
  }

  /** call after every pass has been encoded, before submit */
  finish(enc: GPUCommandEncoder): void {
    if (!this.enabled || !this.querySet || !this.resolve || this.slots.size === 0) return;
    const n = this.slots.size * 2;
    const buf =
      this.readback.pop() ??
      this.device.createBuffer({
        label: 'sdfgi query readback',
        size: this.capacity * 2 * 8,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    enc.resolveQuerySet(this.querySet, 0, n, this.resolve, 0);
    enc.copyBufferToBuffer(this.resolve, 0, buf, 0, n * 8);
    // read on the next tick; the buffer goes back in the pool when it lands
    queueMicrotask(() => {
      buf
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const t = new BigUint64Array(buf.getMappedRange().slice(0));
          buf.unmap();
          for (const [label, slot] of this.slots) {
            const dt = Number(t[slot * 2 + 1] - t[slot * 2]) / 1e6;
            // timestamps can come back zeroed while a pass is still warming up
            if (dt > 0) this.ms[label] = dt;
          }
          this.readback.push(buf);
        })
        .catch(() => {}); // destroyed device / lost buffer: drop the sample
    });
  }

  dispose(): void {
    this.querySet?.destroy();
    this.resolve?.destroy();
    for (const b of this.readback) b.destroy();
    this.readback.length = 0;
  }
}
