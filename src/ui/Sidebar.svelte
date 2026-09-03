<script lang="ts">
  import { runnableAgents } from '@services/agent/config';
  import { isPluginView, type SidebarView } from '@services/ui';
  import { panelViewId } from '@services/plugin/panels';
  import PluginPanel from './PluginPanel.svelte';
  import { useApp } from './context';
  import ExplorerPanel from './ExplorerPanel.svelte';
  import SearchPanel from './SearchPanel.svelte';
  import NotesPanel from './NotesPanel.svelte';
  import AnswersPanel from './AnswersPanel.svelte';
  import ProblemsPanel from './ProblemsPanel.svelte';
  import ReferencesPanel from './ReferencesPanel.svelte';
  import GitPanel from './GitPanel.svelte';
  import Icon, { isIconName, type IconName } from './Icon.svelte';
  import { problemTotals } from './problems';

  /**
   * The sidebar shell.
   *
   * Holds the view rail and swaps the active panel. Deliberately a short rail
   * rather than a full activity bar: a dedicated 48px column of chrome would
   * cost more than it earns at this number of views. Adding one is an entry in
   * `VIEWS` and a branch below.
   */

  const app = useApp();
  const { ui, keymap, agentConfig, agents, commands, lsp } = app;
  const diagnostics = lsp.diagnostics;
  const view = ui.sidebarView;
  // The rail's one ambient status: how many errors the project has. An
  // activity rail that shows nothing until clicked is not earning its row.
  const errorCount = $derived(problemTotals($diagnostics).errors);
  const configured = agentConfig.agents;
  const providers = agents.providers;

  interface View {
    id: SidebarView;
    icon: IconName;
    label: string;
    command: string;
    /**
     * A different command whose chord also lands here, shown when `command`
     * has none of its own.
     *
     * References is the case: `app.ts:3882` records the decision that it keeps
     * no chord because Shift+F12 already fills *and* shows the view. True, but
     * the tooltip then read "References" with nothing after it while its four
     * neighbours advertised a chord — so the panel looked like the one with no
     * keyboard route rather than the one whose route is on another command.
     */
    chordFrom?: string;
  }

  const VIEWS: View[] = [
    { id: 'explorer', icon: 'sidebar', label: 'Explorer', command: 'nav.focusExplorer' },
    { id: 'search', icon: 'search', label: 'Search', command: 'search.focus' },
    { id: 'notes', icon: 'note', label: 'Notes', command: 'notes.focus' },
    { id: 'answers', icon: 'info', label: 'Answers', command: 'answers.focus' },
    { id: 'problems', icon: 'warning', label: 'Problems', command: 'problems.focus' },
    {
      id: 'references',
      icon: 'references',
      label: 'References',
      command: 'references.focus',
      chordFrom: 'lsp.findReferences',
    },
    { id: 'git', icon: 'branch', label: 'Git', command: 'git.focus' },
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

  /**
   * The rail entries plugins contribute.
   *
   * Read from the manifests rather than from anything running, which is what
   * keeps a plugin with a panel as lazy as one with only commands: the button
   * exists before the plugin does, and clicking it is what starts it.
   *
   * `revision` is what this recomputes on — the host bumps it whenever a
   * plugin is loaded, stopped or disabled.
   */
  const pluginRevision = app.plugins.revision;
  const pluginViews: View[] = $derived.by(() => {
    void $pluginRevision;
    return app.plugins.panelContributions().map((panel) => ({
      id: panelViewId(panel.pluginId, panel.name) as SidebarView,
      // An unrecognised icon falls back rather than failing: an icon is
      // decoration, and a panel that refused to appear over one would be a
      // poor trade for whoever installed the plugin.
      icon: (panel.icon && isIconName(panel.icon) ? panel.icon : 'command') satisfies IconName,
      label: panel.title,
      command: panelViewId(panel.pluginId, panel.name),
    }));
  });

  const coreViews = $derived(available ? VIEWS : VIEWS.filter((entry) => entry.id !== 'answers'));
  // Plugin buttons last, for the reason plugin status items are last: the rail
  // is Nox's own chrome first, and a plugin appearing mid-session must not
  // move a button someone is already reaching for.
  const views = $derived([...coreViews, ...pluginViews]);

  /** The one plugin panel showing, if the active view is one. */
  const activePluginView = $derived(
    isPluginView($view) ? pluginViews.find((entry) => entry.id === $view) : undefined,
  );

  // The section exists only while an agent does. Without this, removing the
  // last agent leaves the panel showing with no button in the rail for it.
  $effect(() => {
    if (!available) ui.dropView('answers');
  });
</script>

<aside class="nox-sidebar" aria-label="Sidebar">
  <nav class="rail" aria-label="Sidebar views">
    {#each views as entry (entry.id)}
      {@const hint = keymap.displayFor(entry.command) ?? (entry.chordFrom ? keymap.displayFor(entry.chordFrom) : undefined)}
      <button
        class="rail-button"
        class:active={$view === entry.id}
        aria-pressed={$view === entry.id}
        aria-label={entry.label}
        title={hint ? `${entry.label} (${hint})` : entry.label}
        onclick={() => {
          // Re-clicking the current view focuses its panel; it used to collapse
          // the sidebar.
          //
          // Collapse-on-reclick is the rail convention, but the convention
          // assumes a *persistent* activity bar — in VS Code the column stays
          // and only the panel body goes. This rail lives inside the aside it
          // was collapsing, so the gesture deleted its own affordance along
          // with the other six entry points, and nothing under the cursor said
          // how to get them back. ⌘B and the title-bar button are the labelled
          // ways to collapse, and they remain.
          //
          // Focusing is what a re-click most likely meant anyway, and each view
          // already names the command that does it.
          if ($view === entry.id) void commands.execute(entry.command);
          else ui.showView(entry.id);
        }}
      >
        <Icon name={entry.icon} size={15} />
        {#if entry.id === 'problems' && errorCount > 0}
          <span class="badge" aria-label="{errorCount} errors">
            {errorCount > 99 ? '99+' : errorCount}
          </span>
        {/if}
      </button>
    {/each}
  </nav>

  {#if $view === 'search'}
    <SearchPanel />
  {:else if $view === 'problems'}
    <ProblemsPanel />
  {:else if $view === 'references'}
    <ReferencesPanel />
  {:else if $view === 'git'}
    <GitPanel />
  {:else if $view === 'notes'}
    <NotesPanel />
    <!-- Guarded on `available` as well as the view, so an answers view that
         outlives its last agent by a frame falls through to the explorer
         below rather than rendering nothing at all. -->
  {:else if $view === 'answers' && available}
    <AnswersPanel />
    <!-- Guarded on the entry existing, not just on the id shape: a plugin
         removed by a reload can leave the view pointing at a panel that no
         longer has a rail button, and falling through to the explorer is
         better than rendering a header for something that is gone. -->
  {:else if activePluginView}
    <PluginPanel view={activePluginView.id} title={activePluginView.label} />
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

  .badge {
    position: absolute;
    top: -3px;
    right: -4px;
    min-width: 13px;
    height: 13px;
    padding: 0 3px;
    border-radius: var(--nox-r-full);
    background: var(--nox-danger);
    color: var(--nox-bg-base);
    /* The smallest step on the scale, up from a 9px that was under it. */
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    line-height: 13px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    /* Over the icon's corner, sitting on the rail's ground so it reads as a
       counter, not part of the glyph. */
    box-shadow: 0 0 0 2px var(--nox-bg-panel);
  }
</style>
