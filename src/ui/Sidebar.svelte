<script lang="ts">
  import type { SidebarView } from '@services/ui';
  import { useApp } from './context';
  import ExplorerPanel from './ExplorerPanel.svelte';
  import SearchPanel from './SearchPanel.svelte';
  import Icon, { type IconName } from './Icon.svelte';

  /**
   * The sidebar shell.
   *
   * Holds the view rail and swaps the active panel. Deliberately a short rail
   * rather than a full activity bar: a dedicated 48px column of chrome would
   * cost more than it earns at this number of views. Adding one is an entry in
   * `VIEWS` and a branch below.
   */

  const app = useApp();
  const { ui, keymap } = app;
  const view = ui.sidebarView;

  const VIEWS: { id: SidebarView; icon: IconName; label: string; command: string }[] = [
    { id: 'explorer', icon: 'sidebar', label: 'Explorer', command: 'nav.focusExplorer' },
    { id: 'search', icon: 'search', label: 'Search', command: 'search.focus' },
  ];
</script>

<aside class="nox-sidebar" aria-label="Sidebar">
  <nav class="rail" aria-label="Sidebar views">
    {#each VIEWS as entry (entry.id)}
      {@const hint = keymap.displayFor(entry.command)}
      <button
        class="rail-button"
        class:active={$view === entry.id}
        aria-pressed={$view === entry.id}
        aria-label={entry.label}
        title={hint ? `${entry.label} (${hint})` : entry.label}
        onclick={() => ui.showView(entry.id)}
      >
        <Icon name={entry.icon} size={15} />
      </button>
    {/each}
  </nav>

  {#if $view === 'search'}
    <SearchPanel />
  {:else}
    <ExplorerPanel />
  {/if}
</aside>

<style>
  .nox-sidebar {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    background: var(--nox-bg-panel);
  }

  /* Deliberately short and borderless so it reads as one unit with the
     panel header beneath it rather than a second bar of chrome. */
  .rail {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-1);
    flex: none;
    height: 28px;
    padding: var(--nox-sp-2) var(--nox-sp-3) 0;
  }

  .rail-button {
    display: grid;
    place-items: center;
    width: 26px;
    height: 22px;
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-faint);
    position: relative;
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .rail-button:hover {
    background: var(--nox-hover);
    color: var(--nox-text);
  }

  .rail-button.active {
    color: var(--nox-accent);
    background: var(--nox-active);
  }
</style>
