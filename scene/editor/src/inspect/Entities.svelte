<script lang="ts">
  // The entity browser's own button in the tool bar, next to bake, keys and preferences. It is in the bar
  // rather than only in the inspector because placing data is a mode of working, not a property of what
  // happens to be selected — the same reason the tool it arms has a key of its own.
  import IconDatabase from "@tabler/icons-svelte/icons/database";
  import Dialog from "../ui/Dialog.svelte";
  import { tooltip } from "../ui/tooltip.ts";
  import EntityBrowser from "./EntityBrowser.svelte";

  let open = $state(false);
</script>

<button class="btn" class:on={open} use:tooltip={"entities — the data this project places"}
  onclick={() => (open = !open)}>
  <IconDatabase size={16} />
</button>

{#if open}
  <Dialog title="entities" say="what the level places that nothing draws" width={420}
    onclose={() => (open = false)}>
    <div class="body"><EntityBrowser /></div>
  </Dialog>
{/if}

<style>
  .body { padding: 4px 12px 12px; }
</style>
