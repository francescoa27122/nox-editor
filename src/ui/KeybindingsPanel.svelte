<script lang="ts">
  import { fuzzyMatch } from '@core/fuzzy';
  import { formatChord } from '@services/keymap';
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  /**
   * Read-only keyboard shortcut reference, generated from the live keymap.
   *
   * Rebinding is deliberately not in the MVP — but because bindings and
   * commands are already data, adding an editor here later is a UI change
   * only. See ROADMAP.md.
   */

  const app = useApp();
  const { commands, keymap, ui } = app;

  let filter = $state('');
  let searchInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    searchInput?.focus();
  });

  const rows = $derived.by(() => {
    const query = filter.trim();
    const all = keymap.bindings().map((binding) => {
      const command = commands.get(binding.commandId);
      return {
        chord: formatChord(binding.chord),
        commandId: binding.commandId,
        title: command
          ? command.category
            ? `${command.category}: ${command.title}`
            : command.title
          : binding.commandId,
      };
    });

    const filtered =
      query.length === 0
        ? all
        : all.filter(
            (row) =>
              fuzzyMatch(query, row.title) ??
              fuzzyMatch(query, row.chord) ??
              fuzzyMatch(query, row.commandId),
          );

    return filtered.sort((a, b) => a.title.localeCompare(b.title));
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
</script>

<div class="keys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
  <header>
    <div>
      <h2>Keyboard Shortcuts</h2>
      <p>Every command is reachable from the palette, whether or not it has a key.</p>
    </div>
    <button class="close" aria-label="Close" onclick={() => ui.closeOverlay()}>
      <Icon name="close" size={14} />
    </button>
  </header>

  <div class="search">
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
    {#each rows as row (row.commandId + row.chord)}
      <div class="row">
        <span class="title">{row.title}</span>
        <kbd class="chord">{row.chord}</kbd>
      </div>
    {:else}
      <p class="nox-empty">No matching shortcuts.</p>
    {/each}

    {#if editorRows.length > 0}
      <h3>Editor</h3>
      {#each editorRows as row (row.title)}
        <div class="row">
          <span class="title">{row.title}</span>
          <kbd class="chord">{row.chord}</kbd>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .keys {
    display: flex;
    flex-direction: column;
    width: min(620px, calc(100vw - 64px));
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

  .search {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    flex: none;
    margin: 0 var(--nox-sp-6) var(--nox-sp-4);
    height: 30px;
    padding: 0 var(--nox-sp-4);
    background: var(--nox-bg-inset);
    border: 1px solid var(--nox-border);
    border-radius: var(--nox-r-md);
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

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nox-sp-5);
    height: 28px;
    padding: 0 var(--nox-sp-3);
    border-radius: var(--nox-r-sm);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
  }

  .row:hover {
    background: var(--nox-hover);
    color: var(--nox-text);
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chord {
    flex: none;
    font-family: var(--nox-font-ui);
    font-size: var(--nox-fs-xs);
    color: var(--nox-text);
    background: var(--nox-bg-inset);
    border: 1px solid var(--nox-border);
    border-radius: var(--nox-r-sm);
    padding: 2px var(--nox-sp-3);
    letter-spacing: 0.04em;
  }
</style>
