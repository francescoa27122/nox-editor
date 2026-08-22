<script lang="ts">
  import { basename } from '@core/path';
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  /**
   * The no-buffers screen.
   *
   * It is shown whenever every tab is closed, which is *not* the same thing as
   * a first run — closing your last file inside an open project used to land
   * you on a screen whose leading offer was "Open folder…", as though the
   * folder you were standing in did not exist. So the Start list is built from
   * the workspace state rather than hardcoded, and its first entry is always
   * the thing someone in that state actually wants next.
   */

  const app = useApp();
  const { commands, keymap, workspace } = app;

  const recentFolders = workspace.recentFolders;
  const rootPath = workspace.rootPath;

  const projectName = $derived($rootPath ? basename($rootPath) || $rootPath : null);

  interface Action {
    id: string;
    label: string;
    /** The project name, appended as its own element so it can ellipsise. */
    subject?: string;
  }

  /**
   * Three actions with identical weight is not a choice, it is a list — and
   * "New file" led it, which is the one thing nobody downloads an editor to
   * do first. The head of this array gets the filled-accent treatment the
   * dialogs use for their default action.
   */
  const actions = $derived<Action[]>(
    $rootPath
      ? [
          { id: 'nav.quickOpen', label: 'Go to file in', subject: projectName ?? '' },
          { id: 'file.new', label: 'New file' },
          { id: 'file.open', label: 'Open file…' },
          { id: 'file.openFolder', label: 'Open folder…' },
        ]
      : [
          { id: 'file.openFolder', label: 'Open folder…' },
          { id: 'file.new', label: 'New file' },
          { id: 'file.open', label: 'Open file…' },
        ],
  );

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
          {#each actions as action, index (action.id)}
            <li>
              <button class:primary={index === 0} onclick={() => void commands.execute(action.id)}>
                <span class="label">
                  {action.label}{#if action.subject}&nbsp;<span class="subject">{action.subject}</span
                    >{/if}
                </span>
                {#if keymap.displayFor(action.id)}
                  <kbd class="nox-kbd">{keymap.displayFor(action.id)}</kbd>
                {/if}
              </button>
            </li>
          {/each}
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
        color-mix(in srgb, var(--nox-violet) 5%, transparent),
        transparent 70%
      ),
      var(--nox-bg-editor);
    overflow: auto;
  }

  .inner {
    width: min(640px, 100%);
  }

  /* The mark and the wordmark are the last thing left that can outgrow a very
     narrow editor area — 44px of logo plus a 26px uppercase "NOX" has a hard
     floor. Letting the pair wrap costs nothing at any sane width and is what
     keeps the whole screen free of a horizontal scrollbar at the extreme. */
  .brand {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--nox-sp-6);
    margin-bottom: var(--nox-sp-9);
  }

  .brand > div {
    min-width: 0;
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
    color: var(--nox-text-muted);
  }

  /*
    The columns reflow on the space they actually have, not on the window's.
    `1fr 1fr` with a viewport media query was wrong twice over: a grid track's
    implicit `auto` minimum is min-content, so the pair could grow wider than
    its container and push the Keyboard column clean off the right edge — and
    the only rule that would have stacked them keyed off the *viewport*, which
    this component never sees. The editor area is the window minus the sidebar
    (150–520px) and the splitter, so the two numbers can differ by more than
    half a window: measured at a 700px viewport with the sidebar dragged wide,
    the heading and every chord sat 177px past the visible edge while the
    640px breakpoint stayed dormant. `auto-fit` + `minmax` takes the decision
    away from any breakpoint: two tracks while 240px each will fit, one below
    that, and `min(…, 100%)` keeps a lone track from overflowing either.
  */
  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
    gap: var(--nox-sp-8);
  }

  /* Without this a section's min-content floor is back in charge of the
     track, which is the overflow the grid rule above exists to prevent. */
  .columns > section {
    min-width: 0;
  }

  h2 {
    margin: 0 0 var(--nox-sp-3);
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    text-transform: uppercase;
    letter-spacing: var(--nox-tracking-wide);
    color: var(--nox-text-muted);
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

  /* The same filled-accent default that ConfirmDialog and PromptDialog paint
     on the choice Enter would take, so "the obvious one" looks the same
     wherever it appears. Its left edge lines up with the hover wash on the
     rows below it, which is why it keeps their negative margin. */
  li button.primary {
    background: var(--nox-accent);
    color: var(--nox-text-on-accent);
    font-weight: var(--nox-fw-medium);
    margin-bottom: var(--nox-sp-2);
  }

  li button.primary:hover {
    background: var(--nox-text-bright);
  }

  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subject {
    font-weight: var(--nox-fw-semibold);
  }

  /* Right-aligned so the Start column's chords make the same vertical line
     the Keyboard column's do. */
  li button .nox-kbd {
    margin-left: auto;
    flex: none;
  }

  /* --nox-text-muted on a filled accent measures 2.15:1; the on-accent ink
     the button already uses measures 10.81:1 and is the only honest choice. */
  li button.primary .nox-kbd {
    color: var(--nox-text-on-accent);
  }

  .path {
    flex: 1;
    min-width: 0;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
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

  /* The label yields first: a chord that wrapped or slid out of view teaches
     nothing, and it is the shorter of the two. */
  .keys li span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
