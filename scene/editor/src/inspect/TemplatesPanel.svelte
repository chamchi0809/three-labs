<script lang="ts">
  /** the template list under a panel title, so the left column reads as one stack of sections */
  import Panel from "../ui/Panel.svelte";
  import TemplateList from "./TemplateList.svelte";
</script>

<Panel title="templates">
  <TemplateList />
</Panel>
