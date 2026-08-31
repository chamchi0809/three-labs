<script lang="ts">
  /**
   * The box a double-click opens over a name.
   *
   * The hierarchy has one of its own, tangled up with dragging; this is the plain one for the lists that
   * only need a name typed. Enter commits, Escape cancels, and every key stops here — the panel
   * underneath binds Enter and ⌫ to things a designer typing a name does not mean.
   */
  type Props = { value: string; done: (to: string) => void; cancel: () => void };
  let { value, done, cancel }: Props = $props();

  const grab = (el: HTMLInputElement): void => {
    el.focus();
    el.select();
  };
</script>

<input
  class="rename"
  {value}
  use:grab
  onpointerdown={(e) => e.stopPropagation()}
  onblur={(e) => done((e.target as HTMLInputElement).value)}
  onkeydown={(e) => {
    e.stopPropagation();
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
    // the box unmounts, which fires blur, which would commit whatever was typed: put the name it opened
    // with back first, and the commit is a rename to the name it already has — a no-op
    if (e.key === "Escape") {
      (e.target as HTMLInputElement).value = value;
      cancel();
    }
  }}
/>

<style>
  .rename {
    flex: 1 1 auto; min-width: 0; padding: 1px 3px;
    background: var(--bg); border: 1px solid var(--accent); border-radius: 3px;
    font: var(--mono); color: var(--text);
  }
</style>
