import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import {
  AgentRuntime,
  ProviderTransport,
  scopeFromSelection,
  type AgentSession,
} from '../src/services/agent/runtime';
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

/** Any non-user principal: the brief's reads are logged against whoever asked. */
const PRINCIPAL = { kind: 'agent', sessionId: 's-brief', label: 'Test agent' } as const;

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

  return { workspace, context, commands, permissions, review, jobs, runtime, a, b, platform };
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

describe('a declared base revision', () => {
  /** The summary `context.openBuffers` reported for one buffer. */
  const listed = (summaries: BufferSummary[], id: string) =>
    summaries.find((buffer) => buffer.id === id)!;

  /**
   * The honest case: the agent says what it computed against and it is still
   * true. A declaration must not cost a working agent its stage.
   *
   * Prevents: a check that refuses whenever the field is present, or one that
   * compares the wrong way round — either of which turns opting into the
   * guarantee into never being able to stage.
   */
  it('stages when the declared revision is the buffer’s current one', async () => {
    const { runtime, review, a } = await setup();

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const buffers = yield { type: 'action', request: { method: 'context.openBuffers' } };
          const summary = listed((buffers?.ok ? buffers.result : []) as BufferSummary[], a);

          yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Shout the first line',
                edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
                baseRevisions: { [a]: summary.revision },
              },
            },
          };
        }),
      ),
      'shout at line one',
    );
    await settle(session);

    expect(review.staged.get()).not.toBeNull();
    expect(session.actions.get().some((entry) => entry.kind === 'error')).toBe(false);
  });

  /**
   * `-0` is not a shape worth refusing: `-0 === 0` in JavaScript, so a
   * declaration of `-0` for a buffer at revision 0 is not claiming anything
   * false. Tightening finding 3's validation to a non-negative integer must
   * not catch it — `Number.isSafeInteger(-0)` is `true` and `-0 >= 0` is
   * `true`, so it stays accepted.
   *
   * Prevents: a `revision > 0` (rather than `>= 0`) boundary, or a `Object.is`
   * check, either of which would refuse the one negative-looking value that
   * is not actually a lie.
   */
  it('stages a declaration of -0 against a buffer at revision 0', async () => {
    const { runtime, review, a } = await setup();

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Shout the first line',
                edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
                baseRevisions: { [a]: -0 },
              },
            },
          };
        }),
      ),
      'shout at line one',
    );
    await settle(session);

    expect(review.staged.get()).not.toBeNull();
    expect(session.actions.get().some((entry) => entry.kind === 'error')).toBe(false);
  });

  /**
   * The declaration is the whole point: an agent that says which revision its
   * offsets came from is refused when the buffer is no longer at it, under the
   * same `stale` code `workspace.apply` already uses for the same mismatch.
   *
   * Prevents: a field that is accepted and then ignored, which is worse than
   * no field at all — the agent believes it is covered.
   */
  it('refuses a declaration behind the buffer’s current revision', async () => {
    const { runtime, workspace, review, a } = await setup();
    const refusals: { code: string; message: string }[] = [];

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const buffers = yield { type: 'action', request: { method: 'context.openBuffers' } };
          const summary = listed((buffers?.ok ? buffers.result : []) as BufferSummary[], a);

          // The user types while the agent is deciding.
          workspace.applyEdits(a, [{ from: 0, to: 0, insert: '// header\n' }]);

          const response = yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Shout the first line',
                edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
                baseRevisions: { [a]: summary.revision },
              },
            },
          };
          if (response && !response.ok) refusals.push(response.error);
        }),
      ),
      'shout at line one',
    );
    await settle(session);

    expect(review.staged.get()).toBeNull();
    expect(refusals.map((refusal) => refusal.code)).toEqual(['stale']);
    expect(workspace.textOf(a)).toBe(`// header\n${A}`);
  });

  /**
   * `workspace.revisionOf` answers `-1` for a buffer it does not have, and
   * before this fix the mismatch check compared that sentinel directly
   * against whatever the agent declared, so `-1 !== -1` was false and
   * `{ 'no-such-buffer': -1 }` passed — while every other revision for the
   * same missing buffer was correctly refused `stale`. `workspace.apply`
   * already treats an unknown buffer as `missing` regardless of the declared
   * revision (`workspace.ts:958-961`); this refuses it here too, under
   * `not-found`, the code this runtime already uses for "no such buffer"
   * (`context.bufferText`'s unknown-buffer case) since `ErrorCode` has no
   * `missing` of its own to borrow.
   *
   * Prevents: a declaration naming a buffer that was never open, or has
   * since been closed, sailing through because `-1 === -1`.
   */
  it('refuses a declaration naming a buffer that is not open', async () => {
    const { runtime, review, a } = await setup();
    const refusals: { code: string; message: string }[] = [];
    const noSuchBuffer = 'buffer-does-not-exist';

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const response = yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Shout the first line',
                edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
                // A plausible, well-formed revision — not the `-1` sentinel
                // itself. Finding 3's non-negative validation now rejects
                // `-1` on its own before this check ever runs, which closes
                // the reviewer's exact `{ 'no-such-buffer': -1 }` payload as
                // a side effect; this pins the general bug that remains for
                // any declared revision naming a buffer that isn't open.
                baseRevisions: { [noSuchBuffer]: 0 },
              },
            },
          };
          if (response && !response.ok) refusals.push(response.error);
        }),
      ),
      'shout at line one',
    );
    await settle(session);

    expect(review.staged.get()).toBeNull();
    expect(refusals.map((refusal) => refusal.code)).toEqual(['not-found']);
    expect(refusals[0]?.message).toContain(noSuchBuffer);
  });

  /**
   * `Array.prototype.find` hands back the found *element*, not a found/absent
   * flag — the caller has to test the result itself, and here the element is
   * the buffer id. For every other id that reads as truthy, so `if
   * (declaredMissing)` works; for the empty string it does not, because `''`
   * is falsy. A declaration keyed `{"": 0}` for a buffer that was never open
   * would find `''`, read `if ('')` as "nothing missing", and fall straight
   * through into the revision-mismatch check below — which compares against
   * `workspace.revisionOf('')`'s `-1` sentinel and refuses `stale`, naming no
   * buffer and putting `-1` in an agent-facing message instead.
   *
   * Prevents: the one buffer id namely `''` — falsy, unlike every other
   * string — bypassing the not-open check the rest of this map is refused by.
   */
  it('refuses a declaration keyed by the empty string for a buffer that is not open', async () => {
    const { runtime, review, a } = await setup();
    const refusals: { code: string; message: string }[] = [];

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const response = yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Shout the first line',
                edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
                baseRevisions: { '': 0 },
              },
            },
          };
          if (response && !response.ok) refusals.push(response.error);
        }),
      ),
      'shout at line one',
    );
    await settle(session);

    expect(review.staged.get()).toBeNull();
    expect(refusals.map((refusal) => refusal.code)).toEqual(['not-found']);
  });

  /**
   * Hole 1, measured on 9882d92: `BufferSummary.length` is the
   * end-of-document offset, so a session that lists a buffer and appends at
   * that length stages against a position the user may have moved — and
   * `context.openBuffers` establishes no read baseline, so nothing refused it.
   * The append landed in the middle of the line the user had just typed.
   *
   * Prevents: that splice, for any agent willing to say what it listed.
   */
  it('refuses an append staged at a length the listing reported', async () => {
    const { runtime, workspace, review, a } = await setup();
    const refusals: { code: string; message: string }[] = [];

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const buffers = yield { type: 'action', request: { method: 'context.openBuffers' } };
          const summary = listed((buffers?.ok ? buffers.result : []) as BufferSummary[], a);

          // The user types at the end of the document, past where the listing
          // said it finished.
          workspace.applyEdits(a, [{ from: summary.length, to: summary.length, insert: 'six' }]);

          const response = yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Add a footer',
                edits: [
                  {
                    bufferId: a,
                    changes: { from: summary.length, to: summary.length, insert: '// footer\n' },
                  },
                ],
                baseRevisions: { [a]: summary.revision },
              },
            },
          };
          if (response && !response.ok) refusals.push(response.error);
        }),
      ),
      'add a footer',
    );
    await settle(session);

    expect(review.staged.get()).toBeNull();
    expect(refusals.map((refusal) => refusal.code)).toEqual(['stale']);
    // The user's own line is intact rather than having a footer spliced into it.
    expect(workspace.textOf(a)).toBe(`${A}six`);
  });

  /**
   * Hole 2: refresh trusts the agent to stage from its most recent read. A
   * session that reads, lets the buffer move, reads again and then stages
   * offsets from the *first* read clears the read guard, because the baseline
   * caught up with the buffer. Only the agent knows which read it computed
   * from, and now it can say.
   *
   * Prevents: a whole re-read laundering offsets computed before the user
   * typed.
   */
  it('refuses offsets declared against the first of two reads', async () => {
    const { runtime, workspace, review, a } = await setup();
    const refusals: { code: string; message: string }[] = [];

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const buffers = yield { type: 'action', request: { method: 'context.openBuffers' } };
          const before = listed((buffers?.ok ? buffers.result : []) as BufferSummary[], a).revision;

          const whole = yield {
            type: 'action',
            request: { method: 'context.bufferText', params: { bufferId: a } },
          };
          const original = (whole?.ok ? whole.result : '') as string;

          workspace.applyEdits(a, [{ from: 0, to: 0, insert: '// header\n' }]);

          // A second whole read refreshes the baseline to the current
          // revision, so the read guard has nothing left to refuse.
          yield {
            type: 'action',
            request: { method: 'context.bufferText', params: { bufferId: a } },
          };

          const response = yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Rewrite from the first read',
                edits: [
                  { bufferId: a, changes: { from: 0, to: original.length, insert: 'REPLACED' } },
                ],
                baseRevisions: { [a]: before },
              },
            },
          };
          if (response && !response.ok) refusals.push(response.error);
        }),
      ),
      'rewrite',
    );
    await settle(session);

    expect(review.staged.get()).toBeNull();
    expect(refusals.map((refusal) => refusal.code)).toEqual(['stale']);
  });

  /**
   * The case the brief left open, decided the way `workspace.apply` already
   * decided it: a declared entry is checked whether or not an edit names that
   * buffer. `apply`'s stale filter runs over every `baseRevisions` entry
   * regardless of the edits, and giving the identically named, identically
   * shaped field a second meaning one layer up would mean the agent and the
   * runtime disagreed about what a key means. It is also the safe direction —
   * a declaration can only ever add a refusal — and it is the only reading
   * that keeps a real promise: an agent that read `b.txt`, concluded from it
   * that `b.txt` needs no edit, and edited `a.txt` instead has a conclusion
   * that is stale the moment `b.txt` moves.
   *
   * Prevents: filtering the declaration down to the edited buffers, which
   * would silently drop exactly the entries an agent added on purpose.
   */
  it('refuses a declaration for a buffer the edits do not touch', async () => {
    const { runtime, workspace, review, a, b } = await setup();
    const refusals: { code: string; message: string }[] = [];

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const buffers = yield { type: 'action', request: { method: 'context.openBuffers' } };
          const summaries = (buffers?.ok ? buffers.result : []) as BufferSummary[];
          const both = {
            [a]: listed(summaries, a).revision,
            [b]: listed(summaries, b).revision,
          };

          // The user types in the file the agent read but decided not to edit.
          workspace.applyEdits(b, [{ from: 0, to: 0, insert: '// header\n' }]);

          const response = yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Shout the first line of a.txt',
                edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
                baseRevisions: both,
              },
            },
          };
          if (response && !response.ok) refusals.push(response.error);
        }),
      ),
      'shout at line one',
    );
    await settle(session);

    expect(review.staged.get()).toBeNull();
    expect(refusals.map((refusal) => refusal.code)).toEqual(['stale']);
    // Named in the refusal, so the agent knows which of the two moved.
    expect(refusals[0]?.message).toContain('b.txt');
  });

  /**
   * The declaration is checked *in addition to* the read guard, never instead
   * of it. An agent that reads at r5, lets the buffer reach r6 and then
   * declares r6 while staging offsets from the r5 text is describing a check
   * it did not do.
   *
   * Prevents: treating a present declaration as proof of freshness and
   * skipping the guard that tracks what the session actually read.
   */
  it('still refuses a stale read when the declaration is current', async () => {
    const { runtime, workspace, review, a } = await setup();
    const refusals: { code: string; message: string }[] = [];

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const whole = yield {
            type: 'action',
            request: { method: 'context.bufferText', params: { bufferId: a } },
          };
          const original = (whole?.ok ? whole.result : '') as string;

          workspace.applyEdits(a, [{ from: 0, to: 0, insert: '// header\n' }]);

          // A listing is not a read, so this hands back the current revision
          // without refreshing the baseline the whole read established.
          const buffers = yield { type: 'action', request: { method: 'context.openBuffers' } };
          const current = listed((buffers?.ok ? buffers.result : []) as BufferSummary[], a).revision;

          const response = yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Rewrite from the first read',
                edits: [
                  { bufferId: a, changes: { from: 0, to: original.length, insert: 'REPLACED' } },
                ],
                baseRevisions: { [a]: current },
              },
            },
          };
          if (response && !response.ok) refusals.push(response.error);
        }),
      ),
      'rewrite',
    );
    await settle(session);

    expect(review.staged.get()).toBeNull();
    expect(refusals.map((refusal) => refusal.code)).toEqual(['stale']);
    // The read guard's own advice, not the declaration check's.
    expect(refusals[0]?.message).toContain('context.bufferText');
  });

  /**
   * The reviewer's loop: list, let the buffer move, stage stale offsets
   * declaring the listed revision, get refused, then re-list and declare the
   * *fresh* revision while sending the *same* stale offsets. The old message
   * — "Read it again and declare the revision you computed the offsets
   * against" — reads as "look up a fresher number", which is exactly what
   * that loop does, and it staged the corruption back in.
   *
   * This pins the honest reading of the corrected message: recompute the
   * offsets against the buffer's current text (a real `context.bufferText`
   * read), then declare the revision that read came back at. That must
   * actually succeed — a message whose advice does not work is worse than no
   * message.
   *
   * Prevents: advice that reads as "refresh the number" and reopens the hole
   * a declaration exists to close.
   */
  it('stages once the agent recomputes offsets against current text before declaring', async () => {
    const { runtime, workspace, review, a } = await setup();
    const refusals: { code: string; message: string }[] = [];

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const buffers = yield { type: 'action', request: { method: 'context.openBuffers' } };
          const summary = listed((buffers?.ok ? buffers.result : []) as BufferSummary[], a);

          // The user types at the end of the document, past where the
          // listing said it finished.
          workspace.applyEdits(a, [{ from: summary.length, to: summary.length, insert: 'six' }]);

          // The naive move: stage against the listed length, declaring the
          // listed revision. Refused, which is what triggers the advice this
          // test is about.
          const first = yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Add a footer',
                edits: [
                  {
                    bufferId: a,
                    changes: { from: summary.length, to: summary.length, insert: '// footer\n' },
                  },
                ],
                baseRevisions: { [a]: summary.revision },
              },
            },
          };
          if (first && !first.ok) refusals.push(first.error);

          // The honest reading of the advice: a whole read, to recompute
          // offsets against the text as it now stands, not a re-list to
          // fetch a fresher number for the offsets already in hand.
          const whole = yield {
            type: 'action',
            request: { method: 'context.bufferText', params: { bufferId: a } },
          };
          const current = (whole?.ok ? whole.result : '') as string;

          const response = yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Add a footer',
                edits: [
                  {
                    bufferId: a,
                    changes: { from: current.length, to: current.length, insert: '// footer\n' },
                  },
                ],
                baseRevisions: { [a]: workspace.revisionOf(a) },
              },
            },
          };
          if (response && !response.ok) refusals.push(response.error);
        }),
      ),
      'add a footer',
    );
    await settle(session);

    expect(refusals.map((refusal) => refusal.code)).toEqual(['stale']);
    expect(review.staged.get()).not.toBeNull();
  });

  /**
   * The old wording — "Read it again and declare the revision you computed
   * the offsets against" — reads as "go fetch a fresher number", which is
   * the reviewer's loop from the test above. Pins that the replacement talks
   * about recomputing offsets against current text rather than just
   * rereading for a number.
   *
   * Prevents: regressing the wording back to something that invites the
   * fresh-number-stale-offsets loop.
   */
  it('tells the agent to recompute offsets, not just reread for a fresher number', async () => {
    const { runtime, workspace, review, a } = await setup();
    const refusals: { code: string; message: string }[] = [];

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const buffers = yield { type: 'action', request: { method: 'context.openBuffers' } };
          const summary = listed((buffers?.ok ? buffers.result : []) as BufferSummary[], a);

          workspace.applyEdits(a, [{ from: 0, to: 0, insert: '// header\n' }]);

          const response = yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Shout the first line',
                edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
                baseRevisions: { [a]: summary.revision },
              },
            },
          };
          if (response && !response.ok) refusals.push(response.error);
        }),
      ),
      'shout at line one',
    );
    await settle(session);

    expect(review.staged.get()).toBeNull();
    expect(refusals.map((refusal) => refusal.code)).toEqual(['stale']);
    expect(refusals[0]?.message).toContain('recompute');
    expect(refusals[0]?.message).not.toContain('Read it again');
  });

  /**
   * The guarantee is opt-in. Every shipped agent — the reference agent, every
   * provider, everything in `tests/stdio.test.ts` — stages without this field,
   * and a required declaration would break all of them at once.
   *
   * Pins that an absent declaration leaves hole 1 exactly where it was:
   * listed, moved, appended at the listed length, staged. The runtime has
   * nothing to check and does not pretend otherwise.
   *
   * Prevents: making the field mandatory, or inferring a declaration from a
   * listing, either of which turns an opt-in guarantee into a silent refusal
   * for agents that never asked for one.
   */
  it('stages without a declaration exactly as it did before', async () => {
    const { runtime, workspace, review, a } = await setup();

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const buffers = yield { type: 'action', request: { method: 'context.openBuffers' } };
          const summary = listed((buffers?.ok ? buffers.result : []) as BufferSummary[], a);

          workspace.applyEdits(a, [{ from: summary.length, to: summary.length, insert: 'six' }]);

          yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Add a footer',
                edits: [
                  {
                    bufferId: a,
                    changes: { from: summary.length, to: summary.length, insert: '// footer\n' },
                  },
                ],
              },
            },
          };
        }),
      ),
      'add a footer',
    );
    await settle(session);

    expect(review.staged.get()).not.toBeNull();
    expect(session.actions.get().some((entry) => entry.kind === 'error')).toBe(false);
  });
});

describe('a malformed base-revision declaration', () => {
  /**
   * Stage one edit against a buffer nothing has touched, declaring whatever is
   * passed. Nothing has moved, so the only thing that can refuse is validation.
   */
  const stageDeclaring = async (declaration: unknown) => {
    const { runtime, review, a } = await setup();
    const refusals: { code: string; message: string }[] = [];

    const session = runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const response = yield {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Shout the first line',
                edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
                baseRevisions: declaration as Record<string, number>,
              },
            },
          };
          if (response && !response.ok) refusals.push(response.error);
        }),
      ),
      'shout at line one',
    );
    await settle(session);

    return { refusals, staged: review.staged.get() };
  };

  /**
   * Every one of these refuses rather than staging anyway, and that is the
   * decision worth stating: an agent that sent a declaration believes it is
   * protected. Ignoring a malformed one and staging hands it a guarantee it
   * does not have, which is more dangerous than never having offered the
   * field. `parseInbound` validates only `id` and `method`, so an
   * out-of-process agent can put any of these on the wire.
   *
   * Prevents: a permissive parse — `Number(value)`, or skipping entries it
   * cannot read — quietly turning a declaration into no declaration.
   */
  const malformed: [name: string, value: unknown][] = [
    // A JSON array is an object to `typeof`, and `Object.entries` would read
    // it happily, with numeric string keys that are not buffer ids.
    ['an array', []],
    ['a string', 'revision 3'],
    ['a number', 3],
    // Not read as "no declaration": `lines: null` degrading to a wider read
    // costs nothing, but a null declaration read as absent silently drops the
    // whole promise the agent thinks it asked for.
    ['null', null],
    ['a string revision', { 'buffer-1': '3' }],
    ['a null revision', { 'buffer-1': null }],
    ['NaN', { 'buffer-1': Number.NaN }],
    ['Infinity', { 'buffer-1': Number.POSITIVE_INFINITY }],
    // Finite but still impossible: a revision is a counter that starts at 0
    // and only ever increases by whole numbers, so none of these can ever
    // equal one. Accepting them at the door — as the old `Number.isFinite`
    // check did — would only turn the declaration into a permanent,
    // unexplained `stale` refusal at the next step, which is the exact
    // failure `NaN`/`Infinity` are already refused to avoid.
    ['a negative revision', { 'buffer-1': -7 }],
    ['a fractional revision', { 'buffer-1': 3.5 }],
    ['a revision too large to represent safely', { 'buffer-1': 1e308 }],
    ['a revision at the edge of safe-integer range', { 'buffer-1': 2 ** 53 }],
    // A nested object and an explicit `undefined` both reach `shown()`'s
    // fallback branch — the two shapes that produced "not a undefined" and
    // "not a object" before the article fix, covered precisely below.
    ['an object revision', { 'buffer-1': {} }],
    ['an undefined revision', { 'buffer-1': undefined }],
  ];

  for (const [name, value] of malformed) {
    it(`refuses ${name}`, async () => {
      const { refusals, staged } = await stageDeclaring(value);

      expect(staged).toBeNull();
      expect(refusals.map((refusal) => refusal.code)).toEqual(['invalid-request']);
      expect(refusals[0]?.message).toContain('baseRevisions');
    });
  }

  /**
   * `shown()`'s fallback used to read `a ${typeof value}` for every type it
   * did not special-case, which is correct for "a boolean" or "a function"
   * but wrong for "undefined" and "object" — a wire-visible audit string
   * should not say "not a undefined" or "not a object". Pins both cases the
   * reviewer measured, by name rather than by the generic `toContain
   * ('baseRevisions')` assertion the shared loop above uses.
   *
   * Prevents: regressing to the bare `a ${typeof value}` fallback for these
   * two types.
   */
  it('describes an undefined revision without a wrong article', async () => {
    const { refusals, staged } = await stageDeclaring({ 'buffer-1': undefined });

    expect(staged).toBeNull();
    expect(refusals.map((refusal) => refusal.code)).toEqual(['invalid-request']);
    expect(refusals[0]?.message).not.toContain('a undefined');
  });

  it('describes an object revision without a wrong article', async () => {
    const { refusals, staged } = await stageDeclaring({ 'buffer-1': {} });

    expect(staged).toBeNull();
    expect(refusals.map((refusal) => refusal.code)).toEqual(['invalid-request']);
    expect(refusals[0]?.message).not.toContain('a object');
    expect(refusals[0]?.message).toContain('an object');
  });
});

describe('the brief', () => {
  // A model told only "a.txt, 5 lines" cannot act on "make this shorter" —
  // the selection is the whole subject of a selection-scoped edit.
  it('names the selected range and quotes its text', async () => {
    const { runtime, workspace, a } = await setup();
    // setup() opens b.txt after a.txt, which leaves b.txt active — brief()
    // reports the selection of whichever file is active, so make it a.txt.
    workspace.setActive(a);
    workspace.setSelection(a, { ranges: [[4, 13]], main: 0 });

    const brief = runtime.brief(PRINCIPAL);
    expect(brief).toContain(`Selected in a.txt [${a}], lines 2–3:`);
    expect(brief).toContain('two\nthree');
  });

  // Measured against qwen2.5-coder:7b: shown "shapes.js" with no id, it called
  // context.bufferText with the file name as bufferId, got "Buffer shapes.js
  // not found." eleven times, and hit the turn cap without staging anything.
  // The selection is the one line most likely to be acted on immediately, so
  // it above all must carry an id the model can actually call back with.
  it('carries the buffer id of the buffer the selection is in', async () => {
    const { runtime, workspace, a } = await setup();
    workspace.setActive(a);
    workspace.setSelection(a, { ranges: [[4, 13]], main: 0 });

    expect(runtime.brief(PRINCIPAL)).toContain(`[${a}]`);
  });

  // A bare cursor is not a selection. Quoting the empty string would tell the
  // model it had been given something when it had not.
  it('says nothing about a selection when the cursor is empty', async () => {
    const { runtime, workspace, a } = await setup();
    // Same as above: without this, the assertion below checks b.txt's
    // (always-empty) selection, and the setSelection call is dead code.
    workspace.setActive(a);
    workspace.setSelection(a, { ranges: [[4, 4]], main: 0 });

    expect(runtime.brief(PRINCIPAL)).not.toContain('Selected in');
  });

  // Nothing else in this file asserts brief()'s literal content, so a change
  // to the string an ordinary session opens with — the common case, since
  // most sessions start with no selection — could regress unnoticed.
  it('produces exactly this brief for a session with no selection', async () => {
    const { runtime, workspace, a, b } = await setup();
    workspace.setActive(a);

    expect(runtime.brief(PRINCIPAL)).toBe(
      `Open files: a.txt [${a}], b.txt [${b}]\nActive file: a.txt [${a}] (Plain Text, 6 lines)`,
    );
  });

  // The active-file line is what most instructions act against ("update the
  // comment on line 1"), so it must carry an id on its own — a model must not
  // have to cross-reference the "Open files" line to find it.
  it("carries the active file's buffer id", async () => {
    const { runtime, workspace, a } = await setup();
    workspace.setActive(a);

    expect(runtime.brief(PRINCIPAL)).toContain(`Active file: a.txt [${a}]`);
  });

  // Silent truncation lets a model answer as though it had the whole
  // selection, and be confidently wrong about the part it never saw.
  it('truncates a selection past the cap and says that it did', async () => {
    const { runtime, workspace, platform } = await setup();
    platform.seedFile('/w/big.txt', 'x\n'.repeat(500));
    const id = (await workspace.open('/w/big.txt'))!;
    workspace.setSelection(id, { ranges: [[0, 1000]], main: 0 });

    const brief = runtime.brief(PRINCIPAL);
    expect(brief).toContain('truncated');
    expect(brief.split('\n').length).toBeLessThan(260);
  });

  // Multi-range semantics are out of scope; sending every range would let the
  // model edit somewhere the primary cursor never was.
  it('carries only the primary range when several are selected', async () => {
    const { runtime, workspace, a } = await setup();
    // Same as above: a.txt must be made active for brief() to report its selection.
    workspace.setActive(a);
    workspace.setSelection(a, { ranges: [[0, 3], [4, 13]], main: 1 });

    const brief = runtime.brief(PRINCIPAL);
    expect(brief).toContain('two\nthree');
    expect(brief).not.toContain(`Selected in a.txt [${a}], lines 1–1`);
  });
});

describe('the workspace boundary on reads', () => {
  /**
   * Open a file from outside the project, selected and active.
   *
   * The state the boundary exists for: Nox opens anything you point it at, so
   * a `.env` or a credentials file can be the active tab when an agent starts
   * on an instruction that has nothing to do with it.
   */
  async function withOutsideFile(fixture: Awaited<ReturnType<typeof setup>>) {
    fixture.platform.seedFile('/elsewhere/.env', 'API_KEY=hunter2\n');
    const id = (await fixture.workspace.open('/elsewhere/.env'))!;
    fixture.workspace.setActive(id);
    fixture.workspace.setSelection(id, { ranges: [[0, 15]], main: 0 });
    return id;
  }

  it('refuses a read outside the root and shows the refusal on the trail', async () => {
    const fixture = await setup();
    const outside = await withOutsideFile(fixture);
    const refusals: { code: string; message: string }[] = [];

    const session = fixture.runtime.start(
      new ProviderTransport(
        new ScriptedProvider(async function* () {
          const response = yield {
            type: 'action',
            request: { method: 'context.bufferText', params: { bufferId: outside } },
          };
          if (response && !response.ok) refusals.push(response.error);
        }),
      ),
      'read the env file',
    );
    await settle(session);

    // `permission-denied` and not `not-found`: the buffer is open and the
    // answer is that this agent may not have it. `not-found` would invite an
    // agent to go looking for another id for the same file.
    expect(refusals.map((refusal) => refusal.code)).toEqual(['permission-denied']);
    // On the trail, so the Agents panel shows the attempt. `ContextReader`
    // answers `null`, which an agent reads as an empty file; without this row
    // the only record of the refusal would be the message the agent got.
    expect(
      session.actions.get().filter((action) => action.kind === 'read' && action.refused === true),
    ).toHaveLength(1);
  });

  it('keeps a selection from outside the root out of the brief', async () => {
    const fixture = await setup();
    await withOutsideFile(fixture);

    const brief = fixture.runtime.brief(PRINCIPAL);
    expect(brief).not.toContain('hunter2');
    expect(brief).not.toContain('.env');
    // The brief is built from the reader's listing, so an out-of-root file
    // leaves it entirely rather than appearing with its text withheld. With
    // the active file gone there is no active line and no selection to quote.
    expect(brief).toBe(`Open files: a.txt [${fixture.a}], b.txt [${fixture.b}]`);
  });
});

describe('a scoped session', () => {
  // The conversion nobody notices until it is wrong: context.selection counts
  // lines from 1 for humans, Hunk.fromLine counts from 0.
  it('converts a 1-based selection into a 0-based scope', async () => {
    const { workspace, context, a } = await setup();
    workspace.setSelection(a, { ranges: [[4, 13]], main: 0 });

    expect(scopeFromSelection(a, context.selection(a))).toEqual({
      bufferId: a,
      fromLine: 1,
      toLine: 2,
    });
  });

  // A bare cursor scopes nothing; returning a zero-width scope would default
  // every real hunk to unkept.
  it('answers null for an empty selection', async () => {
    const { workspace, context, a } = await setup();
    workspace.setSelection(a, { ranges: [[4, 4]], main: 0 });

    expect(scopeFromSelection(a, context.selection(a))).toBeNull();
    expect(scopeFromSelection(a, null)).toBeNull();
  });

  // The scope has to survive the whole session, not just the call that made
  // it — a proposal staged three turns later is still scoped.
  it('defaults an out-of-scope hunk to unkept when the session carries a scope', async () => {
    const { runtime, review, a: id } = await setup();
    const chunks: ModelChunk[] = [
      { type: 'action', request: { method: 'proposal.stage', params: {
        description: 'two edits',
        edits: [
          { bufferId: id, changes: { from: 0, to: 3, insert: 'ONE' } },
          { bufferId: id, changes: { from: 19, to: 23, insert: 'FIVE' } },
        ],
      } } },
    ];
    // `scripted` is the file's own helper at tests/agent.test.ts:76 —
    // `ScriptedProvider` takes a Script *function*, not an array.
    const session = runtime.start(scripted(chunks), 'edit it', {
      label: 'Scripted',
      scope: { bufferId: id, fromLine: 0, toLine: 0 },
    });
    await settle(session);

    const hunks = review.staged.get()!.files[0]!.hunks;
    expect(hunks.map((h) => h.accepted)).toEqual([true, false]);
  });
});

describe('what the opening brief hands over', () => {
  // The brief reached ContextService directly, so up to SELECTION_MAX_CHARS of
  // the user's code opened every session without ever landing in `reads` —
  // the log whose stated contract is that no non-user read escapes it.
  it('records its reads against the session principal', async () => {
    const { runtime, workspace, context, a } = await setup();
    workspace.setActive(a);
    workspace.setSelection(a, { ranges: [[4, 13]], main: 0 });

    runtime.brief({ kind: 'agent', sessionId: 's1', label: 'Test agent' });

    const reads = context.reads.get();
    expect(reads.map((read) => read.method)).toEqual(
      expect.arrayContaining(['openBuffers', 'selection']),
    );
    expect(reads.every((read) => read.principal.kind === 'agent')).toBe(true);
  });

  // The panel is where a user looks to see what an agent was given. A brief
  // carrying their selected code and leaving no trace there is the gap this
  // whole change exists to close.
  it('records a brief action naming the buffer whose selection it carried', async () => {
    const { runtime, workspace, a } = await setup();
    workspace.setActive(a);
    workspace.setSelection(a, { ranges: [[4, 13]], main: 0 });

    const session = runtime.start(scripted([]), 'do nothing', { label: 'Scripted' });
    await settle(session);

    const brief = session.actions.get().find((action) => action.kind === 'brief');
    expect(brief).toMatchObject({ kind: 'brief', detail: expect.stringContaining('a.txt') });
  });

  // Recording a brief that carried no selection would add a line to every
  // session for something the model was always told: names and line counts.
  it('records no brief action when there is no selection to carry', async () => {
    const { runtime, workspace, a } = await setup();
    workspace.setActive(a);
    workspace.setSelection(a, { ranges: [[4, 4]], main: 0 });

    const session = runtime.start(scripted([]), 'do nothing', { label: 'Scripted' });
    await settle(session);

    expect(session.actions.get().some((action) => action.kind === 'brief')).toBe(false);
  });
});

describe('the size the brief reports', () => {
  // The detail was built from the raw selection while the brief embeds a
  // clipped copy, so a truncated selection told the audit the model had seen
  // 1000 characters when it had seen 452. A record that overstates what was
  // handed over is the exact failure this action exists to prevent.
  it('reports what it sent, not what it read, when the selection is clipped', async () => {
    const { runtime, workspace, platform } = await setup();
    platform.seedFile('/w/big.txt', 'x\n'.repeat(500));
    const big = (await workspace.open('/w/big.txt'))!;
    workspace.setActive(big);
    workspace.setSelection(big, { ranges: [[0, 1000]], main: 0 });

    const session = runtime.start(scripted([]), 'do nothing', { label: 'Scripted' });
    await settle(session);

    const brief = session.actions.get().find((action) => action.kind === 'brief');
    const reported = Number(/(\d+) characters/.exec((brief as { detail: string }).detail)![1]);
    expect(reported).toBeLessThan(1000);
    expect(runtime.brief(PRINCIPAL)).toContain('truncated');
  });
});
