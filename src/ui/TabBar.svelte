<script lang="ts">
  import { tabLabels } from '@core/tab-labels';
  import { useApp } from './context';
  import ContextMenu, { type MenuAnchor, type MenuItem } from './ContextMenu.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    groupId: string;
  }

  let { groupId }: Props = $props();

  const app = useApp();
  const { workspace, commands, ui } = app;

  const groups = workspace.groups;
  const rootPath = workspace.rootPath;
  const tabDrag = ui.tabDrag;

  const group = $derived($groups.find((candidate) => candidate.id === groupId) ?? null);
  const buffers = $derived(group?.tabs ?? []);
  const activeId = $derived(group?.activeId ?? null);
  const isActiveGroup = $derived(group?.isActive ?? false);
  const canClose = $derived($groups.length > 1);

  // Two open `index.ts` need telling apart; every other tab keeps its name.
  // Disambiguation spans every open buffer, not just this group's, so the
  // same file wears the same label in both panes of a split.
  const labels = $derived(tabLabels($groups.flatMap((candidate) => candidate.tabs)));

  let strip = $state<HTMLElement | null>(null);
  let scroller = $state<HTMLElement | null>(null);

  // Keep the active tab on screen when it changes from a keyboard command.
  $effect(() => {
    const id = activeId;
    if (!id || !strip) return;
    queueMicrotask(() => {
      strip?.querySelector(`[data-tab="${id}"]`)?.scrollIntoView?.({
        block: 'nearest',
        inline: 'nearest',
      });
    });
  });

  // --- Overflow affordance ------------------------------------------------
  // The strip hides its scrollbar, so when tabs overflow, edge fades say
  // "there is more": left once scrolled, right while more remains.
  let scrolledLeft = $state(false);
  let scrolledRight = $state(false);

  function updateOverflow() {
    const el = scroller;
    if (!el) return;
    scrolledLeft = el.scrollLeft > 0;
    scrolledRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  }

  $effect(() => {
    const el = scroller;
    if (!el) return;
    updateOverflow();
    // jsdom has no ResizeObserver; there the fades are scroll-driven only.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  });

  $effect(() => {
    // Tabs opening or closing change scrollWidth without resizing the strip,
    // which is exactly the case a ResizeObserver on the strip cannot see.
    void buffers;
    queueMicrotask(updateOverflow);
  });

  // --- Context menu ---------------------------------------------------------
  let menu = $state<{
    anchor: MenuAnchor;
    bufferId: string;
    returnTo: HTMLElement | null;
  } | null>(null);

  const menuBuffer = $derived(
    menu ? (buffers.find((buffer) => buffer.id === menu?.bufferId) ?? null) : null,
  );

  const menuItems = $derived.by<MenuItem[]>(() => {
    const target = menuBuffer;
    if (!target) return [];
    const index = buffers.findIndex((buffer) => buffer.id === target.id);
    return [
      { id: 'close', label: 'Close', hint: app.keymap.displayFor('file.close') ?? undefined },
      { id: 'closeOthers', label: 'Close Others', disabled: buffers.length < 2 },
      { id: 'closeToRight', label: 'Close to the Right', disabled: index >= buffers.length - 1 },
      {
        id: 'closeSaved',
        label: 'Close Saved',
        disabled: !buffers.some((buffer) => !buffer.isDirty),
      },
      { id: 'copyPath', label: 'Copy Path', separatorBefore: true, disabled: !target.path },
      { id: 'reveal', label: 'Reveal in Explorer', disabled: !target.path || !$rootPath },
      {
        id: 'split',
        label: 'Split Editor',
        separatorBefore: true,
        hint: app.keymap.displayFor('view.splitEditor') ?? undefined,
      },
    ];
  });

  function openTabMenu(event: MouseEvent, id: string) {
    event.preventDefault();
    event.stopPropagation();
    workspace.focusGroup(groupId);
    menu = {
      anchor: { x: event.clientX, y: event.clientY },
      bufferId: id,
      returnTo: event.currentTarget as HTMLElement,
    };
  }

  function openTabMenuFromKeyboard(event: KeyboardEvent, id: string) {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    menu = { anchor: { x: rect.left + 12, y: rect.bottom }, bufferId: id, returnTo: target };
  }

  function runMenuItem(itemId: string) {
    const target = menuBuffer;
    menu = null;
    if (!target) return;
    switch (itemId) {
      case 'close':
        void app.closeBuffer(target.id, { group: groupId });
        break;
      case 'closeOthers':
        void commands.execute('file.closeOthers', target.id);
        break;
      case 'closeToRight':
        void commands.execute('file.closeToRight', target.id);
        break;
      case 'closeSaved':
        void commands.execute('file.closeSaved', target.id);
        break;
      case 'copyPath':
        if (target.path) void app.copyToClipboard(target.path, 'path');
        break;
      case 'reveal':
        if (target.path) void app.revealInExplorer(target.path);
        break;
      case 'split':
        void commands.execute('view.splitEditor');
        break;
    }
  }

  function externalTitle(buffer: { path: string | null; name: string; externalState: string }) {
    const location = buffer.path ?? buffer.name;
    if (buffer.externalState === 'deleted') return `${location}\nDeleted on disk`;
    if (buffer.externalState === 'modified') return `${location}\nChanged on disk`;
    return location;
  }

  /**
   * "Label (⌘N)", or just the label when the command has no binding.
   *
   * `keybindings.json` can `remove` any default, which turned the interpolated
   * `?? ''` here into a tooltip reading "New File ()".
   */
  function withChord(label: string, commandId: string): string {
    const chord = app.keymap.displayFor(commandId);
    return chord ? `${label} (${chord})` : label;
  }

  /**
   * Arrow-key navigation across the strip.
   *
   * A `role="tablist"` with a roving tabindex promises this: every non-active
   * tab is `tabindex="-1"`, so without arrow keys no tab but the active one
   * was reachable from the keyboard *at all* — the widget claimed a contract
   * and honoured none of it.
   *
   * Automatic activation (moving focus selects) rather than the manual
   * variant, because in an editor "focus a tab without showing it" is not a
   * state anyone wants: selecting is the only thing a tab does. Focus is then
   * moved by hand, since the newly-active tab is the one that just became
   * `tabindex="0"` and the old one stops being focusable.
   */
  function onStripKeydown(event: KeyboardEvent, index: number): boolean {
    const last = buffers.length - 1;
    let target: number;
    if (event.key === 'ArrowRight') target = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') target = index === 0 ? last : index - 1;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = last;
    else return false;

    const buffer = buffers[target];
    if (!buffer) return true;
    event.preventDefault();
    workspace.setActive(buffer.id);
    // After the DOM has caught up with the new `tabindex`; focusing an element
    // that is still `-1` works, but the roving state would then disagree with
    // where focus actually is.
    queueMicrotask(() => {
      const node = strip?.querySelector(`[data-tab="${buffer.id}"]`);
      if (node instanceof HTMLElement) node.focus();
    });
    return true;
  }

  function onPointerDown(event: MouseEvent, id: string) {
    // Middle-click closes, matching every browser and editor.
    if (event.button === 1) {
      event.preventDefault();
      void app.closeBuffer(id, { group: groupId });
    }
  }

  function onDragStart(event: DragEvent, id: string) {
    ui.tabDrag.set({ bufferId: id, overGroupId: null, overIndex: null });
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(event: DragEvent, index: number) {
    const drag = ui.tabDrag.get();
    if (!drag) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    ui.tabDrag.set({ ...drag, overGroupId: groupId, overIndex: index });
  }

  function onDrop(event: DragEvent, index: number) {
    event.preventDefault();
    event.stopPropagation();
    const drag = ui.tabDrag.get();
    // The target group comes from this strip, so dragging a tab onto another
    // pane's strip moves it between groups rather than just reordering.
    if (drag) workspace.moveTab(drag.bufferId, index, groupId);
    ui.tabDrag.set(null);
  }
</script>

<div
  class="nox-tabbar"
  class:inactive={!isActiveGroup}
  role="tablist"
  aria-label="Open files"
  bind:this={strip}
  onfocusin={() => workspace.focusGroup(groupId)}
>
  <div class="strip-wrap">
    <div
      class="strip nox-scroll"
      role="presentation"
      class:drop-end={$tabDrag?.overGroupId === groupId && $tabDrag.overIndex === buffers.length}
      bind:this={scroller}
      onscroll={updateOverflow}
      ondragover={(event) => onDragOver(event, buffers.length)}
      ondrop={(event) => onDrop(event, buffers.length)}
    >
      {#each buffers as buffer, index (buffer.id)}
        <div
          class="tab"
          class:active={buffer.id === activeId}
          class:dirty={buffer.isDirty}
          class:drop-before={$tabDrag?.overGroupId === groupId &&
              $tabDrag.overIndex === index &&
              $tabDrag.bufferId !== buffer.id}
          class:external={buffer.externalState !== 'none'}
          class:deleted={buffer.externalState === 'deleted'}
          data-tab={buffer.id}
          role="tab"
          tabindex={buffer.id === activeId ? 0 : -1}
          aria-selected={buffer.id === activeId}
          title={externalTitle(buffer)}
          draggable="true"
          onclick={() => workspace.setActive(buffer.id)}
          onmousedown={(event) => onPointerDown(event, buffer.id)}
          oncontextmenu={(event) => openTabMenu(event, buffer.id)}
          onkeydown={(event) => {
            if (onStripKeydown(event, index)) {
              // Handled: moving along the strip is not also a tab activation.
            } else if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              workspace.setActive(buffer.id);
            } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
              event.preventDefault();
              openTabMenuFromKeyboard(event, buffer.id);
            }
          }}
          ondragstart={(event) => onDragStart(event, buffer.id)}
          ondragover={(event) => onDragOver(event, index)}
          ondrop={(event) => onDrop(event, index)}
          ondragend={() => ui.tabDrag.set(null)}
        >
          {#if buffer.externalState !== 'none'}
            <span
              class="external-mark"
              aria-hidden="true"
              title={buffer.externalState === 'deleted'
                ? 'Deleted on disk'
                : 'Changed on disk'}
            >
              <Icon name={buffer.externalState === 'deleted' ? 'error' : 'warning'} size={11} />
            </span>
          {/if}

          <span class="label">{labels.get(buffer.id) ?? buffer.name}</span>

          <button
            class="close"
            class:dirty={buffer.isDirty}
            aria-label="Close {buffer.name}"
            title="Close"
            onclick={(event) => {
              event.stopPropagation();
              void app.closeBuffer(buffer.id, { group: groupId });
            }}
          >
            {#if buffer.isDirty}
              <span class="dot" aria-hidden="true"></span>
            {/if}
            <Icon name="close" size={11} />
          </button>
        </div>
      {/each}
    </div>

    <div class="fade left" class:show={scrolledLeft} aria-hidden="true"></div>
    <div class="fade right" class:show={scrolledRight} aria-hidden="true"></div>
  </div>

  <button
    class="new-tab"
    title={withChord('New File', 'file.new')}
    aria-label="New file"
    onclick={() => {
      workspace.focusGroup(groupId);
      void commands.execute('file.new');
    }}
  >
    <Icon name="plus" size={14} />
  </button>

  <!--
    Splitting had no visible affordance anywhere: its only UI reference was
    inside the tab right-click menu, which itself has nothing hinting it
    exists. The strip already spends a slot on "Close this pane" once a split
    exists, so the way out was visible while the way in was not.

    `sidebar` is the icon: a rectangle with a vertical divider is the
    universal split-editor glyph, and the set has no dedicated one.
  -->
  <button
    class="new-tab"
    title={withChord('Split Editor', 'view.splitEditor')}
    aria-label="Split editor"
    onclick={() => {
      workspace.focusGroup(groupId);
      void commands.execute('view.splitEditor');
    }}
  >
    <Icon name="sidebar" size={13} />
  </button>

  {#if canClose}
    <button
      class="new-tab"
      title="Close this pane"
      aria-label="Close this editor pane"
      onclick={() => workspace.closeGroup(groupId)}
    >
      <Icon name="close" size={13} />
    </button>
  {/if}
</div>

{#if menu}
  <!-- Keyed so each invocation is a fresh menu with its own initial state. -->
  {#key `${menu.anchor.x}:${menu.anchor.y}:${menu.bufferId}`}
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
  /* An unfocused pane's strip recedes so the active one is unmistakable. */
  .nox-tabbar.inactive .tab.active {
    color: var(--nox-text-muted);
  }

  .nox-tabbar.inactive .tab.active::before {
    opacity: 0.35;
  }

  .nox-tabbar {
    display: flex;
    align-items: stretch;
    height: var(--nox-tabbar-h);
    flex: none;
    background: var(--nox-bg-panel);
    border-bottom: 1px solid var(--nox-border);
  }

  /* Holds the strip and its two edge fades; the fades must not scroll. */
  .strip-wrap {
    position: relative;
    display: flex;
    flex: 1;
    min-width: 0;
  }

  .strip {
    display: flex;
    align-items: stretch;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    /* Firefox cannot draw a 4px scrollbar, so it gets none; the edge fades
       still say "there is more", and the wheel still scrolls. */
    scrollbar-width: none;
  }

  /* A 4px sliver of base.css's ghostly scrollbar: the track is always
     reserved so the thumb's appearance on hover cannot reflow the tabs. */
  .strip::-webkit-scrollbar {
    height: 4px;
  }

  .strip::-webkit-scrollbar-thumb {
    background: transparent;
    border: 0;
    border-radius: var(--nox-r-full);
    background-clip: border-box;
  }

  .strip:hover::-webkit-scrollbar-thumb {
    background: var(--nox-border-strong);
  }

  .strip::-webkit-scrollbar-thumb:hover {
    background: var(--nox-scrollbar-hover);
  }

  .fade {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 28px;
    z-index: 1;
    pointer-events: none;
    opacity: 0;
    transition: opacity var(--nox-dur-fast) var(--nox-ease);
  }

  .fade.left {
    left: 0;
    background: linear-gradient(90deg, var(--nox-bg-panel), transparent);
  }

  .fade.right {
    right: 0;
    background: linear-gradient(-90deg, var(--nox-bg-panel), transparent);
  }

  .fade.show {
    opacity: 1;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    flex: none;
    max-width: 200px;
    padding: 0 var(--nox-sp-2) 0 var(--nox-sp-5);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
    background: transparent;
    border-right: 1px solid var(--nox-border);
    cursor: default;
    position: relative;
    /* Background as well as colour: `.tab:hover` moves both, and easing one
       of them made the fill arrive before the label. */
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .tab:hover {
    color: var(--nox-text);
    background: var(--nox-hover);
  }

  .tab.active {
    background: var(--nox-bg-editor);
    color: var(--nox-text-bright);
  }

  /* The violet spine is the single strongest "you are here" signal in Nox. */
  .tab.active::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(90deg, var(--nox-violet), var(--nox-accent));
  }

  .tab.drop-before::after {
    content: '';
    position: absolute;
    left: -1px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--nox-accent);
  }

  /* Dropping past the last tab targets index buffers.length, which matches
     no tab — so the most common drop, "to the end", drew nothing at all.
     The indicator hangs off the last tab's right edge. */
  .strip.drop-end .tab:last-child::after {
    content: '';
    position: absolute;
    right: -1px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--nox-accent);
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .external-mark {
    display: grid;
    place-items: center;
    flex: none;
    color: var(--nox-warning);
  }

  .tab.deleted .external-mark {
    color: var(--nox-danger);
  }

  /* A struck-through name reads as "gone" instantly, before any tooltip. */
  .tab.deleted .label {
    text-decoration: line-through;
    text-decoration-color: var(--nox-danger);
    opacity: 0.75;
  }

  .close {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    flex: none;
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-faint);
    position: relative;
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .close :global(svg) {
    opacity: 0;
    transition: opacity var(--nox-dur-fast) var(--nox-ease);
  }

  /* On a clean tab, hovering anywhere on the tab reveals the ✕. On a dirty
     tab the dot holds the slot until the pointer is over the button itself —
     hiding the only "unsaved" signal at the exact moment the user aims at a
     close that will prompt was the audit's sharpest catch. Same rule keeps
     the dot and the ✕ from rendering on top of each other on active dirty
     tabs, which the old rules allowed. */
  .tab:hover .close:not(.dirty) :global(svg),
  .tab.active .close:not(.dirty) :global(svg),
  .close:hover :global(svg),
  .close:focus-visible :global(svg) {
    opacity: 1;
  }

  .close:hover {
    background: var(--nox-active);
    color: var(--nox-text-bright);
  }

  /* The dirty dot occupies the close button's slot and yields to it on hover. */
  .dot {
    position: absolute;
    width: 7px;
    height: 7px;
    border-radius: var(--nox-r-full);
    background: var(--nox-modified);
    transition: opacity var(--nox-dur-fast) var(--nox-ease);
  }

  .close:hover .dot,
  .close:focus-visible .dot {
    opacity: 0;
  }

  .new-tab {
    display: grid;
    place-items: center;
    width: 34px;
    flex: none;
    color: var(--nox-text-faint);
    border-left: 1px solid var(--nox-border);
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .new-tab:hover {
    background: var(--nox-hover);
    color: var(--nox-text-bright);
  }
</style>
