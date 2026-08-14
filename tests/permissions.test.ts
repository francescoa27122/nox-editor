import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry, type Command } from '../src/services/commands';
import {
  PermissionError,
  PermissionService,
  USER,
  type Policy,
  type Principal,
  type PromptAnswer,
} from '../src/services/permissions';

/**
 * The permission layer, tested with a test principal as the only non-user
 * caller — which is the point: the checks are wired in and provably enforced
 * before anything exists that would need them.
 */

const agent: Principal = { kind: 'agent', sessionId: 's1', label: 'Test agent' };
const other: Principal = { kind: 'agent', sessionId: 's2', label: 'Other agent' };

const policy = (rules: Policy['rules'], fallback: Policy['fallback'] = 'deny'): Policy => ({
  fallback,
  rules,
});

/** A permission service that answers its own prompts. */
function withPrompter(answer: PromptAnswer, root: string | null = '/w') {
  const permissions = new PermissionService(() => root);
  const prompter = vi.fn(async () => answer);
  permissions.setPrompter(prompter);
  return { permissions, prompter };
}

describe('policy', () => {
  it('allows what the policy allows', async () => {
    const permissions = new PermissionService();
    permissions.setPolicy(agent, policy({ 'fs.write': 'allow' }));

    expect(await permissions.check({ principal: agent, capability: 'fs.write' })).toBe(true);
  });

  it('denies what the policy denies, without asking', async () => {
    const { permissions, prompter } = withPrompter('allow-once');
    permissions.setPolicy(agent, policy({ 'fs.write': 'deny' }));

    expect(await permissions.check({ principal: agent, capability: 'fs.write' })).toBe(false);
    expect(prompter).not.toHaveBeenCalled();
  });

  it('falls back for capabilities the rules do not name', async () => {
    const permissions = new PermissionService();
    permissions.setPolicy(agent, policy({ 'fs.read': 'allow' }, 'deny'));

    expect(await permissions.check({ principal: agent, capability: 'shell.exec' })).toBe(false);
  });

  it('keeps policies separate per principal', async () => {
    const permissions = new PermissionService();
    permissions.setPolicy(agent, policy({ 'fs.write': 'allow' }));
    permissions.setPolicy(other, policy({ 'fs.write': 'deny' }));

    expect(await permissions.check({ principal: agent, capability: 'fs.write' })).toBe(true);
    expect(await permissions.check({ principal: other, capability: 'fs.write' })).toBe(false);
  });

  it('refuses when a decision needs a human and there is none', async () => {
    const permissions = new PermissionService();
    permissions.setPolicy(agent, policy({}, 'prompt'));

    // Failing closed is the only safe reading of "ask the user" with no user.
    expect(await permissions.check({ principal: agent, capability: 'fs.write' })).toBe(false);
    expect(permissions.decisions.get().at(-1)?.source).toBe('no-prompter');
  });
});

describe('the user', () => {
  it('is never prompted, whatever the policy says', async () => {
    const { permissions, prompter } = withPrompter('deny');
    permissions.setDefaultPolicy(policy({}, 'prompt'));
    permissions.setPolicy(USER, policy({ 'fs.write': 'deny' }));

    // Even a policy that names the user cannot get between them and their
    // own keystroke: a model that can do that is a model people switch off.
    expect(await permissions.check({ principal: USER, capability: 'fs.write' })).toBe(true);
    expect(prompter).not.toHaveBeenCalled();
  });

  it('is not written to the decision log', async () => {
    const permissions = new PermissionService();
    await permissions.check({ principal: USER, capability: 'fs.write' });

    // "The user was allowed to type" would bury the entries that matter.
    expect(permissions.decisions.get()).toEqual([]);
  });
});

describe('prompting', () => {
  it('asks when the policy says to, and honours the answer', async () => {
    const { permissions, prompter } = withPrompter('allow-once');
    permissions.setPolicy(agent, policy({ 'fs.write': 'prompt' }));

    expect(
      await permissions.check({ principal: agent, capability: 'fs.write', resource: '/w/a.ts' }),
    ).toBe(true);
    expect(prompter).toHaveBeenCalledTimes(1);
  });

  it('asks again after allow-once', async () => {
    const { permissions, prompter } = withPrompter('allow-once');
    permissions.setPolicy(agent, policy({ 'fs.write': 'prompt' }));

    const request = { principal: agent, capability: 'fs.write' as const, resource: '/w/a.ts' };
    await permissions.check(request);
    await permissions.check(request);

    expect(prompter).toHaveBeenCalledTimes(2);
  });

  it('stops asking after allow-for-session', async () => {
    const { permissions, prompter } = withPrompter('allow-session');
    permissions.setPolicy(agent, policy({ 'fs.write': 'prompt' }));

    const request = { principal: agent, capability: 'fs.write' as const, resource: '/w/a.ts' };
    expect(await permissions.check(request)).toBe(true);
    expect(await permissions.check(request)).toBe(true);

    expect(prompter).toHaveBeenCalledTimes(1);
    expect(permissions.decisions.get().at(-1)?.source).toBe('remembered');
  });

  it('scopes a remembered file grant to that file', async () => {
    const { permissions, prompter } = withPrompter('allow-session');
    permissions.setPolicy(agent, policy({ 'fs.write': 'prompt' }));

    await permissions.check({ principal: agent, capability: 'fs.write', resource: '/w/a.ts' });
    // Saying yes to one file is not saying yes to the next one.
    await permissions.check({ principal: agent, capability: 'fs.write', resource: '/w/b.ts' });

    expect(prompter).toHaveBeenCalledTimes(2);
  });

  it('does not carry a grant across principals', async () => {
    const { permissions, prompter } = withPrompter('allow-session');
    permissions.setDefaultPolicy(policy({ 'fs.write': 'prompt' }));

    await permissions.check({ principal: agent, capability: 'fs.write', resource: '/w/a.ts' });
    await permissions.check({ principal: other, capability: 'fs.write', resource: '/w/a.ts' });

    expect(prompter).toHaveBeenCalledTimes(2);
  });

  it('forgets session grants on request', async () => {
    const { permissions, prompter } = withPrompter('allow-session');
    permissions.setPolicy(agent, policy({ 'fs.write': 'prompt' }));

    const request = { principal: agent, capability: 'fs.write' as const, resource: '/w/a.ts' };
    await permissions.check(request);
    permissions.forgetSession(agent);
    await permissions.check(request);

    expect(prompter).toHaveBeenCalledTimes(2);
  });
});

describe('the workspace boundary', () => {
  it('asks about a path outside the workspace even when policy allows', async () => {
    const { permissions, prompter } = withPrompter('deny', '/w');
    permissions.setPolicy(agent, policy({ 'fs.write': 'allow' }));

    expect(
      await permissions.check({ principal: agent, capability: 'fs.write', resource: '/w/a.ts' }),
    ).toBe(true);
    expect(prompter).not.toHaveBeenCalled();

    // The one line policy cannot quietly move.
    expect(
      await permissions.check({
        principal: agent,
        capability: 'fs.write',
        resource: '/home/me/.ssh/config',
      }),
    ).toBe(false);
    expect(prompter).toHaveBeenCalledTimes(1);
    expect(permissions.decisions.get().at(-1)?.source).toBe('workspace-boundary');
  });

  it('cannot turn a denial into a yes', async () => {
    const { permissions, prompter } = withPrompter('allow-session', '/w');
    permissions.setPolicy(agent, policy({ 'fs.write': 'deny' }));

    expect(
      await permissions.check({
        principal: agent,
        capability: 'fs.write',
        resource: '/elsewhere/x',
      }),
    ).toBe(false);
    expect(prompter).not.toHaveBeenCalled();
  });

  it('leaves non-filesystem capabilities alone', async () => {
    const { permissions, prompter } = withPrompter('deny', '/w');
    permissions.setPolicy(agent, policy({ 'net.request': 'allow' }));

    expect(
      await permissions.check({
        principal: agent,
        capability: 'net.request',
        resource: 'https://example.com',
      }),
    ).toBe(true);
    expect(prompter).not.toHaveBeenCalled();
  });
});

describe('the decision log', () => {
  it('records what was asked, by whom, and how it was answered', async () => {
    const { permissions } = withPrompter('allow-once');
    permissions.setPolicy(agent, policy({ 'fs.write': 'prompt', 'shell.exec': 'deny' }));

    await permissions.check({ principal: agent, capability: 'fs.write', resource: '/w/a.ts' });
    await permissions.check({ principal: agent, capability: 'shell.exec' });

    expect(
      permissions.decisions.get().map((d) => [d.capability, d.granted, d.source]),
    ).toEqual([
      ['fs.write', true, 'prompt'],
      ['shell.exec', false, 'policy'],
    ]);
  });
});

describe('enforcement in the dispatcher', () => {
  function setup() {
    const permissions = new PermissionService(() => '/w');
    const commands = new CommandRegistry();
    const saved: string[] = [];

    commands.setGuard(async (command, principal, resource) => {
      for (const capability of command.capabilities ?? []) {
        await permissions.require({
          principal,
          capability,
          ...(resource ? { resource } : {}),
        });
      }
    });

    const save: Command = {
      id: 'file.save',
      title: 'Save',
      capabilities: ['fs.write'],
      resourceFrom: (arg) => (typeof arg === 'string' ? arg : undefined),
      run: (arg) => {
        saved.push(String(arg ?? 'active'));
      },
    };
    const move: Command = {
      id: 'nav.goToLine',
      title: 'Go to Line',
      run: () => {},
    };
    commands.registerAll([save, move]);

    return { permissions, commands, saved };
  }

  it('lets a denied principal do nothing, loudly', async () => {
    const { permissions, commands, saved } = setup();
    permissions.setPolicy(agent, policy({ 'fs.write': 'deny' }));

    // The milestone's own acceptance: a principal denied fs.write cannot save.
    await expect(commands.execute('file.save', '/w/a.ts', { principal: agent })).rejects.toThrow(
      PermissionError,
    );
    expect(saved).toEqual([]);
  });

  it('lets an allowed principal through', async () => {
    const { permissions, commands, saved } = setup();
    permissions.setPolicy(agent, policy({ 'fs.write': 'allow' }));

    expect(await commands.execute('file.save', '/w/a.ts', { principal: agent })).toBe(true);
    expect(saved).toEqual(['/w/a.ts']);
  });

  it('never consults the guard for the user', async () => {
    const { permissions, commands, saved } = setup();
    permissions.setPolicy(USER, policy({ 'fs.write': 'deny' }));
    permissions.setDefaultPolicy(policy({}, 'deny'));

    // No principal at all is the ordinary case: a keybinding, a menu, a button.
    expect(await commands.execute('file.save', '/w/a.ts')).toBe(true);
    expect(await commands.execute('file.save', '/w/b.ts', { principal: USER })).toBe(true);
    expect(saved).toEqual(['/w/a.ts', '/w/b.ts']);
  });

  it('does not gate commands that declare no capability', async () => {
    const { permissions, commands } = setup();
    permissions.setDefaultPolicy(policy({}, 'deny'));

    expect(await commands.execute('nav.goToLine', undefined, { principal: agent })).toBe(true);
  });

  it('carries the resource from the command into the decision', async () => {
    const { permissions, commands } = setup();
    permissions.setPolicy(agent, policy({ 'fs.write': 'allow' }));

    await commands.execute('file.save', '/w/deep/file.ts', { principal: agent });

    expect(permissions.decisions.get().at(-1)?.resource).toBe('/w/deep/file.ts');
  });

  it('throws rather than reporting the same false a disabled command would', async () => {
    const { permissions, commands } = setup();
    permissions.setPolicy(agent, policy({ 'fs.write': 'deny' }));

    // "Nothing happened" is the worst possible answer to "may I", because it
    // is indistinguishable from the command simply not being available.
    const error = await commands
      .execute('file.save', '/w/a.ts', { principal: agent })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).capability).toBe('fs.write');
    expect((error as PermissionError).resource).toBe('/w/a.ts');
  });
});
