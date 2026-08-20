<script lang="ts">
  import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
  import { basename, dirname, relative } from '@core/path';
  import { fuzzyFilter, fuzzyMatch, fuzzyMatchPath, segmentMatch } from '@core/fuzzy';
  import { createSymbolCache, symbolListState, type SymbolKind } from '@core/symbols';
  import { cachedLanguage, hasGrammar } from '@editor/languages';
  import type { Command } from '@services/commands';
  import { formatChord, normalizeChord } from '@services/keymap';
  import type { OverlayKind } from '@services/ui';
  import { useApp } from './context';
  import Icon, { type IconName } from './Icon.svelte';

  /**
   * One component serves the command palette, quick open, the buffer switcher,
   * go-to-line and go-to-symbol.
   *
   * They share an input, a result list, ranking and keyboard handling — only
   * the item source and the accept action differ. Prefixes (`>`, `~`, `:`,
   * `@`) switch between them mid-typing, so a single muscle memory covers all
   * five.
   */

  interface Props {
    mode: OverlayKind;
  }

  let { mode }: Props = $props();

  const app = useApp();
  const { commands, workspace, files, keymap, ui } = app;

  const fileIndex = files.fileIndex;
  const buffers = workspace.buffers;
  const recentFiles = workspace.recentFiles;
  const rootPath = workspace.rootPath;
  const commandVersion = commands.version;

  let input = $state<HTMLInputElement | null>(null);
  let listElement = $state<HTMLElement | null>(null);
  // Intentionally a one-time seed: Overlays keys this component on the mode,
  // so a mode change remounts rather than mutating the query mid-typing.
  // svelte-ignore state_referenced_locally
  let text = $state(initialText(mode));
  let selected = $state(0);

  function initialText(kind: OverlayKind): string {
    if (kind === 'palette') return '>';
    if (kind === 'buffers') return '~';
    if (kind === 'go-to-line') return ':';
    if (kind === 'go-to-symbol') return '@';
    return '';
  }

  /** The active mode, which the prefix can change without reopening. */
  const effectiveMode = $derived.by<'commands' | 'files' | 'buffers' | 'line' | 'symbols'>(() => {
    if (text.startsWith('>')) return 'commands';
    if (text.startsWith('~')) return 'buffers';
    if (text.startsWith(':')) return 'line';
    if (text.startsWith('@')) return 'symbols';
    return 'files';
  });

  const term = $derived(
    effectiveMode === 'files' ? text.trim() : text.slice(1).trim(),
  );

  const placeholder = $derived.by(() => {
    switch (effectiveMode) {
      case 'commands':
        return 'Search commands…';
      case 'buffers':
        return 'Switch to an open file…';
      case 'line':
        return 'Go to line:column…';
      case 'symbols':
        return 'Go to a symbol in this file…';
      default:
        return 'Search files by name…';
    }
  });

  const modeIcon = $derived.by<IconName>(() => {
    switch (effectiveMode) {
      case 'commands':
        return 'command';
      case 'buffers':
        return 'file';
      case 'line':
        return 'arrow-down';
      case 'symbols':
        return 'dot';
      default:
        return 'search';
    }
  });

  /**
   * Skips the walk while the tree stands still. `rows` recomputes on every
   * keystroke and the palette is remounted per opening, so one cache per
   * mount is exactly the lifetime the file being looked at has.
   */
  const symbolsFor = createSymbolCache();

  interface Row {
    key: string;
    title: string;
    /** Highlight positions into `title`. */
    positions: number[];
    detail?: string;
    badge?: string;
    hint?: string;
    /**
     * The keyword this row matched on, when the title itself did not match.
     * Rendered as a chip so a keyword hit does not look like a mis-hit with
     * zero highlighted characters.
     */
    keyword?: string;
    disabled?: boolean;
    icon: IconName;
    accept: () => void;
  }

  /**
   * `total` is the real match count before the per-mode display caps, so the
   * header count can be honest about truncation ("first M of N") instead of
   * presenting the sliced length as the whole story.
   */
  interface RowsResult {
    rows: Row[];
    total: number;
  }

  const result = $derived.by<RowsResult>(() => {
    void $commandVersion;
    if (effectiveMode === 'commands') return commandRows(term);
    if (effectiveMode === 'buffers') return bufferRows(term);
    if (effectiveMode === 'line') return lineRows(term);
    if (effectiveMode === 'symbols') return symbolRows(term);
    return fileRows(term);
  });
  const rows = $derived(result.rows);
  const total = $derived(result.total);

  /**
   * Where the cursor lands when the result set changes.
   *
   * Normally the top match. The buffer switcher opens on the *second* entry
   * instead, because the first is the file you are already looking at — the
   * whole point of the switcher is getting back to the one before it.
   */
  const defaultIndex = $derived(
    effectiveMode === 'buffers' && term.length === 0 && rows.length > 1 ? 1 : 0,
  );

  $effect(() => {
    void rows;
    selected = defaultIndex;
  });

  $effect(() => {
    input?.focus();
  });

  function commandRows(query: string): RowsResult {
    const scored: { row: Row; score: number }[] = [];

    for (const command of commands.palette()) {
      const label = command.category ? `${command.category}: ${command.title}` : command.title;
      const match = fuzzyMatch(query, label);
      const keywordMatch = match ? null : matchAgainstKeywords(query, command);
      const won = match ?? keywordMatch;
      if (!won) continue;

      const enabled = commands.isEnabled(command.id);
      // Application bindings win; `keyHint` covers the CodeMirror-owned ones.
      const hint =
        keymap.displayFor(command.id) ??
        (command.keyHint ? formatChord(normalizeChord(command.keyHint)) : undefined);
      scored.push({
        score: won.score - (enabled ? 0 : 1000),
        row: {
          key: command.id,
          title: label,
          positions: match ? match.positions : [],
          disabled: !enabled,
          icon: 'command',
          ...(hint ? { hint } : {}),
          // Only a keyword-won match carries the chip; a title hit already
          // shows where it landed via the highlights.
          ...(keywordMatch ? { keyword: keywordMatch.keyword } : {}),
          accept: () => {
            ui.closeOverlay();
            void commands.execute(command.id);
          },
        },
      });
    }

    scored.sort((a, b) => b.score - a.score);

    // With an empty query, float this session's recently-run commands to the
    // top in most-recent-first order, skipping any that are disabled right
    // now; everything else keeps its order below. With a query the ranking
    // stays pure fuzzy score — no recency blending. Decision: the command set
    // is small, and a predictable "what you typed wins" ranking beats a
    // cleverer one that reorders under your fingers.
    if (query.length === 0) {
      const rank = new Map(commands.recentCommands().map((id, index) => [id, index]));
      const recent: typeof scored = [];
      const rest: typeof scored = [];
      for (const entry of scored) {
        if (!entry.row.disabled && rank.has(entry.row.key)) recent.push(entry);
        else rest.push(entry);
      }
      recent.sort((a, b) => rank.get(a.row.key)! - rank.get(b.row.key)!);
      scored.length = 0;
      scored.push(...recent, ...rest);
    }

    return { rows: scored.slice(0, 200).map((s) => s.row), total: scored.length };
  }

  function matchAgainstKeywords(query: string, command: Command) {
    for (const keyword of command.keywords ?? []) {
      const match = fuzzyMatch(query, keyword);
      // Keyword hits rank below title hits so exact titles always win. The
      // keyword itself travels along so the row can say what it matched on.
      if (match) return { score: match.score * 0.6, positions: [] as number[], keyword };
    }
    return null;
  }

  function fileRows(query: string): RowsResult {
    const root = $rootPath;
    const candidates = query.length === 0 ? recentFirst() : $fileIndex;

    const scored: { row: Row; score: number }[] = [];
    for (const path of candidates) {
      const display = root ? relative(root, path) : path;
      const nameStart = display.length - basename(display).length;
      const match = fuzzyMatchPath(query, display, nameStart);
      if (!match) continue;

      const name = basename(display);
      const folder = dirname(display);
      // Highlights are computed against the full display path; shift them
      // onto the filename, which is what the row actually renders.
      const positions = match.positions
        .filter((p) => p >= nameStart)
        .map((p) => p - nameStart);

      scored.push({
        score: match.score,
        row: {
          key: path,
          title: name,
          positions,
          icon: 'file',
          ...(folder ? { detail: folder } : {}),
          accept: () => {
            ui.closeOverlay();
            void workspace.open(path);
          },
        },
      });
      if (scored.length > 4000) break;
    }

    scored.sort((a, b) => b.score - a.score);
    // `total` is capped by the 4000-candidate scoring break above, so on a
    // huge index it is a lower bound — still far more honest than the slice.
    return { rows: scored.slice(0, 100).map((s) => s.row), total: scored.length };
  }

  /**
   * Open buffers, most recently used first.
   *
   * Distinct from quick open on purpose: this searches what is already open,
   * ranked by when you last looked at it, so it answers "take me back" rather
   * than "find me this file". With no query the order is left alone — MRU is
   * the ranking, and fuzzy scoring would only scramble it.
   */
  function bufferRows(query: string): RowsResult {
    // Establishes the reactive dependency; the order itself comes from the
    // MRU list, which the snapshot signal does not carry.
    void $buffers;
    const root = $rootPath;

    const scored: { row: Row; score: number; order: number }[] = [];
    workspace.recentBuffers().forEach((buffer, order) => {
      const match = query.length === 0 ? { score: 0, positions: [] } : fuzzyMatch(query, buffer.name);
      if (!match) return;

      const folder = buffer.path ? dirname(root ? relative(root, buffer.path) : buffer.path) : '';
      scored.push({
        score: match.score,
        order,
        row: {
          key: buffer.id,
          title: buffer.name,
          positions: match.positions,
          icon: 'file',
          ...(folder && folder !== '.' ? { detail: folder } : {}),
          ...(buffer.isDirty ? { badge: 'unsaved' } : {}),
          accept: () => {
            ui.closeOverlay();
            workspace.setActive(buffer.id);
            ui.focusEditor();
          },
        },
      });
    });

    // Score first, then MRU as the tie-break — which with no query is the
    // only thing separating them.
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    // No display cap here: every open buffer is shown, so total === rows.
    return { rows: scored.map((s) => s.row), total: scored.length };
  }

  /** With an empty query, show recents first — that is what people want. */
  function recentFirst(): string[] {
    const recents = $recentFiles;
    const seen = new Set(recents);
    return [...recents, ...$fileIndex.filter((p) => !seen.has(p))].slice(0, 100);
  }

  function lineRows(query: string): RowsResult {
    const view = app.view.get();
    if (!view) return { rows: [], total: 0 };

    // Named to stay clear of the component-level `total` derived above.
    const totalLines = view.state.doc.lines;
    const [rawLine, rawColumn] = query.split(':');
    const line = Number.parseInt(rawLine ?? '', 10);
    const column = Number.parseInt(rawColumn ?? '', 10);

    if (!Number.isFinite(line)) {
      return {
        rows: [
          {
            key: 'goto-hint',
            title: `Current file has ${totalLines} lines`,
            positions: [],
            detail: 'Type a line number, optionally line:column',
            disabled: true,
            icon: 'info',
            accept: () => {},
          },
        ],
        total: 1,
      };
    }

    const clamped = Math.min(Math.max(1, line), totalLines);
    const preview = view.state.doc.line(clamped).text.trim().slice(0, 90);

    return {
      rows: [
        {
          key: 'goto',
          title: `Go to line ${clamped}${Number.isFinite(column) ? `, column ${column}` : ''}`,
          positions: [],
          icon: 'arrow-down',
          ...(preview ? { detail: preview } : {}),
          ...(line !== clamped ? { badge: `clamped from ${line}` } : {}),
          accept: () => {
            ui.closeOverlay();
            app.goToLine(clamped, Number.isFinite(column) ? column : 1);
          },
        },
      ],
      total: 1,
    };
  }

  /**
   * How long to spend parsing before listing what we have.
   *
   * The palette is a keystroke-latency surface, so this is a budget rather
   * than a wait. Past it the list is honest about being partial instead of
   * looking complete.
   */
  const PARSE_BUDGET_MS = 100;

  /** One word per kind, shown in the row's detail. */
  const KIND_LABEL: Record<SymbolKind, string> = {
    function: 'function',
    class: 'class',
    interface: 'interface',
    type: 'type',
    enum: 'enum',
    module: 'module',
    rule: 'rule',
    heading: 'heading',
  };

  /** A single disabled row, the shape `lineRows` uses to explain an empty list. */
  function hintRow(title: string, detail: string): RowsResult {
    return {
      rows: [
        { key: 'symbol-hint', title, positions: [], detail, disabled: true, icon: 'info', accept: () => {} },
      ],
      total: 1,
    };
  }

  function symbolRows(query: string): RowsResult {
    const view = app.view.get();
    // Settled before there is anything to parse or a language to ask about,
    // which is why it is the one state `symbolListState` does not name.
    if (!view) return hintRow('No file is open', 'Open a file to list its symbols');

    const buffer = workspace.active();

    // `syntaxTree` returns only what has been parsed so far, so on a large
    // file a plain read silently stops partway and the list *looks* complete.
    // `ensureSyntaxTree` forces the rest with a deadline and returns null when
    // it cannot finish in it. A language with no grammar, or one whose
    // grammar has not loaded, has no parser to spend that deadline on and
    // comes straight back.
    const tree = ensureSyntaxTree(view.state, view.state.doc.length, PARSE_BUDGET_MS);
    const symbols = symbolsFor(tree ?? syntaxTree(view.state), view.state.doc);

    // Which of the five things this list is saying — the branching lives in
    // `core/` where it can be tested, and the sentences live here, because
    // that is all this component is deciding. `hasGrammar(id) &&
    // !cachedLanguage(id)` is the same pairing that guards the reconfigure at
    // EditorPane.svelte:150.
    const state = symbolListState({
      language: buffer ? buffer.language.name : null,
      hasGrammar: buffer ? hasGrammar(buffer.language.id) : true,
      grammarLoaded: buffer ? cachedLanguage(buffer.language.id) !== null : true,
      parsed: tree !== null,
      count: symbols.length,
    });

    switch (state.kind) {
      case 'no-grammar':
        return hintRow(
          `Nox has no parser for ${state.language}`,
          'Symbols come from the grammar, the same one syntax highlighting uses',
        );
      case 'loading-grammar':
        return hintRow('Loading the grammar for this file', 'Reopen this list once it is ready');
      case 'still-parsing':
        return hintRow('Still parsing this file', 'More symbols may appear');
      case 'no-symbols':
        return hintRow(
          'No functions or classes in this file',
          'Only structure is listed, not variables',
        );
    }

    // No limit passed: `fuzzyFilter` sorts the full match set before any
    // slice regardless, and the pre-slice count is what makes the header
    // count honest when the 200-cap truncates a fully-parsed file.
    const matches = query
      ? fuzzyFilter(query, symbols, (s) => s.qualified)
      : symbols.map((item) => ({ item, score: 0, positions: [] as number[] }));
    const scored = matches.slice(0, 200);

    const built = scored.map(({ item, positions }) => {
      // The symbol's start, not the start of its line: §7 says accepting puts
      // the cursor on the symbol, and `goToLine` already takes the column.
      const line = view.state.doc.lineAt(item.from);
      return {
        key: `${item.from}:${item.qualified}`,
        title: item.qualified,
        positions,
        detail: KIND_LABEL[item.kind],
        icon: 'dot' as const,
        accept: () => {
          ui.closeOverlay();
          app.goToLine(line.number, item.from - line.from + 1);
        },
      };
    });

    const rows = state.partial
      ? [
          ...built,
          {
            key: 'symbol-partial',
            title: 'Still parsing this file',
            positions: [],
            detail: 'More symbols may appear',
            disabled: true,
            icon: 'info' as const,
            accept: () => {},
          },
        ]
      : built;
    // The appended "still parsing" hint counts on both sides so an uncapped
    // partial list still renders a plain count rather than "first N of N-1".
    return { rows, total: matches.length + (state.partial ? 1 : 0) };
  }

  function move(delta: number) {
    if (rows.length === 0) return;
    selected = (selected + delta + rows.length) % rows.length;
    queueMicrotask(() => {
      listElement?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  function onKeydown(event: KeyboardEvent) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        move(8);
        break;
      case 'PageUp':
        event.preventDefault();
        move(-8);
        break;
      case 'Enter': {
        event.preventDefault();
        const row = rows[selected];
        if (row && !row.disabled) row.accept();
        break;
      }
      case 'Tab':
        // Trap focus: the palette is modal, Tab must not escape it.
        event.preventDefault();
        move(event.shiftKey ? -1 : 1);
        break;
    }
  }
</script>

<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
  <div class="input-row">
    <Icon name={modeIcon} size={15} class="mode-icon" />
    <input
      bind:this={input}
      bind:value={text}
      onkeydown={onKeydown}
      type="text"
      {placeholder}
      spellcheck="false"
      autocomplete="off"
      aria-label={placeholder}
      aria-controls="nox-palette-list"
      aria-activedescendant={rows[selected] ? `nox-row-${selected}` : undefined}
    />
    {#if rows.length > 0 && effectiveMode !== 'line'}
      <!-- Honest about the display caps: a sliced list says so. -->
      <span class="result-count">
        {total === rows.length ? rows.length : `first ${rows.length} of ${total}`}
      </span>
    {/if}
  </div>

  <div class="results nox-scroll" id="nox-palette-list" role="listbox" bind:this={listElement}>
    {#each rows as row, index (row.key)}
      <div
        class="row"
        class:selected={index === selected}
        class:disabled={row.disabled}
        id="nox-row-{index}"
        role="option"
        aria-selected={index === selected}
        tabindex="-1"
        onclick={() => !row.disabled && row.accept()}
        onmousemove={() => (selected = index)}
        onkeydown={() => {}}
      >
        <Icon name={row.icon} size={14} class="row-icon" />

        <span class="label">
          {#each segmentMatch(row.title, row.positions) as segment, i (i)}
            <span class:hit={segment.hit}>{segment.text}</span>
          {/each}
        </span>

        {#if row.keyword}
          <span class="keyword">{row.keyword}</span>
        {/if}

        {#if row.detail}
          <span class="detail">{row.detail}</span>
        {/if}

        {#if row.badge}
          <span class="badge">{row.badge}</span>
        {/if}

        {#if row.hint}
          <kbd class="nox-kbd hint">{row.hint}</kbd>
        {/if}
      </div>
    {:else}
      <p class="nox-empty">
        {#if effectiveMode === 'files' && $fileIndex.length === 0}
          No folder open — press {keymap.displayFor('file.openFolder') ?? '⇧⌘O'} to open one.
        {:else}
          No matches
        {/if}
      </p>
    {/each}
  </div>

  <div class="footer">
    <span class="hint-group"><kbd class="nox-kbd">↑↓</kbd> navigate</span>
    <span class="hint-group"><kbd class="nox-kbd">↵</kbd> select</span>
    <span class="hint-group"><kbd class="nox-kbd">esc</kbd> dismiss</span>
    <span class="spacer"></span>
    <span class="hint-group prefix"><kbd class="nox-kbd">&gt;</kbd> commands</span>
    <span class="hint-group prefix"><kbd class="nox-kbd">~</kbd> switch file</span>
    <span class="hint-group prefix"><kbd class="nox-kbd">:</kbd> line</span>
    <span class="hint-group prefix"><kbd class="nox-kbd">@</kbd> symbol</span>
  </div>
</div>

<style>
  .palette {
    display: flex;
    flex-direction: column;
    width: min(660px, calc(100vw - 64px));
    max-height: min(60vh, 520px);
    background: var(--nox-bg-raised);
    border-radius: var(--nox-r-xl);
    box-shadow: var(--nox-shadow-lg);
    overflow: hidden;
  }

  .input-row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-4);
    flex: none;
    padding: 0 var(--nox-sp-5);
    height: 46px;
    border-bottom: 1px solid var(--nox-border);
  }

  .input-row :global(.mode-icon) {
    color: var(--nox-accent);
    flex: none;
  }

  .input-row input {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    outline: none;
    font-size: var(--nox-fs-lg);
    color: var(--nox-text-bright);
    user-select: text;
    letter-spacing: var(--nox-tracking-tight);
  }

  .input-row input::placeholder {
    color: var(--nox-text-faint);
  }

  .result-count {
    flex: none;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-faint);
    font-variant-numeric: tabular-nums;
  }

  .results {
    flex: 1;
    padding: var(--nox-sp-2);
    min-height: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-4);
    height: 30px;
    padding: 0 var(--nox-sp-4);
    border-radius: var(--nox-r-md);
    font-size: var(--nox-fs-md);
    color: var(--nox-text-muted);
    cursor: default;
    min-width: 0;
  }

  .row.selected {
    background: var(--nox-selected);
    color: var(--nox-text-bright);
  }

  .row.disabled {
    opacity: 0.42;
  }

  .row :global(.row-icon) {
    color: var(--nox-text-faint);
    flex: none;
  }

  .row.selected :global(.row-icon) {
    color: var(--nox-accent);
  }

  .label {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .label .hit {
    color: var(--nox-accent);
    font-weight: var(--nox-fw-medium);
  }

  /* Why this row matched when the title shows no highlight: the keyword it
     hit. Same quiet register as the footer legend — informative, not loud. */
  .keyword {
    flex: none;
    font-size: var(--nox-fs-2xs);
    color: var(--nox-text-faint);
    border: 1px solid var(--nox-border);
    border-radius: var(--nox-r-full);
    padding: 0 var(--nox-sp-3);
    line-height: 15px;
    white-space: nowrap;
  }

  .detail {
    flex: 1;
    min-width: 0;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }

  .badge {
    flex: none;
    font-size: var(--nox-fs-2xs);
    color: var(--nox-warning);
    text-transform: uppercase;
    letter-spacing: var(--nox-tracking-wide);
  }

  .hint {
    flex: none;
    margin-left: auto;
  }

  .row.selected .hint {
    color: var(--nox-text-muted);
  }

  .footer {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-5);
    flex: none;
    height: 28px;
    padding: 0 var(--nox-sp-5);
    border-top: 1px solid var(--nox-border);
    background: var(--nox-bg-base);
    font-size: var(--nox-fs-2xs);
    color: var(--nox-text-faint);
  }

  .hint-group {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
  }

  .spacer {
    flex: 1;
  }

  .prefix :global(.nox-kbd),
  .hint-group :global(.nox-kbd) {
    color: var(--nox-text-muted);
  }
</style>
