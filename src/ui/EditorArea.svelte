<script lang="ts">
  import { useApp } from './context';
  import EditorGroupView from './EditorGroupView.svelte';

  /**
   * Lays out the editor groups.
   *
   * A flat row or column with draggable dividers. Sizes are kept as flex
   * weights rather than pixels so the panes keep their proportions when the
   * window resizes — the thing that makes a hand-tuned split survive a
   * maximise.
   */

  const app = useApp();
  const { workspace, config } = app;

  const groups = workspace.groups;
  const settings = config.settings;

  const orientation = $derived($settings['workbench.splitOrientation']);

  /** Flex weight per group id. Groups without an entry default to 1. */
  let weights = $state<Record<string, number>>({});
  let container = $state<HTMLElement | null>(null);
  let resizing = $state(false);

  const weightOf = (id: string) => weights[id] ?? 1;

  // Drop weights for panes that no longer exist so a reopened split starts even.
  $effect(() => {
    const live = new Set($groups.map((group) => group.id));
    const stale = Object.keys(weights).filter((id) => !live.has(id));
    if (stale.length > 0) {
      const next = { ...weights };
      for (const id of stale) delete next[id];
      weights = next;
    }
  });

  function startResize(event: PointerEvent, beforeId: string, afterId: string) {
    if (!container) return;
    event.preventDefault();
    resizing = true;

    const vertical = orientation === 'vertical';
    const rect = container.getBoundingClientRect();
    const total = vertical ? rect.width : rect.height;
    const start = vertical ? event.clientX : event.clientY;

    const startBefore = weightOf(beforeId);
    const startAfter = weightOf(afterId);
    const pair = startBefore + startAfter;
    // Convert the pixel delta into a share of the two panes being dragged.
    const span = (total * pair) / $groups.reduce((sum, g) => sum + weightOf(g.id), 0);

    const move = (moveEvent: PointerEvent) => {
      const delta = (vertical ? moveEvent.clientX : moveEvent.clientY) - start;
      const shift = (delta / Math.max(span, 1)) * pair;
      // 0.15 keeps a pane from collapsing to an unusable sliver.
      const before = Math.max(0.15, Math.min(pair - 0.15, startBefore + shift));
      weights = { ...weights, [beforeId]: before, [afterId]: pair - before };
    };

    const up = () => {
      resizing = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function resizeByKey(event: KeyboardEvent, beforeId: string, afterId: string) {
    const vertical = orientation === 'vertical';
    const decrease = vertical ? 'ArrowLeft' : 'ArrowUp';
    const increase = vertical ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== decrease && event.key !== increase) return;

    event.preventDefault();
    const step = event.shiftKey ? 0.2 : 0.05;
    const direction = event.key === increase ? 1 : -1;
    const pair = weightOf(beforeId) + weightOf(afterId);
    const before = Math.max(0.15, Math.min(pair - 0.15, weightOf(beforeId) + step * direction));
    weights = { ...weights, [beforeId]: before, [afterId]: pair - before };
  }
</script>

<div
  class="editor-area"
  class:vertical={orientation === 'vertical'}
  class:is-resizing={resizing}
  bind:this={container}
>
  {#each $groups as group, index (group.id)}
    {#if index > 0}
      <!--
        A focusable splitter is exactly what `role="separator"` with a tabindex
        is for (the WAI-ARIA window splitter pattern).
      -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="divider"
        role="separator"
        tabindex="0"
        aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
        aria-label="Resize editor panes"
        onpointerdown={(event) => startResize(event, $groups[index - 1]!.id, group.id)}
        onkeydown={(event) => resizeByKey(event, $groups[index - 1]!.id, group.id)}
      ></div>
    {/if}

    <div class="group-slot" style="flex: {weightOf(group.id)} 1 0">
      <EditorGroupView groupId={group.id} />
    </div>
  {/each}
</div>

<style>
  .editor-area {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .editor-area.vertical {
    flex-direction: row;
  }

  .group-slot {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .divider {
    flex: none;
    background: var(--nox-border);
    position: relative;
    transition: background var(--nox-dur-fast) var(--nox-ease);
  }

  .editor-area.vertical > .divider {
    width: 1px;
    cursor: col-resize;
  }

  .editor-area:not(.vertical) > .divider {
    height: 1px;
    cursor: row-resize;
  }

  /* Widen the hit area well past the visible hairline. */
  .divider::after {
    content: '';
    position: absolute;
  }

  .editor-area.vertical > .divider::after {
    inset: 0 -4px;
  }

  .editor-area:not(.vertical) > .divider::after {
    inset: -4px 0;
  }

  .divider:hover,
  .divider:focus-visible,
  .is-resizing .divider {
    background: var(--nox-accent-dim);
  }

  .divider:focus-visible {
    box-shadow: none;
    outline: none;
  }

  :global(.is-resizing *) {
    user-select: none !important;
  }
</style>
