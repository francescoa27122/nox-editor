import { describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { DEFAULT_POLICY, type Principal, type PromptAnswer } from '../src/services/permissions';

/**
 * Standing permissions: what the user has granted that is still in force, and
 * taking it back without taking back the work.
 *
 * The defect these guard is not "grants were invisible" — it is that
 * `forgetSession` had exactly one caller, `AgentRuntime.undoSession`, so the
 * only way to stop an agent writing was to revert everything it had written.
 * A user who wanted to keep the edits and close the door had no move.
 *
 * See AGENT-PLATFORM.md §2.6.
 */

const AGENT: Principal = { kind: 'agent', sessionId: 'agent-1', label: 'Test agent' };
const OTHER: Principal = { kind: 'agent', sessionId: 'agent-2', label: 'Other agent' };

/**
 * A real app over a fake disk, answering its own permission prompts.
 *
 * `NoxApp` installs `#askPermission` as the prompter, which reaches for a
 * confirm dialog nobody is here to answer; overriding it is what lets this run
 * in Node with no DOM. The default policy is flattened to `prompt` so every
 * capability under test reaches the prompter rather than being decided by a
 * rule the test did not write.
 */
async function appAnswering(answer: PromptAnswer = 'allow-session') {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/a.txt', 'one\ntwo\n');

  const app = new NoxApp(platform);
  await app.workspace.openFolder('/w');

  const prompter = vi.fn(async (): Promise<PromptAnswer> => answer);
  app.permissions.setPrompter(prompter);
  app.permissions.setDefaultPolicy({ fallback: 'prompt', rules: {} });

  return { app, platform, prompter };
}

describe('the standing-grant ledger', () => {
  it('lists a permission the user chose to keep', async () => {
    const { app } = await appAnswering('allow-session');

    await app.permissions.check({
      principal: AGENT,
      capability: 'fs.write',
      resource: '/w/a.txt',
    });

    expect(app.permissions.grants.get()).toEqual([
      expect.objectContaining({ capability: 'fs.write', resource: '/w/a.txt' }),
    ]);
  });

  /**
   * "Allow once" is answered about one question and expires with it. Listing
   * it beside a session grant would offer the user a revoke button for
   * something that is already gone.
   */
  it('lists nothing for an allow-once', async () => {
    const { app } = await appAnswering('allow-once');

    expect(
      await app.permissions.check({
        principal: AGENT,
        capability: 'fs.write',
        resource: '/w/a.txt',
      }),
    ).toBe(true);
    expect(app.permissions.grants.get()).toEqual([]);
  });

  /**
   * §2.6's distinction, made a test. A policy `allow` is a rule, not something
   * the user granted; putting it in a list headed "you granted this, take it
   * back" would teach them something false about what they authorised — and
   * revoking it would not work, because there is no grant to remove.
   */
  it('does not mistake a policy allow for a grant', async () => {
    const { app, prompter } = await appAnswering('allow-session');
    app.permissions.setPolicy(AGENT, { fallback: 'deny', rules: { 'fs.read': 'allow' } });

    expect(
      await app.permissions.check({
        principal: AGENT,
        capability: 'fs.read',
        resource: '/w/a.txt',
      }),
    ).toBe(true);

    expect(prompter).not.toHaveBeenCalled();
    expect(app.permissions.decisions.get().at(-1)?.source).toBe('policy');
    expect(app.permissions.grants.get()).toEqual([]);
  });

  /** Grants are path-scoped, so the ledger has to say which path. */
  it('keeps one row per resource rather than one per capability', async () => {
    const { app } = await appAnswering('allow-session');

    await app.permissions.check({ principal: AGENT, capability: 'fs.write', resource: '/w/a.txt' });
    await app.permissions.check({ principal: AGENT, capability: 'fs.write', resource: '/w/b.txt' });

    expect(app.permissions.grants.get().map((grant) => grant.resource)).toEqual([
      '/w/a.txt',
      '/w/b.txt',
    ]);
  });
});

describe('revoking a standing permission', () => {
  /**
   * The fail-then-pass. On main this failed twice over: `permissions.grants`
   * did not exist, and `execute('permissions.revokeGrants')` returned false
   * for an unknown id — `grep -rn "'permissions\." src/` matched nothing, and
   * `forgetSession`'s only caller was `undoSession`.
   */
  it('stands until the command runs, and is gone after it', async () => {
    const { app, prompter } = await appAnswering('allow-session');
    const request = { principal: AGENT, capability: 'fs.write' as const, resource: '/w/a.txt' };

    await app.permissions.check(request);
    expect(app.permissions.grants.get()).toHaveLength(1);

    // Standing means standing: a second ask is answered from memory, not by
    // the user. This is the half that already worked and must keep working.
    expect(await app.permissions.check(request)).toBe(true);
    expect(prompter).toHaveBeenCalledTimes(1);
    expect(app.permissions.decisions.get().at(-1)?.source).toBe('remembered');

    expect(await app.commands.execute('permissions.revokeGrants')).toBe(true);

    expect(app.permissions.grants.get()).toEqual([]);
    // And the door is actually shut, not merely delisted.
    await app.permissions.check(request);
    expect(prompter).toHaveBeenCalledTimes(2);
  });

  it('revokes one session without touching another', async () => {
    const { app } = await appAnswering('allow-session');

    await app.permissions.check({ principal: AGENT, capability: 'fs.write', resource: '/w/a.txt' });
    await app.permissions.check({ principal: OTHER, capability: 'fs.write', resource: '/w/a.txt' });
    expect(app.permissions.grants.get()).toHaveLength(2);

    await app.commands.execute('permissions.revokeSessionGrants', AGENT.sessionId);

    expect(app.permissions.grants.get().map((grant) => grant.principal)).toEqual([OTHER]);
  });

  /**
   * The whole reason the command exists. Revoking is not undoing: the user who
   * wants to keep the edits and close the door must be able to have both, or
   * the only revocation path stays welded to `undoSession` and they are back
   * to choosing.
   */
  it('leaves everything the agent already wrote in place', async () => {
    const { app } = await appAnswering('allow-session');
    const id = (await app.workspace.open('/w/a.txt'))!;

    await app.permissions.check({ principal: AGENT, capability: 'fs.write', resource: '/w/a.txt' });
    const applied = app.workspace.apply({
      description: 'Shout the first line',
      author: AGENT,
      edits: [{ bufferId: id, changes: { from: 0, to: 3, insert: 'ONE' } }],
    });
    expect(applied.ok).toBe(true);
    expect(app.workspace.textOf(id)).toBe('ONE\ntwo\n');

    await app.commands.execute('permissions.revokeSessionGrants', AGENT.sessionId);

    expect(app.permissions.grants.get()).toEqual([]);
    expect(app.workspace.textOf(id)).toBe('ONE\ntwo\n');
    // Still in the log, so `undoSession` can still take it back later. Revoking
    // must not quietly cost the user their undo.
    expect(app.workspace.log.bySession(AGENT.sessionId)).toHaveLength(1);
  });

  /**
   * A revoke that reports "revoked 3" when it revoked none is the same class
   * of lie the undo button was already careful about (`AgentPanel.undo`).
   */
  it('reports what it actually removed', async () => {
    const { app } = await appAnswering('allow-session');

    await app.permissions.check({ principal: AGENT, capability: 'fs.write', resource: '/w/a.txt' });
    await app.permissions.check({ principal: AGENT, capability: 'net.request' });

    expect(app.permissions.forgetSession(AGENT).map((grant) => grant.capability)).toEqual([
      'fs.write',
      'net.request',
    ]);
    expect(app.permissions.forgetSession(AGENT)).toEqual([]);
  });

  /**
   * Both commands are gated, and by the mechanism this repo says gates things:
   * the `capabilities` declaration on the command, not a check inside the
   * handler. Asserting the declaration and the refusal separately is the point
   * — a handler-side check would pass the second half and fail the first, and
   * it is the first that the dispatcher actually enforces.
   */
  it('is a capability an agent cannot help itself to', async () => {
    const { app, prompter } = await appAnswering('allow-session');

    for (const id of ['permissions.revokeGrants', 'permissions.revokeSessionGrants']) {
      const command = app.commands.all().find((entry) => entry.id === id);
      expect(command?.capabilities).toEqual(['permissions.revoke']);
    }

    await app.permissions.check({ principal: AGENT, capability: 'fs.write', resource: '/w/a.txt' });

    // Back to the policy Nox actually ships, which denies rather than prompts:
    // a dialog asking whether an agent may edit the record of what the user
    // agreed to is not a question worth putting to them.
    app.permissions.setDefaultPolicy(DEFAULT_POLICY);
    await expect(
      app.commands.execute('permissions.revokeGrants', undefined, { principal: AGENT }),
    ).rejects.toThrow(/not allowed to permissions\.revoke/);

    expect(prompter).toHaveBeenCalledTimes(1);
    // Refused, so the grant it tried to clear is still standing.
    expect(app.permissions.grants.get()).toHaveLength(1);
  });
});
