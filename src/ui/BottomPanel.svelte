<script lang="ts">
  import { useApp } from './context';
  import TerminalPanel from './TerminalPanel.svelte';
  import TasksPanel from './TasksPanel.svelte';

  /**
   * The panel below the editor: Terminal and Tasks, one at a time.
   *
   * One bar for whichever view is showing, carrying the actions that used
   * to sit in each panel's own header, so a view is a strip and a body
   * rather than two bars stacked. Every button dispatches a command; this
   * component decides nothing about what showing, hiding or restarting
   * means. See `docs/superpowers/specs/2026-09-05-bottom-panel-design.md`.
   *
   * Hidden with CSS rather than unmounted, for the terminal's reason: the
   * xterm instance inside it owns the scrollback, and unmounting the
   * container would unmount that.
   */

  const app = useApp();
  const { ui, commands, config, terminal, tasks, keymap } = app;

  const terminalOpen = ui.terminalOpen;
  const tasksOpen = ui.tasksOpen;
  const settings = config.settings;
  const status = terminal.status;
  const exitCode = terminal.exitCode;
  const error = terminal.error;
  const list = tasks.tasks;
  const running = tasks.running;
  const trusted = tasks.trusted;

  /**
   * Read once: a platform's capabilities are fixed for the life of the app.
   * The command's own `enabled` reads `terminal.available`, so a tab and the
   * command it dispatches cannot disagree about whether a shell exists.
   */
  const hasTerminal = app.platform.capabilities.terminals;

  // Mounted from the first time the terminal is opened and never unmounted,
  // so the scrollback survives switching to tasks and hiding the panel.
  let terminalMounted = $state(false);
  $effect(() => {
    if ($terminalOpen) terminalMounted = true;
  });

  const open = $derived($terminalOpen || $tasksOpen);

  function withChord(label: string, commandId: string): string {
    const chord = keymap.displayFor(commandId);
    return chord ? `${label} (${chord})` : label;
  }
</script>

<section
  class="nox-bottom"
  class:is-hidden={!open}
  style="height: {$settings['terminal.height']}px"
  aria-label="Panel"
  aria-hidden={!open}
>
  <div class="bar">
    <!--
      A tablist of buttons rather than a heading per panel: the strip is the
      one place the two views are named, and it is what makes them read as
      views of one panel rather than two panels that happen to share a slot.
    -->
    <div class="tabs" role="tablist" aria-label="Panel views">
      {#if hasTerminal}
        <button
          role="tab"
          class="tab"
          class:active={$terminalOpen}
          aria-selected={$terminalOpen}
          onclick={() => void commands.execute('terminal.focus')}
        >
          Terminal
        </button>
      {/if}
      <button
        role="tab"
        class="tab"
        class:active={$tasksOpen}
        aria-selected={$tasksOpen}
        onclick={() => void commands.execute('tasks.show')}
      >
        Tasks
      </button>
    </div>

    {#if $terminalOpen}
      {#if $status === 'exited'}
        <span class="note" data-tone="muted">
          Shell exited{$exitCode === null ? '' : ` (${$exitCode})`}
        </span>
      {:else if $error}
        <span class="note" data-tone="danger">{$error}</span>
      {/if}
      <span class="actions">
        <button
          type="button"
          class="nox-button ghost small"
          onclick={() => void commands.execute('terminal.restart')}
          title="Restart the shell"
        >
          Restart
        </button>
      </span>
    {:else if $tasksOpen}
      <span class="note" data-tone="muted">
        {$list.length} defined{$running.size > 0 ? ` · ${$running.size} running` : ''}
      </span>
      <span class="actions">
        {#if $trusted.size > 0}
          <!--
            A grant you cannot see is a grant you cannot withdraw. A trusted
            task is otherwise indistinguishable from one that never asks, so
            the count is the disclosure, as it is on the agents panel.
          -->
          <button
            type="button"
            class="nox-button ghost small"
            onclick={() => void commands.execute('tasks.forgetTrust')}
            title="Project tasks will ask again before they run"
          >
            Forget {$trusted.size} approved
          </button>
        {/if}
        <button
          type="button"
          class="nox-button ghost small"
          disabled={$running.size === 0}
          onclick={() => void commands.execute('tasks.stop')}
          title="Stop every running task"
        >
          Stop All
        </button>
        <button
          type="button"
          class="nox-button ghost small"
          onclick={() => void commands.execute('tasks.edit')}
        >
          Edit Tasks
        </button>
      </span>
    {/if}

    <button
      type="button"
      class="nox-button ghost small hide"
      onclick={() => void commands.execute('view.toggleBottomPanel')}
      title={withChord('Hide the panel', 'view.toggleBottomPanel')}
    >
      Hide
    </button>
  </div>

  {#if terminalMounted}
    <TerminalPanel />
  {/if}
  {#if $tasksOpen}
    <TasksPanel />
  {/if}
</section>

<style>
  .nox-bottom {
    display: flex;
    flex-direction: column;
    /*
      `flex: none` is load-bearing. The sibling `.nox-main-content` is
      `flex: 1 1 auto` with a basis that resolves to CodeMirror's full
      document height, and shrinkage is shared in proportion to basis, so a
      shrinkable panel here would surrender almost all of its height to a
      long file. Measured when this was the terminal's own rule.
    */
    flex: none;
    min-height: 0;
    border-top: 1px solid var(--nox-border);
    background: var(--nox-bg-editor);
  }

  /* Hidden rather than removed; see the component comment. */
  .nox-bottom.is-hidden {
    display: none;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-4);
    padding: 0 var(--nox-sp-3) 0 0;
    height: var(--nox-railbar-h);
    flex: 0 0 auto;
    background: var(--nox-bg-panel);
    border-bottom: 1px solid var(--nox-border);
    font-family: var(--nox-font-ui);
    font-size: var(--nox-fs-xs);
  }

  .tabs {
    display: flex;
    align-self: stretch;
  }

  .tab {
    appearance: none;
    border: 0;
    background: none;
    padding: 0 var(--nox-sp-5);
    color: var(--nox-text-muted);
    font: inherit;
    text-transform: uppercase;
    letter-spacing: var(--nox-tracking-wide);
    font-weight: var(--nox-fw-medium);
    /* Painted as a bottom rule rather than a filled tab: the bar is one
       hairline tall and a fill would read as a button, not a tab. */
    box-shadow: inset 0 -2px 0 transparent;
    transition:
      color var(--nox-dur-fast) var(--nox-ease),
      box-shadow var(--nox-dur-fast) var(--nox-ease);
  }

  .tab:hover {
    color: var(--nox-text);
  }

  .tab.active {
    color: var(--nox-text-bright);
    box-shadow: inset 0 -2px 0 var(--nox-accent);
  }

  .note[data-tone='muted'] {
    color: var(--nox-text-muted);
  }

  .note[data-tone='danger'] {
    color: var(--nox-danger);
  }

  .actions {
    margin-left: auto;
    display: inline-flex;
    gap: var(--nox-sp-2);
  }

  /* Hide stays rightmost whether or not a view put actions before it. */
  .hide {
    margin-left: auto;
  }

  .actions + .hide {
    margin-left: 0;
  }
</style>
