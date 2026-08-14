<script lang="ts">
  import { basename, dirname, relative } from '@core/path';
  import { fuzzyMatch, fuzzyMatchPath, segmentMatch } from '@core/fuzzy';
  import type { Command } from '@services/commands';
  import { formatChord, normalizeChord } from '@services/keymap';
  import type { OverlayKind } from '@services/ui';
  import { useApp } from './context';
  import Icon, { type IconName } from './Icon.svelte';

  /**
   * One component serves the command palette, quick open, the buffer switcher
   * and go-to-line.
   *
   * They share an input, a result list, ranking and keyboard handling — only
   * the item source and the accept action differ. Prefixes (`>`, `~`, `:`)
   * switch between them mid-typing, so a single muscle memory covers all four.
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
    return '';
  }

  /** The active mode, which the prefix can change without reopening. */
  const effectiveMode = $derived.by<'commands' | 'files' | 'buffers' | 'line'>(() => {
    if (text.startsWith('>')) return 'commands';
    if (text.startsWith('~')) return 'buffers';
    if (text.startsWith(':')) return 'line';
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
      default:
        return 'search';
    }
  });

  interface Row {
    key: string;
    title: string;
    /** Highlight positions into `title`. */
    positions: number[];
    detail?: string;
    badge?: string;
    hint?: string;
    disabled?: boolean;
    icon: IconName;
    accept: () => void;
  }

  const rows = $derived.by<Row[]>(() => {
    void $commandVersion;
    if (effectiveMode === 'commands') return commandRows(term);
    if (effectiveMode === 'buffers') return bufferRows(term);
    if (effectiveMode === 'line') return lineRows(term);
    return fileRows(term);
  });

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

  function commandRows(query: string): Row[] {
    const scored: { row: Row; score: number }[] = [];

    for (const command of commands.palette()) {
      const label = command.category ? `${command.category}: ${command.title}` : command.title;
      const match = fuzzyMatch(query, label);
      const keywordMatch =
        match ?? matchAgainstKeywords(query, command);
      if (!keywordMatch) continue;

      const enabled = commands.isEnabled(command.id);
      // Application bindings win; `keyHint` covers the CodeMirror-owned ones.
      const hint =
        keymap.displayFor(command.id) ??
        (command.keyHint ? formatChord(normalizeChord(command.keyHint)) : undefined);
      scored.push({
        score: keywordMatch.score - (enabled ? 0 : 1000),
        row: {
          key: command.id,
          title: label,
          positions: match ? match.positions : [],
          disabled: !enabled,
          icon: 'command',
          ...(hint ? { hint } : {}),
          accept: () => {
            ui.closeOverlay();
            void commands.execute(command.id);
          },
        },
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 200).map((s) => s.row);
  }

  function matchAgainstKeywords(query: string, command: Command) {
    for (const keyword of command.keywords ?? []) {
      const match = fuzzyMatch(query, keyword);
      // Keyword hits rank below title hits so exact titles always win.
      if (match) return { score: match.score * 0.6, positions: [] as number[] };
    }
    return null;
  }

  function fileRows(query: string): Row[] {
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
    return scored.slice(0, 100).map((s) => s.row);
  }

  /**
   * Open buffers, most recently used first.
   *
   * Distinct from quick open on purpose: this searches what is already open,
   * ranked by when you last looked at it, so it answers "take me back" rather
   * than "find me this file". With no query the order is left alone — MRU is
   * the ranking, and fuzzy scoring would only scramble it.
   */
  function bufferRows(query: string): Row[] {
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
    return scored.map((s) => s.row);
  }

  /** With an empty query, show recents first — that is what people want. */
  function recentFirst(): string[] {
    const recents = $recentFiles;
    const seen = new Set(recents);
    return [...recents, ...$fileIndex.filter((p) => !seen.has(p))].slice(0, 100);
  }

  function lineRows(query: string): Row[] {
    const view = app.view.get();
    if (!view) return [];

    const total = view.state.doc.lines;
    const [rawLine, rawColumn] = query.split(':');
    const line = Number.parseInt(rawLine ?? '', 10);
    const column = Number.parseInt(rawColumn ?? '', 10);

    if (!Number.isFinite(line)) {
      return [
        {
          key: 'goto-hint',
          title: `Current file has ${total} lines`,
          positions: [],
          detail: 'Type a line number, optionally line:column',
          disabled: true,
          icon: 'info',
          accept: () => {},
        },
      ];
    }

    const clamped = Math.min(Math.max(1, line), total);
    const preview = view.state.doc.line(clamped).text.trim().slice(0, 90);

    return [
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
    ];
  }

  function move(delta: number) {
    if (rows.length === 0) return;
    selected = (selected + delta + rows.length) % rows.length;
    queueMicrotask(() => {
      listElement?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
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
      <span class="result-count">{rows.length}</span>
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
    <span class="hint-group prefix"><kbd class="nox-kbd">~</kbd> open files</span>
    <span class="hint-group prefix"><kbd class="nox-kbd">:</kbd> line</span>
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
