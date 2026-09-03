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
  /**
   * Bindings are a *second* signal, and reading it here is not optional.
   *
   * `MenuService.describe()` calls `keymap.chordFor` for every accelerator,
   * but `commands.version` only moves when a command is registered or
   * unregistered — never when one is rebound. Without this the bar kept
   * offering the old chord after a rebinding while the native menu, which
   * reinstalls on exactly this signal (`menu.ts:345`), showed the new one:
   * the two consumers of the one tree drifting, which is the thing
   * `describe()` says cannot happen.
   */
  const keymapVersion = app.keymap.version;
  const focusRequest = ui.focusMenuBarRequest;
  const menuBarOpen = ui.menuBarOpen;

  /** Top-level menus. Rebuilt when the command table or a keybinding moves. */
  const menus = $derived.by<{ label: string; items: readonly MenuNode[] }[]>(() => {
    void $commandVersion;
    void $keymapVersion;
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

  /**
   * Not `$state`: read and written only inside the effect below, and making it
   * reactive would re-run that effect on its own write.
   */
  let focusRequestSeen = false;

  $effect(() => {
    // `menubar.focus` (F10) bumps a counter rather than reaching for the
    // element, the same shape every panel's focus request uses.
    void $focusRequest;

    // A panel mounts *because* you opened it, so acting on the effect's first
    // run is right for them. The menu bar mounts with the window, and the same
    // shape meant Nox opened with the keyboard parked on the "Nox" button:
    // typing did nothing until you clicked the editor, and Enter or ArrowDown
    // opened a menu. The first run is the mount, so skip it.
    if (!focusRequestSeen) {
      focusRequestSeen = true;
      return;
    }
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

<!--
  The keydown lives on the menubar rather than each button because arrow keys
  move *between* buttons: the WAI-ARIA menubar pattern makes the bar one tab
  stop with a roving tabindex, so the container is what owns navigation. No
  native element expresses a menubar, hence the explicit role.
-->
<div
  class="menu-bar"
  class:showing={open !== null}
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

    /*
      Yield space rather than push the rest of the bar out of the window.

      This is `flex: 0 1 auto` and so nominally shrinkable, but it is itself a
      flex container, and `min-width: auto` on one resolves to min-content —
      the eight titles side by side, 294px, which it will not go below. So the
      bar overflowed to the right and everything after it left the viewport
      with nothing to scroll it back: measured at a 560px window, Commands
      ended at 581, the sidebar toggle at 609 and Settings at 637. Reachable
      in the browser build at any width, and on Windows, where three window
      controls sit further right still, at the 640px `minWidth` the desktop
      app already allows.

      `min-width: 0` lets it give way; `overflow-x` then keeps the titles
      inside the box it gave way to. The scrollbar is hidden because a 23px
      strip cannot host one — the menus stay reachable by trackpad, by F10 and
      arrows (focus scrolls its target into view), and by the palette, which
      lists every command in them.
    */
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .menu-bar::-webkit-scrollbar {
    display: none;
  }

  /*
    While a menu is showing the bar has to sit above `ContextMenu`'s
    click-away layer, which is `position: fixed; inset: 0` at
    `--nox-z-dropdown` and therefore covers these buttons along with
    everything else.

    That layer is why `onmouseenter` above never ran: sliding the pointer from
    File to Edit — the gesture that makes a menu bar a bar — hit the shield,
    not the button, so the comment claiming the bar "tracks" described
    something the stacking context had made impossible. Clicking a second
    title was dead the same way; it dismissed instead of switching.

    The same z-index as the popup rather than one above it, deliberately: at a
    tie the later element in the DOM paints on top, and `ContextMenu` renders
    after this div. So the bar clears the layer and still loses to the menu,
    which is the order that cannot go wrong. Only while open — the bar has no
    business creating a stacking context the rest of the time.
  */
  .menu-bar.showing {
    position: relative;
    z-index: calc(var(--nox-z-dropdown) + 1);
  }

  .menu-title {
    padding: 2px var(--nox-sp-3);
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-muted);
    font-size: var(--nox-fs-sm);
    line-height: 1.6;
    white-space: nowrap;
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .menu-title:hover,
  .menu-title.open {
    background: var(--nox-hover);
    color: var(--nox-text-bright);
  }

  /*
    Yielding is the right trade, but it has a cost the `.menu-bar` comment
    only hints at: at the 640px minimum the bar was 20px narrower than its
    titles (a `scrollWidth` of 281 against a `clientWidth` of 261), so
    "Tools" was clipped to "To" with no scrollbar to say there was more.
    Tightening the title padding one step recovers 32px, and
    `TitleBar.svelte` gives back more at the same breakpoint;
    `tests/browser/menu-bar-fit.test.ts` holds the result in a browser that
    has layout. Last in the file on purpose: it ties `.menu-title` above on
    specificity and has to win on order.
  */
  @media (max-width: 800px) {
    .menu-title {
      padding-inline: var(--nox-sp-2);
    }
  }
</style>
