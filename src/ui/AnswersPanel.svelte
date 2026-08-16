<script lang="ts">
  import { untrack } from 'svelte';
  import {
    answerFreshness,
    answerParts,
    type AgentSessionSnapshot,
    type AnswerTarget,
  } from '@services/agent/runtime';
  import type { BufferId } from '@services/workspace';
  import { useApp } from './context';

  /**
   * What you asked a model, and what it said.
   *
   * Deliberately not the agents panel: that one is a record of what a session
   * read and ran, and says so. This one is for reading prose, which is why it
   * is a column rather than a table of actions.
   *
   * Answers last for the session and no longer. An explanation of code that
   * has since changed is confidently wrong, and persisting one would be the
   * same lie provenance marks refuse to tell.
   */

  const app = useApp();
  const { agents, workspace, ui } = app;

  const sessions = agents.sessions;
  const buffers = workspace.buffers;
  const focusRequest = ui.focusAnswersRequest;

  let panel = $state<HTMLElement | null>(null);

  // Newest first: the answer you just asked for is the one you want to read,
  // and it would otherwise arrive below everything you have already read.
  const answers = $derived($sessions.filter((session) => session.expects === 'prose').reverse());

  $effect(() => {
    // Track the counter so a focus command re-runs this effect. Focus lands on
    // the column itself, which is what makes Page Down work after ⌘⇧A.
    void $focusRequest;
    untrack(() => panel)?.focus();
  });

  interface Target {
    bufferId: BufferId;
    /** Where the question was about, as a person would say it. */
    label: string;
    /** Why the answer may no longer describe it, or null when it still does. */
    stale: string | null;
    /** The buffer is not open, so there is nothing to reveal. */
    closed: boolean;
  }

  /**
   * Describe what a session asked about.
   *
   * One pass rather than one per line of the meta row: the freshness decision
   * itself is `answerFreshness`, in the service, and calling it twice would be
   * two chances to read the buffer at two different revisions.
   *
   * The revision comes off `$buffers` rather than from `workspace.revisionOf`
   * — a method call is not something this component can subscribe to, so the
   * staleness mark would go on claiming the answer was current through every
   * edit that did not happen to re-render the panel. A buffer that is no
   * longer open is absent from the list, so `-1` still means "gone".
   */
  function describe(about: AnswerTarget | null): Target | null {
    if (!about) return null;
    const buffer = $buffers.find((entry) => entry.id === about.bufferId);
    const freshness = answerFreshness(about, buffer?.revision ?? -1);
    const name = buffer?.name;
    const from = about.fromLine + 1;
    const to = about.toLine + 1;
    const lines = from === to ? `line ${from}` : `lines ${from}–${to}`;
    return {
      bufferId: about.bufferId,
      label: name ? `${name}, ${lines}` : lines,
      stale:
        freshness === 'gone'
          ? 'file is closed'
          : freshness === 'changed'
            ? 'the code has changed since'
            : null,
      closed: freshness === 'gone',
    };
  }

  /** The last thing that went wrong, which is why the session says it failed. */
  function failure(session: AgentSessionSnapshot): string {
    // `findLast` would read better, but the lib target here is ES2022.
    for (let index = session.actions.length - 1; index >= 0; index -= 1) {
      const action = session.actions[index];
      if (action?.kind === 'error') return action.message;
    }
    return 'Failed.';
  }

  function reveal(bufferId: BufferId): void {
    // `setActive`, the method the tab bar and the buffer switcher both use.
    // There is no `activate(id)`.
    workspace.setActive(bufferId);
    ui.focusEditor();
  }
</script>

<div class="panel" bind:this={panel} tabindex="-1">
  <div class="header"><span class="title">Answers</span></div>

  {#if answers.length === 0}
    <p class="empty">
      Select some code and run <strong>Explain Selection</strong>, or
      <strong>Ask About Selection…</strong> to ask something else.
    </p>
  {:else}
    <ol class="list">
      {#each answers as session (session.id)}
        {@const where = describe(session.about)}
        <li class="answer">
          <p class="question">{session.instruction}</p>
          <p class="meta">
            {#if where}
              <button class="where" disabled={where.closed} onclick={() => reveal(where.bufferId)}>
                {where.label}
              </button>
            {/if}
            <span class="agent">{session.label}</span>
            {#if where?.stale}<span class="stale">{where.stale}</span>{/if}
          </p>

          {#if session.status === 'failed'}
            <p class="failed">{failure(session)}</p>
          {:else if session.answer === null}
            <p class="working">Working…</p>
          {:else}
            {#each answerParts(session.answer) as piece}
              {#if piece.code}
                <pre class="code">{piece.text}</pre>
              {:else}
                <p class="body">{piece.text}</p>
              {/if}
            {/each}
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  /* base.css's focus ring is a 3px accent glow, right for a small input and
     wrong drawn around the whole column — which only holds focus so the
     keyboard can scroll it. */
  .panel:focus-visible {
    box-shadow: none;
  }

  .header {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    flex: none;
    height: var(--nox-tabbar-h);
    padding: 0 var(--nox-sp-3) 0 var(--nox-sp-4);
    border-bottom: 1px solid var(--nox-border);
  }

  .title {
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    letter-spacing: var(--nox-tracking-wide);
    text-transform: uppercase;
    color: var(--nox-text-muted);
  }

  .empty {
    margin: 0;
    padding: var(--nox-sp-5) var(--nox-sp-4);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-faint);
    line-height: var(--nox-lh-ui);
  }

  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .answer {
    padding: var(--nox-sp-4);
    border-bottom: 1px solid var(--nox-border);
  }

  /* A question is whatever the user typed, and a filename is whatever it is:
     both routinely contain a pasted path with no break opportunity in it.
     Without this the sidebar — 200px at its narrowest — scrolls sideways. */
  .question {
    margin: 0;
    font-size: var(--nox-fs-sm);
    font-weight: var(--nox-fw-semibold);
    color: var(--nox-text-bright);
    line-height: var(--nox-lh-ui);
    overflow-wrap: anywhere;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--nox-sp-1) var(--nox-sp-3);
    margin: var(--nox-sp-2) 0 0;
    font-size: var(--nox-fs-2xs);
    color: var(--nox-text-faint);
  }

  .where {
    color: var(--nox-text-muted);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
    text-align: left;
    overflow-wrap: anywhere;
  }

  .where:hover:not(:disabled) {
    color: var(--nox-text-bright);
  }

  .where:disabled {
    color: var(--nox-text-faint);
    text-decoration: none;
    cursor: default;
  }

  .stale {
    color: var(--nox-warning);
  }

  .failed {
    margin: var(--nox-sp-3) 0 0;
    font-size: var(--nox-fs-sm);
    color: var(--nox-danger);
    line-height: var(--nox-lh-ui);
  }

  .working {
    margin: var(--nox-sp-3) 0 0;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-faint);
  }

  .body {
    margin: var(--nox-sp-3) 0 0;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text);
    line-height: var(--nox-lh-ui);
    /* The answer arrives as text with its own line breaks, and this is the
       whole of what "renders them" means without a markdown renderer. */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .code {
    margin: var(--nox-sp-3) 0 0;
    padding: var(--nox-sp-3);
    border-radius: var(--nox-r-sm);
    background: var(--nox-bg-inset);
    color: var(--nox-text);
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-xs);
    line-height: var(--nox-lh-ui);
    /* Code does not wrap: a broken line is harder to read than a scrolled one. */
    overflow-x: auto;
  }
</style>
