<script lang="ts">
  /**
   * A modal dialog: a scrim, a titled panel, a scrolling body — pixi-vania's `Dialog`, with the one thing
   * three-broom's sheets already had kept on it: `say`, the line of grey text along the top where a dialog
   * says what it is waiting for.
   *
   * Shared because the keymap, the preferences and the bake panel are the same shape of thing — a list of
   * settings you open, change, and close — and three copies of a dialog is three dialogs that drift apart.
   *
   * Everything outside the dialog goes `inert` while it is up, so tab never wanders into the viewport
   * behind it; the branch that *contains* the dialog is exempt, since a dialog opened from a tool bar is a
   * child of that tool bar.
   */
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import IconX from "@tabler/icons-svelte/icons/x";
  import { tooltip } from "./tooltip.ts";

  type Props = {
    title: string;
    /** the line of grey text along the top, which is where a dialog says what it is waiting for */
    say?: string;
    width?: number;
    onclose: () => void;
    actions?: Snippet;
    footer?: Snippet;
    children: Snippet;
  };

  const { title, say = "", width = 640, onclose, actions, footer, children }: Props = $props();

  let dialogEl = $state<HTMLDivElement>();
  const titleId = `broom-dialog-${nextDialogId()}`;

  const focusable = () =>
    [
      ...(dialogEl?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ].filter((element) => !element.hidden && element.getClientRects().length > 0);

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    } else if (e.key === "Tab") {
      const items = focusable();
      if (!items.length) return e.preventDefault();
      const first = items[0]!;
      const last = items.at(-1)!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // Svelte transitions are JS-driven, so the CSS reduced-motion override can't reach them.
  const ms = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160;

  onMount(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closest = dialogEl?.closest(".shell");
    const root = closest instanceof HTMLElement ? closest : null;
    const overlay = dialogEl?.parentElement;
    const inerted: HTMLElement[] = [];
    // "does not contain the dialog" rather than "is not the overlay": a dialog opened from a button lives
    // inside whatever drew the button, which in this editor is the tool bar
    for (const child of root?.children ?? []) {
      if (child instanceof HTMLElement && !child.inert && overlay && !child.contains(overlay)) {
        child.inert = true;
        inerted.push(child);
      }
    }
    queueMicrotask(() => (focusable()[0] ?? dialogEl)?.focus());
    return () => {
      for (const child of inerted) child.inert = false;
      queueMicrotask(() => previous?.isConnected && previous.focus());
    };
  });
</script>

<svelte:window {onkeydown} />

<div
  class="overlay"
  role="presentation"
  transition:fade={{ duration: ms, easing: cubicOut }}
  onpointerdown={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    bind:this={dialogEl}
    class="dialog"
    style="width:{width}px"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
    transition:scale={{ duration: ms, start: 0.96, opacity: 0, easing: cubicOut }}
  >
    <header>
      <span class="title" id={titleId}>{title}</span>
      <span class="say">{say}</span>
      {@render actions?.()}
      <button class="x" aria-label="Close {title}" use:tooltip={"Close (Esc)"} onclick={onclose}>
        <IconX size={16} />
      </button>
    </header>
    <div class="body">{@render children()}</div>
    {#if footer}
      <footer>{@render footer()}</footer>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: grid;
    place-items: center;
    z-index: 10000;
  }
  .dialog {
    max-width: 92vw;
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
    font: var(--ui);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--panel-2);
    border-bottom: 1px solid var(--border);
    border-radius: 8px 8px 0 0;
  }
  .title {
    font-weight: 700;
    letter-spacing: 0.03em;
    color: var(--p9);
  }
  .say {
    margin-right: auto;
    color: var(--muted);
  }
  .x {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    display: grid;
    place-items: center;
    padding: 0;
  }
  .x:hover {
    color: var(--p9);
  }
  .body {
    overflow: auto;
    padding: 6px 0 10px;
    min-height: 0;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--border);
  }

  /* every button a dialog passes into its header, so the row matches across dialogs */
  header :global(.plain) {
    height: 22px;
    padding: 0 9px;
    cursor: pointer;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 5px;
    font: inherit;
    font-weight: 600;
    color: var(--text);
  }
  header :global(.plain:hover:not(:disabled)) {
    background: var(--accent-dim);
    color: var(--p9);
  }
  header :global(.plain:disabled) {
    opacity: 0.4;
    cursor: default;
  }
</style>

<script lang="ts" module>
  let dialogSequence = 0;
  function nextDialogId() {
    return ++dialogSequence;
  }
</script>
