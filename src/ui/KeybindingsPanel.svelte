<script lang="ts">
  import { fuzzyMatch } from '@core/fuzzy';
  import { formatChord, type Chord } from '@services/keymap';
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  /**
   * Keyboard shortcuts: the reference, and the editor.
   *
   * Every application command gets a row — bound or not, because adding a key
   * to a command that has none is half of what "change the keys" means. The
   * rows are derived from the live keymap on every version bump; the panel
   * keeps no copy of the map, so what is listed is what will run.
   *
   * Recording goes through `keymap.beginCapture`, not a listener here: the
   * service listens on the window's capture phase, so a claimed chord is
   * already handled before any element in this panel could see it. See
   * `docs/superpowers/specs/2026-08-20-keybinding-editor-design.md` §3.
   */

  const app = useApp();
  const { commands, keymap, ui } = app;
  const keymapVersion = keymap.version;

  let filter = $state('');
  let searchInput = $state<HTMLInputElement | null>(null);

  /** The row being recorded into, and the chord recorded so far. */
  let editing = $state<{
    key: string;
    commandId: string;
    title: string;
    from: Chord | null;
    arg?: unknown;
  } | null>(null);
  let recorded = $state<Chord | null>(null);

  $effect(() => {
    searchInput?.focus();
  });

  // A half-finished recording must not outlive the panel: the service would
  // keep swallowing every key with nothing left to hand them to.
  $effect(() => () => keymap.endCapture());

  interface Row {
    key: string;
    commandId: string;
    title: string;
    chord: Chord | null;
    arg?: unknown;
    customized: boolean;
  }

  function titleOf(commandId: string): string {
    const command = commands.get(commandId);
    if (!command) return commandId;
    return command.category ? `${command.category}: ${command.title}` : command.title;
  }

  const allRows = $derived.by<Row[]>(() => {
    void $keymapVersion;

    const rows: Row[] = keymap.bindings().map((binding) => ({
      key: `${binding.commandId}::${binding.chord}`,
      commandId: binding.commandId,
      title: titleOf(binding.commandId),
      chord: binding.chord,
      arg: binding.arg,
      customized: keymap.isCustomized(binding.commandId),
    }));

    const bound = new Set(rows.map((row) => row.commandId));
    for (const command of commands.all()) {
      if (bound.has(command.id)) continue;
      rows.push({
        key: `${command.id}::`,
        commandId: command.id,
        title: titleOf(command.id),
        chord: null,
        customized: keymap.isCustomized(command.id),
      });
    }

    return rows.sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
  });

  const rows = $derived.by(() => {
    const query = filter.trim();
    if (query.length === 0) return allRows;
    return allRows.filter(
      (row) =>
        fuzzyMatch(query, row.title) ??
        fuzzyMatch(query, row.chord ? formatChord(row.chord) : 'unassigned') ??
        fuzzyMatch(query, row.commandId),
    );
  });

  const customizedCount = $derived.by(() => {
    void $keymapVersion;
    return keymap.customizedCount;
  });

  const conflicts = $derived.by(() => {
    void $keymapVersion;
    if (!recorded || !editing) return [];
    return keymap.conflictsFor(recorded, editing.commandId);
  });

  // Editor-owned keys never appear in the app keymap, so list them explicitly
  // rather than pretending CodeMirror's bindings do not exist.
  const EDITOR_KEYS: { chord: string; title: string }[] = [
    { chord: 'Mod+Z', title: 'Edit: Undo' },
    { chord: 'Mod+Shift+Z', title: 'Edit: Redo' },
    { chord: 'Mod+X', title: 'Edit: Cut' },
    { chord: 'Mod+C', title: 'Edit: Copy' },
    { chord: 'Mod+V', title: 'Edit: Paste' },
    { chord: 'Mod+A', title: 'Edit: Select All' },
    { chord: 'Mod+D', title: 'Edit: Add Selection to Next Match' },
    { chord: 'Mod+Alt+Up', title: 'Edit: Add Cursor Above' },
    { chord: 'Mod+Alt+Down', title: 'Edit: Add Cursor Below' },
    { chord: 'Mod+/', title: 'Edit: Toggle Line Comment' },
    { chord: 'Alt+Up', title: 'Edit: Move Line Up' },
    { chord: 'Alt+Down', title: 'Edit: Move Line Down' },
    { chord: 'Shift+Alt+Down', title: 'Edit: Duplicate Line' },
    { chord: 'Mod+Shift+K', title: 'Edit: Delete Line' },
    { chord: 'Mod+]', title: 'Edit: Indent' },
    { chord: 'Mod+[', title: 'Edit: Outdent' },
    { chord: 'Tab', title: 'Edit: Indent (or insert tab)' },
    { chord: 'Escape', title: 'Edit: Collapse Multiple Cursors' },
  ];

  const editorRows = $derived.by(() => {
    const query = filter.trim();
    const mapped = EDITOR_KEYS.map((k) => ({ ...k, chord: formatChord(normalize(k.chord)) }));
    if (query.length === 0) return mapped;
    return mapped.filter((row) => fuzzyMatch(query, row.title) ?? fuzzyMatch(query, row.chord));
  });

  function normalize(chord: string): string {
    // formatChord expects canonical lowercase tokens.
    return chord
      .split('+')
      .map((p) => (p.toLowerCase() === 'mod' ? modToken() : p.toLowerCase()))
      .join('+');
  }

  function modToken(): string {
    return formatChord('meta+a').startsWith('⌘') ? 'meta' : 'ctrl';
  }

  // --- Recording -----------------------------------------------------------

  function startRecording(row: Row): void {
    editing = {
      key: row.key,
      commandId: row.commandId,
      title: row.title,
      from: row.chord,
      arg: row.arg,
    };
    recorded = null;
    keymap.beginCapture((chord) => {
      // Escape is never recordable from here, and Enter accepts only once
      // there is something to accept — so pressing Enter twice binds Enter.
      if (chord === 'escape') return stopRecording();
      if (chord === 'enter' && recorded !== null) return accept();
      recorded = chord;
    });
  }

  function stopRecording(): void {
    keymap.endCapture();
    editing = null;
    recorded = null;
  }

  function accept(): void {
    const target = recorded;
    const row = editing;
    if (!target || !row) return;

    // Re-recording the chord a command already has changes nothing; writing a
    // rule for it would mark the row customised for no reason.
    if (target === row.from) return stopRecording();

    // A displaced binding is unassigned rather than shadowed: an addition
    // would win anyway, and a key whose listed owner is not the one that runs
    // is exactly the confusion this panel exists to remove.
    for (const conflict of keymap.conflictsFor(target, row.commandId)) {
      keymap.unassign(conflict.commandId, target);
    }
    keymap.assign(row.commandId, target, {
      from: row.from ?? undefined,
      arg: row.arg,
    });
    stopRecording();
  }
</script>

<div class="keys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
  <header>
    <div>
      <h2>Keyboard Shortcuts</h2>
      <p>
        Every command is reachable from the palette, whether or not it has a key.
        {#if customizedCount > 0}
          <span class="count">{customizedCount} customised.</span>
        {/if}
      </p>
    </div>
    <div class="header-actions">
      {#if customizedCount > 0}
        <button class="nox-button small reset-all" onclick={() => keymap.resetAll()}>
          Reset all
        </button>
      {/if}
      <button class="close" aria-label="Close" onclick={() => ui.closeOverlay()}>
        <Icon name="close" size={14} />
      </button>
    </div>
  </header>

  <div class="search nox-input">
    <Icon name="search" size={13} />
    <input
      bind:this={searchInput}
      bind:value={filter}
      type="text"
      placeholder="Filter shortcuts…"
      aria-label="Filter shortcuts"
      spellcheck="false"
    />
  </div>

  <div class="body nox-scroll">
    <h3>Application</h3>
    {#each rows as row (row.key)}
      <div class="row" class:editing={editing?.key === row.key} data-command={row.commandId}>
        <span class="title" class:custom={row.customized}>{row.title}</span>

        {#if editing?.key === row.key}
          <div class="recording">
            <kbd class="recorded" class:empty={recorded === null}>
              {recorded === null ? 'Press a key…' : formatChord(recorded)}
            </kbd>
            {#if conflicts.length > 0}
              <span class="conflict">
                already {conflicts.map((c) => titleOf(c.commandId)).join(', ')}
              </span>
            {/if}
            <button
              class="nox-button small primary accept"
              disabled={recorded === null}
              onclick={accept}
            >
              {conflicts.length > 0 ? 'Rebind, and unassign' : 'Rebind'}
            </button>
            <button class="nox-button small ghost cancel" onclick={stopRecording}>Cancel</button>
          </div>
        {:else}
          <span class="chord" class:unassigned={row.chord === null}>
            {#if row.chord === null}
              Unassigned
            {:else}
              <kbd>{formatChord(row.chord)}</kbd>
            {/if}
          </span>
          <div class="actions">
            {#if row.customized}
              <button
                class="icon reset"
                aria-label={`Reset ${row.title} to its default key`}
                title="Reset to default"
                onclick={() => keymap.resetCommand(row.commandId)}
              >
                <Icon name="refresh" size={12} />
              </button>
            {/if}
            {#if row.chord !== null}
              <button
                class="icon clear"
                aria-label={`Remove the key for ${row.title}`}
                title="Remove key"
                onclick={() => keymap.unassign(row.commandId, row.chord!)}
              >
                <Icon name="close" size={12} />
              </button>
            {/if}
            <button
              class="icon edit"
              aria-label={`${row.chord === null ? 'Add' : 'Change'} the key for ${row.title}`}
              title={row.chord === null ? 'Add key' : 'Change key'}
              onclick={() => startRecording(row)}
            >
              <Icon name="keyboard" size={12} />
            </button>
          </div>
        {/if}
      </div>
    {:else}
      <p class="nox-empty">No matching shortcuts.</p>
    {/each}

    {#if editorRows.length > 0}
      <h3>Editor</h3>
      <p class="note">These belong to the editor itself and are not editable here.</p>
      {#each editorRows as row (row.title)}
        <div class="row readonly">
          <span class="title">{row.title}</span>
          <span class="chord"><kbd>{row.chord}</kbd></span>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .keys {
    display: flex;
    flex-direction: column;
    width: min(720px, calc(100vw - 64px));
    height: min(640px, calc(100vh - 120px));
    background: var(--nox-bg-raised);
    border-radius: var(--nox-r-xl);
    box-shadow: var(--nox-shadow-lg);
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--nox-sp-5);
    flex: none;
    padding: var(--nox-sp-6) var(--nox-sp-6) var(--nox-sp-4);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    flex: none;
  }

  h2 {
    margin: 0;
    font-size: var(--nox-fs-xl);
    font-weight: var(--nox-fw-semibold);
    color: var(--nox-text-bright);
    letter-spacing: var(--nox-tracking-tight);
  }

  header p {
    margin: var(--nox-sp-1) 0 0;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-faint);
  }

  .count {
    color: var(--nox-text-muted);
  }

  .close {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: var(--nox-r-md);
    color: var(--nox-text-muted);
    flex: none;
  }

  .close:hover {
    background: var(--nox-hover);
    color: var(--nox-text-bright);
  }

  /* Well = the global .nox-input primitive on the wrapper, so the icon
     lives inside the border. width: auto because the primitive's 100%
     would ignore the side margins; icon colour stays local. */
  .search {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    flex: none;
    margin: 0 var(--nox-sp-6) var(--nox-sp-4);
    width: auto;
    color: var(--nox-text-faint);
  }

  .search:focus-within {
    border-color: var(--nox-border-accent);
  }

  .search input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-bright);
    user-select: text;
  }

  .body {
    flex: 1;
    padding: 0 var(--nox-sp-6) var(--nox-sp-6);
    min-height: 0;
  }

  h3 {
    margin: var(--nox-sp-5) 0 var(--nox-sp-2);
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    text-transform: uppercase;
    letter-spacing: var(--nox-tracking-wide);
    color: var(--nox-text-faint);
  }

  .note {
    margin: 0 0 var(--nox-sp-2);
    padding: 0 var(--nox-sp-3);
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-faint);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nox-sp-4);
    min-height: 30px;
    padding: 0 var(--nox-sp-3);
    border-radius: var(--nox-r-sm);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
  }

  .row:hover,
  .row.editing {
    background: var(--nox-hover);
    color: var(--nox-text);
  }

  .row.editing {
    outline: 1px solid var(--nox-border-accent);
  }

  .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* A customised row says so without a second column of noise. */
  .title.custom::after {
    content: '•';
    margin-left: var(--nox-sp-2);
    color: var(--nox-accent);
  }

  .chord {
    flex: none;
    display: flex;
    align-items: center;
  }

  .chord.unassigned {
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-faint);
    font-style: italic;
  }

  kbd {
    font-family: var(--nox-font-ui);
    font-size: var(--nox-fs-xs);
    color: var(--nox-text);
    background: var(--nox-bg-inset);
    border: 1px solid var(--nox-border);
    border-radius: var(--nox-r-sm);
    padding: 2px var(--nox-sp-3);
    letter-spacing: 0.04em;
  }

  /* Reserved, not conditional: the row must not reflow on hover. */
  .actions {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-1);
    flex: none;
    width: 66px;
    justify-content: flex-end;
    opacity: 0;
  }

  .row:hover .actions,
  .actions:focus-within {
    opacity: 1;
  }

  .icon {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-muted);
  }

  .icon:hover {
    background: var(--nox-bg-inset);
    color: var(--nox-text-bright);
  }

  .recording {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    flex: none;
  }

  .recorded.empty {
    color: var(--nox-text-faint);
    font-style: italic;
  }

  .conflict {
    font-size: var(--nox-fs-xs);
    color: var(--nox-warning);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row.readonly .chord kbd {
    opacity: 0.75;
  }
</style>
