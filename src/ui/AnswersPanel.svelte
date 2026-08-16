<script lang="ts">
  import { untrack } from 'svelte';
  import {
    answerFreshness,
    answerParts,
    type AgentSessionSnapshot,
    type AnswerTarget,
    type SessionStatus,
  } from '@services/agent/runtime';
  import type { BufferId, SelectionRecord } from '@services/workspace';
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
   *
   * Reopening a closed file does not revive an answer's target: buffer ids are
   * a counter, not a path, so the reopened file is a different buffer and the
   * entry goes on saying "file is closed". That is honest — the buffer the
   * answer was measured against really is gone, and its revision with it — but
   * it surprises people, so it is written down rather than left to be
   * rediscovered.
   */

  const app = useApp();
  const { agents, workspace, ui } = app;

  const sessions = agents.sessions;
  const buffers = workspace.buffers;
  const focusRequest = ui.focusAnswersRequest;

  let panel = $state<HTMLElement | null>(null);

  // Newest first, because `agents.sessions` is already published newest-first
  // — `AgentRuntime.start` prepends. Filtering preserves that order, so there
  // is nothing to do here but keep it. This once carried a `.reverse()` meant
  // to *produce* newest-first, which instead produced exactly the oldest-first
  // list its own comment said it existed to prevent. `tests/answers.test.ts`
  // pins the runtime's order; `tests/answers-panel.test.ts` pins this file
  // rendering it in that order. Both, because the runtime test passed
  // throughout that bug — the published order was never wrong, and no test at
  // that level could have seen what this file did with it.
  const answers = $derived($sessions.filter((session) => session.expects === 'prose'));

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
    /** The lines to select on reveal, or null when selecting would mislead. */
    select: SelectionRecord | null;
  }

  /**
   * The lines an answer was about, as document offsets.
   *
   * Only ever called for a `current` answer, so the line numbers are known to
   * address the same text the model saw. Still returns null rather than
   * clamping if they are somehow out of range: a selection silently snapped to
   * a different span is the failure this is trying to avoid, not a recovery
   * from it.
   */
  function rangeFor(about: AnswerTarget): SelectionRecord | null {
    const doc = workspace.stateOf(about.bufferId)?.doc;
    if (!doc || about.fromLine < 0 || about.toLine >= doc.lines) return null;
    const from = doc.line(about.fromLine + 1).from;
    const to = doc.line(about.toLine + 1).to;
    return { ranges: [[from, to]], main: 0 };
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
      // Only a `current` answer selects. Its line numbers were recorded
      // against text that has since moved in every other case, so selecting
      // them would highlight code the answer is not about — precisely what
      // the staleness mark exists to prevent. A changed answer still reveals
      // the file; the user lands there and reads it themselves.
      select: freshness === 'current' ? rangeFor(about) : null,
    };
  }

  /**
   * What to say for a session that has no answer.
   *
   * Branching on the status rather than on `answer === null`, because null is
   * also the *resting* state of a session that finished and said nothing —
   * which is reachable two ways today: the Ollama prose branch yields nothing
   * when the model returns only whitespace, and an out-of-process agent that
   * ignores `expects` never sends a `session.note` at all. Rendering
   * "Working…" for those claimed work was still going on after it had stopped,
   * which is the same class of lie as a staleness mark saying code is current
   * after it has moved.
   *
   * A prose session only ever reaches `running`, `done`, `cancelled` or
   * `failed` — `failed` is handled before this is called, and the review
   * statuses need a branch only because they are in the type.
   */
  function resting(status: SessionStatus): string {
    switch (status) {
      case 'running':
        return 'Working…';
      case 'cancelled':
        return 'Cancelled before it answered.';
      default:
        return 'The model finished without saying anything.';
    }
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

  function reveal(target: Target): void {
    // `setActive`, the method the tab bar and the buffer switcher both use.
    // There is no `activate(id)`.
    workspace.setActive(target.bufferId);
    // `setSelection` scrolls the range into view as well as selecting it.
    if (target.select) workspace.setSelection(target.bufferId, target.select);
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
              <button class="where" disabled={where.closed} onclick={() => reveal(where)}>
                {where.label}
              </button>
            {/if}
            <span class="agent">{session.label}</span>
            {#if where?.stale}<span class="stale">{where.stale}</span>{/if}
          </p>

          {#if session.status === 'failed'}
            <p class="failed">{failure(session)}</p>
          {:else if session.answer !== null}
            {#each answerParts(session.answer) as piece}
              {#if piece.code}
                <pre class="code">{piece.text}</pre>
              {:else}
                <p class="body">{piece.text}</p>
              {/if}
            {/each}
          {:else}
            <p class="state">{resting(session.status)}</p>
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

  /* Covers every reason there is no answer to show — still working, cancelled,
     or finished having said nothing. Faint rather than warning-coloured: none
     of them is an error, and the failed case has its own rule above. */
  .state {
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
