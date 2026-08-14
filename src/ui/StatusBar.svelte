<script lang="ts">
  import { hasGrammar } from '@editor/languages';
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  const app = useApp();
  const { workspace, config, commands, files, jobs, review, ui } = app;

  const buffers = workspace.buffers;
  const activeId = workspace.activeId;
  const cursor = app.cursor;
  const settings = config.settings;
  const indexing = files.indexing;
  const activeJobs = jobs.active;
  const staged = review.staged;
  const reviewOpen = ui.reviewOpen;

  /** A review put away is easy to forget about; this is how it gets found. */
  const pendingReview = $derived($staged && !$reviewOpen ? review.acceptedCount() : null);

  /**
   * One job at a time. The status bar has room for a line, not a queue, and
   * showing the oldest keeps the label from flickering between concurrent
   * jobs — anything richer belongs in a panel, which nothing needs yet.
   */
  const job = $derived($activeJobs[0] ?? null);

  const jobLabel = $derived.by(() => {
    if (!job) return '';
    const { done, total } = job.progress;
    if (total) return `${job.title} · ${Math.round((done / total) * 100)}%`;
    return done > 0 ? `${job.title} · ${done}` : job.title;
  });

  const active = $derived($buffers.find((b) => b.id === $activeId) ?? null);
  const dirtyCount = $derived($buffers.filter((b) => b.isDirty).length);

  const indentLabel = $derived(
    $settings['editor.insertSpaces']
      ? `Spaces: ${$settings['editor.tabSize']}`
      : `Tabs: ${$settings['editor.tabSize']}`,
  );

  const selectionLabel = $derived.by(() => {
    const { selectionLength, selectionLines, cursors } = $cursor;
    if (cursors > 1) return `${cursors} cursors`;
    if (selectionLength === 0) return null;
    if (selectionLines > 1) return `${selectionLength} selected · ${selectionLines} lines`;
    return `${selectionLength} selected`;
  });
</script>

<footer class="nox-statusbar">
  <div class="side">
    {#if pendingReview}
      <button
        class="item job"
        title="Go back to the review you left open"
        onclick={() => void commands.execute('review.show')}
      >
        <Icon name="file" size={11} />
        Review · {pendingReview.hunks}/{pendingReview.total}
      </button>
    {/if}

    {#if job}
      <button
        class="item job"
        title={`${job.progress.message ?? job.title} — click to cancel`}
        onclick={() => jobs.cancel(job.id)}
      >
        <span class="pulse" aria-hidden="true"></span>
        <span class="job-label">{jobLabel}</span>
        <Icon name="close" size={10} />
      </button>
    {/if}

    {#if $indexing}
      <span class="item static">
        <span class="pulse" aria-hidden="true"></span>
        Indexing
      </span>
    {/if}

    {#if dirtyCount > 0}
      <button class="item" onclick={() => void commands.execute('file.saveAll')}>
        <Icon name="dot" size={9} />
        {dirtyCount} unsaved
      </button>
    {/if}

    {#if active && active.externalState !== 'none'}
      <button
        class="item"
        class:warn={active.externalState === 'modified'}
        class:danger={active.externalState === 'deleted'}
        title="Reload this file from disk"
        onclick={() => void commands.execute('file.revert')}
      >
        <Icon name={active.externalState === 'deleted' ? 'error' : 'warning'} size={11} />
        {active.externalState === 'deleted' ? 'Deleted on disk' : 'Changed on disk'}
      </button>
    {/if}
  </div>

  <div class="side right">
    {#if selectionLabel}
      <span class="item static accent">{selectionLabel}</span>
    {/if}

    {#if active}
      <button
        class="item"
        title="Go to Line"
        onclick={() => void commands.execute('nav.goToLine')}
      >
        Ln {$cursor.line} : Col {$cursor.column}
      </button>

      <button
        class="item"
        title="Toggle spaces and tabs"
        onclick={() => config.set('editor.insertSpaces', !$settings['editor.insertSpaces'])}
      >
        {indentLabel}
      </button>

      <span
        class="item static"
        title={active.encoding === 'utf-8-bom'
          ? 'UTF-8 with a byte-order mark — preserved on save'
          : 'UTF-8'}
      >
        {active.encoding === 'utf-8-bom' ? 'UTF-8 BOM' : 'UTF-8'}
      </span>

      <span class="item static" title="Line endings">
        {active.eol === '\r\n' ? 'CRLF' : 'LF'}
      </span>

      <span
        class="item static"
        class:muted={!hasGrammar(active.languageId)}
        title={hasGrammar(active.languageId)
          ? active.languageName
          : `${active.languageName} — no grammar installed`}
      >
        {active.languageName}
      </span>
    {/if}

    <button
      class="item"
      title="Toggle word wrap"
      class:on={$settings['editor.wordWrap']}
      onclick={() => void commands.execute('view.toggleWordWrap')}
    >
      Wrap
    </button>
  </div>
</footer>

<style>
  .nox-statusbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: var(--nox-statusbar-h);
    flex: none;
    padding: 0 var(--nox-sp-3);
    background: var(--nox-bg-base);
    border-top: 1px solid var(--nox-border);
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .side {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-1);
    min-width: 0;
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    height: 18px;
    padding: 0 var(--nox-sp-3);
    border-radius: var(--nox-r-sm);
    color: inherit;
    white-space: nowrap;
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  button.item:hover {
    background: var(--nox-hover);
    color: var(--nox-text-bright);
  }

  .item.static {
    cursor: default;
  }

  .item.muted {
    color: var(--nox-text-faint);
  }

  .item.accent {
    color: var(--nox-accent);
  }

  .item.warn {
    color: var(--nox-warning);
  }

  .item.danger {
    color: var(--nox-danger);
  }

  .item.on {
    color: var(--nox-accent);
  }

  .item.job {
    color: var(--nox-accent);
  }

  /*
   * The label is the only thing here that varies in width, and a long file
   * path would otherwise push everything else along the bar as the walk
   * moves through the project.
   */
  .job-label {
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item.job :global(svg) {
    opacity: 0.55;
  }

  .item.job:hover :global(svg) {
    opacity: 1;
  }

  .pulse {
    width: 6px;
    height: 6px;
    border-radius: var(--nox-r-full);
    background: var(--nox-accent);
    animation: nox-pulse 1.4s var(--nox-ease) infinite;
  }

  @keyframes nox-pulse {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }
</style>
