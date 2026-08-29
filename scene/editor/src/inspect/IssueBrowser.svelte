<script lang="ts">
  /**
   * The issue browser: everything wrong with the level, and one click each to put it right.
   *
   * Grouped by validator rather than listed flat, because a level with a hundred off-grid corners has one
   * problem and not a hundred — and because "fix all of these" is only a safe button when the designer can
   * see what "these" are before pressing it.
   *
   * Every validator can be switched off. That is not a convenience: a checker that reports something the
   * project has decided it does not care about is a checker whose whole list gets ignored, and the list is
   * worth more than any one check in it.
   */
  import { describeIssues, issuesOf, VALIDATORS, type Context, type Issue } from "../doc/issues.ts";
  import { gridSize } from "../doc/editor.ts";
  import { fixIssue, fixIssues, showIssue } from "../actions.ts";
  import { library } from "../library.svelte.ts";
  import { session } from "../session.svelte.ts";

  /** the checks the designer has switched off; kept in the panel because it is a way of looking, not an edit */
  let off = $state<string[]>([]);

  const context = $derived<Context>({
    world: session.editor.world,
    catalogue: library.catalogue,
    grid: gridSize(session.editor),
    material: session.editor.material,
  });

  const issues = $derived(issuesOf(context, off));
  const groups = $derived(
    VALIDATORS.map((v) => ({ validator: v, found: issues.filter((i) => i.validator === v.id) }))
      .filter((g) => g.found.length),
  );

  const toggle = (id: string) => (off = off.includes(id) ? off.filter((x) => x !== id) : [...off, id]);
  const selected = (issue: Issue) => session.editor.selection.nodes.includes(issue.node);
</script>

<p class="head">
  <b>{describeIssues(issues)}</b>
  {#if issues.length}
    <button onclick={() => fixIssues(context, issues)}>fix all</button>
  {/if}
</p>

{#each groups as group (group.validator.id)}
  <h3>
    {group.validator.title}
    <span class="count">{group.found.length}</span>
    <button onclick={() => fixIssues(context, group.found)}>fix these</button>
  </h3>
  <ul>
    {#each group.found as issue, i (`${issue.node}:${issue.face ?? ""}:${issue.prop ?? ""}:${i}`)}
      <li class:on={selected(issue)}>
        <span class="dot" class:warning={issue.severity === "warning"} title={issue.severity}></span>
        <button class="what" onclick={() => showIssue(issue)}>{issue.message}</button>
        {#if issue.fix}
          <button class="fix" title={issue.fix} onclick={() => fixIssue(context, issue)}>fix</button>
        {/if}
      </li>
    {/each}
  </ul>
{:else}
  <p class="none">nothing to report</p>
{/each}

<h3>checks</h3>
<ul class="checks">
  {#each VALIDATORS as validator (validator.id)}
    <li>
      <label>
        <input type="checkbox" checked={!off.includes(validator.id)} onchange={() => toggle(validator.id)} />
        <span class:muted={off.includes(validator.id)}>{validator.title}</span>
      </label>
    </li>
  {/each}
</ul>

<style>
  .head { display: flex; gap: 6px; align-items: center; margin: 0 0 6px; font: var(--mono); color: var(--text); }
  .head b { color: var(--ink); font-weight: 600; }
  .none { margin: 4px 0; color: var(--dim); font: var(--mono); }
  h3 {
    display: flex; gap: 6px; align-items: center;
    margin: 12px 0 4px; padding-top: 8px; border-top: 1px solid var(--line);
    font: var(--mono); font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em;
  }
  .count { color: var(--ink); font-variant-numeric: tabular-nums; }
  h3 button, .head button { margin-left: auto; }
  button {
    padding: 1px 6px; cursor: pointer;
    background: var(--raised); border: 1px solid var(--line); border-radius: 3px;
    font: var(--mono); color: var(--text); text-transform: none; letter-spacing: 0;
  }
  button:hover { border-color: var(--edge); color: var(--ink); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 5px; align-items: center; padding: 1px 2px; border-radius: 3px; }
  li.on { background: var(--on); }
  .dot {
    flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--bad);
  }
  .dot.warning { background: var(--warn); }
  .what {
    flex: 1; min-width: 0; overflow: hidden; text-align: left; white-space: nowrap; text-overflow: ellipsis;
    background: transparent; border: 0; padding: 1px 2px; color: var(--text);
  }
  .what:hover { color: var(--ink); }
  .fix { flex: none; }
  .checks label { display: flex; gap: 5px; align-items: center; font: var(--mono); color: var(--text); cursor: pointer; }
  .muted { color: var(--dim); }
</style>
