<script lang="ts">
  import { onMount } from 'svelte';
  import type { Terminal } from '@xterm/xterm';
  import type { FitAddon } from '@xterm/addon-fit';
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  /**
   * A real shell, below the editor.
   *
   * The xterm.js instance owns the scrollback and the rendering; this
   * component is the wiring between it and the pty, and nothing else. It is
   * mounted once and hidden with CSS rather than unmounted, because
   * destroying the terminal would throw away everything the shell has printed
   * — closing the panel to glance at a file should not lose a build log.
   */

  const app = useApp();
  const { terminal, ui, config } = app;

  const open = ui.terminalOpen;
  const status = terminal.status;
  const exitCode = terminal.exitCode;
  const error = terminal.error;
  const focusRequest = ui.focusTerminalRequest;
  const restartRequest = terminal.restartRequest;
  const settings = config.settings;

  let host = $state<HTMLDivElement | null>(null);
  let view: Terminal | null = null;
  let fit: FitAddon | null = null;

  /**
   * Colours come from the token file like everything else, read off the
   * document rather than hardcoded — which is what makes the terminal follow
   * Eclipse and Umbra without a second palette to keep in sync.
   */
  function themeFromTokens(): Record<string, string> {
    const style = getComputedStyle(document.documentElement);
    const token = (name: string) => style.getPropertyValue(name).trim();
    return {
      background: token('--nox-bg-editor'),
      foreground: token('--nox-text'),
      cursor: token('--nox-cursor'),
      cursorAccent: token('--nox-bg-editor'),
      selectionBackground: token('--nox-selection'),
      black: token('--nox-bg-inset'),
      red: token('--nox-danger'),
      green: token('--nox-syn-string'),
      yellow: token('--nox-syn-type'),
      blue: token('--nox-info'),
      magenta: token('--nox-syn-keyword'),
      cyan: token('--nox-accent'),
      white: token('--nox-text'),
      brightBlack: token('--nox-text-muted'),
      brightRed: token('--nox-danger'),
      brightGreen: token('--nox-syn-string'),
      brightYellow: token('--nox-warning'),
      brightBlue: token('--nox-info'),
      brightMagenta: token('--nox-violet'),
      brightCyan: token('--nox-accent'),
      brightWhite: token('--nox-text-bright'),
    };
  }

  /** Re-measure and tell the shell, in that order. */
  function resize(): void {
    if (!view || !fit || !$open) return;
    // Measuring a hidden element yields nonsense, hence the `$open` guard.
    try {
      fit.fit();
    } catch {
      // The panel can be mid-transition and unmeasurable; the next resize
      // observation will catch it.
      return;
    }
    terminal.resize(view.cols, view.rows);
  }

  async function start(): Promise<void> {
    if (!view || !fit) return;
    resize();
    await terminal.open(view.cols, view.rows);
  }

  async function restart(): Promise<void> {
    if (!view) return;
    view.reset();
    resize();
    await terminal.restart(view.cols, view.rows);
    view.focus();
  }

  onMount(() => {
    if (!host || !terminal.available) return;

    let disposed = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      // Loaded on demand rather than imported at the top, for the same reason
      // the grammars are: xterm is a few hundred kilobytes, and most sessions
      // never open a terminal. Nothing that is not on screen may sit between
      // launch and the first paint.
      const [xterm, addon] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/xterm/css/xterm.css'),
      ]);
      // The panel can be torn down while this is in flight.
      if (disposed || !host) return;

      view = new xterm.Terminal({
        fontFamily: $settings['editor.fontFamily'],
        fontSize: $settings['terminal.fontSize'],
        scrollback: $settings['terminal.scrollback'],
        theme: themeFromTokens(),
        cursorBlink: true,
        // The shell echoes what it receives; drawing it locally as well would
        // double every character.
        convertEol: false,
        allowProposedApi: true,
      });
      fit = new addon.FitAddon();
      view.loadAddon(fit);
      view.open(host);

      // Keystrokes out, output in.
      const typed = view.onData((data) => terminal.write(data));
      const output = terminal.onData((data) => view?.write(data));

      // The panel is measured from its own box, so a window resize, a sidebar
      // drag and a panel drag are all the same event as far as this is
      // concerned.
      const observer = new ResizeObserver(() => resize());
      observer.observe(host);

      cleanup = () => {
        typed.dispose();
        output();
        observer.disconnect();
        view?.dispose();
        view = null;
        fit = null;
      };

      await start();
      view?.focus();
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  });

  // Re-fit and take focus when the panel is revealed: it could not be
  // measured while hidden, so its size is stale by definition.
  $effect(() => {
    if (!$open) return;
    void $focusRequest;
    requestAnimationFrame(() => {
      resize();
      view?.focus();
    });
  });

  $effect(() => {
    if ($restartRequest === 0) return;
    void restart();
  });

  // Settings and theme are live, like everywhere else in Nox.
  $effect(() => {
    if (!view) return;
    view.options.fontSize = $settings['terminal.fontSize'];
    view.options.fontFamily = $settings['editor.fontFamily'];
    view.options.scrollback = $settings['terminal.scrollback'];
    void $settings['workbench.theme'];
    view.options.theme = themeFromTokens();
    resize();
  });
</script>

<section
  class="nox-terminal"
  class:is-hidden={!$open}
  style="height: {$settings['terminal.height']}px"
  aria-label="Terminal"
  aria-hidden={!$open}
>
  <header class="nox-terminal-bar">
    <span class="nox-terminal-title">
      <Icon name="command" />
      Terminal
    </span>

    {#if $status === 'exited'}
      <span class="nox-terminal-note" data-tone="muted">
        Shell exited{$exitCode === null ? '' : ` (${$exitCode})`}
      </span>
    {:else if $error}
      <span class="nox-terminal-note" data-tone="danger">{$error}</span>
    {/if}

    <span class="nox-terminal-actions">
      <button type="button" class="nox-button ghost small" onclick={() => void restart()} title="Restart the shell">
        Restart
      </button>
      <button type="button" class="nox-button ghost small" onclick={() => ui.hideTerminal()} title="Hide the terminal">
        Hide
      </button>
    </span>
  </header>

  {#if terminal.available}
    <div class="nox-terminal-host" bind:this={host}></div>
  {:else}
    <p class="nox-terminal-unavailable">
      This build has no terminal. Run the desktop app for a shell.
    </p>
  {/if}
</section>

<style>
  .nox-terminal {
    display: flex;
    flex-direction: column;
    /*
      `flex: none` is load-bearing, not tidiness. The sibling `.nox-main-content`
      is `flex: 1 1 auto`, and its flex-basis resolves to CodeMirror's full
      document height — thousands of pixels. Shrinkage is distributed in
      proportion to basis, so a shrinkable terminal surrenders
      `overflow x 260/(260 + docHeight)` of its height and collapses to ~32px
      no matter what `terminal.height` says. Measured, not theorised.
    */
    flex: none;
    min-height: 0;
    border-top: 1px solid var(--nox-border);
    background: var(--nox-bg-editor);
  }

  /*
    Hidden rather than removed: unmounting would dispose the xterm instance
    and take the scrollback with it.
  */
  .nox-terminal.is-hidden {
    display: none;
  }

  .nox-terminal-bar {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-4);
    padding: 0 10px;
    height: var(--nox-railbar-h);
    flex: 0 0 auto;
    background: var(--nox-bg-panel);
    border-bottom: 1px solid var(--nox-border);
    font-family: var(--nox-font-ui);
    font-size: var(--nox-fs-xs);
  }

  .nox-terminal-title {
    display: inline-flex;
    align-items: center;
    gap: var(--nox-sp-3);
    color: var(--nox-text-muted);
    text-transform: uppercase;
    letter-spacing: var(--nox-tracking-wide);
    font-weight: var(--nox-fw-medium);
  }

  .nox-terminal-note[data-tone='muted'] {
    color: var(--nox-text-faint);
  }

  .nox-terminal-note[data-tone='danger'] {
    color: var(--nox-danger);
  }

  .nox-terminal-actions {
    margin-left: auto;
    display: inline-flex;
    gap: var(--nox-sp-2);
  }

  .nox-terminal-host {
    flex: 1 1 auto;
    min-height: 0;
    padding: var(--nox-sp-3) var(--nox-sp-4);
  }

  .nox-terminal-unavailable {
    margin: 0;
    padding: var(--nox-sp-6);
    color: var(--nox-text-muted);
    font-family: var(--nox-font-ui);
    font-size: var(--nox-fs-sm);
  }
</style>
