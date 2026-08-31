// The map's own lights: that a declaration becomes the light it says it is, that a template's numbers reach
// an instance that never repeated them, and that where a light *is* survives being inside a group.
// Run with: node --experimental-strip-types src/render/lights.check.ts
import assert from "node:assert/strict";
import {
  AmbientLight, DirectionalLight, HemisphereLight, PointLight, SpotLight, type Object3D,
} from "three/webgpu";
import { report, test } from "../check.ts";
import { EMPTY, type Catalogue } from "../doc/catalogue.ts";
import { demoCatalogue, demoMap } from "../doc/demo.ts";
import { objectNode, groupNode, layerNode, type Node, type World } from "../doc/document.ts";
import { newEditor } from "../doc/editor.ts";
import { hex, num, setProp, setVec3, str } from "../doc/props.ts";
import { editorLights, mapLights } from "./lights.ts";
import { newRenderScene, syncLook } from "./scene.ts";

// a render scene rasterises label text, and node has no canvas; nothing here looks at one
(globalThis as { document?: unknown }).document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({
      font: "", textBaseline: "", fillStyle: "",
      measureText: (text: string) => ({ width: text.length * 7 }),
      beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, fillText() {},
    }),
  }),
};

const worldOf = (children: Node[]): World => ({
  layers: [layerNode("Default", children)],
  broom: { grid: -2, scale: 1 },
});

const lit = (children: Node[], catalogue: Catalogue = EMPTY): Object3D[] =>
  mapLights(worldOf(children), catalogue);

const place = (at: [number, number, number]) => setVec3([], "position", at);

test("the editor's own rig is three lights and does not depend on the document", () => {
  assert.equal(editorLights().length, 3);
});

// ---------------------------------------------------------------- one declaration at a time

test("a point light is built with the numbers it wrote, and three's defaults for the rest", () => {
  let props = place([1, 2, 3]);
  props = setProp(props, "color", hex(0xff8800));
  props = setProp(props, "intensity", num(7));
  props = setProp(props, "distance", num(9));
  const [light] = lit([objectNode("pointLight", { props })]);
  assert.ok(light instanceof PointLight);
  assert.deepEqual(light.position.toArray(), [1, 2, 3]);
  assert.equal(light.color.getHex(), 0xff8800);
  assert.equal(light.intensity, 7);
  assert.equal(light.distance, 9);
  assert.equal(light.decay, 2, "three's own default, and what a sheet saying nothing is asking for");
});

test("a hemisphere light takes a ground colour, and black is the one it gets if it wrote none", () => {
  const [a] = lit([objectNode("hemisphereLight", { props: setProp([], "groundColor", hex(0x203040)) })]);
  assert.ok(a instanceof HemisphereLight);
  assert.equal(a.groundColor.getHex(), 0x203040);

  const [b] = lit([objectNode("hemisphereLight")]);
  assert.equal((b as HemisphereLight).groundColor.getHex(), 0x000000);
});

test("a colour can be a name as well as a hex, because a sheet is entitled to write one", () => {
  const [light] = lit([objectNode("ambientLight", { props: setProp([], "color", str("tomato")) })]);
  assert.ok(light instanceof AmbientLight);
  assert.equal(light.color.getHex(), 0xff6347);
});

test("a spot light aims at a literal place, and at the origin when it names a node instead", () => {
  const [aimed] = lit([objectNode("spotLight", { props: setVec3([], "target", [0, -1, 4]) })]);
  assert.ok(aimed instanceof SpotLight);
  assert.deepEqual(aimed.target.position.toArray(), [0, -1, 4]);

  // `target: ref(#thing)` is the ordinary way to write it, and resolving it is the runtime's job
  const [guessed] = lit([objectNode("directionalLight", { props: setProp([], "target", str("#lamp")) })]);
  assert.deepEqual((guessed as DirectionalLight).target.position.toArray(), [0, 0, 0]);
});

test("anything that is not a light is not one, however it is dressed", () => {
  assert.deepEqual(lit([objectNode("mesh", { props: place([0, 1, 0]) })]), []);
  assert.deepEqual(lit([objectNode("perspectiveCamera")]), []);
});

// ---------------------------------------------------------------- where it is, and whether it counts

test("a light inside a group is where the group put it", () => {
  const light = objectNode("pointLight", { props: place([0, 1, 0]) });
  const inner = groupNode("lamp", [light], { props: place([0, 0, 2]) });
  const outer = groupNode("room", [inner], { props: place([10, 0, 0]) });
  assert.deepEqual(lit([outer])[0]!.position.toArray(), [10, 1, 2]);
});

test("a light nobody placed keeps three's own place, because that place is a direction", () => {
  // a hemisphere light at the origin has no up and emits nothing; three starts one at (0, 1, 0) for that
  // reason, and a document that says nothing about where the sky is is not asking for it to be moved
  const [sky] = lit([objectNode("hemisphereLight")]);
  assert.deepEqual(sky!.position.toArray(), [0, 1, 0]);
  const [sun] = lit([objectNode("directionalLight")]);
  assert.deepEqual(sun!.position.toArray(), [0, 1, 0]);

  const [placed] = lit([objectNode("hemisphereLight", { props: place([0, 0, 0]) })]);
  assert.deepEqual(placed!.position.toArray(), [0, 0, 0], "but a place written down is honoured");
});

test("a group with a place puts the lights inside it there, even the ones with none of their own", () => {
  const inside = groupNode("rig", [objectNode("hemisphereLight")], { props: place([0, 5, 0]) });
  assert.deepEqual(lit([inside])[0]!.position.toArray(), [0, 5, 0]);
});

test("a hidden subtree is not lit, because hiding a floor is how you work on the one below it", () => {
  const light = objectNode("pointLight");
  assert.equal(lit([groupNode("upstairs", [light], { broom: { hidden: true } })]).length, 0);
  assert.equal(lit([objectNode("pointLight", { broom: { hidden: true } })]).length, 0);
});

test("a locked light still lights: locked is finished with, not turned off", () => {
  assert.equal(lit([objectNode("pointLight", { broom: { locked: true } })]).length, 1);
});

// ---------------------------------------------------------------- through a template

test("an instance is lit by its template's numbers, which it never had to repeat", () => {
  const node = objectNode("pointLight", { classes: ["lamp"], props: place([0, 3, 0]) });
  const [light] = lit([node], demoCatalogue());
  assert.ok(light instanceof PointLight);
  assert.equal(light.color.getHex(), 0xffddaa, "the @template's colour");
  assert.equal(light.intensity, 12);
  assert.equal(light.distance, 9);
  assert.deepEqual(light.position.toArray(), [0, 3, 0], "and its own place");
});

test("what the instance writes wins over what the template says", () => {
  const node = objectNode("pointLight", { classes: ["lamp"], props: setProp([], "intensity", num(2)) });
  assert.equal((lit([node], demoCatalogue())[0] as PointLight).intensity, 2);
});

test("the demo room lights itself, which is the whole claim the modern look makes", () => {
  const lights = mapLights(demoMap(), demoCatalogue());
  assert.equal(lights.length, 3, "a sky fill, a sun and a lamp");
  assert.ok(lights.some((l) => l instanceof HemisphereLight));
  assert.ok(lights.some((l) => l instanceof PointLight));
  const sun = lights.find((l) => l instanceof DirectionalLight)!;
  assert.ok(sun.position.length() > 1, "and the sun is out where a direction can be read off it");
});

// ---------------------------------------------------------------- and how often they are installed

// Installing a light is what recompiles every shader in the map, and an edit hands `syncLook` a brand new
// `World` object every time — so "has the world changed" is the wrong question and these pin the right one.

/** what is actually in the light group, by identity — which is the thing that must not churn */
const rig = (rs: ReturnType<typeof newRenderScene>): Object3D[] => [...rs.lights.children];

const lamp = (at: [number, number, number]) =>
  worldOf([objectNode("pointLight", { props: place(at) })]);

test("the same lights declared by a different world object are the same rig", () => {
  const rs = newRenderScene();
  syncLook(rs, newEditor(lamp([0, 2, 0])), EMPTY, "pbr");
  const first = rig(rs);
  assert.equal(first.length, 1);

  syncLook(rs, newEditor(lamp([0, 2, 0])), EMPTY, "pbr");
  assert.deepEqual(rig(rs), first, "an edit hands over a new world every frame; the lamp did not move");
});

test("a lamp that did move relights, so the guard is on the lights and not on the clock", () => {
  const rs = newRenderScene();
  syncLook(rs, newEditor(lamp([0, 2, 0])), EMPTY, "pbr");
  const first = rig(rs);

  syncLook(rs, newEditor(lamp([3, 2, 0])), EMPTY, "pbr");
  assert.notDeepEqual(rig(rs), first);
  assert.deepEqual((rs.lights.children[0] as PointLight).position.toArray(), [3, 2, 0]);
});

test("switching look relights even when the map did not change", () => {
  const rs = newRenderScene();
  syncLook(rs, newEditor(lamp([0, 2, 0])), EMPTY, "pbr");
  syncLook(rs, newEditor(lamp([0, 2, 0])), EMPTY, "classic");
  assert.equal(rig(rs).filter((l) => "isLight" in l).length, 3, "the editor's own rig");
  assert.ok(rig(rs).every((l) => !(l instanceof PointLight)), "and no lamp from the map");
});

report("lights");
