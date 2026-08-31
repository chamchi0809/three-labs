/**
 * Hover-tooltip Svelte action: `use:tooltip={'Label (K)'}`. Renders a bubble in `document.body`
 * (escapes panel `overflow:hidden`), below the target, flipping above when cramped; '' disables.
 * Styling lives in `App.svelte` as `:global(.sv-tooltip)`.
 *
 * Brought over from pixi-vania unchanged. A `title` attribute is the browser's tooltip, which arrives
 * after a second and a half and cannot be styled; a tool bar of fifteen icons needs a label that turns up
 * while the pointer is still moving.
 */
export interface Tip {
  update(text: string, anchor: DOMRect): void;
  hide(): void;
}

/** The bubble itself, anchored to any client rect — for targets that aren't DOM nodes. */
export function showTip(text: string, anchor: DOMRect): Tip {
  const el = document.createElement("div");
  el.className = "sv-tooltip";
  el.textContent = text;
  document.body.appendChild(el);

  function place(a: DOMRect) {
    const t = el.getBoundingClientRect();
    let left = a.left + a.width / 2 - t.width / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - t.width - 4));
    let top = a.bottom + 6;
    if (top + t.height > window.innerHeight - 4) top = a.top - t.height - 6;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }
  place(anchor);

  return {
    update(next, a) {
      if (el.textContent !== next) el.textContent = next;
      place(a);
    },
    hide: () => el.remove(),
  };
}

export function tooltip(node: HTMLElement, text: string) {
  let tip: Tip | null = null;
  let current = text;
  const suppliedLabel = node.hasAttribute("aria-label") || node.hasAttribute("aria-labelledby");
  let actionLabel = false;
  const syncAccessibleName = () => {
    if (suppliedLabel || node.textContent?.trim()) return;
    if (current) {
      node.setAttribute("aria-label", current);
      actionLabel = true;
    } else if (actionLabel) {
      node.removeAttribute("aria-label");
      actionLabel = false;
    }
  };
  syncAccessibleName();

  function show() {
    if (!current || tip) return;
    tip = showTip(current, node.getBoundingClientRect());
  }

  function hide() {
    tip?.hide();
    tip = null;
  }

  node.addEventListener("pointerenter", show);
  node.addEventListener("pointerleave", hide);
  node.addEventListener("pointerdown", hide);

  return {
    update(next: string) {
      current = next;
      syncAccessibleName();
      if (next) tip?.update(next, node.getBoundingClientRect());
      else hide();
    },
    destroy() {
      hide();
      node.removeEventListener("pointerenter", show);
      node.removeEventListener("pointerleave", hide);
      node.removeEventListener("pointerdown", hide);
      if (actionLabel) node.removeAttribute("aria-label");
    },
  };
}
