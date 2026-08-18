<script lang="ts">
  import { useApp } from './context';
  import Icon from './Icon.svelte';
  import { problemRows, problemTotals } from './problems';

  /**
   * Everything the language servers have to say, across the whole project.
   *
   * Listed by URI rather than by open tab, because a server publishes
   * project-wide errors for files nobody has opened — and those are exactly
   * the ones worth surfacing. Navigation copies `SearchPanel`'s rows/focused
   * shape rather than inventing a second one.
   */

  const app = useApp();
  const { lsp, workspace } = app;

  const diagnostics = lsp.diagnostics;
  const rootPath = workspace.rootPath;

  let focused = $state(-1);

  const rows = $derived(problemRows($diagnostics, $rootPath));
  const totals = $derived(problemTotals($diagnostics));

  const summary = $derived.by(() => {
    if (totals.files === 0) return 'No problems';
    const parts: string[] = [];
    if (totals.errors > 0) parts.push(`${totals.errors} error${totals.errors === 1 ? '' : 's'}`);
    if (totals.warnings > 0) {
      parts.push(`${totals.warnings} warning${totals.warnings === 1 ? '' : 's'}`);
    }
    return `${parts.join(', ')} in ${totals.files} file${totals.files === 1 ? '' : 's'}`;
  });

  async function open(index: number): Promise<void> {
    const row = rows[index];
    if (!row) return;

    focused = index;
    const id = await workspace.open(row.path);
    if (!id) return;
    // The same call the search panel's `onReveal` lands on, so opening a
    // problem and opening a match put the cursor the same way.
    if (row.kind === 'problem') app.goToLine(row.line, row.column);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (rows.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focused = Math.min(focused + 1, rows.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focused = Math.max(focused - 1, 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void open(focused);
    }
  }

  const ICONS = { 1: 'error', 2: 'warning', 3: 'info', 4: 'info' } as const;
</script>

<div class="panel">
  <header>
    <h2>Problems</h2>
    <span class="summary">{summary}</span>
  </header>

  {#if rows.length === 0}
    <p class="empty">
      Nothing to report. Problems appear here once a language server is running —
      run <strong>Configure Language Servers</strong> from the palette to set one up.
    </p>
  {:else}
    <div
      class="list"
      role="listbox"
      tabindex="0"
      aria-label="Problems"
      onkeydown={onKeyDown}
    >
      {#each rows as row, index (`${row.path}:${row.kind}:${row.line}:${index}`)}
        <div
          class="row"
          class:file={row.kind === 'file'}
          class:focused={index === focused}
          role="option"
          aria-selected={index === focused}
          tabindex="-1"
          onclick={() => void open(index)}
          onkeydown={() => {}}
        >
          {#if row.kind === 'file'}
            <span class="path">{row.label}</span>
            <span class="count">{row.count}</span>
          {:else}
            <Icon name={ICONS[row.severity]} size={11} />
            <span class="line">{row.line}</span>
            <span class="message">{row.label}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 10px;
  }

  h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
    color: var(--nox-text-muted);
  }

  .summary {
    font-size: 11px;
    color: var(--nox-text-muted);
    margin-left: auto;
  }

  .empty {
    padding: 0 10px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--nox-text-muted);
  }

  .list {
    overflow-y: auto;
    min-height: 0;
    flex: 1;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    font-size: 12px;
    cursor: default;
    white-space: nowrap;
  }

  .row.focused {
    background: var(--nox-selection);
  }

  .row:not(.file) {
    padding-left: 20px;
  }

  .row.file .path {
    font-weight: 500;
  }

  .count {
    margin-left: auto;
    color: var(--nox-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .line {
    color: var(--nox-text-muted);
    font-variant-numeric: tabular-nums;
    min-width: 2.5ch;
    text-align: right;
  }

  .message {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
