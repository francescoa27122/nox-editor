<script lang="ts">
  import { EditorView } from '@codemirror/view';
  import { onMount } from 'svelte';
  import { cursorInfo } from '@editor/commands';
  import { reconfigureAllEffects, reconfigureEffects } from '@editor/extensions';
  import { cachedLanguage, hasGrammar, languageCompartment, loadLanguage } from '@editor/languages';
  import { useApp } from './context';

  /**
   * Host for the CodeMirror view.
   *
   * One view is created for the lifetime of the pane and re-pointed at a
   * different `EditorState` on every tab switch. That is what makes switching
   * tabs instant and keeps per-tab undo history and scroll position intact.
   */

  interface Props {
    groupId: string;
  }

  let { groupId }: Props = $props();

  const app = useApp();
  const { workspace, config, ui, find } = app;

  const groups = workspace.groups;
  const focusRequest = ui.focusEditorRequest;

  /** This pane follows its own group's active tab, not the app-wide one. */
  const group = $derived($groups.find((candidate) => candidate.id === groupId) ?? null);
  const activeId = $derived(group?.activeId ?? null);
  const isActiveGroup = $derived(group?.isActive ?? false);

  let host = $state<HTMLElement | null>(null);
  let view: EditorView | null = null;
  let currentId: string | null = null;
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    if (!host) return;

    view = new EditorView({
      parent: host,
      // Every transaction is routed through the workspace so it stays the
      // authoritative owner of state for all buffers, not just the visible one.
      dispatchTransactions: (transactions, instance) => {
        instance.update(transactions);
        const id = currentId;
        if (!id) return;

        let docChanged = false;
        for (const transaction of transactions) {
          workspace.applyTransaction(id, transaction);
          docChanged ||= transaction.docChanged;
        }

        publishCursor();
        find.refresh();
        if (docChanged) scheduleAutosave();
      },
    });

    app.registerGroupView(groupId, view);

    // Lets the workspace push changes (an external reload, a grouped undo)
    // into the live view instead of resetting state, so scroll position and
    // undo history survive. Every pane registers; each declines the buffers it
    // is not showing.
    const offDispatcher = workspace.addViewDispatcher((id, spec) => {
      if (!view || id !== currentId) return false;
      view.dispatch(spec);
      return true;
    });

    syncToBuffer(activeId);

    const offReset = workspace.events.on('buffer-reset', ({ id }) => {
      if (id === currentId) syncToBuffer(id, { force: true });
    });

    const offConfig = config.changed.subscribe((keys) => {
      if (!view || keys.size === 0) return;
      const effects = reconfigureEffects(config.settings.get(), keys);
      if (effects.length > 0) view.dispatch({ effects });
    });

    return () => {
      offReset();
      offConfig();
      offDispatcher();
      if (autosaveTimer) clearTimeout(autosaveTimer);
      app.unregisterGroupView(groupId);
      view?.destroy();
      view = null;
    };
  });

  // Swap the view onto whichever buffer this group is showing.
  $effect(() => {
    const id = activeId;
    if (view) syncToBuffer(id);
  });

  // Keep the app pointed at the focused pane's view.
  $effect(() => {
    if (isActiveGroup && view) app.setActiveGroupView(groupId);
  });

  // A focus command anywhere in the app lands in the active pane only.
  $effect(() => {
    void $focusRequest;
    if (isActiveGroup) view?.focus();
  });

  function syncToBuffer(id: string | null, options: { force?: boolean } = {}) {
    if (!view) return;
    if (id === currentId && !options.force) return;

    currentId = id;
    if (!id) return;

    const state = workspace.stateOf(id);
    if (!state) return;

    view.setState(state);

    // Background buffers may have been created under older settings, and a
    // state swap does not carry compartment configuration across.
    const buffer = workspace.buffers.get().find((b) => b.id === id);
    const languageId = buffer?.languageId ?? 'plaintext';
    view.dispatch({
      effects: [
        ...reconfigureAllEffects(config.settings.get()),
        languageCompartment.reconfigure(cachedLanguage(languageId) ?? []),
      ],
      // `setState` resets the scroll to the top of the document, so without
      // this a tab switch — or a session restored mid-file — lands nowhere
      // near the cursor it just restored.
      scrollIntoView: true,
    });

    publishCursor();
    find.attach(view);
    find.refresh();

    // Only the focused pane may take the caret; a background pane swapping
    // tabs must not yank focus away from where the user is typing.
    if (isActiveGroup) view.focus();

    if (hasGrammar(languageId) && !cachedLanguage(languageId)) {
      void loadLanguage(languageId).then((extension) => {
        // The user may have switched tabs while the grammar was loading.
        if (view && currentId === id && extension) {
          view.dispatch({ effects: languageCompartment.reconfigure(extension) });
        }
      });
    }
  }

  function publishCursor() {
    // The status bar reflects the focused pane only.
    if (view && isActiveGroup) app.cursor.set(cursorInfo(view));
  }

  function scheduleAutosave() {
    const mode = config.get('files.autoSave');
    if (mode !== 'afterDelay') return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      const id = currentId;
      const buffer = id ? workspace.buffers.get().find((b) => b.id === id) : null;
      // Never auto-prompt a Save As dialog behind the user's back.
      if (id && buffer?.isDirty && !buffer.isUntitled) void app.save(id);
    }, config.get('files.autoSaveDelay'));
  }

  function onBlur() {
    if (config.get('files.autoSave') !== 'onFocusChange') return;
    const id = currentId;
    const buffer = id ? workspace.buffers.get().find((b) => b.id === id) : null;
    if (id && buffer?.isDirty && !buffer.isUntitled) void app.save(id);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="nox-editor-pane"
  class:inactive={!isActiveGroup}
  bind:this={host}
  onfocusout={onBlur}
  onfocusin={() => workspace.focusGroup(groupId)}
  onpointerdown={() => workspace.focusGroup(groupId)}
  aria-label="Editor"
></section>

<style>
  .nox-editor-pane {
    flex: 1;
    min-height: 0;
    position: relative;
    background: var(--nox-bg-editor);
    /* The chrome disables selection; the editor must opt back in. */
    user-select: text;
    cursor: auto;
  }

  .nox-editor-pane :global(.cm-editor) {
    height: 100%;
  }

  .nox-editor-pane :global(.cm-editor.cm-focused) {
    outline: none;
  }

  .nox-editor-pane :global(.cm-scroller) {
    /* Room for the status bar's rounded corner illusion. */
    padding-bottom: 0;
  }
</style>
