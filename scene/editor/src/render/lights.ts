/**
 * What the map is lit by.
 *
 * Two answers, because the two looks are asking two different questions.
 *
 * The classic look asks *what shape is this* — so its light is fixed to the world and exists only to make a
 * wall, a floor and a ceiling read as three different surfaces. It is not the level's lighting and it is not
 * supposed to be; a designer cutting a corridor wants to see the corridor, not the mood.
 *
 * The modern look asks *what will a player see* — so it lights the map with the map's own lights, read out
 * of the document exactly as they are declared. This is where a level designer finds out that the torch
 * they placed is two metres too high, and no amount of an editor's own key light will ever tell them that.
 *
 * A map that declares no lights at all falls back to the editor's rig rather than to black. Black is
 * technically the honest answer and it is a useless one — the usual reason a map has no lights yet is that
 * it is an hour old.
 */
import {
  AmbientLight, Color, DirectionalLight, HemisphereLight, PointLight, SpotLight, type Object3D,
} from "three/webgpu";
import type { Member } from "tscene";
import type { Catalogue } from "../doc/catalogue.ts";
import { defFor } from "../doc/catalogue.ts";
import type { Node, World } from "../doc/document.ts";
import { childrenOf } from "../doc/document.ts";
import { SYNTHETIC, numberOf, valueOf, vec3Of } from "../doc/props.ts";

/**
 * The editor's own lighting, which is not the map's.
 *
 * A sky fill that separates up-facing surfaces from down-facing ones, one key from over the designer's left
 * shoulder, and enough ambient that nothing is ever unreadably dark.
 */
export function editorLights(): Object3D[] {
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(-0.6, 1, 0.45);
  return [new HemisphereLight(0xcfd6e0, 0x2a2c30, 1.1), key, new AmbientLight(0xffffff, 0.35)];
}

/** the node names this file knows how to build, which is every light three ships that a sheet can write */
const KINDS = new Set([
  "ambientLight", "hemisphereLight", "directionalLight", "pointLight", "spotLight",
]);

/**
 * The lights the document declares, as three objects.
 *
 * Hidden subtrees are skipped, because a hidden layer is how a designer works on one floor of a building
 * and a hidden torch that went on lighting the room would make that useless. Lock is *not* skipped: a
 * locked light is one you have finished with, not one you have turned off.
 *
 * A light nothing gave a place to is left where three puts it, rather than moved to the origin. That reads
 * like a distinction without a difference and it is not: a hemisphere light and a directional light take
 * their *direction* from where they are, which is why three starts both of them at `(0, 1, 0)`, and a sky
 * light dragged to the origin has no direction and therefore emits nothing at all.
 */
export function mapLights(world: World, catalogue: Catalogue): Object3D[] {
  const out: Object3D[] = [];
  const descend = (node: Node, at: [number, number, number], placed: boolean) => {
    if (node.broom.hidden === true) return;
    const body = node.kind === "entity" ? props(node, catalogue) : node.props;
    const own = vec3Of(body, "position");
    const here = offset(at, own);
    const put = placed || own !== undefined;
    if (node.kind === "entity") {
      const light = lightOf(node.type, body);
      if (light) {
        if (put) light.position.set(here[0], here[1], here[2]);
        out.push(light);
      }
    }
    for (const kid of childrenOf(node)) descend(kid, here, put);
  };
  for (const layer of world.layers) descend(layer, [0, 0, 0], false);
  return out;
}

const offset = (
  at: [number, number, number],
  by: readonly [number, number, number] | undefined,
): [number, number, number] => (by ? [at[0] + by[0], at[1] + by[1], at[2] + by[2]] : at);

/**
 * A node's properties, with its definition's underneath.
 *
 * `pointLight.torch { position: … }` means everything the `@template` says about a torch plus a place to put
 * it, so a light whose intensity lives on the template has to be read through the template. The instance's
 * own members come first, because {@link valueOf} takes the first it finds and the instance is the one that
 * has overridden anything.
 */
function props(node: Extract<Node, { kind: "entity" }>, catalogue: Catalogue): Member[] {
  const def = defFor(catalogue, node);
  if (!def) return node.props;
  const inherited = def.props
    .filter((p) => p.value !== undefined && !node.props.some((m) => m.kind === "prop" && m.name === p.name))
    .map((p): Member => ({ ...SYNTHETIC, kind: "prop", name: p.name, value: p.value! }));
  return [...node.props, ...inherited];
}

/** the light one declaration is, or nothing if the declaration is not a light at all */
function lightOf(type: string, body: Member[]): Object3D | undefined {
  if (!KINDS.has(type)) return undefined;
  const tint = colourOf(body, "color") ?? 0xffffff;
  // three's own default, and the one a sheet that says nothing is asking for
  const power = numberOf(body, "intensity") ?? 1;

  switch (type) {
    case "ambientLight":
      return new AmbientLight(tint, power);
    case "hemisphereLight":
      return new HemisphereLight(tint, colourOf(body, "groundColor") ?? 0x000000, power);
    case "directionalLight": {
      const light = new DirectionalLight(tint, power);
      aim(light.target, body);
      return light;
    }
    case "pointLight": {
      const light = new PointLight(tint, power, numberOf(body, "distance") ?? 0, numberOf(body, "decay") ?? 2);
      return light;
    }
    default: {
      const light = new SpotLight(
        tint, power,
        numberOf(body, "distance") ?? 0,
        numberOf(body, "angle") ?? Math.PI / 3,
        numberOf(body, "penumbra") ?? 0,
        numberOf(body, "decay") ?? 2,
      );
      aim(light.target, body);
      return light;
    }
  }
}

/**
 * Where a directional or spot light points.
 *
 * `target: ref(#thing)` is the ordinary way a sheet writes it and it cannot be followed here — the target
 * is another node, and resolving one node's position from inside another's construction is the runtime's
 * job. A literal `[x, y, z]` is honoured; anything else leaves the target at the origin, which is where
 * three puts it and is at least a direction rather than a guess.
 */
function aim(target: Object3D, body: Member[]): void {
  const at = vec3Of(body, "target");
  if (at) target.position.set(at[0], at[1], at[2]);
}

/** a colour a sheet wrote as a literal — `#ffddaa`, a bare number, or a name three's `Color` knows */
function colourOf(body: Member[], name: string): number | undefined {
  const v = valueOf(body, name);
  if (v?.kind === "hex" || v?.kind === "number") return v.value;
  if (v?.kind === "string" || v?.kind === "ident") {
    const text = v.kind === "string" ? v.value : v.name;
    try {
      return new Color(text).getHex();
    } catch {
      return undefined;
    }
  }
  return undefined;
}
