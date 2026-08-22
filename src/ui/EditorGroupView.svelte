<script lang="ts">
  import { useApp } from './context';
  import TabBar from './TabBar.svelte';
  import EditorPane from './EditorPane.svelte';
  import FindPanel from './FindPanel.svelte';
  import Icon from './Icon.svelte';

  /**
   * One editor pane: its tab strip, an optional find bar, and the editor.
   *
   * An empty group is a real state — ⌘\ creates one deliberately so you can
   * open something into it — so it gets a proper placeholder rather than
   * collapsing or showing the full welcome screen.
   */

  interface Props {
    groupId: string;
  }

  let { groupId }: Props = $props();

  const app = useApp();
  const { workspace, ui, commands, keymap } = app;

  const groups = workspace.groups;
  const findOpen = ui.findOpen;

  const group = $derived($groups.find((candidate) => candidate.id === groupId) ?? null);
  const isEmpty = $derived((group?.tabs.length ?? 0) === 0);
  const isActive = $derived(group?.isActive ?? false);
</script>

<div class="group" class:active={isActive} class:split={$groups.length > 1}>
  <TabBar {groupId} />

  {#if isEmpty}
    <div class="empty">
      <Icon name="logo" size={26} class="mark" />
      <p>This pane is empty</p>
      <div class="hints">
        <button onclick={() => {
          workspace.focusGroup(groupId);
          void commands.execute('nav.quickOpen');
        }}>
          Open a file
          <kbd class="nox-kbd">{keymap.displayFor('nav.quickOpen') ?? ''}</kbd>
        </button>
        {#if $groups.length > 1}
          <button onclick={() => workspace.closeGroup(groupId)}>Close this pane</button>
        {/if}
      </div>
    </div>
  {:else}
    <!-- Find applies to the focused pane, so only that one shows the bar. -->
    {#if $findOpen && isActive}
      <FindPanel />
    {/if}
    <EditorPane {groupId} />
  {/if}
</div>

<style>
  .group {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    background: var(--nox-bg-editor);
    position: relative;
  }

  /* When split, the focused pane carries a hairline of accent along its top
     edge — enough to answer "where will my typing go" at a glance. */
  .group.split.active::after {
    content: '';
    position: absolute;
    inset: 0 0 auto 0;
    height: 1px;
    background: var(--nox-accent-dim);
    pointer-events: none;
    z-index: var(--nox-z-panel);
  }

  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--nox-sp-4);
    color: var(--nox-text-muted);
  }

  .empty :global(.mark) {
    color: var(--nox-border-strong);
  }

  .empty p {
    margin: 0;
    font-size: var(--nox-fs-sm);
  }

  .hints {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--nox-sp-2);
  }

  .hints button {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    padding: var(--nox-sp-2) var(--nox-sp-4);
    border-radius: var(--nox-r-md);
    font-size: var(--nox-fs-sm);
    color: var(--nox-accent);
    transition: background var(--nox-dur-fast) var(--nox-ease);
  }

  .hints button:hover {
    background: var(--nox-hover);
  }
</style>
