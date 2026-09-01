/**
 * The head-up display.
 *
 * Everything the player has to know without looking away from the crosshair: health, what is in the gun,
 * how many monsters are left, and — the two that matter for a demo mounted next to an editor — what the
 * keys are and how to get back out.
 *
 * It is DOM. The whole thing rebuilt from scratch every frame would still be cheap, but it is not: `set()`
 * compares against what it wrote last time and touches nothing that did not change, so the browser is not
 * doing layout sixty times a second for a number that reads 100 either way.
 */
import "./hud.css";
import { SLOTS, WEAPONS, type WeaponId } from "./weapons.ts";
import type { Player } from "./player.ts";

export type HudState = {
  health: number;
  ammo: { shells: number; cells: number };
  weapon: WeaponId;
  /** monsters down, and how many there were to begin with */
  kills: number;
  monsters: number;
};

/** what the last hit marker and the last damage flash have left to run, in seconds */
const MARKER = 0.12;
const FLASH = 0.09;

export class Hud {
  readonly #root = document.createElement("div");
  readonly #cross = el("div", "cross");
  readonly #damage = el("div", "damage");
  readonly #kills = el("span", "");
  readonly #health = el("b", "");
  readonly #healthBox = el("div", "stat");
  readonly #guns = new Map<WeaponId, { chip: HTMLElement; count: HTMLElement }>();
  readonly #banner = el("div", "banner");
  readonly #title = el("h1", "");
  readonly #note = el("p", "");

  #marker = 0;
  #flash = 0;
  /** the last state written to the DOM, so that a frame that changed nothing writes nothing */
  #was = "";

  constructor(host: HTMLElement) {
    this.#root.className = "hud";

    for (let i = 0; i < 4; i++) this.#cross.append(document.createElement("i"));
    this.#root.append(this.#cross, this.#damage);

    const top = el("div", "top");
    top.append(span("dim", "left "), this.#kills);
    this.#root.append(top);

    const hint = el("div", "hint");
    hint.innerHTML =
      "<kbd>WASD</kbd> move &nbsp; <kbd>shift</kbd> run &nbsp; <kbd>space</kbd> jump<br>" +
      "<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> guns &nbsp; <kbd>click</kbd> fire &nbsp; <kbd>R</kbd> restart<br>" +
      "<kbd>Esc</kbd> back to the editor";
    this.#root.append(hint);

    this.#healthBox.append(this.#health, el("small", "", "health"));
    const guns = el("div", "guns");
    for (const id of SLOTS) {
      const chip = el("div", "gun");
      const count = el("b", "");
      chip.append(span("key", String(WEAPONS[id].slot)), document.createTextNode(WEAPONS[id].name), count);
      guns.append(chip);
      this.#guns.set(id, { chip, count });
    }

    const bottom = el("div", "bottom");
    bottom.append(this.#healthBox, guns);
    this.#root.append(bottom);

    this.#banner.append(this.#title, this.#note);
    this.#root.append(this.#banner);

    host.append(this.#root);
  }

  set(state: HudState): void {
    // one string is the whole comparison: cheaper than six, and impossible to forget a field in
    const key = `${state.health}|${state.ammo.shells}|${state.ammo.cells}|${state.weapon}|${state.kills}`;
    if (key === this.#was) return;
    this.#was = key;

    this.#health.textContent = String(Math.max(0, Math.ceil(state.health)));
    this.#healthBox.classList.toggle("low", state.health <= 30);
    this.#kills.textContent = `${state.monsters - state.kills} of ${state.monsters}`;

    for (const [id, { chip, count }] of this.#guns) {
      const ammo = WEAPONS[id].ammo;
      const rounds = ammo ? state.ammo[ammo] : undefined;
      count.textContent = rounds === undefined ? "∞" : String(rounds);
      chip.classList.toggle("on", id === state.weapon);
      chip.classList.toggle("out", rounds === 0);
    }
  }

  /** a shot connected: the crosshair says so, because a tracer into a dark room does not */
  hit(): void {
    this.#marker = MARKER;
    this.#cross.classList.add("hit");
  }

  /** the player took one */
  damage(): void {
    this.#flash = FLASH;
    this.#damage.classList.add("on");
  }

  banner(title: string, note: string, tone: "win" | "lose" | "hold"): void {
    this.#title.textContent = title;
    this.#note.textContent = note;
    this.#banner.className = `banner on ${tone}`;
  }

  clearBanner(): void {
    this.#banner.className = "banner";
  }

  /** frame time: the timers here are all decoration */
  step(dt: number): void {
    if (this.#marker > 0 && (this.#marker -= dt) <= 0) this.#cross.classList.remove("hit");
    if (this.#flash > 0 && (this.#flash -= dt) <= 0) this.#damage.classList.remove("on");
  }

  dispose(): void {
    this.#root.remove();
  }
}

/** the state the HUD wants, read off the player and the tally — kept here so the game loop stays about the game */
export function hudState(player: Player, kills: number, monsters: number): HudState {
  return {
    health: player.health,
    ammo: { shells: player.ammo.shells, cells: player.ammo.cells },
    weapon: player.weapon,
    kills,
    monsters,
  };
}

function el(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function span(className: string, text: string): HTMLElement {
  return el("span", className, text);
}
