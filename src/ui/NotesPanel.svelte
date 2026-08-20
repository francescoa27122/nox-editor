<script lang="ts">
  import { untrack } from 'svelte';
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

  const selected = $derived($list.find((note) => note.id === $selectedId) ?? null);

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
    <ul class="list">
      {#each $list as note (note.id)}
        <li>
          <button
            class="row"
            class:selected={note.id === $selectedId}
            aria-current={note.id === $selectedId}
            onclick={() => notes.select(note.id)}
          >
            <Icon name="note" size={13} />
            <span class="row-title">{note.title}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if selected}
    {@const note = selected}
    <div class="editor">
      <button class="note-title" title="Rename" onclick={() => void commands.execute('notes.rename')}>
        {note.title}
      </button>
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

  .row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    width: 100%;
    padding: var(--nox-sp-2) var(--nox-sp-3);
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-muted);
    font-size: var(--nox-fs-sm);
    text-align: left;
  }

  .row:hover {
    background: var(--nox-hover);
    color: var(--nox-text);
  }

  .row.selected {
    background: var(--nox-selected);
    color: var(--nox-text-bright);
  }

  .row-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
