// Opt-in: three's whole `three/addons` barrel as a runtime registry.
//
// Same trade as `tscene/three`, one level out. The vite plugin traces every addon a `.tscene` file names
// back to its own module — `import { LoftGeometry } from "three/addons/geometries/LoftGeometry.js"` — so a
// bundled sheet never needs this. A sheet that only exists at runtime cannot be analysed at build time,
// so it needs the barrel, and the barrel is all 270 addon modules:
//
// ```ts
// import { loadSceneFromURL } from "tscene";
// import { threeRegistry } from "tscene/three";
// import { addonRegistry } from "tscene/addons";
//
// const root = await loadSceneFromURL("/scenes/loft.tscene", { registry: { ...threeRegistry, ...addonRegistry } });
// ```
import * as ADDONS from "three/addons";

/** Every `three/addons` export, keyed by name — a `LoadOptions["registry"]` that knows every addon. */
export const addonRegistry: Record<string, any> = ADDONS as unknown as Record<string, any>;
