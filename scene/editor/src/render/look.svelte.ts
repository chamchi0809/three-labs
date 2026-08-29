/**
 * Which of the two looks the viewports are showing.
 *
 * A single boolean's worth of state, in its own file, because everything that reads it is somewhere else:
 * the header draws the switch, the render scene rebuilds the mesh's materials, and the lighting swaps
 * wholesale. A store rather than a prop threaded through four components — the look is a property of the
 * session, not of any one panel.
 *
 * It is deliberately *not* in the document. What a designer is looking at is not part of the level, and a
 * look that undo could change would be an undo that appeared to do nothing.
 */
import type { Look } from "./palette.ts";

const KEY = "broom:look";

const stored = (): Look => {
  try {
    return localStorage.getItem(KEY) === "pbr" ? "pbr" : "classic";
  } catch {
    // a browser with storage denied is still a browser that can edit a level
    return "classic";
  }
};

class LookState {
  #look = $state<Look>(stored());

  get current(): Look {
    return this.#look;
  }

  set current(look: Look) {
    if (look === this.#look) return;
    this.#look = look;
    try {
      localStorage.setItem(KEY, look);
    } catch {
      // nothing to do and nothing worth saying: the look still changed
    }
  }

  get pbr(): boolean {
    return this.#look === "pbr";
  }

  toggle(): void {
    this.current = this.#look === "classic" ? "pbr" : "classic";
  }
}

export const look = new LookState();
