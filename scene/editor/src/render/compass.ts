/**
 * Which way is up, and which way is north.
 *
 * A brush editor without a compass is one where a designer builds a room, orbits twice, and puts the door
 * in the ceiling. TrenchBroom draws one in the corner of every viewport and it is not decoration — with
 * four viewports showing four projections of the same room, the compass is what tells you which one you
 * are looking at.
 *
 * It lives in its own tiny scene with its own camera, drawn after the map with the depth buffer cleared,
 * so it is always legible and never intersects the geometry. The 3D form turns with the camera; the 2D
 * form, for the orthographic views, drops the axis pointing at the viewer and shows the two that are left
 * as a cross — because in a top-down view "which way is Y" is a question with no useful answer.
 */
import {
  BufferAttribute, BufferGeometry, ConeGeometry, Group, LineSegments, Mesh, MeshBasicNodeMaterial,
  OrthographicCamera, Quaternion, Scene, Vector3, type Camera, type Object3D,
} from "three/webgpu";
import { LineBasicNodeMaterial } from "three/webgpu";
import { color } from "three/tsl";
import { COLOURS } from "./materials.ts";
import { layoutLabels, newLabels, setLabel, type Labels } from "./text.ts";

/** the compass is drawn in a box this many world units across; the camera below is sized to match */
const REACH = 1;
const HEAD = 0.18;
/**
 * How much of the dial's height one axis letter takes.
 *
 * A fraction rather than a pixel count, because the dial is between 44 and 96 pixels depending on how the
 * viewports are split, and a letter fixed in pixels either vanishes in the big dial or fills the small one.
 * The camera box below is then solved for it: the letter's centre sits at `REACH + HEAD * 1.6` and it needs
 * half its own height above that, which under an orthographic camera is `LETTER * half` — so
 * `half = centre / (1 - LETTER)`, and anything less clips the tops off the letters.
 */
const LETTER = 0.2;
const LETTER_AT = REACH + HEAD * 1.6;
const BOX = LETTER_AT / (1 - LETTER);

export type Compass = {
  scene: Scene;
  camera: OrthographicCamera;
  /** everything that turns with the view */
  dial: Group;
  labels: Labels;
  arms: { axis: 0 | 1 | 2; sign: 1 | -1; object: Object3D }[];
};

const AXES = [
  { axis: 0 as const, letter: "X", colour: COLOURS.axisX, dir: new Vector3(1, 0, 0) },
  { axis: 1 as const, letter: "Y", colour: COLOURS.axisY, dir: new Vector3(0, 1, 0) },
  { axis: 2 as const, letter: "Z", colour: COLOURS.axisZ, dir: new Vector3(0, 0, 1) },
];

export function newCompass(): Compass {
  const scene = new Scene();
  const dial = new Group();
  scene.add(dial);

  // a box exactly big enough for the longest arm plus its letter, so the compass fills its corner
  const camera = new OrthographicCamera(-BOX, BOX, BOX, -BOX, -10, 10);
  camera.position.set(0, 0, 5);

  const arms: Compass["arms"] = [];
  for (const { axis, colour, dir } of AXES) {
    for (const sign of [1, -1] as const) {
      const end = dir.clone().multiplyScalar(REACH * sign);
      const arm = new Group();

      const line = new LineSegments(
        segment(new Vector3(), end),
        lineMaterial(sign > 0 ? colour : dim(colour)),
      );
      arm.add(line);

      // only the positive end gets a head and a letter: two arrowheads on one axis reads as two axes
      if (sign > 0) {
        const head = new Mesh(new ConeGeometry(HEAD * 0.45, HEAD, 12), basic(colour));
        head.position.copy(end);
        head.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir);
        arm.add(head);
      }

      dial.add(arm);
      arms.push({ axis, sign, object: arm });
    }
  }

  const labels = newLabels(scene);
  for (const { letter, dir } of AXES) {
    const at = dir.clone().multiplyScalar(LETTER_AT);
    // the size is set per frame in `updateCompass`, once the dial's own size is known
    setLabel(labels, letter, letter, [at.x, at.y, at.z], { background: "rgba(0,0,0,0)" });
  }

  return { scene, camera, dial, labels, arms };
}

/**
 * The compass turned to match the viewport it belongs to.
 *
 * The dial takes the *inverse* of the camera's rotation: the camera turns around the world, so the world
 * has to turn the other way to stay put under it. `mode` hides what would be a dot rather than an arrow —
 * an axis pointing straight at the viewer is a pixel, and a pixel labelled "Y" is worse than nothing.
 */
export function updateCompass(compass: Compass, camera: Camera, size = 96): void {
  const rotation = new Quaternion();
  camera.getWorldQuaternion(rotation);
  compass.dial.quaternion.copy(rotation.invert());

  const forward = new Vector3(0, 0, -1).applyQuaternion(rotation.invert());
  for (const arm of compass.arms) {
    const along = Math.abs(forward.getComponent(arm.axis));
    // fully hidden past 0.97, which is about fifteen degrees of an axis-aligned view
    arm.object.visible = along < 0.97;
  }
  for (const { letter, axis } of AXES.map((a) => ({ letter: a.letter, axis: a.axis }))) {
    const label = compass.labels.live.get(letter);
    if (!label) continue;
    label.sprite.visible = Math.abs(forward.getComponent(axis)) < 0.97;
    label.pixels = size * LETTER;
  }

  // the letters sit in the compass's own scene, so they are laid out against the compass's own camera
  layoutLabels(compass.labels, compass.camera, size);
}

// ---------------------------------------------------------------- odds and ends

const segment = (from: Vector3, to: Vector3): BufferGeometry => {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([from.x, from.y, from.z, to.x, to.y, to.z]), 3),
  );
  return geometry;
};

const lineMaterial = (hex: number) => {
  const material = new LineBasicNodeMaterial({ toneMapped: false, depthTest: false });
  material.colorNode = color(hex);
  return material;
};

const basic = (hex: number) => {
  const material = new MeshBasicNodeMaterial({ toneMapped: false, depthTest: false });
  material.colorNode = color(hex);
  return material;
};

/** the negative half of an axis, drawn but muted — it says "this line continues" and nothing more */
const dim = (hex: number): number => {
  const [r, g, b] = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((c) => Math.round(c * 0.35 + 20));
  return (r! << 16) | (g! << 8) | b!;
};
