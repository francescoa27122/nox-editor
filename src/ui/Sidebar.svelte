<script lang="ts">
  import { runnableAgents } from '@services/agent/config';
  import type { SidebarView } from '@services/ui';
  import { useApp } from './context';
  import ExplorerPanel from './ExplorerPanel.svelte';
  import SearchPanel from './SearchPanel.svelte';
  import NotesPanel from './NotesPanel.svelte';
  import AnswersPanel from './AnswersPanel.svelte';
  import ProblemsPanel from './ProblemsPanel.svelte';
  import ReferencesPanel from './ReferencesPanel.svelte';
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
  const { ui, keymap, agentConfig, agents } = app;
  const view = ui.sidebarView;
  const configured = agentConfig.agents;
  const providers = agents.providers;

  const VIEWS: { id: SidebarView; icon: IconName; label: string; command: string }[] = [
    { id: 'explorer', icon: 'sidebar', label: 'Explorer', command: 'nav.focusExplorer' },
    { id: 'search', icon: 'search', label: 'Search', command: 'search.focus' },
    { id: 'notes', icon: 'note', label: 'Notes', command: 'notes.focus' },
    { id: 'answers', icon: 'info', label: 'Answers', command: 'answers.focus' },
    { id: 'problems', icon: 'warning', label: 'Problems', command: 'problems.focus' },
    { id: 'references', icon: 'search', label: 'References', command: 'references.focus' },
  ];

  // The same policy `AgentPanel.svelte` and `NoxApp.#runnableAgents()` use, so
  // the rail and the command that focuses it can never disagree about whether
  // the section exists at all.
  const available = $derived(
    runnableAgents($configured, {
      canSpawn: app.platform.capabilities.agentProcesses,
      providerIds: new Set($providers.map((provider) => provider.id)),
    }).length > 0,
  );

  const views = $derived(available ? VIEWS : VIEWS.filter((entry) => entry.id !== 'answers'));

  // The section exists only while an agent does. Without this, removing the
  // last agent leaves the panel showing with no button in the rail for it.
  $effect(() => {
    if (!available) ui.dropView('answers');
  });
</script>

<aside class="nox-sidebar" aria-label="Sidebar">
  <nav class="rail" aria-label="Sidebar views">
    {#each views as entry (entry.id)}
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
  {:else if $view === 'problems'}
    <ProblemsPanel />
  {:else if $view === 'references'}
    <ReferencesPanel />
  {:else if $view === 'notes'}
    <NotesPanel />
    <!-- Guarded on `available` as well as the view, so an answers view that
         outlives its last agent by a frame falls through to the explorer
         below rather than rendering nothing at all. -->
  {:else if $view === 'answers' && available}
    <AnswersPanel />
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
    height: var(--nox-railbar-h);
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
