import { describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
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

  /**
   * The failure this guards: `buffer.edit` remembering at the capability
   * level. Adding the filename to the prompt narrows only the *question* — the
   * grant behind it still covered every buffer, so one "Allow for this
   * session" answered about a scratch file silently covered the next hour of
   * editing in every other file the user opened.
   */
  it('scopes a remembered buffer grant to that buffer', async () => {
    const { permissions, prompter } = withPrompter('allow-session');
    permissions.setPolicy(agent, policy({ 'buffer.edit': 'prompt' }));

    await permissions.check({ principal: agent, capability: 'buffer.edit', resource: '/w/a.ts' });
    await permissions.check({ principal: agent, capability: 'buffer.edit', resource: '/w/b.ts' });
    expect(prompter).toHaveBeenCalledTimes(2);

    // The same file is still remembered, or the grant would mean nothing.
    await permissions.check({ principal: agent, capability: 'buffer.edit', resource: '/w/a.ts' });
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

    // The same two steps `NoxApp` installs: refuse a command that declares
    // nothing, then require each capability a command does declare. Copied
    // rather than imported because this suite builds a registry and a service
    // directly, and the point of the file is to exercise the pair.
    commands.setGuard(async (command, principal, resource) => {
      if (!command.capabilities?.length) {
        permissions.refuseUndeclared({ principal, commandId: command.id, description: command.title });
      }
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
        saved.push(typeof arg === 'string' ? arg : 'active');
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

  /**
   * The rule this file used to pin the opposite of. Until 2026-09-03 the
   * assertion here was that an undeclared command runs, which is what left
   * every command whose author forgot a declaration reachable by an agent with
   * no check and no log entry. `nav.goToLine` is the same harmless command it
   * always was; what changed is that "declares nothing" is now refused rather
   * than trusted, so a command that reaches the OS and says nothing about it
   * fails closed.
   */
  it('refuses a non-user principal a command that declares no capability', async () => {
    const { permissions, commands } = setup();
    permissions.setDefaultPolicy(policy({}, 'allow'));

    // Allow-everything policy on purpose: the refusal is the declaration
    // being absent, not the policy denying anything.
    await expect(
      commands.execute('nav.goToLine', undefined, { principal: agent }),
    ).rejects.toThrow(PermissionError);
  });

  it('records the refusal so it is not silent', async () => {
    const { permissions, commands } = setup();

    await commands.execute('nav.goToLine', undefined, { principal: agent }).catch(() => {});

    const decision = permissions.decisions.get().at(-1);
    expect(decision?.granted).toBe(false);
    // Its own source, so an audit can tell "you did not say what you would do"
    // apart from "policy said no".
    expect(decision?.source).toBe('undeclared');
    expect(decision?.commandId).toBe('nav.goToLine');
    expect(decision?.capability).toBeUndefined();
  });

  it('still runs an undeclared command for the user', async () => {
    const { permissions, commands } = setup();
    permissions.setDefaultPolicy(policy({}, 'deny'));

    expect(await commands.execute('nav.goToLine')).toBe(true);
    expect(await commands.execute('nav.goToLine', undefined, { principal: USER })).toBe(true);
    expect(permissions.decisions.get()).toEqual([]);
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

/**
 * The prompt and the declarations the app itself builds — the half of the
 * model a `PermissionService` test cannot see.
 */
describe('the prompt Nox builds', () => {
  /** An app with one file open, which is what `resourceFrom` reads. */
  async function appWithFile(): Promise<NoxApp> {
    const platform = new MemoryPlatform();
    platform.mkdirp('/w');
    platform.seedFile('/w/a.ts', 'const a = 1;\n');
    const app = new NoxApp(platform);
    await app.workspace.openFolder('/w');
    await app.workspace.open('/w/a.ts');
    // A focused search result, so the commands scoped to *that* rather than to
    // the active buffer have a subject to name. `search.replaceResult` acts on
    // the row you are on, which is the point of a results list — the file it
    // grants against is usually one you are not looking at.
    app.search.query.set('const');
    await app.search.run();
    app.search.focused.set(0);
    return app;
  }

  /**
   * The failure this guards, and it is the sharpest one in the app: every
   * mechanism that decides the dialog's default landed on "Allow for this
   * session" — because `danger` sat on Deny, the safe answer, and both the
   * focus rule and the primary accent read `danger` or position. Enter on a
   * prompt the user had not read granted a session-wide capability.
   */
  it('defaults to Deny and marks the session-wide grant destructive', async () => {
    const app = await appWithFile();
    const pending = app.permissions.check({
      principal: agent,
      capability: 'buffer.edit',
      resource: '/w/a.ts',
    });

    const request = app.ui.confirm.get();
    expect(request).not.toBeNull();
    expect(request!.defaultChoiceId).toBe('deny');
    expect(request!.choices.find((choice) => choice.id === 'allow-session')?.danger).toBe(true);
    expect(request!.choices.find((choice) => choice.id === 'deny')?.danger).toBeUndefined();
    // The path is in the message, so the question names what it is about.
    expect(request!.message).toContain('a.ts');

    request!.resolve('deny');
    expect(await pending).toBe(false);
  });

  /**
   * The failure this guards: a new `buffer.edit` command landing without a
   * decision about its subject, so its prompt reads "Allow edit what is open?"
   * with no filename and its grant covers every buffer at once.
   */
  it('names the file behind every buffer.edit command that has one', async () => {
    const app = await appWithFile();
    // These four write across a set of files, so naming the active one would
    // understate the grant; `file.new` is about a buffer that does not exist
    // yet. Each is commented at its registration in `app.ts`.
    //
    // `agents.undoLastSession` is the fifth and the one that reads least like
    // the others: it reverts whichever files one agent session wrote, which is
    // a set nobody can name from the active tab.
    const unscoped = new Set([
      'agents.undoLastSession',
      'file.new',
      'review.apply',
      'search.replaceAll',
      'search.undoReplace',
    ]);

    const editing = app.commands
      .all()
      .filter((command) => command.capabilities?.includes('buffer.edit'));
    expect(editing.length).toBeGreaterThan(10);

    for (const command of editing) {
      if (unscoped.has(command.id)) {
        expect(command.resourceFrom).toBeUndefined();
        continue;
      }
      expect(command.resourceFrom?.()).toBe('/w/a.ts');
    }
  });
});
