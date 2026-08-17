<script lang="ts">
  import { basename, join, tildify } from '@core/path';
  import { platformIsMac } from '@services/keymap';
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  const app = useApp();
  const { workspace, ui, commands, keymap } = app;

  const buffers = workspace.buffers;
  const activeId = workspace.activeId;
  const rootPath = workspace.rootPath;
  const homeDir = app.homeDir;

  const active = $derived($buffers.find((b) => b.id === $activeId) ?? null);
  const rootName = $derived($rootPath ? basename($rootPath) : null);

  /**
   * On macOS the window uses an overlay title bar, so the traffic lights sit
   * on top of this element and we reserve room for them.
   */
  const reserveTrafficLights = app.platform.id === 'tauri' && platformIsMac;

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
      <kbd class="nox-kbd">{paletteHint}</kbd>
    </button>

    <button
      class="icon-button"
      onclick={() => void commands.execute('view.toggleExplorer')}
      title="Toggle Explorer ({keymap.displayFor('view.toggleExplorer') ?? ''})"
      aria-label="Toggle explorer"
    >
      <Icon name="sidebar" size={15} />
    </button>

    <button
      class="icon-button"
      onclick={() => ui.toggleOverlay('settings')}
      title="Settings ({keymap.displayFor('prefs.open') ?? ''})"
      aria-label="Settings"
    >
      <Icon name="settings" size={15} />
    </button>
  </div>
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
    color: var(--nox-text-faint);
    white-space: nowrap;
    overflow: hidden;
  }

  .crumb {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Only the segments inside the workspace are buttons; one outside it has
     nothing to reveal and stays a span, so it must not offer a hover it
     cannot honour. */
  button.crumb {
    cursor: pointer;
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
</style>
