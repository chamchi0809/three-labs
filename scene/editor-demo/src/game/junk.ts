/**
 * Freeing what the game made.
 *
 * tscene has `disposeScene` for what a sheet built. Everything else on screen — monsters, pickups, tracers,
 * the gun in the corner — was made here, and a Play → Esc → Play loop that does not free it leaks a GPU
 * buffer per monster per attempt. Ten minutes of level design is a lot of attempts.
 */
import type { Material, Object3D } from "three/webgpu";

type Disposable = Object3D & {
  geometry?: { dispose(): void };
  material?: Material | Material[];
};

export function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const it = o as Disposable;
    it.geometry?.dispose();
    for (const material of [it.material].flat()) material?.dispose();
  });
  root.removeFromParent();
}
