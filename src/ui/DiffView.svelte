<script lang="ts">
  import { contains, relative } from '@core/path';
  import { diffViewRows, type DiffViewRow, type SideCell } from '@core/diff-view';
  import { MAX_DIFF_BYTES } from '@services/git';
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  /**
   * The active file against its git base — read-only, two layouts.
   *
   * A lens, not a document: it follows the active buffer instead of closing
   * when the tab changes (the deliberate deviation from review and agents,
   * which close because "going to a file must show the file" — this *is*
   * showing the file). Everything it renders is derived from what
   * `GitService` already fetched and computed; nothing here asks git.
   */

  const app = useApp();
  const { workspace, config, ui, git } = app;

  const buffers = workspace.buffers;
  const activeId = workspace.activeId;
  const hunksMap = git.hunks;
  const baseRevision = git.baseRevision;
  const settings = config.settings;

  /** Expand-all: one click on any fold shows the whole file. Per file. */
  let expandedFor = $state<string | null>(null);

  const layout = $derived($settings['workbench.diffLayout']);
  const active = $derived($buffers.find((b) => b.id === $activeId) ?? null);
  const entry = $derived(active ? ($hunksMap.get(active.id) ?? null) : null);
  const base = $derived.by(() => {
    void $baseRevision; // Re-read when a base arrives or is forgotten.
    return active?.path ? git.baseFor(active.path) : undefined;
  });
  const text = $derived(active ? workspace.textOf(active.id) : undefined);

  const tooLarge = $derived(
    typeof base === 'string' &&
      text !== undefined &&
      (base.length > MAX_DIFF_BYTES || text.length > MAX_DIFF_BYTES),
  );

  const rows = $derived.by((): DiffViewRow[] => {
    if (!active?.path || typeof base !== 'string' || text === undefined || tooLarge) return [];
    if (!entry || entry.hunks.length === 0) return [];
    const context = expandedFor === active.path ? Infinity : undefined;
    return diffViewRows(base, text, entry.hunks, context);
  });

  const changeCount = $derived(entry?.hunks.length ?? 0);

  const folder = $derived.by(() => {
    if (!active?.path) return '';
    const root = workspace.rootPath.get();
    const rel = root && contains(root, active.path) ? relative(root, active.path) : active.path;
    const cut = rel.lastIndexOf('/');
    return cut > 0 ? rel.slice(0, cut) : '';
  });

  /**
   * The inline layout, derived from the same rows: a contiguous run of
   * change rows is one hunk (rows from different hunks are always separated
   * by a context or fold row — the core asserts it), rendered as all its
   * befores (−) then all its afters (+).
   */
  interface InlineRow {
    kind: 'context' | 'removed' | 'added' | 'fold';
    before: SideCell | null;
    after: SideCell | null;
    count: number;
  }
  const inline = $derived.by((): InlineRow[] => {
    const out: InlineRow[] = [];
    let run: DiffViewRow[] = [];
    const flush = () => {
      for (const row of run) {
        if (row.kind === 'change' && row.before) {
          out.push({ kind: 'removed', before: row.before, after: null, count: 0 });
        }
      }
      for (const row of run) {
        if (row.kind === 'change' && row.after) {
          out.push({ kind: 'added', before: null, after: row.after, count: 0 });
        }
      }
      run = [];
    };
    for (const row of rows) {
      if (row.kind === 'change') {
        run.push(row);
        continue;
      }
      flush();
      if (row.kind === 'context') {
        out.push({ kind: 'context', before: row.before, after: row.after, count: 0 });
      } else {
        out.push({ kind: 'fold', before: null, after: null, count: row.count });
      }
    }
    flush();
    return out;
  });

  function expand(): void {
    if (active?.path) expandedFor = active.path;
  }

  function setLayout(value: 'side-by-side' | 'inline'): void {
    config.set('workbench.diffLayout', value);
  }
</script>

<section class="diff" aria-label="Changes against git">
  <header>
    <div class="heading">
      <h2>Changes</h2>
      {#if active}
        <p>
          <Icon name="file" size={13} />
          <span class="name">{active.name}</span>
          {#if folder}<span class="folder">{folder}</span>{/if}
          {#if changeCount > 0}
            <span class="tally">
              {changeCount} change{changeCount === 1 ? '' : 's'} against the index
            </span>
          {/if}
        </p>
      {/if}
    </div>
    <div class="actions">
      <button
        class="nox-button small"
        class:on={layout === 'side-by-side'}
        aria-pressed={layout === 'side-by-side'}
        onclick={() => setLayout('side-by-side')}
      >
        Side by side
      </button>
      <button
        class="nox-button small"
        class:on={layout === 'inline'}
        aria-pressed={layout === 'inline'}
        onclick={() => setLayout('inline')}
      >
        Inline
      </button>
      <button
        class="nox-button ghost small"
        onclick={() => ui.diffOpen.set(false)}
        title="Back to the editor (Esc)"
      >
        Close
      </button>
    </div>
  </header>

  <div class="body nox-scroll">
    {#if !active}
      <p class="empty">No file is active. Open one to see its changes.</p>
    {:else if !active.path}
      <p class="empty">An untitled buffer has no git base yet. Save it first.</p>
    {:else if base === undefined}
      <p class="empty">Asking git…</p>
    {:else if base === null}
      <p class="empty">
        Git has no base for this file — it is untracked, outside a repository, or there is no
        git to ask. The gutter and this view stay empty rather than guessing.
      </p>
    {:else if tooLarge}
      <p class="empty">Too large to diff. Files past 2&nbsp;MB are skipped on purpose.</p>
    {:else if rows.length === 0}
      <p class="empty">No changes — the file matches what the index holds.</p>
    {:else if layout === 'side-by-side'}
      <!--
        `role="presentation"` rather than `role="table"`: this is a CSS grid
        whose cells are direct children, so there is nowhere to hang the
        `row`/`cell` roles a table role obliges. Claiming to be a table with
        no rows in it is a worse answer for a screen reader than claiming
        nothing; the section around it is already the labelled landmark.
      -->
      <div class="table side" role="presentation">
        {#each rows as row, index (index)}
          {#if row.kind === 'fold'}
            <button class="fold" onclick={expand}>⋯ {row.count} unchanged lines</button>
          {:else}
            <div class="cell num">{row.before?.line ?? ''}</div>
            <!--
              The −/+ glyph is not decoration. Both halves were distinguished
              by a 12%-alpha wash and nothing else, which is WCAG 1.4.1
              (colour alone) and unreadable to anyone who cannot separate the
              red from the green. The sign column keeps its 1.2em even when
              empty, so context rows stay aligned with changed ones.
            -->
            <div
              class="cell text"
              class:removed={row.kind === 'change' && row.before !== null}
              class:pad={row.before === null}
            ><span class="sign">{row.kind === 'change' && row.before !== null ? '−' : ''}</span
              >{row.before?.text ?? ''}</div>
            <div class="cell num">{row.after?.line ?? ''}</div>
            <div
              class="cell text"
              class:added={row.kind === 'change' && row.after !== null}
              class:pad={row.after === null}
            ><span class="sign">{row.kind === 'change' && row.after !== null ? '+' : ''}</span
              >{row.after?.text ?? ''}</div>
          {/if}
        {/each}
      </div>
    {:else}
      <!-- Presentational for the same reason as the side-by-side grid above. -->
      <div class="table inline" role="presentation">
        {#each inline as row, index (index)}
          {#if row.kind === 'fold'}
            <button class="fold" onclick={expand}>⋯ {row.count} unchanged lines</button>
          {:else}
            <div class="cell num">{row.before?.line ?? ''}</div>
            <div class="cell num">{row.after?.line ?? ''}</div>
            <div class="cell text" class:removed={row.kind === 'removed'} class:added={row.kind === 'added'}>
              <span class="sign">{row.kind === 'removed' ? '−' : row.kind === 'added' ? '+' : ''}</span
              >{(row.before ?? row.after)?.text ?? ''}</div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .diff {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--nox-bg-editor);
  }

  header {
    display: flex;
    align-items: flex-start;
    gap: var(--nox-sp-4);
    padding: var(--nox-sp-4) var(--nox-sp-5) var(--nox-sp-3);
  }

  h2 {
    font-size: var(--nox-fs-md);
    margin: 0 0 2px;
  }

  .heading {
    min-width: 0;
  }

  .heading p {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
  }

  .name {
    color: var(--nox-text);
  }

  .folder {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tally {
    font-variant-numeric: tabular-nums;
  }

  .actions {
    display: flex;
    gap: var(--nox-sp-2);
    margin-left: auto;
    flex: none;
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 var(--nox-sp-5) var(--nox-sp-6);
  }

  .empty {
    padding: var(--nox-sp-4) 0;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
    max-width: 60ch;
    line-height: 1.5;
  }

  .table {
    display: grid;
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-sm);
    line-height: 1.6;
    border: 1px solid var(--nox-border-subtle);
    border-radius: var(--nox-r-md);
    overflow: hidden;
    min-width: min-content;
  }

  .table.side {
    grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr);
  }

  .table.inline {
    grid-template-columns: auto auto minmax(0, 1fr);
  }

  .cell {
    padding: 0 var(--nox-sp-3);
    white-space: pre;
  }

  .cell.num {
    color: var(--nox-gutter-fg);
    text-align: right;
    font-variant-numeric: tabular-nums;
    user-select: none;
    min-width: 3.5ch;
    background: var(--nox-bg-panel);
  }

  .cell.text.removed {
    background: color-mix(in srgb, var(--nox-danger) 12%, transparent);
  }

  .cell.text.added {
    background: color-mix(in srgb, var(--nox-success) 12%, transparent);
  }

  /* The empty half of an unpaired change row: quiet, but visibly not code. */
  .cell.text.pad {
    background: color-mix(in srgb, var(--nox-border-subtle) 40%, transparent);
  }

  .sign {
    display: inline-block;
    width: 1.2em;
    opacity: 0.6;
  }

  .fold {
    grid-column: 1 / -1;
    text-align: left;
    padding: 2px var(--nox-sp-3);
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-faint);
    background: var(--nox-bg-panel);
  }

  .fold:hover {
    color: var(--nox-text);
    background: var(--nox-hover);
  }
</style>
