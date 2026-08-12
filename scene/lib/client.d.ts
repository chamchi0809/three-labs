// `/// <reference types="three-scene/client" />` makes `import scene from "./main.tscene"` typecheck.
declare module "*.tscene" {
  import type { SceneModule } from "three-scene";
  const scene: SceneModule;
  export default scene;
}
