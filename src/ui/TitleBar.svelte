<script lang="ts">
  import { basename, join, tildify } from '@core/path';
  import { useApp } from './context';
  import MenuBar from './MenuBar.svelte';
  import Icon from './Icon.svelte';

  const app = useApp();
  const { workspace, ui, commands, keymap, config } = app;

  const buffers = workspace.buffers;
  const activeId = workspace.activeId;
  const rootPath = workspace.rootPath;
  const homeDir = app.homeDir;
  const settings = config.settings;
  const overlay = ui.overlay;

  const explorerShown = $derived($settings['workbench.showExplorer']);
  const settingsShown = $derived($overlay === 'settings');

  /**
   * "Label (⌘B)", or just the label when the command has no binding.
   *
   * Interpolating `?? ''` into literal parentheses is what this replaces: a
   * `remove` rule in `keybindings.json` unbinds any default, and the tooltip
   * then read "Toggle Explorer ()". `Sidebar.svelte` already got this right.
   */
  function withChord(label: string, commandId: string): string {
    const chord = keymap.displayFor(commandId);
    return chord ? `${label} (${chord})` : label;
  }

  const active = $derived($buffers.find((b) => b.id === $activeId) ?? null);
  const rootName = $derived($rootPath ? basename($rootPath) : null);

  /**
   * On macOS the window uses an overlay title bar, so the traffic lights sit
   * on top of this element and we reserve room for them.
   *
   * Read off a capability rather than `platform.id === 'tauri' && isMac`:
   * `MemoryPlatform.id` is `readonly 'web'`, so that condition could not be
   * made true from a test or the browser target and the inset had no coverage
   * at all — which is how it shipped a permanent gap in fullscreen.
   */
  const overlayChrome = app.platform.capabilities.overlayWindowControls;

  /**
   * macOS has a native menu bar and keeps it. Everywhere else Nox draws its
   * own — Windows because turning decorations off removes the frame that
   * would host one, Linux because the accelerator story for a GTK menu has
   * never been tested, and the browser target because it has no OS menu at
   * all.
   */
  const drawsOwnMenu = !app.platform.capabilities.applicationMenu;

  let fullscreen = $state(false);

  /**
   * Fullscreen takes the traffic lights away, so the room reserved for them
   * has to go with them — otherwise the bar keeps a dead 78px inset with
   * nothing in it for the whole fullscreen session.
   */
  const reserveTrafficLights = $derived(overlayChrome && !fullscreen);

  /**
   * Windows hides its decorations, so this bar is the only window chrome
   * there is and has to carry the three controls itself.
   *
   * Read off the platform rather than sniffed here: which OS gets custom
   * controls is a property of the shell, and `ui/` is not allowed to know
   * about the OS — see `platform/types.ts`.
   */
  const drawWindowControls = app.platform.capabilities.customWindowControls;

  let maximized = $state(false);

  $effect(() => {
    if (!drawWindowControls) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    // The subscription is async, so a teardown can land first. Without the
    // flag the listener outlives the component and writes to dead state.
    void app.platform.onMaximizeChange((value) => (maximized = value)).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  });

  /**
   * Deliberately *not* behind `drawWindowControls`, which is false on macOS —
   * the only platform that has an inset to give back. Behind `overlayChrome`
   * instead, so the subscription exists exactly where it can matter.
   */
  $effect(() => {
    if (!overlayChrome) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void app.platform.onFullscreenChange((value) => (fullscreen = value)).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  });

  const paletteHint = $derived(keymap.displayFor('nav.commandPalette') ?? '');

  interface Crumb {
    segment: string;
    /** What this segment stands for, or null when it cannot be revealed. */
    path: string | null;
  }

  // The breadcrumb is the file's path relative to the workspace root, so the
  // title bar answers "where am I" without repeating the tab label.
  //
  // Each segment carries the absolute path it stands for, because clicking one
  // reveals it and the text on screen has had the prefix cut off it.
  const trail = $derived.by<Crumb[]>(() => {
    const path = active?.path;
    if (!path) return [];
    const root = $rootPath;

    // A file outside the workspace has nothing to reveal into: `files.reveal`
    // returns early for a path that is not under the root. These stay inert
    // text rather than becoming buttons that would silently do nothing.
    if (!root || !path.startsWith(root)) {
      return tildify(path, $homeDir)
        .split(/[\\/]/)
        .filter(Boolean)
        .map((segment) => ({ segment, path: null }));
    }

    let current = root;
    return path
      .slice(root.length)
      .split(/[\\/]/)
      .filter(Boolean)
      .map((segment) => {
        current = join(current, segment);
        return { segment, path: current };
      });
  });
</script>

<!--
  `deep` rather than a bare `data-tauri-drag-region`, and only here.

  Tauri's `drag.js` walks the composed path and stops at the *first* element
  carrying the attribute: bare means "drag only if this exact element was the
  mousedown target", so a bare attribute drags nothing but the slivers between
  children. It was on three elements, and the two inner ones ended the walk
  before it reached this one — which is why nothing on the bar could be
  dragged, wordmark and breadcrumb included.

  Buttons still take their clicks: the same walk returns false as soon as it
  meets a clickable element with no attribute of its own, so `deep` here does
  not steal the palette trigger or a breadcrumb segment.
-->
<header class="nox-titlebar" class:reserve={reserveTrafficLights} data-tauri-drag-region="deep">
  <div class="identity">
    <Icon name="logo" size={15} class="mark" />
    <span class="wordmark">Nox</span>
    {#if rootName}
      <span class="divider" aria-hidden="true">/</span>
      <span class="root" title={$rootPath}>{rootName}</span>
    {/if}
  </div>

  {#if drawsOwnMenu}
    <MenuBar />
  {/if}

  <div class="center">
    {#if trail.length > 0}
      <nav class="breadcrumb" aria-label="File path">
        {#each trail as crumb, index (index)}
          {#if index > 0}<span class="crumb-sep" aria-hidden="true">›</span>{/if}
          {#if crumb.path === null}
            <span class="crumb" class:leaf={index === trail.length - 1}>{crumb.segment}</span>
          {:else}
            {@const target = crumb.path}
            {@const isLeaf = index === trail.length - 1}
            <button
              class="crumb"
              class:leaf={isLeaf}
              title={target}
              onclick={() => void app.revealInExplorer(target, { expandSelf: !isLeaf })}
              >{crumb.segment}</button
            >
          {/if}
        {/each}
        {#if active?.isDirty}
          <span class="dirty" title="Unsaved changes"></span>
        {/if}
      </nav>
    {:else if active}
      <span class="breadcrumb"><span class="crumb leaf">{active.name}</span>
        {#if active.isDirty}<span class="dirty" title="Unsaved changes"></span>{/if}
      </span>
    {/if}
  </div>

  <div class="actions">
    <button
      class="palette-trigger"
      onclick={() => void commands.execute('nav.commandPalette')}
      title="Command Palette"
    >
      <Icon name="search" size={13} />
      <span>Commands</span>
      <!-- Omitted rather than empty when the palette has been unbound: the
           `<kbd>` carries a divider rule, and an empty one is a stray line. -->
      {#if paletteHint}<kbd class="nox-kbd">{paletteHint}</kbd>{/if}
    </button>

    <!-- `aria-pressed` and `.active`, both. This button looked byte-identical
         whether the explorer was open or closed and said "Toggle Explorer"
         either way, so it announced nothing at all about the state it
         controls. The sidebar rail's buttons already work this way. -->
    <button
      class="icon-button"
      class:active={explorerShown}
      onclick={() => void commands.execute('view.toggleExplorer')}
      title={withChord(explorerShown ? 'Hide Sidebar' : 'Show Sidebar', 'view.toggleExplorer')}
      aria-label="Toggle sidebar"
      aria-pressed={explorerShown}
    >
      <Icon name="sidebar" size={15} />
    </button>

    <!-- `prefs.open` rather than `ui.toggleOverlay` directly: the command is
         what the palette, the keybinding editor and any future menu dispatch,
         and it does exactly this. -->
    <button
      class="icon-button"
      class:active={settingsShown}
      onclick={() => void commands.execute('prefs.open')}
      title={withChord('Settings', 'prefs.open')}
      aria-label="Settings"
      aria-pressed={settingsShown}
    >
      <Icon name="settings" size={15} />
    </button>
  </div>

  {#if drawWindowControls}
    <div class="window-controls">
      <button
        class="window-control"
        onclick={() => void app.platform.minimizeWindow()}
        title="Minimise"
        aria-label="Minimise"
      >
        <Icon name="minimize" size={13} />
      </button>
      <button
        class="window-control"
        onclick={() => void app.platform.toggleMaximizeWindow()}
        title={maximized ? 'Restore' : 'Maximise'}
        aria-label={maximized ? 'Restore' : 'Maximise'}
      >
        <Icon name={maximized ? 'restore' : 'maximize'} size={13} />
      </button>
      <button
        class="window-control danger"
        onclick={() => void app.platform.closeWindow()}
        title="Close"
        aria-label="Close window"
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  {/if}
</header>

<style>
  .nox-titlebar {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-5);
    height: var(--nox-titlebar-h);
    flex: none;
    padding: 0 var(--nox-sp-3) 0 var(--nox-sp-5);
    background: var(--nox-bg-base);
    border-bottom: 1px solid var(--nox-border);
    /* The whole bar is a drag handle in the desktop build. */
    -webkit-app-region: drag;
  }

  .nox-titlebar.reserve {
    padding-left: 78px;
  }

  .identity {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    flex: none;
    min-width: 0;
  }

  .identity :global(.mark) {
    color: var(--nox-accent);
    /* A faint bloom on the crescent — the one deliberately "lit" element. */
    filter: drop-shadow(0 0 5px var(--nox-accent-glow));
  }

  .wordmark {
    font-size: var(--nox-fs-sm);
    font-weight: var(--nox-fw-semibold);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--nox-text-bright);
  }

  .divider {
    color: var(--nox-text-faint);
  }

  .root {
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
    max-width: 18ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .center {
    flex: 1;
    display: flex;
    justify-content: center;
    min-width: 0;
    overflow: hidden;
  }

  .breadcrumb {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
    white-space: nowrap;
    overflow: hidden;
  }

  .crumb {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Only the segments inside the workspace are buttons; one outside it has
     nothing to reveal and stays a span, so it must not offer a hover it
     cannot honour.

     `no-drag` for the same reason `.actions` and `.menu-bar` carry it: the
     header is `-webkit-app-region: drag`, and on a platform whose webview
     honours that property a drag region swallows the click. The breadcrumb
     became clickable after those two were written and never got the opt-out.
     It goes on the buttons rather than on `.center`, so the separators and
     the whitespace around them still drag the window — which is the half of
     the bar you actually want to grab. */
  button.crumb {
    cursor: pointer;
    -webkit-app-region: no-drag;
  }

  button.crumb:hover {
    color: var(--nox-text-bright);
  }

  .crumb.leaf {
    color: var(--nox-text);
  }

  .crumb-sep {
    color: var(--nox-text-faint);
    opacity: 0.6;
  }

  .dirty {
    width: 6px;
    height: 6px;
    border-radius: var(--nox-r-full);
    background: var(--nox-modified);
    margin-left: var(--nox-sp-1);
    flex: none;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-1);
    flex: none;
    -webkit-app-region: no-drag;
  }

  .palette-trigger {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    height: 24px;
    padding: 0 var(--nox-sp-3) 0 var(--nox-sp-4);
    border-radius: var(--nox-r-md);
    background: var(--nox-bg-panel);
    border: 1px solid var(--nox-border);
    color: var(--nox-text-muted);
    font-size: var(--nox-fs-xs);
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      border-color var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .palette-trigger:hover {
    background: var(--nox-bg-raised);
    border-color: var(--nox-border-strong);
    color: var(--nox-text);
  }

  .palette-trigger kbd {
    padding-left: var(--nox-sp-2);
    border-left: 1px solid var(--nox-border);
    margin-left: var(--nox-sp-1);
  }

  .icon-button {
    display: grid;
    place-items: center;
    width: 26px;
    height: 24px;
    border-radius: var(--nox-r-md);
    color: var(--nox-text-muted);
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .icon-button:hover {
    background: var(--nox-hover);
    color: var(--nox-text-bright);
  }

  /* The non-colour half of the state signal, matching the sidebar rail. */
  .icon-button.active {
    background: var(--nox-active);
    color: var(--nox-accent);
  }

  /*
    Windows' own controls, redrawn.

    Full bar height and flush to the right edge, with no radius and no gap —
    that shape is what makes them read as window chrome rather than as three
    more toolbar buttons. The header keeps its right padding for every other
    platform, so it is cancelled here instead of made conditional.
  */
  .window-controls {
    display: flex;
    align-items: stretch;
    flex: none;
    align-self: stretch;
    margin-right: calc(-1 * var(--nox-sp-3));
    margin-left: var(--nox-sp-2);
    -webkit-app-region: no-drag;
  }

  .window-control {
    display: grid;
    place-items: center;
    width: 40px;
    color: var(--nox-text-muted);
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .window-control:hover {
    background: var(--nox-hover);
    color: var(--nox-text-bright);
  }

  /* Close is the one that loses work if mis-clicked, so it is the one that
     looks different under the cursor. */
  .window-control.danger:hover {
    background: var(--nox-danger);
    color: var(--nox-text-bright);
  }
</style>
