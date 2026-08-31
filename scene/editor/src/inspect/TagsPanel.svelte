<script lang="ts">
  /** the tag list under a panel title, so the left column reads as one stack of sections */
  import Panel from "../ui/Panel.svelte";
  import TagList from "./TagList.svelte";
</script>

<Panel title="tags">
  <TagList />
</Panel>
