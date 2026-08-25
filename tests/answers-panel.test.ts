// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import AnswersPanel from '../src/ui/AnswersPanel.svelte';
import { flush, mountComponent } from './support/component';
import { ScriptedProvider } from '../src/services/agent/provider';
import { ProviderTransport, type AgentSession } from '../src/services/agent/runtime';

/** A provider that answers with `text` and stops. */
const speaks = (text: string) =>
  new ProviderTransport(new ScriptedProvider(() => [{ type: 'text' as const, text }]));

/** A provider that finishes having said nothing — the resting state that is not "working". */
const silent = () => new ProviderTransport(new ScriptedProvider(() => []));

/** A provider that never finishes, so the session stays running until cancelled. */
const hangs = () =>
  new ProviderTransport(
    // Yielding nothing is the point: this generator exists to leave the
    // session running so a test can cancel it. A `yield` would end the hang
    // it is written to produce.
    // eslint-disable-next-line require-yield
    new ScriptedProvider(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }),
  );

/** Wait for a session to stop running. Mirrors `settle` in tests/answers.test.ts. */
async function settle(session: AgentSession, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (session.status.get() === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The text of every element matching `selector`, in document order. */
const textsOf = (container: HTMLElement, selector: string): (string | null)[] =>
  [...container.querySelectorAll(selector)].map((node) => node.textContent);

describe('the answers panel with nothing in it', () => {
  /**
   * The failure this prevents: the `{#if answers.length === 0}` branch being
   * inverted or dropped by a later edit, so a user who has never asked
   * anything gets an empty box instead of the sentence telling them how to
   * ask. It is also the first thing that proves the harness itself works —
   * a component that mounts at all has reached `useApp()` through real
   * context.
   */
  it('tells you how to ask instead of rendering an empty list', () => {
    const { container, unmount } = mountComponent(AnswersPanel);
    flush();

    expect(container.querySelector('.panel-empty')).not.toBeNull();
    expect(container.querySelector('.list')).toBeNull();
    expect(container.querySelector('.panel-empty')?.textContent).toContain('Explain Selection');

    unmount();
  });
});

describe('the order the answers panel renders in', () => {
  /**
   * The failure this prevents, and it shipped: the panel carried a
   * `.reverse()` whose own comment said it existed to produce newest-first,
   * and which instead produced exactly the oldest-first list it named. Three
   * reviews read past it; a walk against a real model found it.
   *
   * `tests/answers.test.ts` pins that the *runtime* publishes newest-first,
   * and that test passed throughout the bug — the runtime was never wrong.
   * The reversal was in the component, which is why the contract has to be
   * asserted again at the level that consumes it. This is the test that could
   * not exist before there was a harness.
   *
   * Verified against 8abb2ba, the commit that shipped it: this assertion
   * fails there with
   *   AssertionError: expected [ 'asked first', 'asked second' ] to deeply
   *   equal [ 'asked second', 'asked first' ]
   * The `.body` assertion on the next line was never reached — `toEqual`
   * throws on the first failure — but it would fail for the same reason,
   * since the body order comes from the same reversed list.
   */
  it('puts the newest answer at the top', async () => {
    const { container, app, unmount } = mountComponent(AnswersPanel);

    const older = app.agents.start(speaks('the older answer'), 'asked first', {
      expects: 'prose',
    });
    await settle(older);
    const newer = app.agents.start(speaks('the newer answer'), 'asked second', {
      expects: 'prose',
    });
    await settle(newer);
    flush();

    expect(textsOf(container, '.question')).toEqual(['asked second', 'asked first']);
    // Asserted on the bodies too, so a change that reorders the questions
    // without their answers cannot pass this.
    expect(textsOf(container, '.body')).toEqual(['the newer answer', 'the older answer']);

    unmount();
  });
});

describe('what the panel says when there is no answer', () => {
  /**
   * The failure this prevents, and it shipped: the template branched on
   * `answer === null`, which is also the resting state of a session that
   * finished and said nothing — reachable when a local model returns only
   * whitespace, or when an out-of-process agent ignores `expects`. Those
   * sessions rendered "Working…" forever, claiming work was going on after it
   * had stopped.
   *
   * Verified against 8abb2ba, the commit that shipped it: this assertion
   * fails there with
   *   AssertionError: expected [] to deeply equal [ Array(1) ]
   *   - Expected
   *   + Received
   *   - [
   *   -   "The model finished without saying anything.",
   *   - ]
   *   + []
   * `.state` matches nothing pre-fix, because the branch renders
   * `<p class="working">Working…</p>` for this case instead.
   */
  it('says a finished session said nothing, rather than that it is working', async () => {
    const { container, app, unmount } = mountComponent(AnswersPanel);

    const session = app.agents.start(silent(), 'explain this', { expects: 'prose' });
    await settle(session);
    flush();

    expect(textsOf(container, '.state')).toEqual(['The model finished without saying anything.']);

    unmount();
  });

  /**
   * The second state behind the same branch. A cancelled session also has a
   * null answer, and telling the user it is working is the same lie.
   *
   * Verified against 8abb2ba, the commit that shipped it: this assertion
   * fails there with
   *   AssertionError: expected [] to deeply equal [ 'Cancelled before it
   *   answered.' ]
   * Same mechanism as the finished-session case above: `.state` matches
   * nothing, because the pre-fix template still shows
   * `<p class="working">Working…</p>` for a null answer.
   */
  it('says a cancelled session was cancelled', async () => {
    const { container, app, unmount } = mountComponent(AnswersPanel);

    const session = app.agents.start(hangs(), 'take your time', { expects: 'prose' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.cancel();
    await settle(session);
    flush();

    expect(textsOf(container, '.state')).toEqual(['Cancelled before it answered.']);

    unmount();
  });

  /**
   * The true case, kept so that the fix for the two above cannot be "delete
   * the branch". A session that really is running must still say so.
   *
   * Verified against 8abb2ba, the commit that shipped it: this assertion
   * also fails there, with
   *   AssertionError: expected [] to deeply equal [ 'Working…' ]
   * but not because of a shipped defect: the pre-fix component renders the
   * correct text, "Working…", under `<p class="working">` rather than a
   * `.state` element, so this failure is a class-name artifact of the old
   * markup, not evidence of a third bug. `class="working"` only became
   * `.state` in the fix.
   */
  it('says Working… while the session is actually running', async () => {
    const { container, app, unmount } = mountComponent(AnswersPanel);

    const session = app.agents.start(hangs(), 'take your time', { expects: 'prose' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    flush();

    expect(session.status.get()).toBe('running');
    expect(textsOf(container, '.state')).toEqual(['Working…']);

    session.cancel();
    await settle(session);
    unmount();
  });

  /**
   * The failure this prevents: a resting-state branch broad enough to swallow
   * real answers, which would turn every answered question into a sentence
   * about having said nothing.
   */
  it('renders the answer when there is one', async () => {
    const { container, app, unmount } = mountComponent(AnswersPanel);

    const session = app.agents.start(speaks('It adds two numbers.'), 'what does this do?', {
      expects: 'prose',
    });
    await settle(session);
    flush();

    expect(textsOf(container, '.body')).toEqual(['It adds two numbers.']);
    expect(container.querySelector('.state')).toBeNull();

    unmount();
  });
});

describe('which sessions the answers panel is for', () => {
  /**
   * The failure this prevents: the answers column filling with the agent
   * sessions that belong in the agents panel. The two panels read the same
   * `agents.sessions` list and are separated only by this filter — the panel
   * is for reading prose, and a session that was never asked for prose has no
   * answer to read.
   */
  it('ignores sessions that were not asked for prose', async () => {
    const { container, app, unmount } = mountComponent(AnswersPanel);

    const ordinary = app.agents.start(speaks('some narration'), 'do a thing');
    await settle(ordinary);
    flush();

    expect(container.querySelector('.panel-empty')).not.toBeNull();
    expect(textsOf(container, '.question')).toEqual([]);

    unmount();
  });
});
