<script lang="ts">
  import { runnableAgents } from '@services/agent/config';
  import type { AgentAction, AgentSessionSnapshot, SessionStatus } from '@services/agent/runtime';
  import { useApp } from './context';
  import Icon, { type IconName } from './Icon.svelte';

  /**
   * What agents have done, and one button to take it back.
   *
   * Deliberately a record rather than a chat: the thing a user needs from this
   * panel is to see exactly what was read, what was run, what was refused, and
   * to be able to undo all of it. A conversation transcript is a different
   * feature, and not the one that makes an agent safe to leave running.
   */

  const app = useApp();
  const { agents, agentConfig, notifications, ui, commands, platform } = app;

  const sessions = agents.sessions;
  const providers = agents.providers;
  const configured = agentConfig.agents;
  const configError = agentConfig.error;
  const canSpawn = platform.capabilities.agentProcesses;

  // Same policy `NoxApp.#runnableAgents()` uses to build the run-agent
  // chooser, so this button and empty state can never disagree with what
  // running the command would actually do.
  const runnable = $derived(
    runnableAgents($configured, {
      canSpawn,
      providerIds: new Set($providers.map((provider) => provider.id)),
    }),
  );

  let expanded = $state<string | null>(null);

  const STATUS: Record<SessionStatus, { label: string; tone: string }> = {
    running: { label: 'Working', tone: 'accent' },
    'awaiting-review': { label: 'Awaiting review', tone: 'warn' },
    applied: { label: 'Applied', tone: 'good' },
    dismissed: { label: 'Dismissed', tone: 'muted' },
    done: { label: 'Done', tone: '' },
    cancelled: { label: 'Cancelled', tone: 'muted' },
    failed: { label: 'Failed', tone: 'danger' },
  };

  const ICONS: Record<AgentAction['kind'], IconName> = {
    instruction: 'command',
    note: 'info',
    read: 'search',
    brief: 'info',
    command: 'command',
    proposal: 'file',
    summary: 'check',
    error: 'warning',
  };

  function describe(action: AgentAction): string {
    switch (action.kind) {
      case 'instruction':
        return action.text;
      case 'note':
      case 'summary':
        return action.text;
      case 'read':
        return action.target ? `${action.method} (${action.target})` : action.method;
      case 'brief':
        return `Opening brief carried the ${action.detail}`;
      case 'command':
        return `${action.commandId}${action.detail ? ` — ${action.detail}` : ''}`;
      case 'proposal':
        return `${action.description} · ${action.hunks} in ${action.files}`;
      case 'error':
        return action.message;
    }
  }

  function undo(session: AgentSessionSnapshot) {
    const { undone, skipped } = agents.undoSession(session.id);

    if (undone.length === 0 && skipped.length === 0) {
      notifications.info(`${session.label} has not changed anything yet`);
      return;
    }
    // The log is a record of what happened and undoing does not erase it, so
    // the button stays. Pressing it again has to say something true.
    if (undone.length === 0) {
      notifications.info(
        `Nothing left to take back from ${session.label}`,
        'Its changes have already been undone, or those files have been edited since.',
      );
      return;
    }
    if (skipped.length > 0) {
      notifications.warn(
        `Took back ${undone.length} of ${undone.length + skipped.length} files`,
        'The rest have been edited since, so their changes were left alone.',
      );
      return;
    }
    notifications.success(
      `Took back everything ${session.label} did across ${undone.length} ${
        undone.length === 1 ? 'file' : 'files'
      }`,
    );
  }
</script>

<section class="panel" aria-label="Agents">
  <header>
    <div class="heading">
      <h2>Agents</h2>
      <p>
        {#if $configured.length > 0}
          {$configured.map((agent) => agent.label).join(', ')}
        {:else}
          None configured
        {/if}
      </p>
    </div>

    <div class="actions">
      <button class="ghost" onclick={() => void commands.execute('agents.configure')}>
        Configure
      </button>
      <button class="ghost" onclick={() => ui.agentsOpen.set(false)} title="Back to the editor (Esc)">
        Close
      </button>
      <button
        class="primary"
        disabled={runnable.length === 0}
        onclick={() => void commands.execute('agents.run')}
      >
        Run agent…
      </button>
    </div>
  </header>

  {#if $configError}
    <p class="empty problem">agents.json could not be read — {$configError}</p>
  {/if}

  {#if $sessions.length === 0}
    <div class="empty">
      {#if $configured.length === 0}
        <p>
          No agents are configured yet. <strong>Configure</strong> writes an example
          <code>agents.json</code> — an id, a command, and the arguments to start it with.
        </p>
        <p class="aside">
          An agent is any program that speaks Nox's protocol on stdin and stdout. It reads through
          the context API, proposes edits you review, and can be undone in one step.
        </p>
      {:else if runnable.length === 0}
        <p>
          None of the configured agents can start here. Each needs either a process this build can
          spawn or a local model it can reach, and none of them has one.
        </p>
      {:else}
        <p>Nothing has run yet. <strong>Run agent…</strong> starts a session.</p>
      {/if}
      {#if $providers.length > 0}
        <p class="aside">{$providers.length} in-process provider(s) registered.</p>
      {/if}
    </div>
  {/if}

  <div class="sessions nox-scroll">
    {#each $sessions as session (session.id)}
      {@const status = STATUS[session.status]}
      <article>
        <button
          class="head"
          aria-expanded={expanded === session.id}
          onclick={() => (expanded = expanded === session.id ? null : session.id)}
        >
          <Icon name={expanded === session.id ? 'chevron-down' : 'chevron-right'} size={11} />
          <span class="instruction">{session.instruction}</span>
        </button>

        <div class="meta">
          <span class="label">{session.label}</span>
          <span class="status {status.tone}">{status.label}</span>
          <span class="spacer"></span>
          {#if session.changes > 0}
            <button class="undo" onclick={() => undo(session)}>Undo session</button>
          {/if}
        </div>

        {#if expanded === session.id}
          <ol class="trail">
            {#each session.actions as action, index (index)}
              <li class:refused={action.kind === 'command' && !action.granted}>
                <Icon name={ICONS[action.kind]} size={10} />
                <span>{describe(action)}</span>
              </li>
            {/each}
          </ol>
        {/if}
      </article>
    {/each}
  </div>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--nox-bg-editor);
  }

  header {
    display: flex;
    align-items: flex-start;
    gap: var(--nox-sp-4);
    padding: var(--nox-sp-4) var(--nox-sp-5);
    border-bottom: 1px solid var(--nox-border-subtle);
  }

  h2 {
    margin: 0;
    font-size: var(--nox-fs-md);
    font-weight: 600;
    color: var(--nox-text-bright);
  }

  header p {
    margin: var(--nox-sp-1) 0 0;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-faint);
  }

  .actions {
    display: flex;
    gap: var(--nox-sp-2);
    margin-left: auto;
    flex-shrink: 0;
  }

  .actions button {
    font-size: var(--nox-fs-xs);
    padding: var(--nox-sp-2) var(--nox-sp-3);
    border-radius: var(--nox-r-sm);
    border: 1px solid var(--nox-border);
    background: var(--nox-bg-raised);
    color: var(--nox-text);
  }

  .actions button:hover:not(:disabled) {
    background: var(--nox-bg-hover);
    color: var(--nox-text-bright);
  }

  .actions button.primary {
    background: var(--nox-accent);
    border-color: var(--nox-accent);
    color: var(--nox-bg-base);
    font-weight: 600;
  }

  .actions button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .empty {
    /* Prose, so it gets a measure rather than the full window width. */
    max-width: 62ch;
    margin: 0;
    padding: var(--nox-sp-5) var(--nox-sp-5) 0;
    font-size: var(--nox-fs-sm);
    line-height: 1.65;
    color: var(--nox-text-muted);
  }

  .empty p {
    margin: 0 0 var(--nox-sp-3);
  }

  .empty .aside {
    color: var(--nox-text-faint);
    font-size: var(--nox-fs-xs);
  }

  .empty code {
    font-family: var(--nox-font-mono);
    font-size: 0.92em;
    color: var(--nox-text-bright);
  }

  .empty.problem {
    color: var(--nox-warning);
  }

  .sessions {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--nox-sp-4) var(--nox-sp-5) var(--nox-sp-6);
  }

  article {
    max-width: 90ch;
    padding: var(--nox-sp-3) 0;
    border-bottom: 1px solid var(--nox-border-subtle);
  }

  button {
    font: inherit;
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
    padding: 0;
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    width: 100%;
    text-align: left;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-bright);
  }

  .instruction {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    margin: var(--nox-sp-1) 0 0 calc(11px + var(--nox-sp-2));
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-faint);
  }

  .spacer {
    flex: 1;
  }

  .status.accent {
    color: var(--nox-accent);
  }
  .status.warn {
    color: var(--nox-warning);
  }
  .status.danger {
    color: var(--nox-danger);
  }
  .status.good {
    color: var(--nox-success);
  }

  .undo {
    color: var(--nox-text-muted);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .undo:hover {
    color: var(--nox-text-bright);
  }

  .trail {
    list-style: none;
    margin: var(--nox-sp-2) 0 var(--nox-sp-1);
    padding: 0 0 0 calc(11px + var(--nox-sp-2));
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
  }

  .trail li {
    display: flex;
    align-items: flex-start;
    gap: var(--nox-sp-2);
    padding: 2px 0;
    line-height: 1.5;
  }

  /* A refused action is part of the record, not an error to hide. */
  .trail li.refused {
    color: var(--nox-warning);
  }
</style>
