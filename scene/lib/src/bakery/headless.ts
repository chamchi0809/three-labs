// Node has no canvas, no navigator.gpu and no animation frames. three's WebGPU backend wants all three.
import * as THREE from "three/webgpu";
import { create, globals } from "webgpu";

let installed = false;

/** Puts Dawn's WebGPU behind `navigator.gpu` and stubs what three's backend touches. Idempotent. */
export function installWebGPU(): void {
  if (installed) return;
  installed = true;

  // GPUBufferUsage & friends are globals in a browser; the binding hands them over separately
  Object.assign(globalThis, globals);

  const g = globalThis as Record<string, unknown>;
  g.navigator ??= {};
  Object.defineProperty(g.navigator, "gpu", { value: create([]), configurable: true });
  g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16);
  g.cancelAnimationFrame ??= (id: number) => clearTimeout(id as unknown as NodeJS.Timeout);
  // three's Animation reads `self`, not `globalThis`, and null-checks it into a hard failure
  g.self ??= globalThis;
}

/** A canvas that exists only so the renderer can ask it for a size. Nothing is ever presented. */
function canvasStub() {
  return {
    width: 1,
    height: 1,
    style: {},
    getContext: () => ({
      configure() {},
      unconfigure() {},
      getCurrentTexture() {
        throw new Error("tscene/bakery: headless renderer has no swapchain");
      },
    }),
    addEventListener() {},
    removeEventListener() {},
  };
}

/** A `WebGPURenderer` that runs compute in Node. Only `computeAsync` / `getArrayBufferAsync` are usable. */
export async function createHeadlessRenderer(): Promise<THREE.WebGPURenderer> {
  installWebGPU();
  const renderer = new THREE.WebGPURenderer({
    canvas: canvasStub() as unknown as HTMLCanvasElement,
    antialias: false,
    requiredLimits: await adapterLimits(),
  });
  await renderer.init();
  return renderer;
}

/**
 * Every limit the adapter will give us. The tracer binds ten storage buffers in one compute stage and
 * the default guarantee is eight, so the defaults are not an option; asking for the lot is one line
 * instead of a list that goes stale.
 */
async function adapterLimits(): Promise<Record<string, number>> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("tscene/bakery: no WebGPU adapter — is there a GPU on this machine?");
  const limits: Record<string, number> = {};
  // GPUSupportedLimits keeps its values in prototype getters, so for-in is the way in
  for (const key in adapter.limits) {
    const value = (adapter.limits as unknown as Record<string, unknown>)[key];
    if (typeof value === "number") limits[key] = value;
  }
  return limits;
}

/** Blocks until every command submitted so far has finished — the throttle between bake batches. */
export async function drain(renderer: THREE.WebGPURenderer): Promise<void> {
  const device = (renderer.backend as unknown as { device?: GPUDevice }).device;
  await device?.queue.onSubmittedWorkDone();
}
