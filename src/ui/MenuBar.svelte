<script lang="ts">
  import { untrack } from 'svelte';
  import { useApp } from './context';
  import ContextMenu, { type MenuAnchor, type MenuItem } from './ContextMenu.svelte';
  import type { MenuNode } from '@platform/types';

  /**
   * The menu bar, where Nox draws it itself.
   *
   * macOS has a native menu and keeps it; this renders only where
   * `capabilities.applicationMenu` is false — Windows, Linux, and the browser
   * dev target. Windows is why it exists: Nox turns decorations off there to
   * draw its own title bar, and Windows hosts its menu inside the frame that
   * removes.
   *
   * It renders `MenuService.describe()`, the same tree the native menu
   * installs, so the two cannot drift — there is no second layout table.
   *
   * The popup is `ContextMenu`, unchanged. It already does arrow keys,
   * Home/End, type-ahead, Enter, Escape, focus return and viewport flipping;
   * a second implementation of that would be a second set of bugs.
   */

  const app = useApp();
  const { commands, ui } = app;

  const commandVersion = commands.version;
  const focusRequest = ui.focusMenuBarRequest;
  const menuBarOpen = ui.menuBarOpen;

  /** Top-level menus. Rebuilt when the command table or a keybinding moves. */
  const menus = $derived.by<{ label: string; items: readonly MenuNode[] }[]>(() => {
    void $commandVersion;
    return app.menu
      .describe()
      .filter((node): node is Extract<MenuNode, { kind: 'submenu' }> => node.kind === 'submenu')
      .map((node) => ({ label: node.label, items: node.items }));
  });

  let buttons: (HTMLButtonElement | null)[] = $state([]);
  /** Index of the open menu, or null. Only ever one at a time. */
  let open = $state<number | null>(null);
  /** Roving tabindex: the bar is one tab stop, not one per menu. */
  let focused = $state(0);
  let anchor = $state<MenuAnchor>({ x: 0, y: 0 });

  /**
   * `enabled` is read here, when a menu opens — once per item in the one
   * submenu being shown. The predicates already live in this process, so
   * there is no IPC and nothing lands on the typing path. This is the whole
   * reason the native menu draws every item enabled and this one does not.
   */
  const itemsFor = (nodes: readonly MenuNode[]): MenuItem[] => {
    const out: MenuItem[] = [];
    let pendingRule = false;
    for (const node of nodes) {
      if (node.kind === 'separator') {
        // Only remembered, never emitted on its own: `ContextMenu` takes a
        // rule as a flag on the item below it.
        pendingRule = out.length > 0;
        continue;
      }
      if (node.kind !== 'command') continue;
      const command = commands.get(node.commandId);
      out.push({
        id: node.commandId,
        label: node.label,
        ...(node.accelerator ? { hint: node.accelerator } : {}),
        ...(command && commands.isEnabled(node.commandId) ? {} : { disabled: true }),
        ...(pendingRule ? { separatorBefore: true } : {}),
      });
      pendingRule = false;
    }
    return out;
  };

  const openItems = $derived(open === null ? [] : itemsFor(menus[open]?.items ?? []));

  function openAt(index: number) {
    const button = buttons[index];
    if (!button) return;
    const box = button.getBoundingClientRect();
    // Below the button, aligned to its left edge — the one thing a menu bar
    // owes over a context menu, which opens at the pointer.
    anchor = { x: box.left, y: box.bottom };
    open = index;
    focused = index;
    ui.menuBarOpen.set(true);
  }

  function close(restoreFocus = true) {
    open = null;
    ui.menuBarOpen.set(false);
    if (restoreFocus) buttons[focused]?.focus();
  }

  function onBarKeydown(event: KeyboardEvent) {
    const count = menus.length;
    if (count === 0) return;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const next = (focused + step + count) % count;
        focused = next;
        buttons[next]?.focus();
        // A menu bar tracks: with one menu open, moving along opens the next.
        if (open !== null) openAt(next);
        break;
      }
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        event.preventDefault();
        openAt(focused);
        break;
      case 'Escape':
        if (open !== null) {
          event.preventDefault();
          close();
        }
        break;
      case 'Home':
        event.preventDefault();
        focused = 0;
        buttons[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        focused = count - 1;
        buttons[count - 1]?.focus();
        break;
    }
  }

  $effect(() => {
    // `menubar.focus` (F10) bumps a counter rather than reaching for the
    // element, the same shape every panel's focus request uses.
    void $focusRequest;
    queueMicrotask(() => buttons[focused]?.focus());
  });

  /**
   * `UIService` is the authority on whether a menu is showing, and this
   * follows it.
   *
   * Escape reaches the app through the global keymap, so it is `dismissTop`
   * that clears the flag — not this component. Without this the two
   * disagreed: the app believed the menu had closed while it was still on
   * screen with `aria-expanded="true"`, which is exactly what walking the
   * app turned up.
   */
  $effect(() => {
    if (!$menuBarOpen && untrack(() => open) !== null) {
      open = null;
      untrack(() => buttons[focused])?.focus();
    }
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!--
  The keydown lives on the menubar rather than each button because arrow keys
  move *between* buttons: the WAI-ARIA menubar pattern makes the bar one tab
  stop with a roving tabindex, so the container is what owns navigation. No
  native element expresses a menubar, hence the explicit role.
-->
<div
  class="menu-bar"
  role="menubar"
  aria-label="Main"
  aria-orientation="horizontal"
  tabindex={-1}
  onkeydown={onBarKeydown}
>
  {#each menus as menu, index (menu.label)}
    <button
      bind:this={buttons[index]}
      class="menu-title"
      class:open={open === index}
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={open === index}
      tabindex={focused === index ? 0 : -1}
      onclick={() => (open === index ? close() : openAt(index))}
      onmouseenter={() => {
        // Once a menu is open, hovering another switches to it — the
        // behaviour every menu bar has, and the reason a bar feels like a bar.
        if (open !== null && open !== index) openAt(index);
      }}
    >
      {menu.label}
    </button>
  {/each}
</div>

{#if open !== null}
  {#key open}
    <ContextMenu
      items={openItems}
      {anchor}
      onSelect={(id) => {
        close(false);
        void commands.execute(id);
      }}
      onDismiss={() => close()}
      returnFocusTo={buttons[focused] ?? null}
    />
  {/key}
{/if}

<style>
  .menu-bar {
    display: flex;
    align-items: center;
    gap: 1px;
    /* The title bar is a drag region; its children must opt out or the drag
       swallows the click. Same reason `.actions` does. */
    -webkit-app-region: no-drag;
  }

  .menu-title {
    padding: 2px var(--nox-sp-3);
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-muted);
    font-size: var(--nox-fs-sm);
    line-height: 1.6;
    white-space: nowrap;
  }

  .menu-title:hover,
  .menu-title.open {
    background: var(--nox-hover);
    color: var(--nox-text-bright);
  }
</style>
