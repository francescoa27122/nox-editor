<script lang="ts">
  import { untrack } from 'svelte';
  import { join } from '@core/path';
  import type { FileEntry } from '@core/git-status';
  import { useApp } from './context';
  import Icon from './Icon.svelte';
  import PanelEmpty from './PanelEmpty.svelte';
  import PanelHeader from './PanelHeader.svelte';

  /**
   * The Git view: what is my working state, and how do I turn it into a
   * commit — nothing else. Two sections mirroring `git status`, a branch
   * line, a commit box. Everything it renders comes from `GitService.status`;
   * nothing here asks git directly, and every mutation goes through the
   * service so the refresh discipline (envelope §6) has one home.
   *
   * See docs/superpowers/specs/2026-08-19-git-stage-commit-design.md §1.
   */

  const app = useApp();
  const { git, ui, workspace } = app;
  const status = git.status;
  const focusRequest = ui.focusGitRequest;

  let panelEl = $state<HTMLElement | null>(null);

  // `git.focus` (and the rail) land here; give the keyboard somewhere real.
  $effect(() => {
    void $focusRequest;
    untrack(() => panelEl)?.focus();
  });

  const branchLabel = $derived.by(() => {
    const s = $status;
    if (!s) return '';
    if (s.detached) return `detached at ${s.oid?.slice(0, 7) ?? '?'}`;
    return s.branch ?? '?';
  });

  const summary = $derived.by(() => {
    const s = $status;
    if (!s) return '';
    const total = s.staged.length + s.unstaged.length;
    return total === 0 ? 'clean' : `${total} change${total === 1 ? '' : 's'}`;
  });

  function absolute(entry: FileEntry): string {
    // Status paths are toplevel-relative; the workspace root is the repo
    // root in every workflow this row supports (spec §8: one root, one repo).
    const root = workspace.rootPath.get();
    return root ? join(root, entry.path) : entry.path;
  }

  async function open(entry: FileEntry): Promise<void> {
    await workspace.open(absolute(entry));
  }

  async function view(entry: FileEntry): Promise<void> {
    // The diff view is where a change is *looked at*; the row only points.
    await workspace.open(absolute(entry));
    ui.showDiff();
  }
</script>

{#snippet row(entry: FileEntry, section: 'staged' | 'unstaged')}
  <div class="row" title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}>
    <span class="letter letter-{entry.status}">{entry.status}</span>
    <button class="open" onclick={() => void open(entry)}>{entry.path}</button>
    <span class="actions">
      <button class="nox-button ghost small" title="Show Changes" onclick={() => void view(entry)}>
        <Icon name="file" size={11} />
      </button>
      {#if section === 'unstaged'}
        <button
          class="nox-button ghost small"
          title="Stage"
          onclick={() => void git.stage([absolute(entry)])}
        >
          <Icon name="plus" size={11} />
        </button>
      {:else}
        <button
          class="nox-button ghost small"
          title="Unstage"
          onclick={() => void git.unstage([absolute(entry)])}
        >
          <Icon name="minus" size={11} />
        </button>
      {/if}
    </span>
  </div>
{/snippet}

<div class="panel" bind:this={panelEl} tabindex="-1">
  <PanelHeader title="Git" {summary} />

  {#if !$status && !git.started}
    <PanelEmpty>Git is not available in this build.</PanelEmpty>
  {:else if !$status}
    <PanelEmpty>This folder is not a git repository.</PanelEmpty>
  {:else}
    <button
      class="branch-line"
      title="Switch or create a branch"
      onclick={() => {
        /* the branch picker lands in its own task */
      }}
    >
      <Icon name="branch" size={12} />
      <span class="name">{branchLabel}</span>
    </button>

    <div class="lists nox-scroll">
      {#if $status.staged.length > 0}
        <section class="section staged" aria-label="Staged changes">
          <h3>Staged</h3>
          {#each $status.staged as entry (entry.path)}
            {@render row(entry, 'staged')}
          {/each}
        </section>
      {/if}

      <section class="section changes" aria-label="Changes">
        <h3>Changes</h3>
        {#if $status.unstaged.length === 0}
          <p class="quiet">No changes.</p>
        {:else}
          {#each $status.unstaged as entry (entry.path)}
            {@render row(entry, 'unstaged')}
          {/each}
        {/if}
      </section>
    </div>

    <!-- The commit box lands in the commit task. -->
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    outline: none;
  }

  .branch-line {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    padding: var(--nox-sp-2) var(--nox-sp-5);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text);
    flex: none;
  }

  .branch-line:hover {
    background: var(--nox-hover);
  }

  .branch-line .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lists {
    min-height: 0;
    flex: 1;
  }

  .section h3 {
    margin: 0;
    padding: var(--nox-sp-2) var(--nox-sp-5) var(--nox-sp-1);
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    text-transform: uppercase;
    letter-spacing: var(--nox-tracking-wide);
    color: var(--nox-text-muted);
  }

  .quiet {
    margin: 0;
    padding: var(--nox-sp-1) var(--nox-sp-5);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    padding: var(--nox-sp-1) var(--nox-sp-3) var(--nox-sp-1) var(--nox-sp-5);
    font-size: var(--nox-fs-sm);
    white-space: nowrap;
  }

  .row:hover {
    background: var(--nox-hover);
  }

  .row .open {
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
    min-width: 0;
    flex: 1;
    color: var(--nox-text);
  }

  .row .actions {
    display: none;
    align-items: center;
    gap: var(--nox-sp-1);
    flex: none;
  }

  .row:hover .actions {
    display: flex;
  }

  /* The tokens the gutter already uses (editor/theme.ts): added green,
     modified amber, deleted red. Untracked shares added's green — staging
     it is "start tracking this". A rename is informational blue. */
  .letter {
    flex: none;
    width: 1.5ch;
    text-align: center;
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-xs);
  }

  .letter-A,
  .letter-U {
    color: var(--nox-success);
  }

  .letter-M {
    color: var(--nox-warning);
  }

  .letter-D {
    color: var(--nox-danger);
  }

  .letter-R {
    color: var(--nox-info);
  }
</style>
