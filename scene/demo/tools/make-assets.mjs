// Builds the demo's binary assets so the repo stays free of downloaded blobs:
//   assets/robot.glb     — named nodes (Body, Head, Eye) + an "Idle" animation clip, for gltf()/find()/play()
//   assets/checker.png   — an 8x8 checker, for texture()
// node tools/make-assets.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

// GLTFExporter's binary path reads a Blob through FileReader, which node has no global for
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend();
    });
  }
};

const out = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "assets");
fs.mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------- robot.glb

const mesh = (name, geometry, color, y) => {
  const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
  m.name = name;
  m.position.y = y;
  return m;
};

const robot = new THREE.Group();
robot.name = "Robot";
const body = mesh("Body", new THREE.BoxGeometry(0.7, 1, 0.45), 0x8a95a5, 0.5);
const head = mesh("Head", new THREE.BoxGeometry(0.5, 0.45, 0.45), 0xd7dee8, 1.25);
const eye = mesh("Eye", new THREE.SphereGeometry(0.07, 16, 8), 0xff5533, 0);
eye.position.set(0, 0.05, 0.24);
head.add(eye);
robot.add(body, head);

// two clips so play("…") has something to choose between
const spin = [];
for (let i = 0; i <= 8; i++) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i / 8) * Math.PI * 2);
  spin.push(q.x, q.y, q.z, q.w);
}
const idle = new THREE.AnimationClip("Idle", 2, [
  new THREE.QuaternionKeyframeTrack("Head.quaternion", [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], spin),
  new THREE.VectorKeyframeTrack("Body.position", [0, 1, 2], [0, 0.5, 0, 0, 0.62, 0, 0, 0.5, 0]),
]);
const wave = new THREE.AnimationClip("Wave", 1, [
  new THREE.VectorKeyframeTrack("Head.position", [0, 0.5, 1], [0, 1.25, 0, 0.18, 1.25, 0, 0, 1.25, 0]),
]);

const glb = await new GLTFExporter().parseAsync(robot, { binary: true, animations: [idle, wave] });
fs.writeFileSync(path.join(out, "robot.glb"), Buffer.from(glb));

// ---------------------------------------------------------------- checker.png

const SIZE = 8;
const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = [0]; // filter byte: none
  for (let x = 0; x < SIZE; x++) row.push(...((x + y) % 2 ? [0x30, 0x36, 0x40] : [0xe8, 0xec, 0xf2]));
  rows.push(Buffer.from(row));
}
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour
fs.writeFileSync(
  path.join(out, "checker.png"),
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);

console.log(`wrote ${fs.readdirSync(out).join(", ")} to ${out}`);
