<script lang="ts">
  import { basename } from '@core/path';
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  const app = useApp();
  const { commands, keymap, workspace } = app;

  const recentFolders = workspace.recentFolders;

  const shortcuts = [
    { id: 'nav.commandPalette', label: 'Command Palette' },
    { id: 'nav.quickOpen', label: 'Go to File' },
    { id: 'file.openFolder', label: 'Open Folder' },
    { id: 'file.new', label: 'New File' },
    { id: 'edit.find', label: 'Find' },
    { id: 'view.toggleExplorer', label: 'Toggle Explorer' },
  ];
</script>

<div class="welcome">
  <div class="inner">
    <div class="brand">
      <Icon name="logo" size={44} class="mark" />
      <div>
        <h1>Nox</h1>
        <p class="tagline">A command center for your code.</p>
      </div>
    </div>

    <div class="columns">
      <section>
        <h2>Start</h2>
        <ul>
          <li>
            <button onclick={() => void commands.execute('file.new')}>New file</button>
          </li>
          <li>
            <button onclick={() => void commands.execute('file.openFolder')}>Open folder…</button>
          </li>
          <li>
            <button onclick={() => void commands.execute('file.open')}>Open file…</button>
          </li>
        </ul>

        {#if $recentFolders.length > 0}
          <h2 class="spaced">Recent</h2>
          <ul>
            {#each $recentFolders.slice(0, 5) as folder (folder)}
              <li>
                <button title={folder} onclick={() => void workspace.openFolder(folder)}>
                  {basename(folder)}
                  <span class="path">{folder}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section>
        <h2>Keyboard</h2>
        <ul class="keys">
          {#each shortcuts as shortcut (shortcut.id)}
            <li>
              <span>{shortcut.label}</span>
              <kbd class="nox-kbd">{keymap.displayFor(shortcut.id) ?? '—'}</kbd>
            </li>
          {/each}
        </ul>
      </section>
    </div>
  </div>
</div>

<style>
  .welcome {
    flex: 1;
    display: grid;
    place-items: center;
    padding: var(--nox-sp-8);
    background:
      radial-gradient(
        ellipse 60% 50% at 50% 0%,
        rgba(139, 125, 245, 0.05),
        transparent 70%
      ),
      var(--nox-bg-editor);
    overflow: auto;
  }

  .inner {
    width: min(640px, 100%);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-6);
    margin-bottom: var(--nox-sp-9);
  }

  .brand :global(.mark) {
    color: var(--nox-accent);
    filter: drop-shadow(0 0 18px var(--nox-accent-glow));
  }

  h1 {
    margin: 0;
    font-size: var(--nox-fs-2xl);
    font-weight: var(--nox-fw-semibold);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--nox-text-bright);
  }

  .tagline {
    margin: var(--nox-sp-1) 0 0;
    font-size: var(--nox-fs-md);
    color: var(--nox-text-faint);
  }

  .columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--nox-sp-8);
  }

  @media (max-width: 640px) {
    .columns {
      grid-template-columns: 1fr;
    }
  }

  h2 {
    margin: 0 0 var(--nox-sp-3);
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    text-transform: uppercase;
    letter-spacing: var(--nox-tracking-wide);
    color: var(--nox-text-faint);
  }

  h2.spaced {
    margin-top: var(--nox-sp-7);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  li button {
    display: flex;
    align-items: baseline;
    gap: var(--nox-sp-3);
    width: 100%;
    padding: var(--nox-sp-2) var(--nox-sp-3);
    margin-left: calc(var(--nox-sp-3) * -1);
    border-radius: var(--nox-r-md);
    font-size: var(--nox-fs-md);
    color: var(--nox-accent);
    text-align: left;
    transition: background var(--nox-dur-fast) var(--nox-ease);
  }

  li button:hover {
    background: var(--nox-hover);
  }

  .path {
    flex: 1;
    min-width: 0;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }

  .keys li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nox-sp-5);
    padding: var(--nox-sp-2) 0;
    font-size: var(--nox-fs-md);
    color: var(--nox-text-muted);
  }
</style>
