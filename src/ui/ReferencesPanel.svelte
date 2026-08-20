<script lang="ts">
  import { untrack } from 'svelte';
  import PanelEmpty from './PanelEmpty.svelte';
  import PanelHeader from './PanelHeader.svelte';
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
  const focusRequest = app.ui.focusReferencesRequest;

  let focused = $state(-1);
  let listEl = $state<HTMLElement | null>(null);

  // `references.focus` (and Mod+Shift+R) land here; without this the list
  // rendered but the keyboard stayed wherever it was.
  $effect(() => {
    void $focusRequest;
    untrack(() => listEl)?.focus();
  });

  $effect(() => {
    if (focused < 0) return;
    // Optional call: jsdom has no scrollIntoView, and a missing scroll is
    // not worth an exception in the middle of a click handler's flush.
    untrack(() => listEl)
      ?.querySelectorAll('.row')
      [focused]?.scrollIntoView?.({ block: 'nearest' });
  });

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
  <PanelHeader title={$list?.title ?? 'References'} {summary}>
    {#if $list?.subject}<code class="subject">{$list.subject}</code>{/if}
  </PanelHeader>

  {#if rows.length === 0}
    <PanelEmpty
      action={{
        label: 'Find References',
        run: () => void app.commands.execute('lsp.findReferences'),
      }}
    >
      Nothing yet. Put the cursor on a symbol and find every place it is used.
    </PanelEmpty>
  {:else}
    <div
      class="list nox-scroll"
      role="listbox"
      tabindex="0"
      aria-label={$list?.title ?? 'References'}
      bind:this={listEl}
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
          title={row.label}
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

  .subject {
    font-size: var(--nox-fs-xs);
    color: var(--nox-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
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

  /* List selection, not editor text selection — see ProblemsPanel. */
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

  .text {
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--nox-font-mono);
  }
</style>
