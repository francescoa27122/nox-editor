// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { ScriptedProvider, type ModelChunk } from '../src/services/agent/provider';
import { ProviderTransport, type AgentSession } from '../src/services/agent/runtime';
import { USER, type Policy } from '../src/services/permissions';

/**
 * A non-user principal may only run a command that declares capabilities.
 *
 * **The bug this exists for (A7-001).** The dispatcher consulted its guard
 * only when `command.capabilities?.length` was truthy, so a command that
 * declared nothing was never checked, for any principal. The declaration is
 * the whole basis of enforcement, and nothing verifies it: there is no way to
 * ask a `run` function whether it reaches the OS. A security review on
 * 2026-08-30 found twelve side-effecting commands declaring nothing and gave
 * them declarations, which fixed the instances and left the class open. The
 * audit that followed reproduced three escapes through it, and the audit's own
 * fixes then added four more undeclared commands that end or hide the window.
 *
 * The rule closes the class: a missing declaration now fails closed. The
 * pinned list in `tests/command-capabilities.test.ts` keeps the set it refuses
 * visible, which is the half a rule cannot do.
 *
 * Built the way the audit's verification reproduced the bug: a real `NoxApp`
 * over `MemoryPlatform`, a deny-all policy, and a prompter that counts. The
 * prompter must never be called, because a refusal for declaring nothing is
 * not a question to put to a human, and a policy `deny` does not ask either.
 *
 * **What this does not catch.** It says nothing about whether a given command
 * *should* declare a capability. That is still unanswerable, and the pinned
 * list is what holds it.
 */

/** Nothing is allowed, and nothing is asked. See `DEFAULT_POLICY` for the shipped one. */
const DENY_ALL: Policy = { fallback: 'deny', rules: {} };

async function settle(session: AgentSession, budgetMs = 10_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (session.status.get() !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`session stuck in "${session.status.get()}" after ${budgetMs}ms`);
}

interface Harness {
  app: NoxApp;
  platform: MemoryPlatform;
  /** How many times a human was asked. Every test here expects zero. */
  prompts: () => number;
  /** Drive one agent session that executes each id in turn. */
  agentRuns: (commandIds: readonly string[]) => Promise<AgentSession>;
}

async function harness(files: Record<string, string> = { '/w/a.txt': 'one\ntwo\nthree\n' }) {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  for (const [path, text] of Object.entries(files)) platform.seedFile(path, text);

  const app = new NoxApp(platform);
  let prompted = 0;
  app.permissions.setDefaultPolicy(DENY_ALL);
  app.permissions.setPrompter(async () => {
    prompted++;
    return 'deny';
  });
  await app.workspace.openFolder('/w');

  const agentRuns = async (commandIds: readonly string[]) => {
    const chunks: ModelChunk[] = commandIds.map((commandId) => ({
      type: 'action',
      request: { method: 'command.execute', params: { commandId } },
    }));
    const session = app.agents.start(
      new ProviderTransport(new ScriptedProvider(() => chunks)),
      'Do the thing',
      { label: 'Test agent' },
    );
    await settle(session);
    return session;
  };

  return { app, platform, prompts: () => prompted, agentRuns } satisfies Harness;
}

/** The `command` entries a session's trail holds, in order. */
function commandTrail(session: AgentSession) {
  return session.actions
    .get()
    .filter((action) => action.kind === 'command')
    .map((action) => ({ commandId: action.commandId, granted: action.granted }));
}

describe('a command that declares no capabilities', () => {
  it('is refused to an agent, and the refusal is recorded', async () => {
    const { app, agentRuns, prompts } = await harness({ '/w/a.txt': 'one\ntwo\nthree\nfour\nfive\n' });
    const a = (await app.workspace.open('/w/a.txt'))!;

    // `review.keepAll` is in the pinned list: it decides about a staged
    // review, which is in memory until `review.apply`, and that one declares
    // `buffer.edit`. Before the rule it ran for an agent with no check, which
    // is how a scoped session could re-tick the out-of-selection hunks the
    // runtime deliberately left unticked (A7-002). The scope here is line one
    // only, so the second hunk is the one that starts unticked.
    app.review.stage(
      {
        description: 'Two changes, one of them outside the selection',
        author: { kind: 'agent', sessionId: 'agent-0', label: 'Test agent' },
        edits: [
          { bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } },
          { bufferId: a, changes: { from: 18, to: 22, insert: 'FIVE' } },
        ],
      },
      { bufferId: a, fromLine: 0, toLine: 0 },
    );
    const hunksBefore = app.review.staged.get()?.files[0]?.hunks ?? [];
    expect(hunksBefore.map((hunk) => hunk.accepted)).toEqual([true, false]);

    const session = await agentRuns(['review.keepAll']);

    // The box the README promises starts unticked is still unticked.
    expect(
      (app.review.staged.get()?.files[0]?.hunks ?? []).map((hunk) => hunk.accepted),
    ).toEqual([true, false]);

    expect(commandTrail(session)).toEqual([{ commandId: 'review.keepAll', granted: false }]);
    expect(prompts()).toBe(0);

    const decision = app.permissions.decisions.get().at(-1);
    expect(decision?.granted).toBe(false);
    // Its own source, so an audit can tell a command that declared nothing
    // apart from one the policy turned down. Before the rule this list was
    // empty: the hole was silent as well as open.
    expect(decision?.source).toBe('undeclared');
    expect(decision?.commandId).toBe('review.keepAll');
    expect(decision?.principal).toMatchObject({ kind: 'agent', sessionId: session.id });
  });

  it('does not end the window for an agent', async () => {
    const { app, platform, agentRuns, prompts } = await harness();
    // `app.quit`, `window.close`, `window.minimize` and `window.toggleMaximize`
    // were added by the audit's own feature work, after the twelve
    // declarations landed. They are the reason the list alone was not enough:
    // each declares nothing, and each ends or hides the window.
    const close = vi.spyOn(platform, 'closeWindow');

    const session = await agentRuns(['app.quit', 'window.close', 'window.minimize']);

    expect(commandTrail(session).every((entry) => !entry.granted)).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(prompts()).toBe(0);
    expect(
      app.permissions.decisions.get().map((decision) => [decision.commandId, decision.source]),
    ).toEqual([
      ['app.quit', 'undeclared'],
      ['window.close', 'undeclared'],
      ['window.minimize', 'undeclared'],
    ]);
  });
});

/**
 * The three escapes the audit reproduced. All three now declare capabilities,
 * so the refusal comes from policy rather than from the rule above, and these
 * assert the effect rather than the source: what matters is that the write,
 * the revert and the reload no longer happen.
 */
describe('the escapes the audit demonstrated', () => {
  it('does not let an agent write a closed file back to disk', async () => {
    const { app, platform, agentRuns, prompts } = await harness({
      '/w/a.txt': 'one\ntwo\nthree\n',
      '/w/b.txt': 'REPLACED\nbeta\n',
    });
    // A project replace has run over a file that is not open, so the journal
    // is the only route back and `search.undoReplace` walks it to disk. The
    // command is enabled precisely because the journal is set.
    app.search.lastReplace.set([
      { path: '/w/b.txt', before: 'alpha\nbeta\n', after: 'REPLACED\nbeta\n', count: 1 },
    ]);

    const session = await agentRuns(['search.undoReplace']);

    expect(commandTrail(session)).toEqual([{ commandId: 'search.undoReplace', granted: false }]);
    expect(await platform.readTextFile('/w/b.txt')).toBe('REPLACED\nbeta\n');
    expect(prompts()).toBe(0);
    expect(app.permissions.decisions.get().at(-1)).toMatchObject({
      capability: 'fs.write',
      granted: false,
      source: 'policy',
    });
  });

  it('does not let one agent revert an edit another session applied', async () => {
    const { app, agentRuns, prompts } = await harness();
    const a = (await app.workspace.open('/w/a.txt'))!;

    // Session A proposes, and the human keeps it. That is the state the
    // second session is about to try to take back.
    const first = app.agents.start(
      new ProviderTransport(
        new ScriptedProvider(() => [
          {
            type: 'action',
            request: {
              method: 'proposal.stage',
              params: {
                description: 'Uppercase line one',
                edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
              },
            },
          },
        ]),
      ),
      'Uppercase line one',
    );
    await settle(first);
    expect(app.applyReview()).toBe(true);
    expect(app.workspace.get(a)?.state.doc.toString()).toBe('ONE\ntwo\nthree\n');

    const second = await agentRuns(['agents.undoLastSession']);

    expect(commandTrail(second)).toEqual([
      { commandId: 'agents.undoLastSession', granted: false },
    ]);
    expect(app.workspace.get(a)?.state.doc.toString()).toBe('ONE\ntwo\nthree\n');
    expect(prompts()).toBe(0);
  });

  it('does not let an agent reload the window and erase the trail', async () => {
    const { app, platform, agentRuns, prompts } = await harness();

    const session = await agentRuns(['view.reloadWindow']);

    expect(commandTrail(session)).toEqual([{ commandId: 'view.reloadWindow', granted: false }]);
    // The flag `MemoryPlatform` sets, rather than the notification: the toast
    // is raised before `dispose()` and would be a weaker claim than the reload
    // itself not happening.
    expect(platform.reloaded).toBe(false);
    expect(prompts()).toBe(0);
    // The trail the reload would have erased is still here, and it now holds
    // the attempt.
    expect(app.permissions.decisions.get().length).toBeGreaterThan(0);
  });
});

describe('a person', () => {
  it('still runs a command that declares nothing', async () => {
    const { app, platform } = await harness();
    const close = vi.spyOn(platform, 'closeWindow');

    // No principal at all is the ordinary case: a menu, a keybinding, a
    // button. `USER` is the explicit form, and the guard is skipped for both.
    expect(await app.commands.execute('view.toggleWordWrap')).toBe(true);
    expect(await app.commands.execute('app.quit', undefined, { principal: USER })).toBe(true);

    expect(app.config.get('editor.wordWrap')).toBe(true);
    expect(close).toHaveBeenCalled();
    // Not even recorded. A log of what the user was allowed to do would bury
    // the entries an audit is looking for.
    expect(app.permissions.decisions.get()).toEqual([]);
  });

  it('still runs a command that declares one, under a deny-all policy', async () => {
    const { app, platform } = await harness();
    const a = (await app.workspace.open('/w/a.txt'))!;
    app.workspace.applyEdits(a, [{ from: 0, to: 0, insert: 'x' }]);

    // `file.save` declares `fs.write`, which `DENY_ALL` denies for anything
    // that is not the user.
    expect(await app.commands.execute('file.save')).toBe(true);
    expect(await platform.readTextFile('/w/a.txt')).toBe('xone\ntwo\nthree\n');
  });
});
