import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import {
  ProviderTransport,
  AgentRuntime,
  answerFreshness,
  answerParts,
  EXPLAIN_INSTRUCTION,
  type AgentSession,
} from '../src/services/agent/runtime';
import { ScriptedProvider, type ModelRequest } from '../src/services/agent/provider';
import { CommandRegistry } from '../src/services/commands';
import { ContextService } from '../src/services/context';
import { FileTreeService } from '../src/services/filetree';
import { JobRunner } from '../src/services/jobs';
import { PermissionService } from '../src/services/permissions';
import { ReviewService } from '../src/services/review';
import { UIService } from '../src/services/ui';
import { WorkspaceService, type BufferId } from '../src/services/workspace';

const A = 'one\ntwo\nthree\nfour\nfive\n';

async function setup() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/a.txt', A);

  const workspace = new WorkspaceService(platform, () => history());
  const files = new FileTreeService(platform);
  const context = new ContextService(workspace, files);
  const commands = new CommandRegistry();
  const permissions = new PermissionService(() => workspace.rootPath.get());
  const review = new ReviewService(workspace);
  const jobs = new JobRunner();
  const runtime = new AgentRuntime({ workspace, context, commands, permissions, review, jobs });

  await workspace.openFolder('/w');
  await files.setRoot('/w');
  await files.buildIndex();
  const a = (await workspace.open('/w/a.txt'))!;

  return { workspace, context, runtime, a };
}

async function settle(session: AgentSession, budgetMs = 10_000) {
  const deadline = Date.now() + budgetMs;
  while (session.status.get() === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A provider that records the request it was handed and says nothing. */
function watcher() {
  const seen: ModelRequest[] = [];
  const provider = new ScriptedProvider((request) => {
    seen.push(request);
    return [];
  });
  return { seen, transport: new ProviderTransport(provider) };
}

describe('what a session tells its provider to expect', () => {
  /**
   * The failure this prevents: the provider having no way to know prose was
   * wanted, which is the whole reason "explain this" ends in a failed
   * session today.
   */
  it('passes the expectation through to the provider', async () => {
    const { runtime } = await setup();
    const { seen, transport } = watcher();

    const session = runtime.start(transport, 'what does this do?', { expects: 'prose' });
    await settle(session);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.expects).toBe('prose');
  });

  /**
   * The failure this prevents: an ordinary session silently acquiring a new
   * field, which would change what every agent written before this is asked
   * for.
   */
  it('says nothing about expectations for an ordinary session', async () => {
    const { runtime } = await setup();
    const { seen, transport } = watcher();

    const session = runtime.start(transport, 'rename Task to Job');
    await settle(session);

    expect(seen[0]?.expects).toBeUndefined();
  });
});

describe('what a prose session is allowed to do', () => {
  /**
   * The failure this prevents: "explain this selection" staging an edit.
   * Enforced here rather than in the prompt, so an out-of-process agent that
   * ignores `expects` is refused too.
   */
  it('refuses a proposal', async () => {
    const { runtime, a } = await setup();
    const responses: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      const reply = yield {
        type: 'action',
        request: {
          method: 'proposal.stage',
          params: { description: 'nope', edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }], baseRevisions: {} },
        },
      };
      responses.push(reply);
    });

    const session = runtime.start(new ProviderTransport(provider), 'explain this', {
      expects: 'prose',
    });
    await settle(session);

    expect(responses[0]).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });

  /**
   * The failure this prevents: a prose session reaching the command
   * dispatcher at all. `command.execute` is the only verb with a side
   * effect, so this is the whole of what "cannot edit anything" means.
   */
  it('refuses a command', async () => {
    const { runtime } = await setup();
    const responses: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      const reply = yield {
        type: 'action',
        request: { method: 'command.execute', params: { commandId: 'file.save' } },
      };
      responses.push(reply);
    });

    const session = runtime.start(new ProviderTransport(provider), 'explain this', {
      expects: 'prose',
    });
    await settle(session);

    expect(responses[0]).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });

  /**
   * The failure this prevents: the refusal being so broad that the session
   * cannot say anything either, which would refuse the answer itself.
   */
  it('still accepts a summary', async () => {
    const { runtime } = await setup();
    const responses: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      const reply = yield {
        type: 'action',
        request: { method: 'session.summary', params: { text: 'all done' } },
      };
      responses.push(reply);
    });

    const session = runtime.start(new ProviderTransport(provider), 'explain this', {
      expects: 'prose',
    });
    await settle(session);

    expect(responses[0]).toMatchObject({ ok: true });
  });

  /**
   * The failure this prevents: the refusal leaking into ordinary sessions
   * and breaking every agent already written.
   */
  it('leaves an ordinary session able to read', async () => {
    const { runtime } = await setup();
    const responses: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      const reply = yield { type: 'action', request: { method: 'context.openBuffers' } };
      responses.push(reply);
    });

    const session = runtime.start(new ProviderTransport(provider), 'look around');
    await settle(session);

    expect(responses[0]).toMatchObject({ ok: true });
  });
});

describe('the answer a prose session produces', () => {
  const speaks = (text: string) =>
    new ProviderTransport(new ScriptedProvider(() => [{ type: 'text' as const, text }]));

  /**
   * The failure this prevents: an answer arriving only as a `note` action in
   * the audit trail, which is a record of what an agent *did* and is not
   * where anyone looks for an essay.
   */
  it('publishes the answer on the session snapshot', async () => {
    const { runtime } = await setup();
    const session = runtime.start(speaks('It adds two numbers.'), 'what does this do?', {
      expects: 'prose',
    });
    await settle(session);

    const snapshot = runtime.sessions.get().find((entry) => entry.id === session.id);
    expect(snapshot?.answer).toBe('It adds two numbers.');
    expect(snapshot?.expects).toBe('prose');
  });

  /**
   * The failure this prevents: only the first chunk of a multi-chunk answer
   * surviving. Every other test's `speaks` yields exactly one chunk, so the
   * `current === null ? text : `${current}${text}`` branch's non-null side
   * was never exercised before this test. `ProviderTransport.run` turns each
   * chunk into its own `session.note`, so two chunks means two calls into
   * the interception, and the second must append rather than replace.
   */
  it('concatenates a multi-chunk answer in order, with no separator', async () => {
    const { runtime } = await setup();
    const transport = new ProviderTransport(
      new ScriptedProvider(() => [
        { type: 'text' as const, text: 'It adds ' },
        { type: 'text' as const, text: 'two numbers.' },
      ]),
    );
    const session = runtime.start(transport, 'what does this do?', { expects: 'prose' });
    await settle(session);

    const snapshot = runtime.sessions.get().find((entry) => entry.id === session.id);
    expect(snapshot?.answer).toBe('It adds two numbers.');
  });

  /**
   * The failure this prevents: the trail filling with the whole answer,
   * burying the reads it exists to show. Same distinction the `brief` action
   * already makes.
   */
  it('keeps the answer out of the audit trail', async () => {
    const { runtime } = await setup();
    const session = runtime.start(speaks('A paragraph.'), 'explain', { expects: 'prose' });
    await settle(session);

    expect(session.actions.get().some((action) => action.kind === 'note')).toBe(false);
  });

  /**
   * The failure this prevents: a prose session reported as awaiting review
   * when there is nothing to review.
   */
  it('ends done, never awaiting review', async () => {
    const { runtime } = await setup();
    const session = runtime.start(speaks('A paragraph.'), 'explain', { expects: 'prose' });
    await settle(session);

    expect(session.status.get()).toBe('done');
  });

  /**
   * The failure this prevents: an answer with no record of what it was
   * about, which makes both navigation and staleness impossible.
   */
  it('records the buffer, the lines and the revision it was asked about', async () => {
    const { runtime, workspace, a } = await setup();
    const session = runtime.start(speaks('A paragraph.'), 'explain', {
      expects: 'prose',
      scope: { bufferId: a, fromLine: 1, toLine: 2 },
    });
    await settle(session);

    const snapshot = runtime.sessions.get().find((entry) => entry.id === session.id);
    expect(snapshot?.about).toEqual({
      bufferId: a,
      fromLine: 1,
      toLine: 2,
      revision: workspace.revisionOf(a),
    });
  });

  /**
   * The failure this prevents: an ordinary session growing an answer field
   * that is always null but implies one could arrive.
   */
  it('leaves an ordinary session with no answer', async () => {
    const { runtime } = await setup();
    const session = runtime.start(speaks('narration'), 'do a thing');
    await settle(session);

    const snapshot = runtime.sessions.get().find((entry) => entry.id === session.id);
    expect(snapshot?.answer).toBeNull();
    expect(snapshot?.about).toBeNull();
  });

  /**
   * The failure this prevents: "Edit Selection with a Model…" — an ordinary
   * action session that always carries a scope — reporting a target as if it
   * had been asked a question. A later panel treats a non-null `about` as
   * "this session asked something"; capturing it for every scoped session,
   * prose or not, would make that read wrong for the most common scoped
   * session there is. Unlike the test above, this one *does* pass a scope,
   * so it is the one that actually exercises the gate.
   */
  it('leaves a scoped ordinary session with no target either', async () => {
    const { runtime, a } = await setup();
    const session = runtime.start(speaks('narration'), 'rename Task to Job', {
      scope: { bufferId: a, fromLine: 1, toLine: 2 },
    });
    await settle(session);

    const snapshot = runtime.sessions.get().find((entry) => entry.id === session.id);
    expect(snapshot?.about).toBeNull();
  });
});

describe('whether an answer still describes the code', () => {
  const about = { bufferId: 'b1' as BufferId, fromLine: 0, toLine: 3, revision: 7 };

  it('is current while the buffer has not moved', () => {
    expect(answerFreshness(about, 7)).toBe('current');
  });

  /**
   * The failure this prevents: an explanation of code that has been edited
   * since presenting itself as describing what is on screen.
   */
  it('is changed once the buffer has moved', () => {
    expect(answerFreshness(about, 8)).toBe('changed');
  });

  /**
   * The failure this prevents: a closed buffer reading as an edit. `-1` is
   * also "different", and reporting a file you closed as one you changed is
   * a small lie in the same family as the ones this feature avoids.
   */
  it('is gone when the buffer is closed', () => {
    expect(answerFreshness(about, -1)).toBe('gone');
  });
});

describe('the built-in explain instruction', () => {
  /**
   * The failure this prevents: a preset that ships as an empty string or a
   * placeholder, which a local model answers with something unrelated.
   */
  it('asks a real question', () => {
    expect(EXPLAIN_INSTRUCTION.trim().length).toBeGreaterThan(20);
    expect(EXPLAIN_INSTRUCTION).toMatch(/explain/i);
  });
});

describe('the answers sidebar section', () => {
  /**
   * The failure this prevents: the section staying selected after the last
   * agent is removed from agents.json, leaving the rail with no button for
   * the panel that is showing.
   */
  it('falls back to the explorer when its view is dropped', () => {
    const ui = new UIService();
    ui.focusAnswers();
    expect(ui.sidebarView.get()).toBe('answers');

    ui.dropView('answers');

    expect(ui.sidebarView.get()).toBe('explorer');
  });

  /**
   * The failure this prevents: dropping a view yanking the user out of an
   * unrelated panel they are working in.
   */
  it('leaves another view alone', () => {
    const ui = new UIService();
    ui.focusSearch();

    ui.dropView('answers');

    expect(ui.sidebarView.get()).toBe('search');
  });

  /**
   * The failure this prevents: `showView` — what the rail button calls —
   * dropping through to the explorer for a view it has no branch for, which
   * is what happened to notes before its branch was added.
   */
  it('is reachable from showView', () => {
    const ui = new UIService();
    ui.showView('answers');

    expect(ui.sidebarView.get()).toBe('answers');
    expect(ui.focusZone.get()).toBe('answers');
  });

  /**
   * The failure this prevents: ⌘⇧A selecting the section but leaving focus
   * where it was. The counter is the only thing that moves the panel's DOM
   * focus, and because it is a counter rather than a flag it also has to bump
   * when the section is *already* showing — otherwise focusing a panel you
   * are already looking at does nothing.
   */
  it('bumps the focus request every time, by either route', () => {
    const ui = new UIService();
    const start = ui.focusAnswersRequest.get();

    ui.focusAnswers();
    expect(ui.focusAnswersRequest.get()).toBe(start + 1);

    ui.showView('answers');
    expect(ui.focusAnswersRequest.get()).toBe(start + 2);
  });
});

describe('splitting an answer into prose and code', () => {
  it('keeps a fenced block as one code part and the prose around it', () => {
    expect(answerParts('Like this:\n```js\nconst a = 1;\n```\nand that is all.')).toEqual([
      { code: false, text: 'Like this:\n' },
      { code: true, text: 'const a = 1;\n' },
      { code: false, text: 'and that is all.' },
    ]);
  });

  /**
   * The failure this prevents: content vanishing. An optional newline after
   * the info string let the language matcher run on an *inline* fence too, so
   * "Use ```json``` for details." rendered with the word `json` deleted —
   * present in neither part, and nothing on screen to suggest anything was
   * missing. Every other limitation of this splitter shows content in the
   * wrong style; only this one showed no content, which is why it is the one
   * with a test.
   */
  it('does not swallow the word after an inline fence', () => {
    expect(answerParts('Use ```json``` for details.')).toEqual([
      { code: false, text: 'Use ' },
      { code: true, text: 'json' },
      { code: false, text: ' for details.' },
    ]);
  });

  /** The same shape in ordinary phrasing, where a model explains markdown. */
  it('keeps the tag when a fence is never closed', () => {
    expect(answerParts('wrap it in ```ts fences')).toEqual([
      { code: false, text: 'wrap it in ' },
      { code: true, text: 'ts fences' },
    ]);
  });

  /**
   * The failure this prevents: half an info string leaking into the code. Only
   * a bare tag is consumed, so anything the matcher does not recognise — a
   * space, a `+` — stays visible rather than being silently half-eaten.
   */
  it('leaves an info string it does not recognise in the block', () => {
    expect(answerParts('```js title=foo\ncode\n```')).toEqual([
      { code: true, text: 'js title=foo\ncode\n' },
    ]);
    expect(answerParts('```c++\nint x;\n```')).toEqual([{ code: true, text: 'c++\nint x;\n' }]);
  });

  it('drops runs that are only whitespace', () => {
    expect(answerParts('   \n')).toEqual([]);
  });
});

describe('the order the runtime publishes sessions in', () => {
  const speaks = (text: string) =>
    new ProviderTransport(new ScriptedProvider(() => [{ type: 'text' as const, text }]));

  /**
   * The failure this prevents: the answers panel listing oldest-first, so the
   * answer you just waited for arrives below every one you have already read.
   *
   * The panel renders `agents.sessions` in published order and has no sort of
   * its own, so "newest at the top" is this contract and nothing else —
   * `AgentRuntime.start` prepending to `#live`, and `#publish` mapping in that
   * order. Nothing asserted it, and a walk against a real model found the
   * panel reversing a list that was already newest-first. This is the fact the
   * panel now depends on, pinned at the only level this repo can test it.
   */
  it('hands them over newest-first', async () => {
    const { runtime } = await setup();

    const older = runtime.start(speaks('the older answer'), 'asked first', { expects: 'prose' });
    await settle(older);
    const newer = runtime.start(speaks('the newer answer'), 'asked second', { expects: 'prose' });
    await settle(newer);

    const published = runtime.sessions.get();
    expect(published.map((entry) => entry.id)).toEqual([newer.id, older.id]);
    // Asserted by instruction as well as id, so a future change that reuses or
    // reorders ids cannot make this pass while the reading order is wrong.
    expect(published.map((entry) => entry.instruction)).toEqual(['asked second', 'asked first']);
  });
});

describe('a prose session that produces no answer', () => {
  /**
   * The failure this prevents: the answers panel showing "Working…" forever.
   *
   * `answer === null` is not only the state of a session still working — it is
   * also the resting state of one that finished and said nothing, which is
   * reachable two ways today. The Ollama prose branch deliberately yields
   * nothing when the model returns only whitespace (`tests/ollama.test.ts`,
   * `yields nothing at all when the model returns only whitespace`), and an
   * out-of-process agent that ignores `expects` never sends a `session.note`.
   * The panel branches on the *status* because of this test; without the
   * status settling to something terminal, it would have nothing to branch on.
   */
  it('settles to done with a null answer rather than staying running', async () => {
    const { runtime } = await setup();
    const silent = new ProviderTransport(new ScriptedProvider(() => []));

    const session = runtime.start(silent, 'explain this', { expects: 'prose' });
    await settle(session);

    const snapshot = runtime.sessions.get().find((entry) => entry.id === session.id);
    expect(snapshot?.status).toBe('done');
    expect(snapshot?.answer).toBeNull();
    // The distinction the panel rests on: this is not a failure, so it must
    // not be rendered as one either.
    expect(snapshot?.status).not.toBe('failed');
  });
});

describe('a malformed session.note in a prose session', () => {
  /**
   * The failure this prevents: one bad argument killing the whole session.
   *
   * The prose interception reads `params.text` *outside* `#handle`'s
   * try/catch, and `parseInbound` validates only `id` and `method` — see the
   * comment on `parseBaseRevisions` in `protocol.ts`, which states the rule
   * this broke: "A malformed declaration is a well-formed request carrying a
   * bad argument: the agent should be told, in a response it can read… One
   * mistake, one behaviour." A `session.note` with no `params` threw a
   * TypeError out through `StdioTransport.run`, which has no catch, and
   * failed the session — while the identical message in a *non*-prose session
   * was answered cleanly and the agent carried on.
   */
  it('is answered rather than fatal, and the session still finishes', async () => {
    const { runtime } = await setup();
    const replies: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      // No `params` at all, which is what another process can actually send.
      replies.push(yield { type: 'action', request: { method: 'session.note' } } as never);
      // Reached only if the request above did not kill the run: the agent
      // gets to carry on, which is the whole point of answering rather than
      // throwing.
      replies.push(yield {
        type: 'action',
        request: { method: 'session.note', params: { text: 'and now a real answer' } },
      } as never);
    });

    const session = runtime.start(new ProviderTransport(provider), 'explain this', {
      expects: 'prose',
    });
    await settle(session);

    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({ ok: false });
    expect(replies[1]).toMatchObject({ ok: true });

    const snapshot = runtime.sessions.get().find((entry) => entry.id === session.id);
    expect(snapshot?.status).not.toBe('failed');
    // The good note still landed, so the bad one cost the agent nothing but
    // the one refusal it was told about.
    expect(snapshot?.answer).toBe('and now a real answer');
  });
});

describe('what a refused prose session leaves behind', () => {
  /**
   * The failure this prevents: a session that holds nothing at all.
   *
   * An out-of-process agent that ignores `expects` has every request refused,
   * and the refusal returned without recording anything — so the audit trail
   * held only the echoed instruction, and the one thing that could explain the
   * empty answer was the one thing written down nowhere. Every other refusal
   * in `#handle` records; this one now does too, which is also what makes
   * CHANGELOG's "nothing except those refusals" true rather than optimistic.
   */
  it('records the refusal in the trail, not only in the reply', async () => {
    const { runtime, a } = await setup();
    const provider = new ScriptedProvider(async function* () {
      yield {
        type: 'action',
        request: { method: 'context.bufferText', params: { bufferId: a } },
      } as never;
    });

    const session = runtime.start(new ProviderTransport(provider), 'explain this', {
      expects: 'prose',
    });
    await settle(session);

    const snapshot = runtime.sessions.get().find((entry) => entry.id === session.id);
    const errors = snapshot!.actions.filter((action) => action.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: expect.stringContaining('cannot read') });
  });
});

describe('a malformed session.summary', () => {
  /**
   * The failure this prevents: the twin of the `session.note` bug above, on
   * the sibling method, in *any* session rather than only a prose one.
   *
   * `#handle` answers a malformed `session.summary` cleanly — its own
   * try/catch turns the TypeError into an `internal` failure. But the block
   * that mirrors the summary into the session ran afterwards on method name
   * alone, re-reading `params.text` outside any try/catch, so the throw
   * escaped through `StdioTransport.run` and killed the run that `#handle`
   * had just handled.
   */
  it('is answered rather than fatal, and the session still finishes', async () => {
    const { runtime } = await setup();
    const replies: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      // No `params` at all, which is what another process can actually send.
      replies.push(yield { type: 'action', request: { method: 'session.summary' } } as never);
      // Reached only if the request above did not kill the run.
      replies.push(yield {
        type: 'action',
        request: { method: 'session.summary', params: { text: 'done properly' } },
      } as never);
    });

    const session = runtime.start(new ProviderTransport(provider), 'do a thing');
    await settle(session);

    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({ ok: false });
    expect(replies[1]).toMatchObject({ ok: true });
    expect(session.status.get()).not.toBe('failed');
  });

  /**
   * The failure this prevents: a summary that is not a string reaching a
   * `Signal<string | null>` and then the panel. `#handle` records whatever it
   * is given, so without a check here the two disagree about what a summary
   * is.
   */
  it('leaves the summary unset when the text is not a string', async () => {
    const { runtime } = await setup();
    const provider = new ScriptedProvider(async function* () {
      yield { type: 'action', request: { method: 'session.summary', params: { text: 42 } } } as never;
    });

    const session = runtime.start(new ProviderTransport(provider), 'do a thing');
    await settle(session);

    expect(session.summary.get()).toBeNull();
  });
});
