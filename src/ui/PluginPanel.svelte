<script lang="ts">
  import { useApp } from './context';
  import PanelEmpty from './PanelEmpty.svelte';
  import PanelHeader from './PanelHeader.svelte';

  /**
   * A panel a plugin filled.
   *
   * Rows, because a plugin is in another process and cannot ship a component.
   * That is a limit worth being glad of: the alternative is a plugin
   * describing DOM, which is a plugin reaching the render loop, which is the
   * thing being out of process exists to prevent.
   *
   * Nox owns everything visual here. A plugin chooses text, an optional
   * detail, and a command per row — not markup, not styling, not layout.
   */

  interface Props {
    /** The `plugin.<id>.<name>` view id this panel is showing. */
    view: string;
    title: string;
  }

  let { view, title }: Props = $props();

  const app = useApp();
  const { commands } = app;
  const contents = app.plugins.panels.contents;

  const panel = $derived($contents.get(view));
  const rows = $derived(panel?.rows ?? []);
</script>

<PanelHeader {title} />

<div class="body">
  {#if rows.length === 0}
    <!--
      Not an error, and worded so it does not read as one. A plugin that has
      nothing to report and a plugin that has not answered yet look identical
      from here, and claiming either would be a guess.
    -->
    <PanelEmpty>Nothing to show.</PanelEmpty>
  {:else}
    <ul class="rows">
      {#each rows as row, index (index)}
        <li>
          {#if row.command}
            <button
              class="row"
              onclick={() => void commands.execute(row.command ?? '', row.arg)}
            >
              <span class="text">{row.text}</span>
              {#if row.detail}<span class="detail">{row.detail}</span>{/if}
            </button>
          {:else}
            <span class="row static">
              <span class="text">{row.text}</span>
              {#if row.detail}<span class="detail">{row.detail}</span>{/if}
            </span>
          {/if}
        </li>
      {/each}
    </ul>

    {#if panel && panel.dropped > 0}
      <!--
        Said rather than silently cut, the way project search says `10000+`:
        a truncated list presented as a complete one is the worse failure.
      -->
      <p class="truncated">{panel.dropped} more not shown</p>
    {/if}
  {/if}
</div>

<style>
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: var(--nox-sp-1) 0;
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: var(--nox-sp-2);
    width: 100%;
    padding: var(--nox-sp-1) var(--nox-sp-3);
    text-align: left;
    color: var(--nox-text);
    font-size: var(--nox-fs-sm);
    line-height: var(--nox-lh-ui);
  }

  button.row:hover {
    background: var(--nox-hover);
  }

  button.row:focus-visible {
    outline: 1px solid var(--nox-accent);
    outline-offset: -1px;
  }

  .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail {
    flex: none;
    color: var(--nox-text-muted);
    font-size: var(--nox-fs-xs);
  }

  .truncated {
    margin: 0;
    padding: var(--nox-sp-2) var(--nox-sp-3);
    color: var(--nox-text-muted);
    font-size: var(--nox-fs-xs);
  }
</style>
