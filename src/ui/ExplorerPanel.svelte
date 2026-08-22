<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { GIT_STATUS_LABEL, type GitStatusLetter } from '@core/git-status';
  import { FOLDER_STATUS_LABEL, rollUpLetters, rollUpPaths } from '@core/folder-marks';
  import { canMoveInto, dirname, join, separatorOf } from '@core/path';
  import { rootLabel, type FlatNode } from '@services/filetree';
  import { useApp } from './context';
  import ContextMenu, { type MenuAnchor, type MenuItem } from './ContextMenu.svelte';
  import Icon from './Icon.svelte';

  const app = useApp();
  const { workspace, files, ui, commands, git } = app;

  const nodes = files.nodes;
  const rootError = files.rootError;
  const rootPath = workspace.rootPath;
  const buffers = workspace.buffers;
  const activeId = workspace.activeId;
  const gitStatus = git.status;
  const focusRequest = ui.focusExplorerRequest;
  const selection = ui.explorer;
  const selectedPaths = selection.paths;
  const lead = selection.lead;

  let listElement = $state<HTMLElement | null>(null);
  let menu = $state<{ anchor: MenuAnchor; path: string | null } | null>(null);

  /**
   * Windowing.
   *
   * `FileTreeService` has exposed the tree as a flat ordered list since v0.1
   * precisely so the renderer could do this; nothing in the model changes.
   * The row height lives here rather than in the stylesheet, and the CSS
   * reads it back through `--nox-tree-row-h`, so the number the arithmetic
   * uses and the number the browser paints cannot drift apart. See
   * `docs/superpowers/specs/2026-08-20-explorer-virtualisation-design.md`.
   */
  const ROW_HEIGHT = 23;
  const OVERSCAN = 8;
  /** Below this, the extra state costs more than the skipped rows save. */
  const MIN_ROWS_TO_WINDOW = 200;

  let scrollTop = $state(0);
  let viewportHeight = $state(0);

  /**
   * What cannot be measured is not windowed.
   *
   * A viewport height of zero means "before layout" — or jsdom, which has no
   * layout at all. Windowing on that would render nothing, which is a far
   * worse failure than rendering too much.
   */
  const windowed = $derived(viewportHeight > 0 && $nodes.length > MIN_ROWS_TO_WINDOW);

  const firstIndex = $derived(
    windowed ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0,
  );
  const endIndex = $derived(
    windowed
      ? Math.min(
          $nodes.length,
          firstIndex + Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2,
        )
      : $nodes.length,
  );
  const visibleNodes = $derived($nodes.slice(firstIndex, endIndex));
  const padTop = $derived(firstIndex * ROW_HEIGHT);
  const padBottom = $derived(($nodes.length - endIndex) * ROW_HEIGHT);

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

  const activeBuffer = $derived($buffers.find((b) => b.id === $activeId) ?? null);

  /**
   * Which paths are open, and which of those are unsaved — in one pass.
   *
   * `workspace.buffers` is republished by `#sync` on every document-changing
   * transaction (`workspace.ts#applyTransaction`), so anything derived from
   * it here runs per keystroke and is squarely rule 5 territory. The walk is
   * over open *tabs* — tens of entries — and never over document text:
   * `isDirty` is a plain field on the snapshot, computed inside `#sync`
   * whether or not this panel reads it, and bounded there by
   * `EXACT_DIRTY_LIMIT` for exactly the 10 MB-file reason. Folding the dirty
   * set into the walk that already built `openPaths` is what keeps the added
   * per-keystroke cost at zero extra iterations rather than one more.
   *
   * `dirtyAncestors` is the folder roll-up, and it is the one thing here that
   * is not free. It rides this trigger rather than `git.status` because this
   * is where dirtiness lives — the brief's "same trigger as the git map" does
   * not apply to the half of the answer git does not hold. What keeps it
   * inside rule 5 is that it climbs the *dirty* set, not the open one: with
   * nothing unsaved it does no work at all, and with one unsaved file it is
   * a handful of `dirname` calls bounded by that file's depth, against a
   * keystroke that has already run a CodeMirror transaction and a full
   * `#sync` over every buffer.
   */
  const bufferPaths = $derived.by(() => {
    const open = new Set<string>();
    const dirty = new Set<string>();
    for (const buffer of $buffers) {
      if (!buffer.path) continue;
      open.add(buffer.path);
      if (buffer.isDirty) dirty.add(buffer.path);
    }
    const root = $rootPath;
    return {
      open,
      dirty,
      dirtyAncestors: root ? rollUpPaths(dirty, root) : new Set<string>(),
    };
  });

  /**
   * Git's answer per row, keyed by absolute path.
   *
   * Deliberately *not* a `FlatNode` field. This is view state layered onto
   * the model: `FileTreeService` would have to re-run `#flatten` and publish
   * a new `nodes` array on every status refresh, and that identity change is
   * what the windowing slice, the `#each` key and every selection derived
   * all hang off — the whole tree would churn for a fact none of them
   * depend on. Guarded by `tests/explorer-decorations.test.ts`.
   *
   * Recomputes only when `git.status` is republished: a save, an external
   * change, a `.git` write the meta watcher catches, a root change, or the
   * explicit refresh command (`services/git.ts`). Typing republishes
   * `workspace.buffers`, never this, so the map is off the typing path
   * entirely — its cost is one pass over the changed-file list per git
   * refresh.
   *
   * Status paths are toplevel-relative, and the toplevel is *not* the
   * workspace root whenever a workspace is opened below it. Joining onto the
   * wrong one silently decorates a same-named file elsewhere in the tree,
   * which is the bug `GitStatus.toplevel` exists to prevent — so no
   * toplevel means no decorations rather than a guess.
   */
  const gitLetters = $derived.by(() => {
    const letters = new Map<string, GitStatusLetter>();
    /*
      Untracked *directories*, as absolute paths ending in a separator.

      git collapses an untracked directory into a single `? lib/` record and
      never mentions the files inside it, so a tree that only ever matches
      exact paths shows nothing at all for a newly created folder — not on the
      folder, not on anything in it. Found by walking the packaged app; no
      component test could have reached it, because the fake git in
      `MemoryPlatform` only ever emitted `? <file>`.
    */
    const untrackedDirectories: string[] = [];
    const ancestors = new Map<string, GitStatusLetter>();
    const status = $gitStatus;
    const toplevel = status?.toplevel;
    const root = $rootPath;
    if (!status || !toplevel || !root) return { letters, untrackedDirectories, ancestors };
    // Unstaged is written second so the worktree fact wins: the tree shows
    // the file on disk, not the index. A conflict only ever arrives
    // unstaged, so the letter that must never be overwritten cannot be.
    for (const entry of status.staged) letters.set(join(toplevel, entry.path), entry.status);
    for (const entry of status.unstaged) {
      const absolute = join(toplevel, entry.path);
      letters.set(absolute, entry.status);
      // The trailing slash is the only thing that distinguishes git's
      // directory form from a file, and `join` strips it — so it has to be
      // read off the record before joining.
      if (entry.path.endsWith('/')) {
        untrackedDirectories.push(absolute + separatorOf(absolute));
      }
    }
    /*
      The folder roll-up, in the same pass and on the same trigger. Bounded by
      the *workspace* root rather than the toplevel: those differ whenever a
      workspace is opened below its repo root, and only rows at or below the
      workspace root exist to be marked — so climbing past it would be work
      spent on paths the tree can never show. `rollUpLetters` skips any status
      path outside that root for the same reason `gitLetters` joins onto
      `toplevel` at all: a change in a sibling directory of the workspace is
      not this tree's business.
    */
    return { letters, untrackedDirectories, ancestors: rollUpLetters(letters, root) };
  });

  /**
   * The letter for one row, exact match first and then the untracked-directory
   * prefixes. Prefix matching is last because it is the rarer and more
   * expensive answer, and a file git named directly must win over an ancestor.
   *
   * A directory takes the roll-up in between the two: what is actually inside
   * it is a more specific answer than an ancestor git collapsed into a single
   * `? dir/` record. The exact match still comes first, and it is what finally
   * puts a marker on that `? dir/` row itself — the marks group used to be
   * skipped for every directory, so the one folder git *had* named directly
   * was the one folder that showed nothing.
   */
  function letterFor(path: string, isDirectory: boolean): GitStatusLetter | undefined {
    const exact = gitLetters.letters.get(path);
    if (exact) return exact;
    if (isDirectory) {
      const rolled = gitLetters.ancestors.get(path);
      if (rolled) return rolled;
    }
    return gitLetters.untrackedDirectories.some((prefix) => path.startsWith(prefix))
      ? 'U'
      : undefined;
  }

  /**
   * The markers one row carries, or null for a row that carries none.
   *
   * A file answers for itself and a **collapsed** directory answers for what
   * is under it; an expanded directory answers for neither, because the rows
   * below it now do — leaving it marked would stack the same letter up every
   * ancestor of whatever file you were reading, and the marker exists to say
   * "is this worth opening", which an open folder has already answered.
   *
   * That rule is also what keeps the right edge single-occupancy. `#flatten`
   * gates `loading`, `empty` and `error` on `expanded`
   * (`services/filetree.ts`), so a collapsed directory has all three falsy by
   * construction: a row that can show a marker can never also want the note
   * slot the marker's wrapper claims, and the two need no precedence rule
   * between them.
   */
  function marksFor(node: FlatNode): {
    letter: GitStatusLetter | undefined;
    letterLabel: string;
    dirty: boolean;
    dotLabel: string;
  } | null {
    if (node.isDirectory && node.expanded) return null;
    const rolled = node.isDirectory;
    const letter = letterFor(node.path, rolled);
    const dirty = rolled
      ? bufferPaths.dirtyAncestors.has(node.path)
      : bufferPaths.dirty.has(node.path);
    if (!letter && !dirty) return null;
    return {
      letter,
      letterLabel: letter ? (rolled ? FOLDER_STATUS_LABEL : GIT_STATUS_LABEL)[letter] : '',
      dirty,
      dotLabel: rolled ? 'Contains unsaved changes' : 'Unsaved changes',
    };
  }

  /** Visible rows in display order — the axis every range operation works on. */
  const orderedPaths = $derived($nodes.map((node) => node.path));
  const leadIndex = $derived($nodes.findIndex((n) => n.path === $lead));
  const selectionCount = $derived($selectedPaths.size);

  /** Target directory for the header's create buttons. */
  const targetDirectory = $derived.by(() => {
    if (!$lead) return $rootPath;
    const node = $nodes.find((n) => n.path === $lead);
    if (!node) return $rootPath;
    return node.isDirectory ? node.path : dirname(node.path);
  });

  /**
   * The focus request, and *only* the focus request, may re-run this effect.
   *
   * It used to read `$lead` and `$nodes` in its tracked body, which coupled it
   * to the effect below — and that one writes the lead on every active-buffer
   * change. So clicking a tab or accepting a quick-open re-ran this and pulled
   * keyboard focus out of the editor and into the tree: `↓` then scrolled the
   * file list instead of moving the cursor, and `Backspace` fired
   * `explorer.delete`, popping a Move-to-Trash dialog over the document the
   * user believed they were typing in. `untrack` keeps the seeding read
   * without re-establishing that dependency. Guarded by
   * `tests/explorer-focus.test.ts`.
   */
  $effect(() => {
    void $focusRequest;
    const element = listElement;
    if (!element) return;
    untrack(() => {
      if (!$lead && $nodes.length > 0) selection.set($nodes[0]!.path);
    });
    element.focus();
  });

  // Follow the active tab in the tree, the way every good explorer does — but
  // never stomp a multi-selection the user is in the middle of building.
  $effect(() => {
    const path = activeBuffer?.path;
    if (path && selection.size <= 1) selection.set(path);
  });

  async function activate(path: string, isDirectory: boolean) {
    selection.set(path);
    if (isDirectory) await toggleDirectory(path);
    else await workspace.open(path);
  }

  /**
   * Collapsing a folder drops the selection inside it: rows you cannot see
   * must not stay selected, or Delete would act on things that are off-screen.
   */
  async function toggleDirectory(path: string) {
    const wasExpanded = files.isExpanded(path);
    await files.toggle(path);
    if (wasExpanded) selection.removeUnder(path);
  }

  function move(delta: number, extend: boolean) {
    if ($nodes.length === 0) return;
    const from = leadIndex === -1 ? 0 : leadIndex;
    const next = Math.max(0, Math.min($nodes.length - 1, from + delta));
    const path = $nodes[next]?.path;
    if (!path) return;

    if (extend) selection.extendTo(path, orderedPaths);
    else selection.set(path);
    scrollSelectionIntoView();
  }

  function jumpTo(index: number, extend: boolean) {
    const path = $nodes[index]?.path;
    if (!path) return;
    if (extend) selection.extendTo(path, orderedPaths);
    else selection.set(path);
    scrollSelectionIntoView();
  }

  async function onRowClick(event: MouseEvent, node: { path: string; isDirectory: boolean }) {
    // Range and toggle clicks adjust the selection only; they never open a
    // file, because opening while building a selection is never the intent.
    if (event.shiftKey) {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) selection.addRangeTo(node.path, orderedPaths);
      else selection.extendTo(node.path, orderedPaths);
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      selection.toggle(node.path);
      return;
    }
    await activate(node.path, node.isDirectory);
  }

  // --- Drag and drop -----------------------------------------------------

  /**
   * Dragging moves entries into a folder. Dropping onto a *file* targets the
   * folder that contains it, which is what people actually aim at — nobody
   * intends to drop "into" a file.
   */
  let drag = $state<{ paths: string[]; over: string | null; valid: boolean } | null>(null);

  function dropTargetFor(node: { path: string; isDirectory: boolean } | null): string | null {
    if (!node) return $rootPath;
    return node.isDirectory ? node.path : dirname(node.path);
  }

  function onDragStart(event: DragEvent, node: { path: string; isDirectory: boolean }) {
    // Dragging a row inside the selection drags the whole selection; dragging
    // one outside it replaces the selection first, matching the menu's rule.
    if (!$selectedPaths.has(node.path)) selection.set(node.path);
    const paths = selection.ordered(orderedPaths);

    drag = { paths, over: null, valid: false };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // A payload is required for Firefox to start a drag at all.
      event.dataTransfer.setData('text/plain', paths.join('\n'));
    }
  }

  function onDragOver(event: DragEvent, node: { path: string; isDirectory: boolean } | null) {
    if (!drag) return;
    const target = dropTargetFor(node);
    const valid = target !== null && drag.paths.every((path) => canMoveInto(path, target));

    drag = { ...drag, over: valid ? target : null, valid };
    if (!valid) return;

    // Only a preventDefault here makes the element a legal drop site, so an
    // invalid target simply refuses the drop rather than failing after it.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  function onDrop(event: DragEvent, node: { path: string; isDirectory: boolean } | null) {
    event.preventDefault();
    const current = drag;
    drag = null;
    if (!current?.valid) return;

    const target = dropTargetFor(node);
    if (!target) return;
    void commands.execute('explorer.moveTo', { paths: current.paths, target });
  }

  // --- Context menu ------------------------------------------------------

  /**
   * Right-clicking inside the selection keeps it; right-clicking outside
   * replaces it with the clicked row. That is the convention every file
   * manager uses, and getting it wrong means the menu silently acts on
   * something other than what you pointed at.
   */
  function openMenu(event: MouseEvent, path: string | null) {
    event.preventDefault();
    event.stopPropagation();
    if (path && !selection.has(path)) selection.set(path);
    menu = { anchor: { x: event.clientX, y: event.clientY }, path };
  }

  /**
   * Keyboard equivalent: anchor to the focused row rather than the pointer.
   *
   * A menu needs real coordinates, so this one does still measure a real
   * element — which means scrolling the lead into view and letting the window
   * re-render before looking for it. The fixed fallback stays for the case
   * where there is no lead at all.
   */
  async function openMenuFromKeyboard() {
    revealLead();
    await tick();
    const row = listElement?.querySelector('.row.lead');
    const rect = row?.getBoundingClientRect();
    menu = {
      anchor: rect ? { x: rect.left + 24, y: rect.bottom } : { x: 120, y: 120 },
      path: $lead,
    };
  }

  /**
   * Paths the open menu acts on: the whole selection, or the clicked row.
   * Reads `$selectedPaths` rather than `selection.has()` so the derived
   * actually tracks the selection instead of snapshotting it.
   */
  const menuPaths = $derived.by(() => {
    const path = menu?.path ?? null;
    if (!path) return [];
    if (!$selectedPaths.has(path)) return [path];
    return orderedPaths.filter((candidate) => $selectedPaths.has(candidate));
  });

  const menuItems = $derived.by<MenuItem[]>(() => {
    const count = menuPaths.length;
    const many = count > 1;
    const files_ = menuPaths.filter(
      (path) => !$nodes.find((node) => node.path === path)?.isDirectory,
    );

    const items: MenuItem[] = [
      { id: 'explorer.newFile', label: 'New File…' },
      { id: 'explorer.newFolder', label: 'New Folder…' },
    ];

    if (count > 0) {
      if (files_.length > 0) {
        items.push({
          id: 'explorer.openSelection',
          label: many ? `Open ${files_.length} Files` : 'Open',
          separatorBefore: true,
        });
      }

      items.push(
        {
          id: 'explorer.rename',
          label: 'Rename…',
          hint: 'F2',
          // Renaming several things at once needs a pattern UI, not a prompt.
          disabled: many,
          separatorBefore: files_.length === 0,
        },
        {
          id: 'explorer.duplicate',
          label: many ? `Duplicate ${files_.length} Files` : 'Duplicate',
          disabled: files_.length === 0,
        },
        {
          id: 'explorer.delete',
          label: many ? `Delete ${count} Items…` : 'Delete…',
          hint: '⌫',
          danger: true,
        },
        {
          id: 'explorer.copyPath',
          label: many ? `Copy ${count} Paths` : 'Copy Path',
          separatorBefore: true,
        },
        {
          id: 'explorer.copyRelativePath',
          label: many ? `Copy ${count} Relative Paths` : 'Copy Relative Path',
          disabled: !$rootPath,
        },
      );

      if (app.platform.capabilities.revealInFileManager) {
        items.push({
          id: 'explorer.revealInFileManager',
          label: 'Reveal in File Manager',
          disabled: many,
        });
      }
    }

    items.push(
      { id: 'explorer.refresh', label: 'Refresh', separatorBefore: true },
      { id: 'explorer.collapseAll', label: 'Collapse All' },
    );

    return items;
  });

  function runMenuItem(id: string) {
    const paths = menuPaths;
    menu = null;
    void commands.execute(id, paths);
  }

  /**
   * Put the lead row on screen, by arithmetic rather than by element.
   *
   * `scrollIntoView` on `.row.lead` stopped being possible the moment the
   * lead can be outside the window — which is exactly when this matters.
   * Working from the index needs no row in the DOM, and no `scrollIntoView`,
   * which jsdom does not implement anyway.
   */
  function revealLead(): void {
    const element = listElement;
    if (!element) return;
    const index = leadIndex;
    if (index < 0) return;

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

  function scrollSelectionIntoView() {
    queueMicrotask(revealLead);
  }

  async function onKeydown(event: KeyboardEvent) {
    const node = $nodes[leadIndex];
    const extend = event.shiftKey;

    // Select-all is handled here rather than in the global keymap so ⌘A only
    // means "select every row" while the explorer actually has focus.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selection.selectAll(orderedPaths);
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1, extend);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1, extend);
        break;
      case 'Home':
        event.preventDefault();
        jumpTo(0, extend);
        break;
      case 'End':
        event.preventDefault();
        jumpTo($nodes.length - 1, extend);
        break;
      case 'ArrowRight':
        if (!node) return;
        event.preventDefault();
        if (node.isDirectory && !node.expanded) await files.toggle(node.path);
        else move(1, extend);
        break;
      case 'ArrowLeft': {
        if (!node) return;
        event.preventDefault();
        if (node.isDirectory && node.expanded) {
          await toggleDirectory(node.path);
        } else {
          // Jump to the parent directory row.
          const parent = dirname(node.path);
          const parentIndex = $nodes.findIndex((n) => n.path === parent);
          if (parentIndex >= 0) jumpTo(parentIndex, extend);
        }
        break;
      }
      case ' ':
        // Space toggles the focused row without moving, the standard way to
        // build a non-contiguous selection from the keyboard alone.
        if (!node) return;
        event.preventDefault();
        selection.toggle(node.path);
        break;
      case 'Enter':
        if (!node) return;
        event.preventDefault();
        if (selectionCount > 1) {
          void commands.execute('explorer.openSelection', selection.ordered(orderedPaths));
        } else {
          await activate(node.path, node.isDirectory);
        }
        break;
      case 'Escape':
        event.preventDefault();
        // Escape narrows before it leaves: first collapse the selection, then
        // hand focus back to the editor on a second press.
        if (selectionCount > 1) selection.collapseToLead();
        else ui.focusEditor();
        break;

      // File operations are bound here rather than in the global keymap so
      // Delete only deletes files while the explorer actually has focus.
      case 'F2':
        if (!node) return;
        event.preventDefault();
        // Rename is single-target even when several rows are selected.
        void commands.execute('explorer.rename', node.path);
        break;
      case 'Delete':
      case 'Backspace': {
        event.preventDefault();
        const paths = selectionCount > 0 ? selection.ordered(orderedPaths) : node ? [node.path] : [];
        if (paths.length > 0) void commands.execute('explorer.delete', paths);
        break;
      }
      case 'ContextMenu':
        event.preventDefault();
        void openMenuFromKeyboard();
        break;
      case 'F10':
        if (!event.shiftKey) return;
        event.preventDefault();
        void openMenuFromKeyboard();
        break;
    }
  }
</script>

<div class="explorer-panel">
  <div class="header">
    <span class="title" title={$rootPath ?? undefined}>{rootLabel($rootPath)}</span>
    {#if selectionCount > 1}
      <span class="count" aria-live="polite">{selectionCount} selected</span>
    {/if}
    <div class="header-actions">
      {#if $rootPath}
        <button
          class="icon-button"
          title="New File"
          aria-label="New file"
          onclick={() => targetDirectory && void app.newFileInFolder(targetDirectory)}
        >
          <Icon name="plus" size={14} />
        </button>
        <button
          class="icon-button"
          title="New Folder"
          aria-label="New folder"
          onclick={() => targetDirectory && void app.newFolderIn(targetDirectory)}
        >
          <Icon name="folder" size={14} />
        </button>
        <button
          class="icon-button"
          title="Refresh"
          aria-label="Refresh explorer"
          onclick={() => void files.refresh()}
        >
          <Icon name="refresh" size={14} />
        </button>
        <button
          class="icon-button"
          title="Collapse All"
          aria-label="Collapse all folders"
          onclick={() => files.collapseAll()}
        >
          <Icon name="collapse" size={14} />
        </button>
      {/if}
    </div>
  </div>

  {#if !$rootPath}
    <div class="nox-empty">
      <p class="empty-title">No folder open</p>
      <p>Open a folder to browse its files.</p>
      <button class="ghost-button" onclick={() => void commands.execute('file.openFolder')}>
        Open Folder
      </button>
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <div
      class="tree nox-scroll"
      class:drop-root={drag?.valid && drag.over === $rootPath}
      role="tree"
      aria-label="Files"
      tabindex="0"
      bind:this={listElement}
      style="--nox-tree-row-h: {ROW_HEIGHT}px"
      onscroll={(event) => {
        scrollTop = event.currentTarget.scrollTop;
        measure();
      }}
      onkeydown={onKeydown}
      oncontextmenu={(event) => openMenu(event, null)}
      ondragover={(event) => onDragOver(event, null)}
      ondrop={(event) => onDrop(event, null)}
      ondragleave={(event) => {
        // Only clear when the pointer actually leaves the tree, not when it
        // crosses between two rows inside it.
        if (drag && !event.currentTarget.contains(event.relatedTarget as Node)) {
          drag = { ...drag, over: null, valid: false };
        }
      }}
    >
      {#if padTop > 0}
        <div class="spacer" style="height: {padTop}px" role="presentation"></div>
      {/if}
      <!-- `aria-setsize` / `aria-posinset` below are mandatory, not decorative:
           once rows leave the DOM a screen reader would otherwise be told the
           tree is exactly as long as the window. -->
      {#each visibleNodes as node, index (node.path)}
        {@const marks = marksFor(node)}
        <div
          class="row"
          class:selected={$selectedPaths.has(node.path)}
          class:lead={node.path === $lead}
          class:open={bufferPaths.open.has(node.path)}
          class:current={activeBuffer?.path === node.path}
          class:menu-target={menu?.path === node.path}
          class:drop-into={drag?.valid && drag.over === (node.isDirectory ? node.path : null)}
          class:dragging={drag?.paths.includes(node.path)}
          draggable="true"
          ondragstart={(event) => onDragStart(event, node)}
          ondragover={(event) => {
            // Must not reach the tree container, which would re-target the
            // drop at the workspace root and highlight the wrong thing.
            event.stopPropagation();
            onDragOver(event, node);
          }}
          ondrop={(event) => {
            event.stopPropagation();
            onDrop(event, node);
          }}
          ondragend={() => (drag = null)}
          role="treeitem"
          aria-selected={$selectedPaths.has(node.path)}
          aria-expanded={node.isDirectory ? node.expanded : undefined}
          aria-level={node.depth + 1}
          aria-setsize={$nodes.length}
          aria-posinset={firstIndex + index + 1}
          style="padding-left: {8 + node.depth * 12}px"
          onclick={(event) => onRowClick(event, node)}
          ondblclick={() => !node.isDirectory && workspace.open(node.path)}
          oncontextmenu={(event) => openMenu(event, node.path)}
          onkeydown={() => {}}
          tabindex="-1"
        >
          <span class="twisty" aria-hidden="true">
            {#if node.isDirectory}
              <Icon name={node.expanded ? 'chevron-down' : 'chevron-right'} size={12} />
            {/if}
          </span>
          <span class="icon" aria-hidden="true">
            <Icon name={node.isDirectory ? 'folder' : 'file'} size={14} />
          </span>
          <span class="name">{node.name}</span>
          <!--
            The two questions the tree could not answer: what is unsaved, and
            what git holds against this row. Both ride the right edge, the
            same slot the folder notes below use, and the two can never
            collide — `marksFor` answers only for files and *collapsed*
            directories, and `#flatten` gates `loading`, `empty` and `error`
            on `expanded`, so no row can want both.

            Neither marker can change the row height, which the windowing
            arithmetic depends on: `.row` is a fixed `--nox-tree-row-h` with
            `flex: none`, and both children are smaller than it. The dot is
            `Icon`'s filled 8 px glyph — DESIGN.md §8 keeps `dot` filled for
            exactly this size — and matches the tab strip's dirty dot, since
            one fact should not have two appearances. A folder's markers are
            the file markers unchanged for the same reason: the twisty and
            the folder icon already say which kind of row this is, so a
            second visual tier would be a new language for a distinction the
            row has already made. Only the accessible name differs.
          -->
          {#if marks}
            <span class="marks">
              {#if marks.letter}
                <span
                  class="git-letter git-{marks.letter}"
                  role="img"
                  title={marks.letterLabel}
                  aria-label={marks.letterLabel}>{marks.letter}</span
                >
              {/if}
              {#if marks.dirty}
                <span
                  class="dirty-dot"
                  role="img"
                  title={marks.dotLabel}
                  aria-label={marks.dotLabel}
                >
                  <Icon name="dot" size={8} />
                </span>
              {/if}
            </span>
          {/if}
          <!--
            An unreadable directory used to expand into the same silent
            nothing as an empty one, because `#load`'s catch stores an empty
            entry list. The note rides on the folder's own row rather than a
            child row of its own: the tree is windowed on a fixed row height
            (`ROW_HEIGHT` above), and `explorer.selectAll` maps `files.nodes`
            straight to paths, so any row that is not a real node would put
            both of those out by one. `error` wins over `empty` — it is the
            more specific answer, and the catch sets both.
          -->
          {#if node.loading}
            <span class="spinner" aria-hidden="true"></span>
          {:else if node.error}
            <span class="note unreadable" title={node.error}>unreadable</span>
          {:else if node.empty}
            <span class="note">empty</span>
          {/if}
        </div>
      {:else}
        <p class="nox-empty">
          {#if $rootError}
            This folder could not be read: {$rootError}
          {:else}
            This folder is empty.
          {/if}
        </p>
      {/each}
      {#if padBottom > 0}
        <div class="spacer" style="height: {padBottom}px" role="presentation"></div>
      {/if}
    </div>
  {/if}
</div>

{#if menu}
  <!-- Keyed so each invocation is a fresh menu with its own initial state. -->
  {#key `${menu.anchor.x}:${menu.anchor.y}:${menu.path}`}
    <ContextMenu
      items={menuItems}
      anchor={menu.anchor}
      onSelect={runMenuItem}
      onDismiss={() => (menu = null)}
      returnFocusTo={listElement}
    />
  {/key}
{/if}

<style>
  .explorer-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nox-sp-2);
    height: var(--nox-panelbar-h);
    flex: none;
    padding: 0 var(--nox-sp-2) 0 var(--nox-sp-5);
    border-bottom: 1px solid var(--nox-border);
  }

  .title {
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    letter-spacing: var(--nox-tracking-wide);
    text-transform: uppercase;
    color: var(--nox-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    flex: none;
    margin-right: auto;
    padding: 1px var(--nox-sp-3);
    border-radius: var(--nox-r-full);
    background: var(--nox-selected);
    color: var(--nox-accent);
    font-size: var(--nox-fs-2xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .header-actions {
    display: flex;
    gap: 1px;
    flex: none;
    opacity: 0;
    transition: opacity var(--nox-dur-base) var(--nox-ease);
  }

  .explorer-panel:hover .header-actions,
  .header-actions:focus-within {
    opacity: 1;
  }

  .icon-button {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-muted);
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .icon-button:hover {
    background: var(--nox-hover);
    color: var(--nox-text-bright);
  }

  .tree {
    flex: 1;
    padding: var(--nox-sp-2) 0 var(--nox-sp-6);
  }

  /* Dropping on empty space below the rows targets the workspace root. */
  .tree.drop-root {
    box-shadow: inset 0 0 0 1px var(--nox-accent-dim);
  }

  .tree:focus-visible {
    box-shadow: inset 0 0 0 1px var(--nox-border-accent);
    border-radius: 0;
  }

  /* Spacers stand in for the rows outside the window, so the scrollbar
     describes the whole tree and every rendered row keeps its true offset. */
  .spacer {
    flex: none;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    /* Set from ROW_HEIGHT above: the arithmetic and the paint share one number. */
    height: var(--nox-tree-row-h, 23px);
    flex: none;
    padding-right: var(--nox-sp-4);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
    cursor: default;
    position: relative;
    transition: color var(--nox-dur-fast) var(--nox-ease);
  }

  .row:hover {
    background: var(--nox-hover);
    color: var(--nox-text);
  }

  .row.open {
    color: var(--nox-text);
  }

  /* Selection is violet — the same language the editor uses for selected text.
     The lead row adds a hairline so the keyboard focus point stays findable
     inside a large selection. */
  .row.selected {
    background: var(--nox-selected);
    color: var(--nox-text-bright);
  }

  .row.lead {
    background: var(--nox-active);
    color: var(--nox-text-bright);
  }

  .row.selected.lead {
    background: var(--nox-selected-strong);
  }

  /* The rows being dragged recede; the folder they would land in lights up. */
  .row.dragging {
    opacity: 0.4;
  }

  .row.drop-into {
    background: var(--nox-active);
    box-shadow: inset 0 0 0 1px var(--nox-accent-dim);
    color: var(--nox-text-bright);
  }

  .row.drop-into .icon {
    color: var(--nox-accent);
  }

  .tree:focus-visible .row.lead::after {
    content: '';
    position: absolute;
    inset: 0;
    border: 1px solid var(--nox-border-accent);
    border-radius: 2px;
    pointer-events: none;
  }

  /* Keeps the row the menu belongs to visible while the menu covers the tree. */
  .row.menu-target {
    background: var(--nox-selected);
    color: var(--nox-text-bright);
    box-shadow: inset 0 0 0 1px var(--nox-border-accent);
  }

  .row.current::before {
    content: '';
    position: absolute;
    left: 0;
    top: 3px;
    bottom: 3px;
    width: 2px;
    border-radius: 0 2px 2px 0;
    background: var(--nox-accent);
  }

  .twisty {
    width: 12px;
    display: grid;
    place-items: center;
    color: var(--nox-text-faint);
    flex: none;
  }

  .icon {
    flex: none;
    color: var(--nox-text-faint);
  }

  .row.open .icon,
  .row.selected .icon {
    color: var(--nox-accent-dim);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* One wrapper so exactly one child claims the free space. Two siblings
     each carrying `margin-left: auto` would split it between them and leave
     both markers stranded in the middle of the row. */
  .marks {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    margin-left: auto;
    padding-left: var(--nox-sp-2);
    flex: none;
  }

  /* The Git panel's tokens, because the two views describe the same fact and
     must not drift: added and untracked green, modified amber, deleted and
     conflicted red, a rename informational blue. */
  .git-letter {
    flex: none;
    width: 1.5ch;
    text-align: center;
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-2xs);
    line-height: 1;
  }

  .git-A,
  .git-U {
    color: var(--nox-success);
  }

  .git-M {
    color: var(--nox-warning);
  }

  .git-D,
  .git-C {
    color: var(--nox-danger);
  }

  .git-R {
    color: var(--nox-info);
  }

  /* `--nox-modified` is the tab strip's dirty dot; the same fact in two
     places should not be two colours. */
  .dirty-dot {
    display: grid;
    place-items: center;
    flex: none;
    color: var(--nox-modified);
  }

  /* Pushed to the right edge like the spinner it replaces, and quiet enough
     that a tree full of empty folders does not read as a wall of warnings. */
  .note {
    flex: none;
    margin-left: auto;
    font-size: var(--nox-fs-2xs);
    letter-spacing: var(--nox-tracking-wide);
    text-transform: uppercase;
    color: var(--nox-text-faint);
  }

  .note.unreadable {
    color: var(--nox-danger);
  }

  .spinner {
    width: 8px;
    height: 8px;
    margin-left: auto;
    border-radius: var(--nox-r-full);
    border: 1px solid var(--nox-border-strong);
    border-top-color: var(--nox-accent);
    animation: nox-spin var(--nox-dur-spin) linear infinite;
    flex: none;
  }

  @keyframes nox-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .empty-title {
    color: var(--nox-text-muted);
    margin: 0;
  }

  .nox-empty p {
    margin: 0;
  }

  .ghost-button {
    margin-top: var(--nox-sp-3);
    padding: var(--nox-sp-2) var(--nox-sp-5);
    border: 1px solid var(--nox-border-strong);
    border-radius: var(--nox-r-md);
    color: var(--nox-text);
    font-size: var(--nox-fs-sm);
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      border-color var(--nox-dur-fast) var(--nox-ease);
  }

  .ghost-button:hover {
    background: var(--nox-hover);
    border-color: var(--nox-border-accent);
  }
</style>
