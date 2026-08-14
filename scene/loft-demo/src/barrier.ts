// The rope barrier around the exhibition: brass stanchions, and a twisted cord sagging between them.
//
// The ring is fourteen copies placed by sine and cosine. `repeat(14)` unrolls a body and binds `--index`,
// but `calc()` is + - * / and nothing else, so there is no way to write the angle in a sheet — this is a
// node that comes from the registry instead, and the sheet says `barrier();`.
import { Group, Mesh } from "three/webgpu";
import { LoftGeometry } from "three/addons/geometries/LoftGeometry.js";
import { brassMaterial, ropeMaterial } from "./materials.ts";
import { ropeSections, stanchionSections } from "./sections.ts";

const POSTS = 14;
const RADIUS = 20;

export class Barrier extends Group {
  constructor() {
    super();
    const stanchion = new LoftGeometry(stanchionSections, { capStart: true, capEnd: true });
    // the chord between two posts, so both ends of the cord land inside a pole
    const rope = new LoftGeometry(ropeSections(2 * RADIUS * Math.sin(Math.PI / POSTS)));

    for (let i = 0; i < POSTS; i++) {
      const angle = ((i + 0.5) / POSTS) * Math.PI * 2;
      const post = new Mesh(stanchion, brassMaterial);
      post.position.set(Math.sin(angle) * RADIUS, -5, Math.cos(angle) * RADIUS);
      this.add(post);

      const mid = angle + Math.PI / POSTS;
      const midRadius = RADIUS * Math.cos(Math.PI / POSTS);
      const cord = new Mesh(rope, ropeMaterial);
      cord.position.set(Math.sin(mid) * midRadius, -5 + 2.05, Math.cos(mid) * midRadius);
      cord.rotation.y = mid;
      this.add(cord);

      // the sheet's `.exhibit` template only reaches the nodes the sheet writes
      for (const mesh of [post, cord]) mesh.castShadow = mesh.receiveShadow = true;
    }
  }
}
