// three-mesh-bvh 0.9.14 ships types for BVHComputeData only, but `three-mesh-bvh/webgpu` re-exports
// the WGSL structs and the tagged-template helper too. This declares the parts the tracer uses.
// Delete once upstream's index.d.ts covers them — the API is documented as unstable.
import "three-mesh-bvh/webgpu";

declare module "three-mesh-bvh/webgpu" {
  /** What `wgslTagFn` returns: a TSL function node, callable and interpolatable into another tag. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type TslFn = (...args: unknown[]) => any;

  export const wgslTagFn: (tokens: TemplateStringsArray, ...args: unknown[]) => TslFn;
  export const rayStruct: unknown;
  export const rayIntersectionResultStruct: unknown;

  export interface BVHComputeData {
    /** frees every storage buffer the BVH uploaded */
    dispose(): void;
  }
}
