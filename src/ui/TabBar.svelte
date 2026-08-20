<script lang="ts">
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  interface Props {
    groupId: string;
  }

  let { groupId }: Props = $props();

  const app = useApp();
  const { workspace, commands, ui } = app;

  const groups = workspace.groups;
  const tabDrag = ui.tabDrag;

  const group = $derived($groups.find((candidate) => candidate.id === groupId) ?? null);
  const buffers = $derived(group?.tabs ?? []);
  const activeId = $derived(group?.activeId ?? null);
  const isActiveGroup = $derived(group?.isActive ?? false);
  const canClose = $derived($groups.length > 1);

  let strip = $state<HTMLElement | null>(null);

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

  function externalTitle(buffer: { path: string | null; name: string; externalState: string }) {
    const location = buffer.path ?? buffer.name;
    if (buffer.externalState === 'deleted') return `${location}\nDeleted on disk`;
    if (buffer.externalState === 'modified') return `${location}\nChanged on disk`;
    return location;
  }

  function onPointerDown(event: MouseEvent, id: string) {
    // Middle-click closes, matching every browser and editor.
    if (event.button === 1) {
      event.preventDefault();
      void app.closeBuffer(id);
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
  <div
    class="strip nox-scroll"
    role="presentation"
    class:drop-end={$tabDrag?.overGroupId === groupId && $tabDrag.overIndex === buffers.length}
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
        onkeydown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            workspace.setActive(buffer.id);
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

        <span class="label">{buffer.name}</span>

        <button
          class="close"
          class:dirty={buffer.isDirty}
          aria-label="Close {buffer.name}"
          title="Close"
          onclick={(event) => {
            event.stopPropagation();
            void app.closeBuffer(buffer.id);
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

  <button
    class="new-tab"
    title="New File ({app.keymap.displayFor('file.new') ?? ''})"
    aria-label="New file"
    onclick={() => {
      workspace.focusGroup(groupId);
      void commands.execute('file.new');
    }}
  >
    <Icon name="plus" size={14} />
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

  .strip {
    display: flex;
    align-items: stretch;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .strip::-webkit-scrollbar {
    height: 0;
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
    transition: color var(--nox-dur-fast) var(--nox-ease);
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
