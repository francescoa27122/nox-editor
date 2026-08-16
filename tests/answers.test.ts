import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import {
  ProviderTransport,
  AgentRuntime,
  answerFreshness,
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
