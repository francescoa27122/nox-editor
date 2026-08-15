import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { AgentRuntime, ProviderTransport, type AgentSession } from '../src/services/agent/runtime';
import type { ModelChunk } from '../src/services/agent/provider';
import { ScriptedProvider } from '../src/services/agent/provider';
import { CommandRegistry } from '../src/services/commands';
import { ContextService, type BufferSummary, type SelectionInfo } from '../src/services/context';
import { FileTreeService } from '../src/services/filetree';
import { JobRunner } from '../src/services/jobs';
import { PermissionService, type Policy } from '../src/services/permissions';
import { ReviewService } from '../src/services/review';
import { WorkspaceService } from '../src/services/workspace';

/**
 * The runtime, driven by a scripted provider.
 *
 * Every layer underneath is real: the context API, the command dispatcher, the
 * permission model, staging and review, the transaction log. Only the model is
 * substituted, which is exactly the seam `ModelProvider` exists to give.
 */

const A = 'one\ntwo\nthree\nfour\nfive\n';
const B = 'alpha\nbeta\ngamma\n';

const policy = (rules: Policy['rules'], fallback: Policy['fallback'] = 'deny'): Policy => ({
  fallback,
  rules,
});

async function setup() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/a.txt', A);
  platform.seedFile('/w/b.txt', B);

  const workspace = new WorkspaceService(platform, () => history());
  const files = new FileTreeService(platform);
  const context = new ContextService(workspace, files);
  const commands = new CommandRegistry();
  const permissions = new PermissionService(() => workspace.rootPath.get());
  const review = new ReviewService(workspace);
  const jobs = new JobRunner();

  commands.setGuard(async (command, principal, resource) => {
    for (const capability of command.capabilities ?? []) {
      await permissions.require({ principal, capability, ...(resource ? { resource } : {}) });
    }
  });

  const runtime = new AgentRuntime({ workspace, context, commands, permissions, review, jobs });

  await workspace.openFolder('/w');
  await files.setRoot('/w');
  await files.buildIndex();
  const a = (await workspace.open('/w/a.txt'))!;
  const b = (await workspace.open('/w/b.txt'))!;

  return { workspace, context, commands, permissions, review, jobs, runtime, a, b };
}

/** Wait for a session to leave `running`. */
async function settle(session: AgentSession, budgetMs = 10_000) {
  // A deadline, not a loop count. Counting iterations of `setTimeout(1)` makes
  // the real budget whatever timer resolution the machine has spare, which on
  // a loaded one is a different number than on an idle one — and a test that
  // fails under load is a test nobody trusts.
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (session.status.get() !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`session stuck in "${session.status.get()}" after ${budgetMs}ms`);
}

const scripted = (chunks: ModelChunk[]) => new ProviderTransport(new ScriptedProvider(() => chunks));

describe('a session', () => {
  it('reads context, proposes, and stops to wait for a human', async () => {
    const { runtime, review, workspace, a } = await setup();

    const session = runtime.start(
      scripted([
        { type: 'text', text: 'Looking at the open files' },
        { type: 'action', request: { method: 'context.openBuffers' } },
        { type: 'action', request: { method: 'context.bufferText', params: { bufferId: a } } },
        {
          type: 'action',
          request: {
            method: 'proposal.stage',
            params: {
              description: 'Shout the first line',
              edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
            },
          },
        },
        { type: 'action', request: { method: 'session.summary', params: { text: 'Proposed 1 change' } } },
      ]),
      'Shout at the first line',
      { label: 'Test agent' },
    );

    await settle(session);

    // Staged, not applied: the buffer has not moved and the session says so.
    expect(session.status.get()).toBe('awaiting-review');
    expect(session.summary.get()).toBe('Proposed 1 change');
    expect(workspace.textOf(a)).toBe(A);
    expect(review.staged.get()).not.toBeNull();
  });

  it('records what it read, ran and proposed', async () => {
    const { runtime, a } = await setup();

    const session = runtime.start(
      scripted([
        { type: 'text', text: 'Checking' },
        { type: 'action', request: { method: 'context.openBuffers' } },
        {
          type: 'action',
          request: {
            method: 'proposal.stage',
            params: {
              description: 'Shout',
              edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
            },
          },
        },
      ]),
      'Shout',
    );
    await settle(session);

    expect(session.actions.get().map((action) => action.kind)).toEqual([
      'instruction',
      'note',
      'read',
      'proposal',
    ]);
  });

  it('cannot reach a side effect except through a command', async () => {
    const { runtime, permissions, workspace, commands, a } = await setup();
    let saved = 0;
    commands.register({
      id: 'file.save',
      title: 'Save',
      capabilities: ['fs.write'],
      run: () => {
        saved++;
      },
    });
    permissions.setDefaultPolicy(policy({ 'fs.write': 'deny' }));

    const session = runtime.start(
      scripted([
        { type: 'action', request: { method: 'command.execute', params: { commandId: 'file.save' } } },
      ]),
      'Save the file',
    );
    await settle(session);

    expect(saved).toBe(0);
    expect(workspace.textOf(a)).toBe(A);
    // A refusal is recorded, not swallowed: an audit has to be able to show
    // what an agent tried as well as what it managed.
    expect(session.actions.get().at(-1)).toMatchObject({ kind: 'command', granted: false });
  });

  it('runs a command it is permitted to run', async () => {
    const { runtime, permissions, commands } = await setup();
    let saved = 0;
    commands.register({
      id: 'file.save',
      title: 'Save',
      capabilities: ['fs.write'],
      run: () => {
        saved++;
      },
    });
    permissions.setDefaultPolicy(policy({ 'fs.write': 'allow' }));

    const session = runtime.start(
      scripted([
        { type: 'action', request: { method: 'command.execute', params: { commandId: 'file.save' } } },
      ]),
      'Save the file',
    );
    await settle(session);

    expect(saved).toBe(1);
    expect(session.actions.get().at(-1)).toMatchObject({ kind: 'command', granted: true });
  });

  it('can build an edit out of what it read', async () => {
    const { runtime, review, workspace, a } = await setup();

    // The whole point of the context API: read, *then* decide. A one-way
    // stream would make the agent emit every action blind, and it could never
    // see the contents of the file it asked for.
    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const buffers = yield { type: 'action', request: { method: 'context.openBuffers' } };
          const summaries = (buffers?.ok ? buffers.result : []) as { id: string; name: string }[];
          const target = summaries.find((buffer) => buffer.name === 'a.txt')!;

          const text = yield {
            type: 'action',
            request: { method: 'context.bufferText', params: { bufferId: target.id, lines: { from: 1, to: 1 } } },
          };
          const firstLine = (text?.ok ? text.result : '') as string;

          yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: `Uppercase "${firstLine}"`,
                edits: [
                  {
                    bufferId: target.id,
                    changes: { from: 0, to: firstLine.length, insert: firstLine.toUpperCase() },
                  },
                ],
              },
            },
          };
        }),
      ),
      'Uppercase the first line',
    );
    await settle(session);

    expect(review.staged.get()?.description).toBe('Uppercase "one"');
    expect(review.apply().ok).toBe(true);
    expect(workspace.textOf(a)).toBe('ONE\ntwo\nthree\nfour\nfive\n');
  });

  it('can be cancelled mid-flight', async () => {
    const { runtime, review } = await setup();

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          yield { type: 'text', text: 'thinking' };
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          yield { type: 'text', text: 'never arrives' };
        }),
      ),
      'Take your time',
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    session.cancel();
    await settle(session);

    expect(session.status.get()).toBe('cancelled');
    expect(review.staged.get()).toBeNull();
  });

  it('shuts the agent down when the run finishes', async () => {
    const { runtime } = await setup();
    let disposed = 0;

    const session = runtime.start(
      {
        id: 'counts-disposal',
        connect: async () => ({ version: 1, label: 'Tidy' }),
        run: async () => {},
        dispose: () => {
          disposed++;
        },
      },
      'Do nothing much',
    );
    await settle(session);

    // An agent is a process. Disposing only on cancel left one running per
    // completed session, for as long as the editor stayed open.
    expect(disposed).toBe(1);
  });

  it('shuts the agent down when the run fails', async () => {
    const { runtime } = await setup();
    let disposed = 0;

    const session = runtime.start(
      {
        id: 'explodes',
        connect: async () => ({ version: 1, label: 'Boom' }),
        run: async () => {
          throw new Error('crashed mid-run');
        },
        dispose: () => {
          disposed++;
        },
      },
      'Fall over',
    );
    await settle(session);

    expect(session.status.get()).toBe('failed');
    expect(disposed).toBe(1);
  });

  it('refuses an agent speaking a different protocol version', async () => {
    const { runtime } = await setup();
    const session = runtime.start(
      {
        id: 'from-the-future',
        connect: async () => ({ version: 99, label: 'Future agent' }),
        run: async () => {},
      },
      'Hello',
    );
    await settle(session);

    expect(session.status.get()).toBe('failed');
    expect(session.actions.get().at(-1)).toMatchObject({ kind: 'error' });
  });
});

describe('the milestone, end to end', () => {
  /** Five hunks across two files: three in a.txt, two in b.txt. */
  function fiveHunks(a: string, b: string) {
    return scripted([
      { type: 'text', text: 'Uppercasing some lines' },
      { type: 'action', request: { method: 'context.openBuffers' } },
      {
        type: 'action',
        request: {
          method: 'proposal.stage',
          params: {
            description: 'Uppercase some lines',
            edits: [
              { bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } },
              { bufferId: a, changes: { from: 8, to: 13, insert: 'THREE' } },
              { bufferId: a, changes: { from: 19, to: 23, insert: 'FIVE' } },
              { bufferId: b, changes: { from: 0, to: 5, insert: 'ALPHA' } },
              { bufferId: b, changes: { from: 11, to: 16, insert: 'GAMMA' } },
            ],
          },
        },
      },
      { type: 'action', request: { method: 'session.summary', params: { text: 'Five changes proposed' } } },
    ]);
  }

  it('proposes five hunks, three are accepted, and one button reverts it all', async () => {
    const { runtime, review, workspace, a, b } = await setup();

    const session = runtime.start(fiveHunks(a, b), 'Uppercase some lines', { label: 'Test agent' });
    await settle(session);

    const staged = review.staged.get()!;
    const hunks = staged.files.flatMap((file) => file.hunks);
    expect(hunks).toHaveLength(5);

    // Reject two of the five.
    review.toggleHunk(a, staged.files[0]!.hunks[1]!.id);
    review.toggleHunk(b, staged.files[1]!.hunks[1]!.id);
    expect(review.acceptedCount()).toEqual({ hunks: 3, files: 2, total: 5 });

    expect(review.apply().ok).toBe(true);
    expect(workspace.textOf(a)).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
    expect(workspace.textOf(b)).toBe('ALPHA\nbeta\ngamma\n');

    // One button. Everything the session did, gone.
    const outcome = runtime.undoSession(session.id);
    expect(outcome.skipped).toEqual([]);
    expect(workspace.textOf(a)).toBe(A);
    expect(workspace.textOf(b)).toBe(B);
  });

  it('counts the change in the session snapshot once the user applies it', async () => {
    const { runtime, review, a, b } = await setup();
    const session = runtime.start(fiveHunks(a, b), 'Uppercase some lines');
    await settle(session);

    expect(runtime.sessions.get()[0]!.changes).toBe(0);
    review.apply();

    // Applying is the *user's* action, not a session event. Without watching
    // the log the panel would never offer to undo what it just helped land.
    expect(runtime.sessions.get()[0]!.changes).toBe(1);
  });

  it('reports nothing left to take back when undone twice', async () => {
    const { runtime, review, workspace, a, b } = await setup();
    const session = runtime.start(fiveHunks(a, b), 'Uppercase some lines');
    await settle(session);
    review.apply();

    expect(runtime.undoSession(session.id).undone).toHaveLength(2);

    // The log records what happened and undoing does not erase it, so the
    // affordance survives. A second press has to be distinguishable from a
    // first one, which is what the empty `undone` says.
    const again = runtime.undoSession(session.id);
    expect(again.undone).toEqual([]);
    expect(again.skipped.length).toBeGreaterThan(0);
    expect(workspace.textOf(a)).toBe(A);
  });

  it('attributes the applied change to the session that proposed it', async () => {
    const { runtime, review, workspace, a, b } = await setup();
    const session = runtime.start(fiveHunks(a, b), 'Uppercase some lines');
    await settle(session);
    review.apply();

    expect(runtime.changesBy(session.id)).toHaveLength(1);
    expect(workspace.log.recent(1)[0]!.author).toEqual({
      kind: 'agent',
      sessionId: session.id,
      label: session.label,
    });
  });
});

describe('two agents at once', () => {
  it('lets the second one land when they touch different files', async () => {
    const { runtime, review, workspace, a, b } = await setup();

    const first = runtime.start(
      scripted([
        {
          type: 'action',
          request: {
            method: 'proposal.stage',
            params: {
              description: 'First',
              edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
            },
          },
        },
      ]),
      'Edit a',
    );
    await settle(first);
    expect(review.apply().ok).toBe(true);

    const second = runtime.start(
      scripted([
        {
          type: 'action',
          request: {
            method: 'proposal.stage',
            params: {
              description: 'Second',
              edits: [{ bufferId: b, changes: { from: 0, to: 5, insert: 'ALPHA' } }],
            },
          },
        },
      ]),
      'Edit b',
    );
    await settle(second);
    expect(review.apply().ok).toBe(true);

    expect(workspace.textOf(a)).toBe('ONE\ntwo\nthree\nfour\nfive\n');
    expect(workspace.textOf(b)).toBe('ALPHA\nbeta\ngamma\n');
  });

  it('rejects the one working from a revision that has moved', async () => {
    const { runtime, review, workspace, a } = await setup();

    const stale = runtime.start(
      scripted([
        {
          type: 'action',
          request: {
            method: 'proposal.stage',
            params: {
              description: 'Stale',
              edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
            },
          },
        },
      ]),
      'Edit a',
    );
    await settle(stale);

    // Someone else — the user, or another agent — changes the same buffer
    // while this proposal is sitting in review.
    workspace.applyTransaction(
      a,
      workspace.stateOf(a)!.update({ changes: { from: 0, insert: '// theirs\n' } }),
    );

    // Rejected on the stale base revision, which is the conflict rule: not a
    // lock that would block typing, not a queue that would hide the staleness.
    expect(review.apply()).toEqual({ ok: false, reason: 'stale', buffers: [a] });
    expect(workspace.textOf(a)).toBe(`// theirs\n${A}`);
  });
});

describe('what a session says about itself afterwards', () => {
  const oneEdit = (bufferId: string) =>
    scripted([
      {
        type: 'action',
        request: {
          method: 'proposal.stage',
          params: {
            description: 'Shout',
            edits: [{ bufferId, changes: { from: 0, to: 3, insert: 'ONE' } }],
          },
        },
      },
    ]);

  it('waits for a human while the proposal is unresolved', async () => {
    const { runtime, a } = await setup();
    const session = runtime.start(oneEdit(a), 'Shout');
    await settle(session);

    expect(session.status.get()).toBe('awaiting-review');
  });

  it('says applied once the user keeps it', async () => {
    const { runtime, review, a } = await setup();
    const session = runtime.start(oneEdit(a), 'Shout');
    await settle(session);

    review.apply();

    // "Awaiting review" stopped being true the moment they clicked.
    expect(session.status.get()).toBe('applied');
    expect(runtime.sessions.get()[0]!.status).toBe('applied');
  });

  it('says dismissed when the user throws it away', async () => {
    const { runtime, review, a } = await setup();
    const session = runtime.start(oneEdit(a), 'Shout');
    await settle(session);

    review.discard();

    expect(session.status.get()).toBe('dismissed');
  });

  it('counts rejecting every hunk as dismissed, not applied', async () => {
    const { runtime, review, workspace, a } = await setup();
    const session = runtime.start(oneEdit(a), 'Shout');
    await settle(session);

    review.setAllAccepted(false);
    review.apply();

    expect(session.status.get()).toBe('dismissed');
    expect(workspace.textOf(a)).toBe(A);
  });

  it('stays applied after the change is undone', async () => {
    const { runtime, review, a } = await setup();
    const session = runtime.start(oneEdit(a), 'Shout');
    await settle(session);
    review.apply();

    runtime.undoSession(session.id);

    // The log records what happened, and it did happen. Undoing is a later
    // event, not a rewrite of the session's history.
    expect(session.status.get()).toBe('applied');
  });

  it('leaves a session that proposed nothing as done', async () => {
    const { runtime } = await setup();
    const session = runtime.start(scripted([{ type: 'text', text: 'nothing to do' }]), 'Look');
    await settle(session);

    expect(session.status.get()).toBe('done');
  });
});

describe('an agent that read only part of a buffer', () => {
  /**
   * The guard added with the stale-read fix records a revision only for a
   * plain *whole* read, so a range read left no entry and the stage skipped
   * the check entirely. That is the shape `examples/uppercase-agent.mjs`
   * ships in: read line 1, compute offsets from 0, stage.
   *
   * Prevents: a user keystroke between the read and the stage silently
   * rewriting the wrong span, which is the same corruption the whole-read
   * guard exists to refuse.
   */
  it('is refused when the buffer moved after its range read', async () => {
    const { runtime, workspace, review, a } = await setup();

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const text = yield {
            type: 'action',
            request: {
              method: 'context.bufferText',
              params: { bufferId: a, lines: { from: 1, to: 1 } },
            },
          };
          const firstLine = (text?.ok ? text.result : '') as string;

          // The user types while the agent is deciding.
          workspace.applyEdits(a, [{ from: 0, to: 0, insert: '// header\n' }]);

          yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Uppercase the first line',
                edits: [
                  { bufferId: a, changes: { from: 0, to: firstLine.length, insert: firstLine.toUpperCase() } },
                ],
              },
            },
          };
        }),
      ),
      'uppercase line one',
    );
    await settle(session);

    expect(review.staged.get()).toBeNull();
    expect(session.actions.get().some((entry) => entry.kind === 'error')).toBe(true);
  });

  /**
   * The inversion the whole-read guard's comment warns about: a later narrow
   * read must not re-bless offsets computed against text that has since
   * moved. A range read may establish a baseline, never raise one.
   *
   * Prevents: whole-read at r5, user types, range-read at r6, stage against
   * the r5 text sailing through because the entry caught up.
   */
  it('does not let a later range read re-bless an older whole read', async () => {
    const { runtime, workspace, review, a } = await setup();

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const whole = yield {
            type: 'action',
            request: { method: 'context.bufferText', params: { bufferId: a } },
          };
          const original = (whole?.ok ? whole.result : '') as string;

          workspace.applyEdits(a, [{ from: 0, to: 0, insert: '// header\n' }]);

          // A narrow read after the change: it sees new text, but the offsets
          // below were computed from `original`.
          yield {
            type: 'action',
            request: {
              method: 'context.bufferText',
              params: { bufferId: a, lines: { from: 1, to: 1 } },
            },
          };

          yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Rewrite from stale offsets',
                edits: [{ bufferId: a, changes: { from: 0, to: original.length, insert: 'REPLACED' } }],
              },
            },
          };
        }),
      ),
      'rewrite',
    );
    await settle(session);

    expect(review.staged.get()).toBeNull();
    expect(session.actions.get().some((entry) => entry.kind === 'error')).toBe(true);
  });
});

describe('an agent that read a selection', () => {
  /** Put a range under the user's cursor. Selection alone does not move the revision. */
  const select = (
    workspace: Awaited<ReturnType<typeof setup>>['workspace'],
    id: string,
    anchor: number,
    head: number,
  ) =>
    workspace.applyTransaction(id, workspace.stateOf(id)!.update({ selection: { anchor, head } }));

  /**
   * `context.selection` hands back real document offsets and the text at
   * them — everything needed to compute an edit — but recorded no baseline,
   * so a session that read only the selection skipped the check entirely.
   * That is the most natural shape of "uppercase my selection".
   *
   * Prevents: a user keystroke between the selection read and the stage
   * writing `ONEheader` over a `// header` the agent never saw.
   */
  it('is refused when the buffer moved after its selection read', async () => {
    const { runtime, workspace, review, a } = await setup();
    select(workspace, a, 0, 3);

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const read = yield {
            type: 'action',
            request: { method: 'context.selection', params: { bufferId: a } },
          };
          const info = (read?.ok ? read.result : null) as SelectionInfo;
          const main = info.ranges[info.main]!;

          // The user types above the selection while the agent is deciding.
          workspace.applyEdits(a, [{ from: 0, to: 0, insert: '// header\n' }]);

          yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Uppercase the selection',
                edits: [
                  {
                    bufferId: a,
                    changes: { from: main.from, to: main.to, insert: main.text.toUpperCase() },
                  },
                ],
              },
            },
          };
        }),
      ),
      'uppercase my selection',
    );
    await settle(session);

    expect(review.staged.get()).toBeNull();
    expect(session.actions.get().some((entry) => entry.kind === 'error')).toBe(true);
    expect(workspace.textOf(a)).toBe(`// header\n${A}`);
  });

  /**
   * The same asymmetry a range read keeps: a selection read shows where the
   * cursor is, not that the offsets about to be staged came from the current
   * text.
   *
   * Prevents: whole read at r5, user types, selection read at r6, stage
   * against the r5 text sailing through because the entry caught up.
   */
  it('does not let a later selection read re-bless an older whole read', async () => {
    const { runtime, workspace, review, a } = await setup();
    select(workspace, a, 0, 3);

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const whole = yield {
            type: 'action',
            request: { method: 'context.bufferText', params: { bufferId: a } },
          };
          const original = (whole?.ok ? whole.result : '') as string;

          workspace.applyEdits(a, [{ from: 0, to: 0, insert: '// header\n' }]);

          yield {
            type: 'action',
            request: { method: 'context.selection', params: { bufferId: a } },
          };

          yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Rewrite from stale offsets',
                edits: [
                  { bufferId: a, changes: { from: 0, to: original.length, insert: 'REPLACED' } },
                ],
              },
            },
          };
        }),
      ),
      'rewrite',
    );
    await settle(session);

    expect(review.staged.get()).toBeNull();
    expect(session.actions.get().some((entry) => entry.kind === 'error')).toBe(true);
  });
});

describe('reads that locate no text', () => {
  /**
   * A buffer summary, a scroll position, a path tree and a change-set list
   * say nothing about where any text sits, so none of them establishes a
   * baseline. Listing the buffers is how most sessions open, and a baseline a
   * narrow read may not raise would then refuse the honest sequence below.
   *
   * Prevents: widening the guard to every `context.*` method and turning the
   * ordinary list → user types → read the range → stage into a refusal.
   *
   * Also pins what `BufferSummary.revision` is: something to compare across
   * reads, not a base revision anything checks. The listing reports one, the
   * buffer moves past it, and the stage lands anyway — `proposal.stage` has
   * no field to pass it back through.
   */
  it('lets a range read after a listing still stage', async () => {
    const { runtime, workspace, context, review, a } = await setup();
    context.setViewportProvider(() => ({ from: 1, to: 3 }));
    let listed = -1;

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const buffers = yield { type: 'action', request: { method: 'context.openBuffers' } };
          const summaries = (buffers?.ok ? buffers.result : []) as BufferSummary[];
          listed = summaries.find((buffer) => buffer.id === a)!.revision;
          yield {
            type: 'action',
            request: { method: 'context.viewport', params: { bufferId: a } },
          };

          // The user types after the listing but before the read the agent
          // actually computes from.
          workspace.applyEdits(a, [{ from: 0, to: 0, insert: '// header\n' }]);

          const read = yield {
            type: 'action',
            request: {
              method: 'context.bufferText',
              params: { bufferId: a, lines: { from: 1, to: 1 } },
            },
          };
          const firstLine = (read?.ok ? read.result : '') as string;

          yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Uppercase the first line',
                edits: [
                  {
                    bufferId: a,
                    changes: { from: 0, to: firstLine.length, insert: firstLine.toUpperCase() },
                  },
                ],
              },
            },
          };
        }),
      ),
      'uppercase line one',
    );
    await settle(session);

    expect(listed).not.toBe(workspace.revisionOf(a));
    expect(review.staged.get()).not.toBeNull();
    expect(session.actions.get().some((entry) => entry.kind === 'error')).toBe(false);
  });
});

describe('the stale refusal', () => {
  /**
   * The message used to say "read it again", which for the range-reading
   * agent this guard newly refuses is not a recovery: re-reading the same
   * narrow way leaves the baseline untouched and the next stage is refused
   * again. Only a plain whole read refreshes it.
   *
   * Prevents: an agent looping on the advice it was given.
   */
  it('names a re-read that clears it, and that re-read clears it', async () => {
    const { runtime, workspace, review, a } = await setup();
    const refusals: string[] = [];

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const first = yield {
            type: 'action',
            request: {
              method: 'context.bufferText',
              params: { bufferId: a, lines: { from: 1, to: 1 } },
            },
          };
          const stale = (first?.ok ? first.result : '') as string;

          workspace.applyEdits(a, [{ from: 0, to: 0, insert: '// header\n' }]);

          const refused = yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Uppercase the first line',
                edits: [
                  {
                    bufferId: a,
                    changes: { from: 0, to: stale.length, insert: stale.toUpperCase() },
                  },
                ],
              },
            },
          };
          if (refused && !refused.ok) refusals.push(refused.error.message);

          // Do exactly what the message says.
          const again = yield {
            type: 'action',
            request: { method: 'context.bufferText', params: { bufferId: a } },
          };
          const fresh = (again?.ok ? again.result : '') as string;
          const firstLine = fresh.slice(0, fresh.indexOf('\n'));

          yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Uppercase the first line',
                edits: [
                  {
                    bufferId: a,
                    changes: { from: 0, to: firstLine.length, insert: firstLine.toUpperCase() },
                  },
                ],
              },
            },
          };
        }),
      ),
      'uppercase line one',
    );
    await settle(session);

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('context.bufferText');
    expect(refusals[0]).toContain('no other params');
    // The advice works: the whole read cleared it and the second stage landed.
    expect(review.staged.get()).not.toBeNull();
    expect(session.status.get()).toBe('awaiting-review');
  });
});

describe('what the runtime counts as a plain whole read', () => {
  /**
   * The reader resolves the range with `?.from ?? 1` / `?.to ?? doc.lines`
   * and clamps it, so a span past the end returns the whole document while
   * the runtime's `lines === undefined` test filed it as narrow. The two
   * disagreeing means a read that genuinely handed over the current text
   * could not refresh the baseline it had established.
   *
   * Prevents: an agent that always sends an over-wide range being refused
   * forever after the first user keystroke.
   */
  it('refreshes the baseline for a range that spans the document', async () => {
    const { runtime, workspace, review, a } = await setup();

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          yield {
            type: 'action',
            request: {
              method: 'context.bufferText',
              params: { bufferId: a, lines: { from: 1, to: 1000 } },
            },
          };

          workspace.applyEdits(a, [{ from: 0, to: 0, insert: '// header\n' }]);

          const again = yield {
            type: 'action',
            request: {
              method: 'context.bufferText',
              params: { bufferId: a, lines: { from: 1, to: 1000 } },
            },
          };
          const fresh = (again?.ok ? again.result : '') as string;
          const firstLine = fresh.slice(0, fresh.indexOf('\n'));

          yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Uppercase the first line',
                edits: [
                  {
                    bufferId: a,
                    changes: { from: 0, to: firstLine.length, insert: firstLine.toUpperCase() },
                  },
                ],
              },
            },
          };
        }),
      ),
      'uppercase line one',
    );
    await settle(session);

    expect(review.staged.get()).not.toBeNull();
    expect(session.actions.get().some((entry) => entry.kind === 'error')).toBe(false);
  });

  /**
   * `parseInbound` validates only `id` and `method`, so an out-of-process
   * agent can send `lines: null` — which the reader answers with the whole
   * document and the runtime's `=== undefined` test called narrow.
   *
   * Prevents: the same permanent refusal, reached from a JSON encoder that
   * writes an absent field as null.
   */
  it('refreshes the baseline when lines is null', async () => {
    const { runtime, workspace, review, a } = await setup();
    const nulled = { bufferId: a, lines: null as unknown as { from: number; to: number } };

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          yield { type: 'action', request: { method: 'context.bufferText', params: nulled } };

          workspace.applyEdits(a, [{ from: 0, to: 0, insert: '// header\n' }]);

          const again = yield {
            type: 'action',
            request: { method: 'context.bufferText', params: nulled },
          };
          const fresh = (again?.ok ? again.result : '') as string;
          const firstLine = fresh.slice(0, fresh.indexOf('\n'));

          yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Uppercase the first line',
                edits: [
                  {
                    bufferId: a,
                    changes: { from: 0, to: firstLine.length, insert: firstLine.toUpperCase() },
                  },
                ],
              },
            },
          };
        }),
      ),
      'uppercase line one',
    );
    await settle(session);

    expect(review.staged.get()).not.toBeNull();
    expect(session.actions.get().some((entry) => entry.kind === 'error')).toBe(false);
  });
});
