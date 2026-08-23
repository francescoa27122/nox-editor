<script lang="ts">
  import PanelEmpty from './PanelEmpty.svelte';
  import PanelHeader from './PanelHeader.svelte';
  import { useApp } from './context';
  import Icon from './Icon.svelte';
  import { basename } from '@core/path';

  /**
   * Project-wide search results.
   *
   * Grouped by file, collapsible, and fully keyboard-navigable — the row list
   * comes from the service already flattened, so arrows step through files and
   * matches alike without the component knowing anything about the tree shape.
   */

  const app = useApp();
  const { search, ui, workspace } = app;

  const query = search.query;
  const options = search.options;
  const results = search.results;
  const status = search.status;
  const summary = search.summary;
  const collapsed = search.collapsed;
  const focused = search.focused;
  const rootPath = workspace.rootPath;
  /** Just the folder's name; the full path is too long for a sentence. */
  const rootName = $derived($rootPath ? basename($rootPath) : '');
  const focusRequest = ui.focusSearchRequest;
  const replacement = search.replacement;
  const replaceMode = search.replaceMode;
  const lastReplace = search.lastReplace;

  let input = $state<HTMLInputElement | null>(null);
  let listElement = $state<HTMLElement | null>(null);
  let showFilters = $state(false);

  let scrollTop = $state(0);
  let viewportHeight = $state(0);

  /**
   * The replacement preview, as a *derived closure*.
   *
   * `search.previewReplacement()` reads its inputs through `.get()`, which
   * Svelte cannot track — calling it straight from the markup would compute
   * the preview once and never update it as you type. Reading the signals here
   * makes the closure's identity change whenever they do, which is what
   * invalidates the rows that use it.
   */
  const previewReplacement = $derived.by(() => {
    void $replacement;
    void $options;
    void $query;
    return (match: { preview: string; column: number; length: number }) =>
      search.previewReplacement(match);
  });

  const rows = $derived.by(() => {
    // Track the signals the flattening depends on so this recomputes.
    void $results;
    void $collapsed;
    return search.rows();
  });

  /**
   * Windowing — the explorer's, over a list that fits it better.
   *
   * A search can put `MAX_RESULTS` (5000, `services/search.ts:43`) match rows
   * of six elements each in here, appended while the walk is still streaming,
   * which is exactly when the panel needs to stay responsive.
   * `search.rows()` is already the flat, ordered axis the arrows navigate, so
   * the window is a slice of it and nothing in the service changes. See
   * `docs/superpowers/specs/2026-08-20-explorer-virtualisation-design.md`.
   *
   * The height lives here and the CSS reads it back through
   * `--nox-search-row-h`, so the number the arithmetic uses and the number the
   * browser paints cannot drift apart. Its own property rather than the
   * explorer's `--nox-tree-row-h` because the two lists are different heights,
   * and a shared name would inherit one panel's row height into the other.
   *
   * Both kinds of row must be that one height for index arithmetic to be
   * valid: `.row` sets it, and `.row.file` / `.row.match` below vary only
   * padding, colour and font. Give either its own height and this breaks.
   */
  const ROW_HEIGHT = 22;
  const OVERSCAN = 8;
  /** Below this, the extra state costs more than the skipped rows save. */
  const MIN_ROWS_TO_WINDOW = 200;

  /**
   * What cannot be measured is not windowed.
   *
   * A viewport height of zero means "before layout" — or jsdom, which has no
   * layout at all. Windowing on that would render nothing, which is a far
   * worse failure than rendering too much.
   */
  const windowed = $derived(viewportHeight > 0 && rows.length > MIN_ROWS_TO_WINDOW);

  const firstIndex = $derived(
    windowed ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0,
  );
  const endIndex = $derived(
    windowed
      ? Math.min(rows.length, firstIndex + Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2)
      : rows.length,
  );
  const visibleRows = $derived(rows.slice(firstIndex, endIndex));
  const padTop = $derived(firstIndex * ROW_HEIGHT);
  const padBottom = $derived((rows.length - endIndex) * ROW_HEIGHT);

  function measure(): void {
    const height = listElement?.clientHeight ?? 0;
    if (height !== viewportHeight) viewportHeight = height;
  }

  $effect(() => {
    const element = listElement;
    if (!element) return;
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => observer.disconnect();
  });

  const totals = $derived.by(() => {
    const matches = $results.reduce((sum, file) => sum + file.matches.length, 0);
    return { matches, files: $results.length };
  });

  const statusLine = $derived.by(() => {
    if ($status === 'searching') {
      return totals.matches > 0
        ? `${totals.matches} in ${totals.files} files…`
        : 'Searching…';
    }
    if ($status !== 'done') return '';
    if ($summary?.error) return $summary.error;
    if (totals.matches === 0) return 'No results';

    const base = `${totals.matches} ${totals.matches === 1 ? 'result' : 'results'} in ${totals.files} ${totals.files === 1 ? 'file' : 'files'}`;
    return $summary?.truncated ? `${base} (stopped at the limit)` : base;
  });

  /**
   * The header's right-hand summary. The status line under the controls owns
   * the detail; this is the glanceable half, and it stays blank while idle so
   * the header does not assert a count nobody asked for.
   */
  const headerSummary = $derived(
    $status === 'done' && totals.matches > 0
      ? `${totals.matches} in ${totals.files}`
      : undefined,
  );

  $effect(() => {
    void $focusRequest;
    input?.focus();
    input?.select();
  });

  /**
   * Keep the focused row on screen, by arithmetic rather than by element.
   *
   * This was `querySelector('.row.focused')?.scrollIntoView()`, which stopped
   * being possible the moment the focused row can be outside the window —
   * precisely when scrolling to it matters. Working from the index needs no
   * row in the DOM, and no `scrollIntoView`, which jsdom does not implement.
   */
  function revealFocused(): void {
    const element = listElement;
    const index = $focused;
    if (!element || index < 0) return;

    measure();
    const height = viewportHeight || element.clientHeight;
    if (height <= 0) return;

    const top = index * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + height) {
      element.scrollTop = top + ROW_HEIGHT - height;
    }
    // Written back here rather than waited for: setting `scrollTop` does not
    // reliably emit a scroll event, and the next window must not lag a frame
    // behind the row it was asked to show.
    scrollTop = element.scrollTop;
  }

  $effect(() => {
    void $focused;
    queueMicrotask(revealFocused);
  });

  function onQueryKeydown(event: KeyboardEvent) {
    switch (event.key) {
      case 'Enter':
        event.preventDefault();
        void search.run();
        break;
      case 'ArrowDown':
        event.preventDefault();
        search.moveFocus(1);
        listElement?.focus();
        break;
      case 'Escape':
        event.preventDefault();
        if ($query.length > 0) search.clear();
        else ui.focusEditor();
        break;
    }
  }

  async function onListKeydown(event: KeyboardEvent) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        search.moveFocus(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if ($focused <= 0) {
          search.focused.set(-1);
          input?.focus();
        } else {
          search.moveFocus(-1);
        }
        break;
      case 'Enter':
        event.preventDefault();
        await search.activateFocused();
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        const row = rows[$focused];
        if (!row) return;
        const file = $results[row.fileIndex];
        if (!file) return;
        const isCollapsed = $collapsed.has(file.path);
        // Left collapses (or jumps to the group header), right expands.
        if (event.key === 'ArrowLeft' && !isCollapsed) {
          event.preventDefault();
          search.toggleFile(file.path);
        } else if (event.key === 'ArrowRight' && isCollapsed) {
          event.preventDefault();
          search.toggleFile(file.path);
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        input?.focus();
        break;
    }
  }
</script>

<div class="search-panel">
  <!--
    Search was the one sidebar panel with no header, so it was also the one
    with no landmark and no name on screen — every other panel announces
    itself in 10px uppercase and this opened straight onto an input.
  -->
  <PanelHeader title="Search" summary={headerSummary} />

  <div class="controls">
    <button
      class="replace-toggle"
      aria-label={$replaceMode ? 'Hide replace' : 'Show replace'}
      aria-expanded={$replaceMode}
      title={$replaceMode ? 'Hide replace' : 'Show replace'}
      onclick={() => search.showReplace(!$replaceMode)}
    >
      <Icon name={$replaceMode ? 'chevron-down' : 'chevron-right'} size={12} />
    </button>

    <div class="field" class:invalid={Boolean($summary?.error)}>
      <Icon name="search" size={13} class="field-icon" />
      <input
        bind:this={input}
        type="text"
        placeholder="Search project"
        aria-label="Search project"
        spellcheck="false"
        autocomplete="off"
        value={$query}
        oninput={(event) => search.setQuery(event.currentTarget.value)}
        onkeydown={onQueryKeydown}
      />
      <div class="toggles">
        <button
          class="toggle"
          class:on={$options.caseSensitive}
          title="Match case"
          aria-label="Match case"
          aria-pressed={$options.caseSensitive}
          onclick={() => search.toggle('caseSensitive')}
        >
          <Icon name="case-sensitive" size={13} />
        </button>
        <button
          class="toggle"
          class:on={$options.wholeWord}
          title="Match whole word"
          aria-label="Match whole word"
          aria-pressed={$options.wholeWord}
          onclick={() => search.toggle('wholeWord')}
        >
          <Icon name="whole-word" size={13} />
        </button>
        <button
          class="toggle"
          class:on={$options.regexp}
          title="Use regular expression"
          aria-label="Use regular expression"
          aria-pressed={$options.regexp}
          onclick={() => search.toggle('regexp')}
        >
          <Icon name="regex" size={13} />
        </button>
        <!--
          Only with replace showing: preserve-case is a property of the
          *replacement*, and it sat in the search row whether or not there was
          one — a fourth unexplained toggle crowding a 100px input, controlling
          something not on screen.
        -->
        {#if $replaceMode}
          <button
            class="toggle"
            class:on={$options.preserveCase}
            title="Preserve case in replacements"
            aria-label="Preserve case in replacements"
            aria-pressed={$options.preserveCase}
            onclick={() => search.toggle('preserveCase')}
          >
            <span class="preserve-case-label">AB</span>
          </button>
        {/if}
      </div>
    </div>

    <button
      class="filters-toggle"
      class:on={showFilters}
      aria-expanded={showFilters}
      title="Filter by file"
      aria-label="Filter by file"
      onclick={() => (showFilters = !showFilters)}
    >
      <Icon name={showFilters ? 'chevron-down' : 'chevron-right'} size={12} />
    </button>
  </div>

  {#if $replaceMode}
    <div class="replace-row">
      <div class="field">
        <Icon name="replace" size={13} class="field-icon" />
        <input
          type="text"
          placeholder={$options.regexp ? 'Replace (use $1 for groups)' : 'Replace'}
          aria-label="Replace with"
          spellcheck="false"
          autocomplete="off"
          value={$replacement}
          oninput={(event) => search.setReplacement(event.currentTarget.value)}
          onkeydown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void app.replaceAcrossProject();
          }}
        />
      </div>
      <button
        class="replace-all"
        disabled={totals.matches === 0}
        title="Replace all matches in the project"
        onclick={() => void app.replaceAcrossProject()}
      >
        Replace All
      </button>
    </div>
  {/if}

  {#if $lastReplace}
    <div class="undo-bar">
      <span>
        Replaced in {$lastReplace.length}
        {$lastReplace.length === 1 ? 'file' : 'files'}
      </span>
      <button onclick={() => void app.undoProjectReplace()}>Undo</button>
    </div>
  {/if}

  {#if showFilters}
    <div class="filters">
      <label>
        <span>Include</span>
        <input
          type="text"
          placeholder="*.ts, src/**"
          spellcheck="false"
          value={$options.includes}
          oninput={(event) => search.setOption('includes', event.currentTarget.value)}
        />
      </label>
      <label>
        <span>Exclude</span>
        <input
          type="text"
          placeholder="*.test.ts"
          spellcheck="false"
          value={$options.excludes}
          oninput={(event) => search.setOption('excludes', event.currentTarget.value)}
        />
      </label>
      <button
        class="ignore-toggle"
        class:on={$options.respectGitIgnore}
        aria-pressed={$options.respectGitIgnore}
        onclick={() => search.toggle('respectGitIgnore')}
      >
        <Icon name={$options.respectGitIgnore ? 'check' : 'close'} size={11} />
        Respect .gitignore
      </button>
    </div>
  {/if}

  <div class="status">
    <span class:searching={$status === 'searching'} class:error={Boolean($summary?.error)}>
      {statusLine}
    </span>
    {#if $results.length > 0}
      <button
        class="mini"
        title="Collapse all"
        aria-label="Collapse all results"
        onclick={() => ($collapsed.size === $results.length ? search.expandAll() : search.collapseAll())}
      >
        <Icon name="collapse" size={12} />
      </button>
    {/if}
  </div>

  {#if !$rootPath}
    <PanelEmpty action={{ label: 'Open Folder', run: () => void app.commands.execute('file.openFolder') }}>
      Open a folder to search it.
    </PanelEmpty>
    <!--
      The two states below were a blank rectangle: every other panel says what
      it is waiting for, and this one showed an empty listbox whether you had
      typed nothing or had typed something with no matches. The status line
      does say "No results", but in 11px grey above an empty void — the panel
      read as broken rather than as empty.
    -->
  {:else if $query.trim() === ''}
    <PanelEmpty>
      Search every file in <strong>{rootName}</strong>. Results group by file;
      <strong>Enter</strong> opens the focused one.
    </PanelEmpty>
  {:else if $status === 'done' && !$summary?.error && totals.matches === 0}
    <PanelEmpty>
      No matches for <strong>{$query}</strong>. Case, whole word and regular
      expressions are the toggles beside the box.
    </PanelEmpty>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <div
      class="results nox-scroll"
      role="listbox"
      aria-label="Search results"
      tabindex="0"
      bind:this={listElement}
      style="--nox-search-row-h: {ROW_HEIGHT}px"
      onscroll={(event) => {
        // Two number writes per scroll event, against the several thousand
        // elements the unwindowed list put in the DOM — the cheapest half of
        // this trade by a wide margin.
        scrollTop = event.currentTarget.scrollTop;
        measure();
      }}
      onkeydown={onListKeydown}
    >
      {#if padTop > 0}
        <div class="spacer" style="height: {padTop}px" role="presentation"></div>
      {/if}
      <!-- `aria-setsize` / `aria-posinset` below are mandatory, not decorative:
           once rows leave the DOM a screen reader would otherwise be told the
           result list is exactly as long as the window. -->
      {#each visibleRows as row, offset (row.kind + row.fileIndex + ':' + row.matchIndex)}
        {@const index = firstIndex + offset}
        {@const file = $results[row.fileIndex]}
        {#if file}
          {#if row.kind === 'file'}
            {@const label = search.labelFor(file.path)}
            <div
              class="row file"
              class:focused={index === $focused}
              role="option"
              aria-selected={index === $focused}
              aria-setsize={rows.length}
              aria-posinset={index + 1}
              tabindex="-1"
              title={file.path}
              onclick={() => {
                search.focused.set(index);
                search.toggleFile(file.path);
              }}
              onkeydown={() => {}}
            >
              <Icon
                name={$collapsed.has(file.path) ? 'chevron-right' : 'chevron-down'}
                size={12}
                class="twisty"
              />
              <span class="name">{label.name}</span>
              {#if label.folder}<span class="folder">{label.folder}</span>{/if}
              <span class="count">{file.matches.length}</span>
              {#if $replaceMode}
                <button
                  class="row-action"
                  aria-label="Replace all in {label.name}"
                  title="Replace all in this file"
                  onclick={(event) => {
                    event.stopPropagation();
                    void app.replaceInOneFile(file.path);
                  }}
                >
                  <Icon name="replace" size={11} />
                </button>
              {/if}
              <button
                class="row-action"
                aria-label="Dismiss results for {label.name}"
                title="Dismiss"
                onclick={(event) => {
                  event.stopPropagation();
                  search.dismissFile(file.path);
                }}
              >
                <Icon name="close" size={10} />
              </button>
            </div>
          {:else}
            {@const match = file.matches[row.matchIndex]}
            {#if match}
              <div
                class="row match"
                class:focused={index === $focused}
                role="option"
                aria-selected={index === $focused}
                aria-setsize={rows.length}
                aria-posinset={index + 1}
                tabindex="-1"
                title="Line {match.line}"
                onclick={() => {
                  search.focused.set(index);
                  void search.openMatch(file.path, match);
                }}
                onkeydown={() => {}}
              >
                <span class="line-number">{match.line}</span>
                <span class="preview">
                  <span class="lead">{match.preview.slice(0, match.column)}</span><mark
                    class:removed={$replaceMode}
                    >{match.preview.slice(match.column, match.column + match.length)}</mark
                  >{#if $replaceMode}{@const next = previewReplacement(match)}{#if next}<mark
                        class="added">{next}</mark
                      >{/if}{/if}<span class="tail"
                    >{match.preview.slice(match.column + match.length)}</span
                  >
                </span>
                {#if $replaceMode}
                  <button
                    class="row-action"
                    aria-label="Replace this match on line {match.line}"
                    title="Replace this match"
                    onclick={(event) => {
                      event.stopPropagation();
                      void app.replaceOneMatch(file.path, match);
                    }}
                  >
                    <Icon name="replace" size={11} />
                  </button>
                {/if}
                <button
                  class="row-action"
                  aria-label="Dismiss the match on line {match.line}"
                  title="Dismiss this match"
                  onclick={(event) => {
                    event.stopPropagation();
                    search.dismissMatch(file.path, match);
                  }}
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            {/if}
          {/if}
        {/if}
      {/each}
      {#if padBottom > 0}
        <div class="spacer" style="height: {padBottom}px" role="presentation"></div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .search-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-1);
    flex: none;
    padding: var(--nox-sp-2) var(--nox-sp-3) var(--nox-sp-3);
  }

  .field {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    flex: 1;
    min-width: 0;
    height: 26px;
    padding: 0 var(--nox-sp-1) 0 var(--nox-sp-3);
    background: var(--nox-bg-inset);
    border: 1px solid var(--nox-border);
    border-radius: var(--nox-r-md);
    transition: border-color var(--nox-dur-fast) var(--nox-ease);
  }

  .field:focus-within {
    border-color: var(--nox-border-accent);
  }

  .field.invalid {
    border-color: var(--nox-danger);
  }

  .field :global(.field-icon) {
    color: var(--nox-text-faint);
    flex: none;
  }

  .field input {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    outline: none;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-bright);
    user-select: text;
  }

  .field input::placeholder {
    color: var(--nox-text-faint);
  }

  .toggles {
    display: flex;
    gap: 1px;
    flex: none;
  }

  .toggle {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-faint);
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .toggle:hover {
    background: var(--nox-hover);
    color: var(--nox-text);
  }

  .toggle.on {
    background: var(--nox-active);
    color: var(--nox-accent);
  }

  .preserve-case-label {
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    line-height: 1;
  }

  .replace-toggle {
    display: grid;
    place-items: center;
    width: 18px;
    height: 26px;
    flex: none;
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-faint);
  }

  .replace-toggle:hover {
    color: var(--nox-text);
    background: var(--nox-hover);
  }

  .replace-row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    flex: none;
    padding: 0 var(--nox-sp-3) var(--nox-sp-3) calc(var(--nox-sp-3) + 18px + var(--nox-sp-1));
  }

  .replace-all {
    flex: none;
    height: 26px;
    padding: 0 var(--nox-sp-4);
    border: 1px solid var(--nox-border-strong);
    border-radius: var(--nox-r-md);
    font-size: var(--nox-fs-xs);
    color: var(--nox-text);
    white-space: nowrap;
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      border-color var(--nox-dur-fast) var(--nox-ease);
  }

  .replace-all:hover:not(:disabled) {
    background: var(--nox-hover);
    border-color: var(--nox-border-accent);
    color: var(--nox-text-bright);
  }

  .replace-all:disabled {
    opacity: 0.4;
  }

  .undo-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nox-sp-3);
    flex: none;
    margin: 0 var(--nox-sp-3) var(--nox-sp-3);
    padding: var(--nox-sp-2) var(--nox-sp-2) var(--nox-sp-2) var(--nox-sp-4);
    background: color-mix(in srgb, var(--nox-success) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--nox-success) 28%, transparent);
    border-radius: var(--nox-r-md);
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
  }

  .undo-bar button {
    flex: none;
    padding: 2px var(--nox-sp-3);
    border-radius: var(--nox-r-sm);
    color: var(--nox-accent);
    font-size: var(--nox-fs-xs);
  }

  .undo-bar button:hover {
    background: var(--nox-hover);
  }

  .filters-toggle {
    display: grid;
    place-items: center;
    width: 20px;
    height: 26px;
    flex: none;
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-faint);
  }

  .filters-toggle:hover,
  .filters-toggle.on {
    color: var(--nox-text);
  }

  .filters {
    display: flex;
    flex-direction: column;
    gap: var(--nox-sp-2);
    flex: none;
    padding: 0 var(--nox-sp-3) var(--nox-sp-3);
  }

  .filters label {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    font-size: var(--nox-fs-2xs);
    color: var(--nox-text-faint);
    text-transform: uppercase;
    letter-spacing: var(--nox-tracking-wide);
  }

  .filters label span {
    width: 4.5em;
    flex: none;
  }

  .filters input {
    flex: 1;
    min-width: 0;
    height: 22px;
    padding: 0 var(--nox-sp-3);
    background: var(--nox-bg-inset);
    border: 1px solid var(--nox-border);
    border-radius: var(--nox-r-sm);
    color: var(--nox-text);
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-xs);
    outline: none;
    text-transform: none;
    letter-spacing: normal;
    user-select: text;
  }

  .filters input:focus {
    border-color: var(--nox-border-accent);
  }

  .ignore-toggle {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    align-self: flex-start;
    padding: 2px var(--nox-sp-2);
    border-radius: var(--nox-r-sm);
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-faint);
  }

  .ignore-toggle:hover {
    background: var(--nox-hover);
  }

  .ignore-toggle.on {
    color: var(--nox-accent);
  }

  .status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nox-sp-3);
    flex: none;
    min-height: 20px;
    padding: 0 var(--nox-sp-3) var(--nox-sp-2) var(--nox-sp-4);
    font-size: var(--nox-fs-2xs);
    color: var(--nox-text-faint);
    font-variant-numeric: tabular-nums;
  }

  .status .searching {
    color: var(--nox-accent);
  }

  .status .error {
    color: var(--nox-danger);
  }

  .mini {
    display: grid;
    place-items: center;
    width: 20px;
    height: 18px;
    flex: none;
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-faint);
  }

  .mini:hover {
    background: var(--nox-hover);
    color: var(--nox-text);
  }

  .results {
    flex: 1;
    min-height: 0;
    padding-bottom: var(--nox-sp-6);
    border-top: 1px solid var(--nox-border);
  }

  .results:focus-visible {
    box-shadow: inset 0 0 0 1px var(--nox-border-accent);
    border-radius: 0;
  }

  /* Spacers stand in for the rows outside the window, so the scrollbar
     describes the whole result list and every rendered row keeps its true
     offset. */
  .spacer {
    flex: none;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    /* Set from ROW_HEIGHT above: the arithmetic and the paint share one
       number, and both kinds of row must keep it. */
    height: var(--nox-search-row-h, 22px);
    padding-right: var(--nox-sp-2);
    font-size: var(--nox-fs-sm);
    cursor: default;
    position: relative;
  }

  .row:hover {
    background: var(--nox-hover);
  }

  .row.focused {
    background: var(--nox-selected);
  }

  .row.file {
    padding-left: var(--nox-sp-2);
    color: var(--nox-text);
  }

  .row.file :global(.twisty) {
    color: var(--nox-text-faint);
    flex: none;
  }

  .name {
    flex: none;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .folder {
    flex: 1;
    min-width: 0;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }

  .count {
    flex: none;
    margin-left: auto;
    padding: 0 var(--nox-sp-2);
    border-radius: var(--nox-r-full);
    background: var(--nox-bg-inset);
    color: var(--nox-text-muted);
    font-size: var(--nox-fs-2xs);
  }

  .row-action {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    flex: none;
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-faint);
    opacity: 0;
    transition: opacity var(--nox-dur-fast) var(--nox-ease);
  }

  /* Both row kinds reveal their actions the same way. Kept as one rule per
     kind rather than a bare `.row:hover` so the spacer divs, which carry no
     `.row` class but sit in the same list, stay out of it. */
  .row.file:hover .row-action,
  .row.file.focused .row-action,
  .row.match:hover .row-action,
  .row.match.focused .row-action,
  .row-action:focus-visible {
    opacity: 1;
  }

  .row-action:hover {
    background: var(--nox-active);
    color: var(--nox-text-bright);
  }

  .row.match {
    padding-left: var(--nox-sp-6);
    color: var(--nox-text-muted);
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-xs);
  }

  .line-number {
    flex: none;
    min-width: 3ch;
    text-align: right;
    color: var(--nox-gutter-fg);
  }

  .preview {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
  }

  .preview mark {
    background: var(--nox-search-match);
    color: var(--nox-text-bright);
    border-radius: 2px;
  }

  .row.focused .preview mark {
    background: var(--nox-search-match-active);
  }

  /* Replace preview reads as a diff: what goes, then what arrives. */
  .preview mark.removed {
    background: color-mix(in srgb, var(--nox-danger) 16%, transparent);
    color: var(--nox-danger);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--nox-danger) 60%, transparent);
  }

  .preview mark.added {
    background: color-mix(in srgb, var(--nox-success) 16%, transparent);
    color: var(--nox-success);
    text-decoration: none;
  }

  .row.focused .preview mark.removed {
    background: color-mix(in srgb, var(--nox-danger) 24%, transparent);
  }

  .row.focused .preview mark.added {
    background: color-mix(in srgb, var(--nox-success) 24%, transparent);
  }

  .lead,
  .tail {
    color: inherit;
  }
</style>
