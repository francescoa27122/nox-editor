<script lang="ts">
  import { contains, relative } from '@core/path';
  import { runnableAgents } from '@services/agent/config';
  import {
    stillOnDisk,
    type AgentAction,
    type AgentSessionSnapshot,
    type SessionStatus,
  } from '@services/agent/runtime';
  import { describeCapability, isResourceScoped, type Grant } from '@services/permissions';
  import { useApp } from './context';
  import Icon, { type IconName } from './Icon.svelte';

  /**
   * What agents have done, what they may still do, and buttons to take back
   * either one without taking back the other.
   *
   * Deliberately a record rather than a chat: the thing a user needs from this
   * panel is to see exactly what was read, what was run, what was refused, and
   * to be able to undo all of it. A conversation transcript is a different
   * feature, and not the one that makes an agent safe to leave running.
   *
   * Standing permissions live here rather than in a panel of their own for the
   * same reason: the moment a user wants to close a door is the moment they
   * are looking at what came through it, and a permissions viewer somewhere
   * else is a permissions viewer nobody opens.
   */

  const app = useApp();
  const { agents, agentConfig, notifications, permissions, ui, commands, platform } = app;

  const sessions = agents.sessions;
  const grants = permissions.grants;
  const root = app.workspace.rootPath;
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

  /** Standing grants held by one session. Empty for most of them, and that is the honest answer. */
  const grantsOf = (sessionId: string): Grant[] =>
    $grants.filter(
      (grant) => grant.principal.kind === 'agent' && grant.principal.sessionId === sessionId,
    );

  /**
   * What a grant actually covers, in the words the prompt asked in.
   *
   * A resource-scoped capability with no resource is not a narrow grant with a
   * missing label — it is the widest kind there is. `review.apply` declares
   * `buffer.edit` and deliberately names no file, because naming the active
   * one would understate the reach of what the user agreed to; the list has to
   * say so rather than render a blank beside neighbours that show a path.
   */
  function coversOf(grant: Grant): string {
    if (grant.resource) {
      return contains($root ?? '', grant.resource) ? relative($root!, grant.resource) : grant.resource;
    }
    return isResourceScoped(grant.capability) ? 'any file' : 'anywhere';
  }

  /**
   * Which command the grant is confined to, in the title the prompt used.
   *
   * Shown since 2026-08-31, when grants stopped being keyed on the capability
   * alone. Without it the list under-reports in the direction that matters:
   * two rows reading "edit what is open / any file" would look like one
   * duplicated grant rather than two different commands, and the whole reason
   * the key narrowed is that those two are not interchangeable.
   *
   * Falls back to the id, and then to nothing, because a grant is only
   * required to carry what the question carried.
   */
  function viaOf(grant: Grant): string {
    return grant.description ?? grant.commandId ?? '';
  }

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
    elided: 'info',
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
      case 'elided':
        return `${action.count} earlier ${action.count === 1 ? 'action' : 'actions'} dropped`;
    }
  }

  function undo(session: AgentSessionSnapshot) {
    // `AgentRuntime.undoSession` revokes this session's standing permissions
    // as well as reverting its work, so the count has to be taken before the
    // call. Saying so is not decoration: the two are separable now, the panel
    // offers a button for each, and a user who pressed the one marked Undo
    // would otherwise have no way to learn that it also shut a door.
    const revoked = grantsOf(session.id).length;
    const alsoRevoked =
      revoked === 0
        ? ''
        : ` Its ${revoked === 1 ? 'standing permission was' : `${revoked} standing permissions were`}` +
          ' revoked too, so it will be asked again next time.';

    const { undone, skipped, onDisk } = agents.undoSession(session.id);
    // Reverted in the buffer, still on disk: said in the toast, because the
    // dirty marker on the tab is not a message anyone reads as "you shipped
    // it". The tone follows: this is a warning, not a success.
    const unsaved = stillOnDisk(onDisk.length);

    if (undone.length === 0 && skipped.length === 0) {
      notifications.info(
        `${session.label} has not changed anything yet`,
        alsoRevoked.trim() || undefined,
      );
      return;
    }
    // The log is a record of what happened and undoing does not erase it, so
    // the button stays. Pressing it again has to say something true.
    if (undone.length === 0) {
      notifications.info(
        `Nothing left to take back from ${session.label}`,
        'Its changes have already been undone, or those files have been edited since.' +
          alsoRevoked,
      );
      return;
    }
    if (skipped.length > 0) {
      notifications.warn(
        `Took back ${undone.length} of ${undone.length + skipped.length} files`,
        'The rest have been edited since, so their changes were left alone.' +
          (unsaved ? ` ${unsaved}` : '') +
          alsoRevoked,
      );
      return;
    }
    const everything = `Took back everything ${session.label} did across ${undone.length} ${
      undone.length === 1 ? 'file' : 'files'
    }`;
    if (unsaved) {
      notifications.warn(`${everything} in the editor`, unsaved + alsoRevoked);
      return;
    }
    notifications.success(everything, alsoRevoked.trim() || undefined);
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
      {#if $grants.length > 0}
        <!--
          Shown only when there is something to revoke, so the count is the
          disclosure: it says how much is standing without a viewer to open,
          and it is the one route to a grant whose session is not on screen.
        -->
        <button
          class="nox-button small"
          onclick={() => void commands.execute('permissions.revokeGrants')}
          title="Take back every standing permission. Nothing already written changes."
        >
          Revoke {$grants.length} {$grants.length === 1 ? 'permission' : 'permissions'}
        </button>
      {/if}
      <button class="nox-button small" onclick={() => void commands.execute('agents.configure')}>
        Configure
      </button>
      <button class="nox-button small" onclick={() => ui.agentsOpen.set(false)} title="Back to the editor (Esc)">
        Close
      </button>
      <button
        class="nox-button small primary"
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
          {#if grantsOf(session.id).length > 0}
            <button
              class="linkish"
              onclick={() => void commands.execute('permissions.revokeSessionGrants', session.id)}
              title="Stop this agent without reverting its work"
            >
              Revoke access
            </button>
          {/if}
          {#if session.changes > 0}
            <button class="linkish" onclick={() => undo(session)}>Undo session</button>
          {/if}
          <button
            class="linkish"
            onclick={() => void commands.execute('agents.copyTrail', session.id)}
            title="Copy this session's trail, reads and permission decisions as JSON"
          >
            Copy trail
          </button>
        </div>

        {#if expanded === session.id}
          {@const held = grantsOf(session.id)}
          <section class="grants">
            <h3>Standing permissions</h3>
            {#if held.length === 0}
              <p>
                None. Whatever this agent was allowed to do, it was allowed once or allowed by
                policy — a policy rule is not something you granted, so there is nothing here to
                take back.
              </p>
            {:else}
              <ul>
                {#each held as grant (grant.key)}
                  {@const via = viaOf(grant)}
                  <li>
                    <span>{describeCapability(grant.capability)}</span>
                    {#if via}<span class="via">via {via}</span>{/if}
                    <code>{coversOf(grant)}</code>
                  </li>
                {/each}
              </ul>
              <p>
                Granted with <strong>Allow for this session</strong>, and in force until you revoke
                them or Nox restarts. Revoking leaves everything the agent has already written
                exactly as it is.
              </p>
            {/if}
          </section>
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
    color: var(--nox-text-muted);
  }

  .actions {
    display: flex;
    gap: var(--nox-sp-2);
    margin-left: auto;
    flex-shrink: 0;
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
    color: var(--nox-text-muted);
    font-size: var(--nox-fs-xs);
  }

  .empty code {
    font-family: var(--nox-font-mono);
    /* One step under the prose around it, which is `--nox-fs-sm`. */
    font-size: var(--nox-fs-xs);
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
    color: var(--nox-text-muted);
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

  .linkish {
    color: var(--nox-text-muted);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .linkish:hover {
    color: var(--nox-text-bright);
  }

  .grants {
    margin: var(--nox-sp-2) 0 0 calc(11px + var(--nox-sp-2));
    padding: var(--nox-sp-2) 0 var(--nox-sp-2) var(--nox-sp-3);
    /* A rule rather than a filled card: this sits inside the expanded row and
       a second background would read as a second panel. */
    border-left: 2px solid var(--nox-border-subtle);
  }

  .grants h3 {
    margin: 0;
    font-size: var(--nox-fs-xs);
    font-weight: 600;
    color: var(--nox-text-muted);
  }

  .grants p {
    max-width: 62ch;
    margin: var(--nox-sp-2) 0 0;
    font-size: var(--nox-fs-xs);
    line-height: 1.6;
    color: var(--nox-text-muted);
  }

  .grants ul {
    list-style: none;
    margin: var(--nox-sp-2) 0 0;
    padding: 0;
    font-size: var(--nox-fs-xs);
  }

  .grants li {
    display: flex;
    align-items: baseline;
    gap: var(--nox-sp-2);
    padding: 2px 0;
    /* The standing grants are the one thing on this panel that is still live,
       so they read at the warning colour the refused-action rows use. */
    color: var(--nox-warning);
  }

  /* Secondary to the capability, which is the thing being granted, but ahead
     of the path in the reading order the prompt used: what, then by which
     command, then where. */
  .grants .via {
    flex: none;
    color: var(--nox-text-muted);
  }

  .grants code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--nox-font-mono);
    /* One step under the list around it, which is `--nox-fs-xs`. */
    font-size: var(--nox-fs-2xs);
    color: var(--nox-text-muted);
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
