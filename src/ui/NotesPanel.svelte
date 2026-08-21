<script lang="ts">
  import { untrack } from 'svelte';
  import { findNotes } from '@core/note-search';
  import { contains, relative } from '@core/path';
  import { useApp } from './context';
  import Icon from './Icon.svelte';
  import PanelEmpty from './PanelEmpty.svelte';
  import PanelHeader from './PanelHeader.svelte';

  /**
   * The notes panel: a list, and the selected note's body.
   *
   * A `<textarea>` rather than a second CodeMirror instance. A note is prose,
   * not a file: bracket matching, autocomplete and a language compartment are
   * code affordances, and dragging the editor stack in here would undo the
   * point of keeping notes out of the workspace. The textarea also gets native
   * spellcheck, which prose wants and code does not.
   */

  const app = useApp();
  const { notes, ui, commands } = app;

  const list = notes.notes;
  const selectedId = notes.selectedId;
  const focusRequest = ui.focusNotesRequest;

  let bodyInput = $state<HTMLTextAreaElement | null>(null);
  let query = $state('');

  /**
   * The rows to show. `findNotes` is a pure function in `core/` rather than
   * logic here, so the matching and the ordering are tested without a DOM.
   *
   * Filtering costs nothing: `load()` already reads every body into the
   * signal, so the whole corpus is in memory and there is no index to keep
   * agreeing with it.
   */
  const hits = $derived(findNotes($list, query));

  const selected = $derived($list.find((note) => note.id === $selectedId) ?? null);

  const rootPath = app.workspace.rootPath;

  /**
   * Whether the selected note's anchor points into the folder that is open.
   *
   * A note anchored in folder A and read in folder B cannot jump anywhere, so
   * the chip says so rather than pretending. The note itself is never hidden
   * or altered: an unresolvable anchor costs the jump, not the note — and
   * rewriting anchors on a folder switch would let opening a folder mutate
   * notes, which is the one thing `NotesService` is built to prevent.
   */
  /**
   * How the chip names the anchored file: relative to the open folder, so
   * `src/lsp.rs` rather than `lsp.rs`. The basename alone is what the note's
   * default title already says, and it cannot tell two `index.ts` apart.
   */
  const anchorLabel = $derived.by(() => {
    const anchor = selected?.anchor;
    if (!anchor) return '';
    const root = $rootPath;
    const where = root ? relative(root, anchor.path) : anchor.path;
    return `${where}:${anchor.line}`;
  });

  const anchorReachable = $derived.by(() => {
    const anchor = selected?.anchor;
    const root = $rootPath;
    if (!anchor || !root) return false;
    return anchor.path === root || contains(root, anchor.path);
  });

  /**
   * Load the note into the textarea when the *selection* changes, and never
   * again. Rendering `value={selected.body}` would reassign the element's
   * value on every keystroke, which puts the caret back at the end — the same
   * class of bug as the dialog that kept only the last character typed.
   */
  $effect(() => {
    const id = $selectedId;
    if (!bodyInput) return;
    bodyInput.value = untrack(
      () => notes.notes.get().find((note) => note.id === id)?.body ?? '',
    );
  });

  $effect(() => {
    // Track the counter so a focus command re-runs this effect.
    void $focusRequest;
    untrack(() => bodyInput)?.focus();
  });

  $effect(() => {
    // Switching away from the panel is a checkpoint, like switching notes:
    // it bounds how long a body sits only in memory.
    return () => void notes.flush();
  });
</script>

<div class="notes-panel">
  <PanelHeader title="Notes">
    {#snippet actions()}
      <button
        class="icon-button"
        title="New Note"
        aria-label="New note"
        onclick={() => void commands.execute('notes.new')}
      >
        <Icon name="plus" size={14} />
      </button>
      <button
        class="icon-button"
        title="Delete Note"
        aria-label="Delete note"
        disabled={selected === null}
        onclick={() => void commands.execute('notes.delete')}
      >
        <Icon name="trash" size={14} />
      </button>
    {/snippet}
  </PanelHeader>

  {#if $list.length === 0}
    <PanelEmpty action={{ label: 'New Note', run: () => void commands.execute('notes.new') }}>
      No notes yet. A note is yours, not the workspace's — it survives
      switching folders.
    </PanelEmpty>
  {:else}
    <div class="filter">
      <Icon name="search" size={12} />
      <input
        class="filter-input"
        type="text"
        placeholder="Filter notes…"
        aria-label="Filter notes"
        bind:value={query}
        onkeydown={(event) => {
          // Escape clears the filter rather than bubbling to the overlay
          // layer, which has nothing open — an unhandled Escape here would
          // leave a narrowed list with no obvious way back.
          if (event.key === 'Escape' && query.length > 0) {
            event.stopPropagation();
            query = '';
          }
        }}
      />
    </div>

    {#if hits.length === 0}
      <p class="no-matches">No note matches “{query}”.</p>
    {:else}
      <ul class="list">
        {#each hits as hit (hit.note.id)}
          <li>
            <div class="row-wrap" class:selected={hit.note.id === $selectedId}>
              <button
                class="row"
                aria-current={hit.note.id === $selectedId}
                onclick={() => notes.select(hit.note.id)}
              >
                <Icon name="note" size={13} />
                <span class="row-text">
                  <span class="row-title">{hit.note.title}</span>
                  {#if hit.snippet}
                    <!-- Only ever the line that matched: quoting the first
                         line of a body that does not contain the query would
                         read as a hit on text that is not there. -->
                    <span class="row-snippet">{hit.snippet}</span>
                  {/if}
                </span>
              </button>
              <button
                class="pin-button"
                class:pinned={hit.note.pinned}
                title={hit.note.pinned ? 'Unpin' : 'Pin to top'}
                aria-label={hit.note.pinned ? 'Unpin note' : 'Pin note to top'}
                aria-pressed={hit.note.pinned}
                onclick={() => notes.pin(hit.note.id, !hit.note.pinned)}
              >
                <Icon name="pin" size={12} />
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  {#if selected}
    {@const note = selected}
    <div class="editor">
      <button class="note-title" title="Rename" onclick={() => void commands.execute('notes.rename')}>
        {note.title}
      </button>
      {#if note.anchor}
        {@const anchor = note.anchor}
        <!-- The line here is where the note was *made*. Clicking re-finds the
             snippet, so a drifted anchor still lands on its code — resolving
             on render instead would mean reading the file on every paint, for
             a file that may not even be open. -->
        <button
          class="anchor"
          class:unreachable={!anchorReachable}
          disabled={!anchorReachable}
          title={anchorReachable
            ? `Open ${anchor.path}:${anchor.line}`
            : `${anchor.path} is not in the folder that is open`}
          onclick={() => void app.openNoteAnchor(anchor)}
        >
          <Icon name="file" size={11} />
          <span class="anchor-label">{anchorLabel}</span>
        </button>
      {/if}
      <textarea
        bind:this={bodyInput}
        class="body"
        spellcheck="true"
        placeholder="Write…"
        aria-label="Note body"
        oninput={(event) => notes.setBody(note.id, event.currentTarget.value)}
      ></textarea>
    </div>
  {/if}
</div>

<style>
  .notes-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .icon-button {
    display: grid;
    place-items: center;
    width: 22px;
    height: 20px;
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-faint);
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .icon-button:hover:not(:disabled) {
    background: var(--nox-hover);
    color: var(--nox-text);
  }

  .icon-button:disabled {
    opacity: 0.4;
  }

  /* Capped so the body always has room: the list is for picking, not reading. */
  .list {
    flex: 0 1 auto;
    max-height: 40%;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0 var(--nox-sp-2);
  }

  .filter {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    margin: 0 var(--nox-sp-3) var(--nox-sp-2);
    padding: 0 var(--nox-sp-2);
    border: 1px solid var(--nox-border);
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-faint);
  }

  .filter:focus-within {
    border-color: var(--nox-accent);
  }

  .filter-input {
    flex: 1;
    min-width: 0;
    padding: var(--nox-sp-2) 0;
    background: transparent;
    border: none;
    color: var(--nox-text);
    font-family: var(--nox-font-ui);
    font-size: var(--nox-fs-sm);
  }

  /* The wrapper already draws the focus state for the whole row. */
  .filter-input:focus-visible {
    box-shadow: none;
  }

  .no-matches {
    margin: 0;
    padding: var(--nox-sp-2) var(--nox-sp-4);
    color: var(--nox-text-faint);
    font-size: var(--nox-fs-sm);
  }

  .row-wrap {
    display: flex;
    align-items: center;
    border-radius: var(--nox-r-sm);
  }

  .row-wrap:hover {
    background: var(--nox-hover);
  }

  .row-wrap.selected {
    background: var(--nox-selected);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    flex: 1;
    min-width: 0;
    padding: var(--nox-sp-2) var(--nox-sp-3);
    color: var(--nox-text-muted);
    font-size: var(--nox-fs-sm);
    text-align: left;
  }

  .row-wrap:hover .row {
    color: var(--nox-text);
  }

  .row-wrap.selected .row {
    color: var(--nox-text-bright);
  }

  /* Column so a snippet sits under its title rather than beside it: the
     sidebar is narrow and the title is what the eye scans for. */
  .row-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .row-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-snippet {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--nox-text-faint);
    font-size: var(--nox-fs-xs);
  }

  /* Hidden until the row is worth acting on, or the note is already pinned.
     A pin button on every row at rest turns a list of notes into a list of
     controls. */
  .pin-button {
    display: grid;
    place-items: center;
    flex: none;
    width: 22px;
    height: 22px;
    margin-right: var(--nox-sp-2);
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-faint);
    opacity: 0;
  }

  .row-wrap:hover .pin-button,
  .pin-button:focus-visible,
  .pin-button.pinned {
    opacity: 1;
  }

  /* Hover feedback is the background, not the colour: colouring it would
     have to beat `.pinned` below, and then hovering a pinned note would hide
     the very state the button exists to show. */
  .pin-button:hover {
    background: var(--nox-hover);
    color: var(--nox-text);
  }

  .pin-button.pinned {
    color: var(--nox-accent);
  }

  .editor {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    border-top: 1px solid var(--nox-border);
  }

  .note-title {
    flex: none;
    padding: var(--nox-sp-3) var(--nox-sp-4);
    color: var(--nox-text-bright);
    font-size: var(--nox-fs-sm);
    font-weight: var(--nox-fw-medium);
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note-title:hover {
    background: var(--nox-hover);
  }

  .anchor {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    align-self: flex-start;
    max-width: calc(100% - var(--nox-sp-4) * 2);
    margin: 0 var(--nox-sp-4) var(--nox-sp-3);
    padding: 2px var(--nox-sp-2);
    border: 1px solid var(--nox-border);
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-muted);
    font-size: var(--nox-fs-xs);
  }

  .anchor:hover:not(:disabled) {
    background: var(--nox-hover);
    color: var(--nox-text);
    border-color: var(--nox-accent);
  }

  /* Greyed rather than hidden: a note whose code is in another folder should
     still say what it was about. */
  .anchor.unreachable {
    opacity: 0.5;
  }

  .anchor-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .body {
    flex: 1;
    min-height: 0;
    resize: none;
    padding: 0 var(--nox-sp-4) var(--nox-sp-4);
    background: transparent;
    border: none;
    color: var(--nox-text);
    /* Prose, not code: the UI stack, not the mono one. */
    font-family: var(--nox-font-ui);
    font-size: var(--nox-fs-sm);
    line-height: var(--nox-lh-ui);
  }

  /* base.css's global :focus-visible ring is a 3px accent glow, right for a
     small input but wrong wrapped around this entire writing surface — the
     body draws it for as long as the note stays focused, however it got
     focus. Suppressed here rather than in base.css, which other elements
     still want. */
  .body:focus-visible {
    box-shadow: none;
  }

  .body::placeholder {
    color: var(--nox-text-faint);
  }
</style>
