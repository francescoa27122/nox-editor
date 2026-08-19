<script lang="ts">
  import { useApp } from './context';

  /**
   * The References view: the last answer to "where is this used" (or, for a
   * definition with several homes, "where is this defined"), as file rows
   * over location rows.
   *
   * A snapshot, not a live view — `NoxApp.showLocations` builds the rows
   * once, with the line text read at that moment. Navigation copies
   * `ProblemsPanel`'s rows/focused shape rather than inventing a third.
   */

  const app = useApp();
  const list = app.locations;

  let focused = $state(-1);

  const rows = $derived($list?.rows ?? []);

  const summary = $derived.by(() => {
    if (!$list) return '';
    const { total, files } = $list;
    return `${total} in ${files} file${files === 1 ? '' : 's'}`;
  });

  async function open(index: number): Promise<void> {
    const row = rows[index];
    if (!row) return;
    focused = index;
    if (row.location) await app.revealLocation(row.location);
    else await app.workspace.open(row.path);
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
</script>

<div class="panel">
  <header>
    <h2>{$list?.title ?? 'References'}</h2>
    {#if $list?.subject}<code class="subject">{$list.subject}</code>{/if}
    <span class="summary">{summary}</span>
  </header>

  {#if rows.length === 0}
    <p class="empty">
      Nothing yet. Put the cursor on a symbol and run <strong>Find References</strong>
      from the palette to list every place it is used.
    </p>
  {:else}
    <div
      class="list"
      role="listbox"
      tabindex="0"
      aria-label={$list?.title ?? 'References'}
      onkeydown={onKeyDown}
    >
      {#each rows as row, index (`${row.path}:${row.kind}:${row.line}:${row.column}:${index}`)}
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
            <span class="line">{row.line}</span>
            <span class="text">{row.label}</span>
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
    min-width: 0;
  }

  h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
    color: var(--nox-text-muted);
  }

  .subject {
    font-size: 11px;
    color: var(--nox-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .summary {
    font-size: 11px;
    color: var(--nox-text-muted);
    margin-left: auto;
    flex: none;
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

  .text {
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--nox-font-mono);
  }
</style>
