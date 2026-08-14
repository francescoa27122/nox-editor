<script lang="ts" module>
  export interface MenuItem {
    id: string;
    label: string;
    /** Shortcut hint, already formatted for display. */
    hint?: string;
    danger?: boolean;
    disabled?: boolean;
    /** Renders a divider above this item. */
    separatorBefore?: boolean;
  }

  export interface MenuAnchor {
    x: number;
    y: number;
  }
</script>

<script lang="ts">
  /**
   * A floating menu.
   *
   * Fully keyboard-operable — arrows, Home/End, type-ahead, Enter, Escape —
   * because Nox claims to be keyboard-first, and a mouse-only context menu
   * would be the one place that claim quietly stops being true.
   */

  interface Props {
    items: MenuItem[];
    anchor: MenuAnchor;
    onSelect: (id: string) => void;
    onDismiss: () => void;
    /** Element to restore focus to when the menu closes. */
    returnFocusTo?: HTMLElement | null;
  }

  let { items, anchor, onSelect, onDismiss, returnFocusTo = null }: Props = $props();

  let menu = $state<HTMLElement | null>(null);
  // One-time seeds: the caller remounts this component per invocation (see the
  // `{#key}` in Sidebar), so a menu never has to react to changing props.
  // svelte-ignore state_referenced_locally
  let active = $state(items.findIndex((item) => !item.disabled));
  // svelte-ignore state_referenced_locally
  let position = $state({ x: anchor.x, y: anchor.y });
  let typeAhead = '';
  let typeAheadTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    menu?.focus();
    return () => returnFocusTo?.focus();
  });

  // Keep the menu inside the viewport: flip rather than clip when it would
  // overflow, which is what every native menu does near a screen edge.
  $effect(() => {
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    let { x, y } = anchor;

    if (x + rect.width + margin > window.innerWidth) x = Math.max(margin, x - rect.width);
    if (y + rect.height + margin > window.innerHeight) y = Math.max(margin, y - rect.height);
    position = { x, y };
  });

  function step(delta: number) {
    if (items.length === 0) return;
    let next = active;
    for (let i = 0; i < items.length; i++) {
      next = (next + delta + items.length) % items.length;
      if (!items[next]?.disabled) break;
    }
    active = next;
  }

  function choose(index: number) {
    const item = items[index];
    if (!item || item.disabled) return;
    onSelect(item.id);
  }

  function onKeydown(event: KeyboardEvent) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        step(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        step(-1);
        return;
      case 'Home':
        event.preventDefault();
        active = items.findIndex((item) => !item.disabled);
        return;
      case 'End':
        event.preventDefault();
        for (let i = items.length - 1; i >= 0; i--) {
          if (!items[i]?.disabled) {
            active = i;
            break;
          }
        }
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(active);
        return;
      case 'Escape':
      case 'Tab':
        event.preventDefault();
        onDismiss();
        return;
    }

    // Type-ahead: jump to the next item starting with what was typed.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      typeAhead += event.key.toLowerCase();
      if (typeAheadTimer) clearTimeout(typeAheadTimer);
      typeAheadTimer = setTimeout(() => (typeAhead = ''), 600);

      const match = items.findIndex(
        (item) => !item.disabled && item.label.toLowerCase().startsWith(typeAhead),
      );
      if (match >= 0) active = match;
    }
  }
</script>

<!-- A transparent full-screen layer catches the click-away and any scroll. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="layer"
  onmousedown={onDismiss}
  oncontextmenu={(event) => {
    event.preventDefault();
    onDismiss();
  }}
  onwheel={onDismiss}
></div>

<div
  class="menu"
  role="menu"
  tabindex="-1"
  aria-orientation="vertical"
  bind:this={menu}
  onkeydown={onKeydown}
  style="left: {position.x}px; top: {position.y}px"
>
  {#each items as item, index (item.id)}
    {#if item.separatorBefore}
      <div class="separator" role="separator"></div>
    {/if}
    <button
      class="item"
      class:active={index === active}
      class:danger={item.danger}
      role="menuitem"
      tabindex="-1"
      disabled={item.disabled}
      onmousemove={() => !item.disabled && (active = index)}
      onclick={() => choose(index)}
    >
      <span class="label">{item.label}</span>
      {#if item.hint}
        <kbd class="nox-kbd hint">{item.hint}</kbd>
      {/if}
    </button>
  {/each}
</div>

<style>
  .layer {
    position: fixed;
    inset: 0;
    z-index: var(--nox-z-dropdown);
  }

  .menu {
    position: fixed;
    z-index: calc(var(--nox-z-dropdown) + 1);
    min-width: 196px;
    max-width: 320px;
    padding: var(--nox-sp-2);
    background: var(--nox-bg-raised);
    border: 1px solid var(--nox-border-strong);
    border-radius: var(--nox-r-lg);
    box-shadow: var(--nox-shadow-md);
    animation: menu-in var(--nox-dur-fast) var(--nox-ease);
  }

  .menu:focus-visible {
    box-shadow: var(--nox-shadow-md);
  }

  @keyframes menu-in {
    from {
      opacity: 0;
      transform: scale(0.97);
    }
  }

  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nox-sp-6);
    width: 100%;
    height: 26px;
    padding: 0 var(--nox-sp-4);
    border-radius: var(--nox-r-sm);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text);
    text-align: left;
  }

  .item.active:not(:disabled) {
    background: var(--nox-selected);
    color: var(--nox-text-bright);
  }

  .item.danger {
    color: var(--nox-danger);
  }

  .item.danger.active:not(:disabled) {
    background: rgba(240, 97, 109, 0.14);
  }

  .item:disabled {
    opacity: 0.38;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint {
    flex: none;
  }

  .item.active .hint {
    color: var(--nox-text-muted);
  }

  .separator {
    height: 1px;
    margin: var(--nox-sp-2) var(--nox-sp-3);
    background: var(--nox-border);
  }
</style>
