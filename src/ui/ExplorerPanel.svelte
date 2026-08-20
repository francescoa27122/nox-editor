<script lang="ts">
  import { canMoveInto, dirname } from '@core/path';
  import { rootLabel } from '@services/filetree';
  import { useApp } from './context';
  import ContextMenu, { type MenuAnchor, type MenuItem } from './ContextMenu.svelte';
  import Icon from './Icon.svelte';

  const app = useApp();
  const { workspace, files, ui, commands } = app;

  const nodes = files.nodes;
  const rootPath = workspace.rootPath;
  const buffers = workspace.buffers;
  const activeId = workspace.activeId;
  const focusRequest = ui.focusExplorerRequest;
  const selection = ui.explorer;
  const selectedPaths = selection.paths;
  const lead = selection.lead;

  let listElement = $state<HTMLElement | null>(null);
  let menu = $state<{ anchor: MenuAnchor; path: string | null } | null>(null);

  const activeBuffer = $derived($buffers.find((b) => b.id === $activeId) ?? null);
  const openPaths = $derived(new Set($buffers.map((b) => b.path).filter(Boolean) as string[]));
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

  $effect(() => {
    // Track the request counter so a focus command re-runs this effect.
    void $focusRequest;
    if (listElement) {
      if (!$lead && $nodes.length > 0) selection.set($nodes[0]!.path);
      listElement.focus();
    }
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

  /** Keyboard equivalent: anchor to the focused row rather than the pointer. */
  function openMenuFromKeyboard() {
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

  function scrollSelectionIntoView() {
    queueMicrotask(() => {
      listElement?.querySelector('.row.lead')?.scrollIntoView?.({ block: 'nearest' });
    });
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
        openMenuFromKeyboard();
        break;
      case 'F10':
        if (!event.shiftKey) return;
        event.preventDefault();
        openMenuFromKeyboard();
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
      {#each $nodes as node (node.path)}
        <div
          class="row"
          class:selected={$selectedPaths.has(node.path)}
          class:lead={node.path === $lead}
          class:open={openPaths.has(node.path)}
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
          {#if node.loading}
            <span class="spinner" aria-hidden="true"></span>
          {/if}
        </div>
      {:else}
        <p class="nox-empty">This folder is empty.</p>
      {/each}
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

  .row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    height: 23px;
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
