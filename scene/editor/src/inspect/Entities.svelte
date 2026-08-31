<script lang="ts">
  // The entity browser's own button in the tool bar, next to bake, keys and preferences. It is in the bar
  // rather than only in the inspector because placing data is a mode of working, not a property of what
  // happens to be selected — the same reason the tool it arms has a key of its own.
  import IconDatabase from "@tabler/icons-svelte/icons/database";
  import Dialog from "../ui/Dialog.svelte";
  import { tooltip } from "../ui/tooltip.ts";
  import EntityTypes from "./EntityTypes.svelte";

  let open = $state(false);
</script>

<button class="btn" class:on={open} use:tooltip={"entities — place data in the level"}
  onclick={() => (open = !open)}>
  <IconDatabase size={16} />
</button>

{#if open}
  <!-- one screen, not two: the list that picks a type to place is the list that picks one to edit -->
  <Dialog title="entities" say="entity types you can place, and the fields each one carries"
    width={720} onclose={() => (open = false)}>
    <div class="body"><EntityTypes /></div>
  </Dialog>
{/if}

<style>
  .body { padding: 4px 12px 12px; }
</style>
