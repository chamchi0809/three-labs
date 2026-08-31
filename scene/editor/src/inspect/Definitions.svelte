<script lang="ts">
  // The object browser's own button in the tool bar, beside the entity one. Same reason: picking what to
  // place is a mode of working, not a property of what happens to be selected, so it does not belong in a
  // panel that is about the selection.
  import IconBulb from "@tabler/icons-svelte/icons/bulb";
  import Dialog from "../ui/Dialog.svelte";
  import { tooltip } from "../ui/tooltip.ts";
  import ObjectBrowser from "./ObjectBrowser.svelte";

  let open = $state(false);
</script>

<button class="btn" class:on={open} use:tooltip={"definitions — objects this project declares"}
  onclick={() => (open = !open)}>
  <IconBulb size={16} />
</button>

{#if open}
  <Dialog title="definitions" say="templates you can place in a level" width={420}
    onclose={() => (open = false)}>
    <div class="body"><ObjectBrowser /></div>
  </Dialog>
{/if}

<style>
  .body { padding: 4px 12px 12px; }
</style>
