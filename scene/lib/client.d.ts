// `/// <reference types="tscene/client" />` makes `import scene from "./main.tscene"` typecheck.
declare module "*.tscene" {
  import type { SceneModule } from "tscene";
  const scene: SceneModule;
  export default scene;
}
