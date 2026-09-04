<script lang="ts" module>
  /**
   * What right-clicking the code surface offers, in order.
   *
   * Ids only: the label, the chord and the enablement are all read back from
   * the command registry when the menu opens, so this list cannot drift from
   * the palette, from a rebound key, or from a command that grew an `enabled`
   * predicate. The four LSP entries are the reason the menu exists at all —
   * they are otherwise reachable only through F12 / ⇧F12 / F2 / ⇧⌥F, which a
   * default-configured Mac laptop hides behind `fn`.
   */
  const MENU_COMMANDS: readonly { id: string; separatorBefore?: boolean }[] = [
    { id: 'lsp.goToDefinition' },
    { id: 'lsp.findReferences' },
    { id: 'lsp.renameSymbol' },
    { id: 'lsp.formatDocument' },
    { id: 'edit.toggleComment', separatorBefore: true },
    { id: 'edit.selectAllMatches' },
    { id: 'git.showDiff', separatorBefore: true },
    { id: 'git.toggleBlame' },
  ];
</script>

<script lang="ts">
  import { EditorSelection } from '@codemirror/state';
  import { EditorView } from '@codemirror/view';
  import { onMount } from 'svelte';
  import { formatChord, normalizeChord } from '@services/keymap';
  import { mirroredAnnotation } from '@services/transactions';
  import { cursorInfo } from '@editor/commands';
  import {
    accessibleNameCompartment,
    blameCompartment,
    lspCompartment,
    reconfigureAllEffects,
    reconfigureEffects,
  } from '@editor/extensions';
  import { completionExtension } from '@editor/completion';
  import { lspHoverExtension } from '@editor/hover';
  import { cachedLanguage, hasGrammar, languageCompartment, loadLanguage } from '@editor/languages';
  import { blameGutter, setGitBlame } from '@editor/git-blame';
  import { onGitGutterClick, setGitGutter } from '@editor/git-gutter';
  import { gutterLines } from '@core/git-gutter';
  import { applyDiagnostics } from '@editor/lsp';
  import { applyPluginDecorations } from '@editor/plugin-decorations';
  import { pathToUri } from '@core/uri';
  import { useApp } from './context';
  import ContextMenu, { type MenuAnchor, type MenuItem } from './ContextMenu.svelte';

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

  /**
   * Built once, not per paint. `Compartment.reconfigure` with the same
   * extension object leaves CodeMirror's existing instances alone; a fresh
   * `blameGutter()` each time would tear the column down and rebuild it on
   * every repaint, including the one that merely delivers git's answer.
   */
  const blameExtension = blameGutter();
  const { workspace, config, ui, find, lsp } = app;

  const groups = workspace.groups;
  const focusRequest = ui.focusEditorRequest;

  /** This pane follows its own group's active tab, not the app-wide one. */
  const group = $derived($groups.find((candidate) => candidate.id === groupId) ?? null);
  const activeId = $derived(group?.activeId ?? null);
  const isActiveGroup = $derived(group?.isActive ?? false);

  let host = $state<HTMLElement | null>(null);
  let view: EditorView | null = null;
  let currentId: string | null = null;
  let menu = $state<{ anchor: MenuAnchor; returnTo: HTMLElement | null } | null>(null);

  /**
   * Built once per pane, not per tab: `documentOf` closes over `currentId`,
   * so the same extension answers correctly for whichever buffer the view is
   * holding. Keyed off `currentId` rather than the app-wide active id, for
   * the reason the diagnostics paint is — they are not the same question.
   */
  const lspDeps = {
    lsp,
    documentOf: () => {
      if (!currentId) return null;
      const buffer = workspace.buffers.get().find((b) => b.id === currentId);
      if (!buffer?.path) return null;
      return { uri: pathToUri(buffer.path), languageId: buffer.languageId };
    },
    /**
     * Read per query rather than captured, so saving `snippets.json` reaches
     * an open pane without anything being rebuilt. The language comes off the
     * buffer directly rather than through `documentOf`, which is null for an
     * untitled one - and an untitled scratch buffer is exactly where a snippet
     * earns its keep.
     */
    snippets: () => {
      const buffer = workspace.buffers.get().find((b) => b.id === currentId);
      return buffer ? app.snippets.forLanguage(buffer.languageId) : [];
    },
  };
  const lspExtensions = [
    completionExtension(lspDeps),
    lspHoverExtension(lspDeps),
    // Not LSP, but the same lifecycle: pane-scoped because it needs the app.
    // A mousedown on the git gutter opens the diff view — the click that
    // gutter's own design deferred to exactly this feature.
    onGitGutterClick.of(() => void app.commands.execute('git.showDiff')),
  ];
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The buffer `autosaveTimer` was armed for; see `scheduleAutosave`. */
  let autosaveTarget: string | null = null;

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
          // A change forwarded from the other pane showing this file has
          // already been recorded by the workspace — handing it back would
          // overwrite `buffer.state` with this pane's copy of it and bounce
          // between the two forever.
          if (transaction.annotation(mirroredAnnotation)) continue;
          workspace.applyTransaction(id, transaction, instance);
          docChanged ||= transaction.docChanged;
        }

        publishCursor();
        find.refresh(docChanged);
        if (docChanged) {
          scheduleAutosave();
          // Beside the autosave timer because it is the same shape and the
          // same cost: one call that resets one timer. Plugins hear about
          // this once the typing stops, and only the ones that already
          // decorated this buffer hear about it at all.
          app.plugins.noteDocumentChanged(id);
        }
      },
    });

    app.registerGroupView(groupId, view);

    // Lets the workspace push changes (an external reload, a grouped undo)
    // into the live view instead of resetting state, so scroll position and
    // undo history survive. Every pane registers; each declines the buffers it
    // is not showing.
    const offDispatcher = workspace.addViewDispatcher(
      (id, spec) => {
        if (!view || id !== currentId) return false;
        view.dispatch(spec);
        return true;
      },
      {
        // Identifies this pane, so an edit it originated is not sent back.
        owner: view,
        groupId,
        // A grouped undo runs against this view rather than arriving as a
        // transaction built elsewhere: with one file in two panes the
        // workspace holds whichever pane's state dispatched last, and the
        // view refuses a transaction that does not start from its own.
        run: (id, command) => {
          if (!view || id !== currentId) return null;
          return command(view);
        },
        // Pulled at save time rather than published: a cursor moves on every
        // keystroke, and only the session ever reads it.
        //
        // Answered **only for the tab this pane is currently showing**. A
        // view's live selection is its active tab's, so answering for any
        // buffer handed the foreground tab's cursor back for every background
        // tab in this pane — which is what the session then wrote down.
        // Declining lets the workspace fall back to that buffer's own state,
        // which is where a background tab's cursor actually lives.
        readSelection: (id) => {
          if (!view || id !== currentId) return null;
          const selection = view.state.selection;
          return {
            ranges: selection.ranges.map((r) => [r.anchor, r.head] as [number, number]),
            main: selection.mainIndex,
          };
        },
      },
    );

    // Diagnostics are painted from here rather than from the app, because
    // `currentId` is the only authoritative answer to "which buffer is this
    // view showing". The app knows `workspace.activeId`, which changes
    // synchronously — while the swap below happens in an effect, which runs
    // later. Painting on the app's signal wrote the newly-active buffer's
    // diagnostics into the previously-active buffer's state, and
    // `dispatchTransactions` recorded them there permanently.
    const offDiagnostics = lsp.diagnostics.subscribe(() => paintDiagnostics());
    // Same trap, same fix: keyed off `currentId`, painted from the pane.
    const offGit = app.git.hunks.subscribe(() => paintGitGutter());
    const offBlame = app.git.blame.subscribe(() => paintBlame());
    const offDecorations = app.plugins.decorations.revision.subscribe(() => paintPluginMarks());

    syncToBuffer(activeId);

    const offReset = workspace.events.on('buffer-reset', ({ id }) => {
      if (id === currentId) syncToBuffer(id, { force: true });
    });

    // Save As is the one way a buffer changes its name without changing
    // its identity. An event rather than a subscription to `buffers`: that
    // list is republished on every keystroke, and the name is not.
    const offSaved = workspace.events.on('saved', ({ id }) => {
      if (view && id === currentId) {
        view.dispatch({ effects: accessibleNameCompartment.reconfigure(accessibleName(id)) });
      }
    });

    const offConfig = config.changed.subscribe((keys) => {
      if (!view || keys.size === 0) return;
      const effects = reconfigureEffects(config.settings.get(), keys);
      if (effects.length > 0) view.dispatch({ effects });
    });

    return () => {
      offReset();
      offSaved();
      offConfig();
      offDispatcher();
      offDiagnostics();
      offGit();
      offBlame();
      offDecorations();
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

  /**
   * Draw the diagnostics belonging to the buffer this view is actually
   * showing. Keyed off `currentId`, never off the app-wide active id.
   */
  function paintGitGutter() {
    if (!view || !currentId) return;
    const entry = app.git.hunks.get().get(currentId);
    // No entry clears: the buffer may have just lost its last hunk, or the
    // view may still carry the previous buffer's marks after a swap.
    view.dispatch({ effects: setGitGutter.of(entry ? gutterLines(entry.hunks) : []) });
  }

  /**
   * Draw whatever plugins have asked for in the buffer this view is showing.
   *
   * Keyed off `currentId` like the two above, and clearing when there is
   * nothing — a view that has just swapped buffers would otherwise keep the
   * marks of the file it was showing a moment ago.
   */
  function paintPluginMarks() {
    if (!view || !currentId) return;
    applyPluginDecorations(view, app.plugins.decorations.forBuffer(currentId));
  }

  /**
   * Draw blame for the buffer this view is showing, and install or remove
   * the gutter along with it.
   *
   * Keyed off `currentId` rather than the app-wide active id, for the reason
   * `paintGitGutter` gives. The compartment and the marks move in one
   * transaction on purpose: a gutter installed a tick ahead of its marks
   * flashes empty, and marks dispatched into a state whose gutter has just
   * gone are drawn by nothing.
   *
   * An absent entry is blame switched *off*, which is why this clears rather
   * than returns. A view that has just swapped buffers would otherwise keep
   * the column, and the names, of the file it was showing a moment ago.
   */
  function paintBlame() {
    if (!view || !currentId) return;
    const lines = app.git.blame.get().get(currentId);
    view.dispatch({
      effects: [
        blameCompartment.reconfigure(lines ? blameExtension : []),
        setGitBlame.of(lines ?? []),
      ],
    });
  }

  function paintDiagnostics() {
    if (!view || !currentId) return;

    const path = workspace.buffers.get().find((b) => b.id === currentId)?.path ?? null;
    // An untitled buffer has no URI, so nothing can have been published for
    // it — clear rather than return, or it keeps the marks of whatever the
    // view showed before.
    applyDiagnostics(view, path ? lsp.diagnosticsFor(pathToUri(path)) : []);
  }

  /**
   * What a screen reader calls the textbox. The file's name, because the
   * `<section aria-label="Editor">` around it already says what kind of
   * thing this is and the focused element is the one that gets read: with
   * no name of its own, CodeMirror's `contentDOM` was announced by its first
   * line of text.
   */
  function accessibleName(id: string) {
    const name = workspace.buffers.get().find((b) => b.id === id)?.name ?? 'Untitled';
    return EditorView.contentAttributes.of({ 'aria-label': `${name} editor` });
  }

  function syncToBuffer(id: string | null, options: { force?: boolean } = {}) {
    if (!view) return;
    if (id === currentId && !options.force) return;

    // Leaving a buffer ends the pause its autosave was waiting for. Saving it
    // now rather than letting the timer run keeps the promise for exactly the
    // buffer the user just left, which is the one a stale timer used to skip.
    if (id !== currentId) flushAutosave();
    currentId = id;
    if (!id) return;

    const state = workspace.stateOf(id);
    if (!state) return;

    view.setState(state);

    // A cursor this pane was restored with, if any. `setState` above adopted
    // the buffer's, which is the other pane's when one file is in two.
    const restored = workspace.takePaneSelection(groupId, id);
    if (restored && restored.ranges.length > 0) {
      const limit = view.state.doc.length;
      const clamp = (n: number) => Math.max(0, Math.min(limit, n));
      view.dispatch({
        selection: EditorSelection.create(
          restored.ranges.map(([anchor, head]) => EditorSelection.range(clamp(anchor), clamp(head))),
          Math.max(0, Math.min(restored.ranges.length - 1, restored.main)),
        ),
        scrollIntoView: true,
      });
    }

    // Background buffers may have been created under older settings, and a
    // state swap does not carry compartment configuration across.
    const buffer = workspace.buffers.get().find((b) => b.id === id);
    const languageId = buffer?.languageId ?? 'plaintext';
    view.dispatch({
      effects: [
        ...reconfigureAllEffects(config.settings.get()),
        languageCompartment.reconfigure(cachedLanguage(languageId) ?? []),
        // `setState` resets every compartment to the state's own
        // configuration, so this is re-applied on each swap rather than once.
        lspCompartment.reconfigure(lspExtensions),
        accessibleNameCompartment.reconfigure(accessibleName(id)),
      ],
      // `setState` resets the scroll to the top of the document, so without
      // this a tab switch — or a session restored mid-file — lands nowhere
      // near the cursor it just restored.
      scrollIntoView: true,
    });

    // After the swap, never before: `setState` replaces the whole state, so
    // anything painted first is discarded, and anything painted while the old
    // state is still loaded lands on the wrong buffer.
    paintDiagnostics();
    paintGitGutter();
    paintBlame();
    paintPluginMarks();

    publishCursor();
    find.attach(view);
    // A buffer swap, not an edit or a selection move: always worth a fresh
    // count, the same as before `refresh()` learned to skip selection-only
    // dispatches.
    find.refresh(true);

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
    // Captured now, not read when the timer fires: the timer outlives a tab
    // switch, and `currentId` by then is whichever buffer the pane moved to.
    const id = currentId;
    if (!id) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTarget = id;
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      autosaveTarget = null;
      autosaveIfDirty(id);
    }, config.get('files.autoSaveDelay'));
  }

  /** Run a pending after-delay save now instead of when its timer fires. */
  function flushAutosave() {
    if (!autosaveTimer) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    const id = autosaveTarget;
    autosaveTarget = null;
    if (id) autosaveIfDirty(id);
  }

  function autosaveIfDirty(id: string) {
    const buffer = workspace.buffers.get().find((b) => b.id === id);
    // Never auto-prompt a Save As dialog behind the user's back.
    if (buffer?.isDirty && !buffer.isUntitled) void app.save(id);
  }

  function onBlur() {
    if (config.get('files.autoSave') !== 'onFocusChange') return;
    const id = currentId;
    const buffer = id ? workspace.buffers.get().find((b) => b.id === id) : null;
    if (id && buffer?.isDirty && !buffer.isUntitled) void app.save(id);
  }

  // --- Context menu --------------------------------------------------------

  /**
   * Built when the menu opens, from the registry rather than from literals.
   *
   * Reading `menu` first is what makes this a snapshot: `enabled()` and
   * `displayFor()` consult live state through plain getters that Svelte does
   * not track, so recomputing is tied to the one event that matters — the
   * menu being opened.
   */
  const menuItems = $derived.by<MenuItem[]>(() => {
    if (!menu) return [];
    return MENU_COMMANDS.flatMap(({ id, separatorBefore }) => {
      const command = app.commands.get(id);
      if (!command) return [];
      // Application bindings win; `keyHint` covers the CodeMirror-owned ones.
      // Left undefined when there is neither, so the menu renders no chord
      // rather than an empty one — `keybindings.json` can `remove` a default.
      const hint =
        app.keymap.displayFor(id) ??
        (command.keyHint ? formatChord(normalizeChord(command.keyHint)) : undefined);
      // Disabled, never omitted: a user who cannot format this file still
      // learns that Nox formats files, and which key does it.
      return [
        {
          id,
          label: command.title,
          hint,
          disabled: !app.commands.isEnabled(id),
          separatorBefore,
        },
      ];
    });
  });

  /**
   * Right-clicking inside the selection keeps it; right-clicking outside
   * collapses the caret to where the pointer landed. That is the convention
   * `ExplorerPanel` follows for rows, and it exists for the same reason: a
   * menu that acts on something other than what you pointed at silently
   * destroys work — here, a multi-line selection about to be commented out.
   *
   * The `preventDefault` is the defect this whole handler replaces. Without
   * it the packaged app answers a right-click with WebKit's menu — Reload,
   * Services, Look Up — on its most central surface.
   */
  function openMenu(event: MouseEvent) {
    event.preventDefault();

    if (view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const inside =
        pos !== null &&
        view.state.selection.ranges.some(
          (range) => !range.empty && pos >= range.from && pos <= range.to,
        );
      if (pos !== null && !inside) view.dispatch({ selection: EditorSelection.cursor(pos) });
    }

    menu = { anchor: { x: event.clientX, y: event.clientY }, returnTo: view?.contentDOM ?? null };
  }

  /**
   * Keyboard equivalent, anchored to the caret rather than to a pointer.
   *
   * `coordsAtPos` needs real layout, so the host's own box is the fallback —
   * which is also the only branch jsdom can ever take.
   */
  function openMenuFromKeyboard() {
    const coords = view ? view.coordsAtPos(view.state.selection.main.head) : null;
    const rect = host?.getBoundingClientRect();
    menu = {
      anchor: coords
        ? { x: coords.left, y: coords.bottom }
        : { x: (rect?.left ?? 0) + 24, y: (rect?.top ?? 0) + 24 },
      returnTo: view?.contentDOM ?? null,
    };
  }

  /**
   * This listener does sit on the typing path, so it is written to leave it
   * immediately: two comparisons and a return for every key that is not one
   * of the two menu keys. Nothing here scales with document size.
   */
  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault();
    openMenuFromKeyboard();
  }

  function runMenuItem(id: string) {
    menu = null;
    // By id, like every other user action, so the palette and the keybinding
    // reference keep describing the same thing this menu does.
    void app.commands.execute(id);
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
  oncontextmenu={openMenu}
  onkeydown={onKeydown}
  aria-label="Editor"
></section>

{#if menu}
  <!-- Keyed so each invocation is a fresh menu with its own initial state. -->
  {#key `${menu.anchor.x}:${menu.anchor.y}`}
    <ContextMenu
      items={menuItems}
      anchor={menu.anchor}
      onSelect={runMenuItem}
      onDismiss={() => (menu = null)}
      returnFocusTo={menu.returnTo}
    />
  {/key}
{/if}

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
