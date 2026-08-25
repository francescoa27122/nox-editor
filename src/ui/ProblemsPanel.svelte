<script lang="ts">
  import { untrack } from 'svelte';
  import { useApp } from './context';
  import Icon from './Icon.svelte';
  import PanelEmpty from './PanelEmpty.svelte';
  import PanelHeader from './PanelHeader.svelte';
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
  const { lsp, workspace, ui } = app;
  const focusRequest = ui.focusProblemsRequest;

  const diagnostics = lsp.diagnostics;
  const rootPath = workspace.rootPath;

  let focused = $state(-1);
  let listEl = $state<HTMLElement | null>(null);

  // `problems.focus` (and Mod+Shift+M) land here; without this the list
  // rendered but the keyboard stayed wherever it was.
  $effect(() => {
    void $focusRequest;
    untrack(() => listEl)?.focus();
  });

  // The keyboard can walk below the fold; the mouse never needs this.
  $effect(() => {
    if (focused < 0) return;
    // Optional call: jsdom has no scrollIntoView, and a missing scroll is
    // not worth an exception in the middle of a click handler's flush.
    untrack(() => listEl)
      ?.querySelectorAll('.row')
      ?.[focused]?.scrollIntoView?.({ block: 'nearest' });
  });

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
  <PanelHeader title="Problems" summary={rows.length === 0 ? '' : summary} />

  {#if rows.length === 0}
    <PanelEmpty
      action={{
        label: 'Configure Language Servers',
        run: () => void app.commands.execute('lsp.configure'),
      }}
    >
      Nothing to report. Problems appear here once a language server is running.
    </PanelEmpty>
  {:else}
    <div
      class="list nox-scroll"
      role="listbox"
      tabindex="0"
      aria-label="Problems"
      bind:this={listEl}
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
          title={row.label}
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

  .list {
    min-height: 0;
    flex: 1;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    padding: var(--nox-sp-1) var(--nox-sp-5);
    font-size: var(--nox-fs-sm);
    cursor: default;
    white-space: nowrap;
  }

  .row:hover {
    background: var(--nox-hover);
  }

  /* List selection, not editor text selection — the audit caught these two
     panels borrowing CodeMirror's hotter violet token. */
  .row.focused {
    background: var(--nox-selected);
  }

  .row:not(.file) {
    padding-left: var(--nox-sp-7);
  }

  .row.file .path {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
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
