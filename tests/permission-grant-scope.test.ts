import { describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import {
  PermissionService,
  type PermissionRequest,
  type Principal,
  type PromptAnswer,
} from '../src/services/permissions';

/**
 * "Allow for this session" covers the command it was asked about, and no other.
 *
 * **The bug this exists for.** A remembered grant was keyed on the principal,
 * the capability and, for `fs.*` and `buffer.edit`, the resource. The prompt
 * has always named the *command*: "wants to create files (Configure Agents)".
 * So one Yes was stored at a granularity wider than the question it answered,
 * and every command declaring the same capability with no `resourceFrom` fell
 * into one bucket with it.
 *
 * That bucket had real neighbours in it. Seven always-enabled commands declare
 * `fs.create` and name no path (`agents.configure`, `lsp.configure`,
 * `snippets.configure`, `tasks.edit`, `themes.openFolder`,
 * `plugins.openFolder`, `plugins.openSettingsFile`), so approving any one of
 * them approved all seven. `buffer.edit` was the sharper case and the one the
 * review found: `review.apply` and `search.replaceAll` both declare it and
 * both deliberately name no file, so approving a review the user had read on
 * screen also approved a project-wide find-and-replace they had never been
 * shown. `AGENT-PLATFORM.md:271` described the old key as "the granularity
 * each is asked at", which was not true of the dialog it was describing.
 *
 * Found by a security review on 2026-08-30.
 *
 * Mutation-checked on 2026-08-31, and the two halves of the fix fail
 * different sets, which is the point of testing both. Dropping
 * `request.commandId` from `grantKey` fails four: the two "asks again for a
 * different command" cases, the revocation count, and the dispatcher case.
 * Dropping `commandId: command.id` from the guard in `app.ts` fails exactly
 * one, the dispatcher case, because the service is then scoping correctly on
 * an id nobody sends it. Neither mutation touches "still remembers a repeat of
 * the same command", which is the regression guard rather than the defect
 * guard: remembering worked before and has to keep working.
 *
 * What this does not check is that the *narrowing* is not itself a problem:
 * an agent using three editing commands on one file is now asked three times.
 * That is a deliberate cost recorded in `grantKey`, not something a test can
 * hold to a number.
 */

const AGENT: Principal = { kind: 'agent', sessionId: 's1', label: 'test-agent' };

function ask(commandId: string, resource?: string): PermissionRequest {
  return {
    principal: AGENT,
    capability: 'fs.write',
    commandId,
    description: commandId,
    ...(resource !== undefined ? { resource } : {}),
  };
}

/** A prompter that says yes for the session and counts how often it was asked. */
function sessionYes() {
  return vi.fn(async (): Promise<PromptAnswer> => 'allow-session');
}

describe('a session grant', () => {
  it('is remembered for a repeat of the same command', async () => {
    const permissions = new PermissionService();
    const prompter = sessionYes();
    permissions.setPrompter(prompter);

    expect(await permissions.check(ask('file.save', '/w/a.ts'))).toBe(true);
    expect(await permissions.check(ask('file.save', '/w/a.ts'))).toBe(true);

    expect(prompter).toHaveBeenCalledTimes(1);
    expect(permissions.decisions.get().at(-1)?.source).toBe('remembered');
  });

  it('asks again for a different command with the same capability and resource', async () => {
    const permissions = new PermissionService();
    const prompter = sessionYes();
    permissions.setPrompter(prompter);

    await permissions.check(ask('file.save', '/w/a.ts'));
    await permissions.check(ask('file.saveAs', '/w/a.ts'));

    expect(prompter).toHaveBeenCalledTimes(2);
    // Two grants, not one widened. The second is a separate thing to revoke.
    expect(permissions.grants.get().map((grant) => grant.commandId)).toEqual([
      'file.save',
      'file.saveAs',
    ]);
  });

  /**
   * The unscoped case, which is the one the defect was live in: no resource on
   * either side, so before the fix the two keys were identical strings.
   */
  it('asks again for a different command when neither names a resource', async () => {
    const permissions = new PermissionService();
    const prompter = sessionYes();
    permissions.setPrompter(prompter);

    await permissions.check(ask('review.apply'));
    await permissions.check(ask('search.replaceAll'));

    expect(prompter).toHaveBeenCalledTimes(2);
  });

  /** Still resource-scoped. The command narrows the key; it does not replace it. */
  it('asks again for the same command on a different resource', async () => {
    const permissions = new PermissionService();
    const prompter = sessionYes();
    permissions.setPrompter(prompter);

    await permissions.check(ask('file.save', '/w/a.ts'));
    await permissions.check(ask('file.save', '/w/b.ts'));

    expect(prompter).toHaveBeenCalledTimes(2);
  });

  /**
   * The grant carries the words the user read, so the Agents panel can list it
   * without the permission layer knowing a command registry exists.
   */
  it('records which command it was granted for', async () => {
    const permissions = new PermissionService();
    permissions.setPrompter(sessionYes());

    await permissions.check({
      principal: AGENT,
      capability: 'buffer.edit',
      commandId: 'review.apply',
      description: 'Apply Reviewed Changes',
    });

    expect(permissions.grants.get()[0]).toMatchObject({
      capability: 'buffer.edit',
      commandId: 'review.apply',
      description: 'Apply Reviewed Changes',
    });
  });

  /** Revoking is unaffected: it still clears every grant a principal holds. */
  it('is still revocable in one action', async () => {
    const permissions = new PermissionService();
    permissions.setPrompter(sessionYes());

    await permissions.check(ask('file.save', '/w/a.ts'));
    await permissions.check(ask('file.saveAs', '/w/a.ts'));

    expect(permissions.forgetSession(AGENT)).toHaveLength(2);
    expect(permissions.grants.get()).toEqual([]);
  });
});

/**
 * The other half: the dispatcher has to actually hand the command's id over.
 * The service could scope perfectly and enforce nothing if the guard kept
 * sending the title alone.
 *
 * These two commands are chosen because both are always enabled and neither
 * declares a `resourceFrom`, which is exactly the shape that shared a bucket.
 * `enabled` is checked *before* the guard (`commands.ts:197` before `:200`),
 * so a disabled command would never be permission-checked at all and the test
 * would prove nothing.
 */
describe('through the real dispatcher', () => {
  it('does not let one fs.create command answer for another', async () => {
    const app = new NoxApp(new MemoryPlatform());
    const prompter = sessionYes();
    app.permissions.setPrompter(prompter);

    await app.commands.execute('agents.configure', undefined, { principal: AGENT });
    await app.commands.execute('plugins.openFolder', undefined, { principal: AGENT });

    expect(prompter).toHaveBeenCalledTimes(2);
    // And the prompt named a different command each time, which is the thing
    // the old key ignored.
    expect(prompter.mock.calls.map((call) => (call as unknown as [PermissionRequest])[0].commandId))
      .toEqual(['agents.configure', 'plugins.openFolder']);
  });

  it('still remembers a repeat of the same command', async () => {
    const app = new NoxApp(new MemoryPlatform());
    const prompter = sessionYes();
    app.permissions.setPrompter(prompter);

    await app.commands.execute('agents.configure', undefined, { principal: AGENT });
    await app.commands.execute('agents.configure', undefined, { principal: AGENT });

    expect(prompter).toHaveBeenCalledTimes(1);
  });
});
