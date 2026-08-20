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
  const { git, ui, workspace, notifications } = app;
  const status = git.status;
  const focusRequest = ui.focusGitRequest;

  let messageEl = $state<HTMLTextAreaElement | null>(null);

  // `git.focus` (and the rail) land here; the one interactive text control
  // is where focus is useful.
  $effect(() => {
    void $focusRequest;
    untrack(() => messageEl)?.focus();
  });

  let message = $state('');
  const canCommit = $derived(($status?.staged.length ?? 0) > 0 && message.trim().length > 0);
  let committing = $state(false);

  async function commit(): Promise<void> {
    if (!canCommit || committing) return;
    committing = true;
    try {
      const result = await git.commit(message);
      if (result !== null) {
        message = '';
        // The success names the short hash and subject — `result` is
        // exactly `git log -1 --format=%h %s`.
        notifications.success(`Committed ${result}`);
      }
    } finally {
      committing = false;
    }
  }

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

  /** Explains, to a title attribute, why a row's actions are switched off. */
  const NO_TOPLEVEL = 'Cannot locate this file: the repository root could not be determined';
  const DELETED = 'Deleted — nothing to open';

  function absoluteOf(path: string): string | null {
    // Status paths are toplevel-relative — joined onto the repository
    // toplevel, never the workspace root: the two differ whenever a
    // workspace is opened below the repo root, and joining onto the wrong
    // one can silently target a same-named file elsewhere in the tree.
    // `null` means "cannot join honestly" — every caller must refuse the
    // action rather than guess at a path.
    const top = $status?.toplevel;
    return top ? join(top, path) : null;
  }

  function absolute(entry: FileEntry): string | null {
    return absoluteOf(entry.path);
  }

  /**
   * What `git.unstage` should touch for this row. A staged rename is two
   * index entries under the hood (the old path deleted, the new path
   * added) that porcelain collapses into one record with `origPath` — reset
   * only `entry.path` and the old path's deletion stays staged. Both need
   * resetting for the rename to leave the index cleanly.
   */
  function unstageTargets(entry: FileEntry): string[] {
    const targets: string[] = [];
    const main = absolute(entry);
    if (main) targets.push(main);
    if (entry.origPath) {
      const orig = absoluteOf(entry.origPath);
      if (orig) targets.push(orig);
    }
    return targets;
  }

  async function open(entry: FileEntry): Promise<void> {
    const target = absolute(entry);
    if (!target) return;
    await workspace.open(target);
  }

  async function view(entry: FileEntry): Promise<void> {
    const target = absolute(entry);
    if (!target) return;
    // The diff view is where a change is *looked at*; the row only points.
    await workspace.open(target);
    ui.showDiff();
  }
</script>

{#snippet row(entry: FileEntry, section: 'staged' | 'unstaged')}
  {@const target = absolute(entry)}
  {@const unresolved = target === null}
  {@const deleted = entry.status === 'D'}
  {@const actionTitle = (label: string) => (unresolved ? NO_TOPLEVEL : label)}
  <div class="row" title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}>
    <span class="letter letter-{entry.status}">{entry.status}</span>
    {#if unresolved || deleted}
      <span class="open disabled" title={unresolved ? NO_TOPLEVEL : DELETED}>{entry.path}</span>
    {:else}
      <button class="open" onclick={() => void open(entry)}>{entry.path}</button>
    {/if}
    <span class="actions">
      <button
        class="nox-button ghost small"
        title={actionTitle('Show Changes')}
        disabled={unresolved}
        onclick={() => void view(entry)}
      >
        <Icon name="file" size={11} />
      </button>
      {#if section === 'unstaged'}
        <button
          class="nox-button ghost small"
          title={actionTitle('Stage')}
          disabled={unresolved}
          onclick={() => void git.stage(target ? [target] : [])}
        >
          <Icon name="plus" size={11} />
        </button>
      {:else}
        <button
          class="nox-button ghost small"
          title={actionTitle('Unstage')}
          disabled={unresolved}
          onclick={() => void git.unstage(unstageTargets(entry))}
        >
          <Icon name="minus" size={11} />
        </button>
      {/if}
    </span>
  </div>
{/snippet}

<div class="panel" tabindex="-1">
  <PanelHeader title="Git" {summary} />

  {#if !$status && !git.started}
    <PanelEmpty>Git is not available in this build.</PanelEmpty>
  {:else if !$status}
    <PanelEmpty>This folder is not a git repository.</PanelEmpty>
  {:else}
    <button
      class="branch-line"
      title="Switch or create a branch"
      onclick={() => ui.openOverlay('git-branch')}
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

    <div class="commit">
      <textarea
        class="nox-input"
        rows="3"
        placeholder="Commit message (first line becomes the subject)"
        bind:value={message}
        bind:this={messageEl}
        onkeydown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void commit();
          }
        }}
      ></textarea>
      <button class="nox-button primary small" disabled={!canCommit || committing} onclick={() => void commit()}>
        Commit
      </button>
    </div>
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

  .row .open.disabled {
    color: var(--nox-text-muted);
  }

  /* opacity, not display:none: a hidden button is unfocusable, which took
     stage/unstage/view out of the tab order entirely (keyboard users could
     never reach them). Revealed on hover for pointer users and on
     :focus-within so Tab still finds them — the house pattern, see
     ExplorerPanel.svelte's .header-actions. */
  .row .actions {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-1);
    flex: none;
    opacity: 0;
    transition: opacity var(--nox-dur-base) var(--nox-ease);
  }

  .row:hover .actions,
  .row .actions:focus-within {
    opacity: 1;
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

  .commit {
    display: flex;
    flex-direction: column;
    gap: var(--nox-sp-2);
    padding: var(--nox-sp-3) var(--nox-sp-5) var(--nox-sp-4);
    border-top: 1px solid var(--nox-border);
    flex: none;
  }

  .commit textarea {
    height: auto;
    resize: vertical;
    font-family: var(--nox-font-ui);
    line-height: 1.4;
  }
</style>
