import { describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import type {
  PermissionRequest,
  Principal,
  PromptAnswer,
} from '../src/services/permissions';

/**
 * The permission check is made against the path the command will act on.
 *
 * **The bug this exists for.** Every explorer command declared
 *
 * ```ts
 * resourceFrom: (arg) => (typeof arg === 'string' ? arg : this.targetPath() ?? undefined)
 * ```
 *
 * while its `run` body passed the same argument to `targetPaths`, which
 * honours an **array**. So the two disagreed about what the command was about
 * the moment a caller passed a list: the guard was handed the explorer's lead
 * selection, a path inside the workspace, and the body then opened, duplicated
 * or deleted the list instead.
 *
 * That is not a cosmetic mismatch, because of what the boundary does.
 * `fs.read` is `allow` in `DEFAULT_POLICY`, and the only thing that turns it
 * into a question is `#isOutsideWorkspace` (`permissions.ts:320-328`). Check
 * an inside path and the answer is a silent yes. So a plugin or an agent could
 * dispatch `explorer.openSelection` with `['/home/you/.ssh/id_rsa']`, get no
 * dialog at all, and then read the buffer back through the context API, which
 * is unguarded by design because reads "cannot leave the process on their own".
 *
 * Found by review on 2026-08-30, in code that had shipped. It contradicted two
 * statements in `AGENT-PLATFORM.md`: "Grants are path-scoped. Approving a
 * write to `src/app.ts` does not approve one to `~/.ssh/config`" (:269) and
 * "The workspace boundary tightens, never loosens" (:288).
 *
 * Mutation-checked on 2026-08-30: restoring the old
 * `typeof arg === 'string' ? arg : this.targetPath()` on
 * `explorer.openSelection` fails the first test here and nothing else in the
 * repository.
 *
 * What this does not catch: whether the *body* should refuse an out-of-tree
 * path outright rather than asking. It should not, deliberately, since opening
 * a file outside the folder is a thing users do.
 */

const AGENT: Principal = { kind: 'agent', sessionId: 's1', label: 'test-agent' };

async function app(answer: PromptAnswer = 'deny') {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/inside.txt', 'in the workspace\n');
  platform.seedFile('/secrets/key', 'PRIVATE\n');

  const nox = new NoxApp(platform);
  await nox.workspace.openFolder('/w');
  // An open buffer, so `enabled()` (which is called with no argument) is
  // satisfied exactly as it would be in a normal session.
  await nox.workspace.open('/w/inside.txt');

  const prompter = vi.fn(async (_request: PermissionRequest): Promise<PromptAnswer> => answer);
  nox.permissions.setPrompter(prompter);

  return { nox, platform, prompter };
}

describe('the resource a permission is checked against', () => {
  it('is the out-of-workspace path when a list carries one', async () => {
    const { nox, prompter } = await app('deny');

    await expect(
      nox.commands.execute('explorer.openSelection', ['/secrets/key'], { principal: AGENT }),
    ).rejects.toThrow();

    // The point: a dialog happened at all. Under the old `resourceFrom` the
    // guard saw `/w/inside.txt`, `fs.read` was allowed by policy, and the file
    // opened with the prompter never called once.
    expect(prompter).toHaveBeenCalledTimes(1);
    expect(prompter.mock.calls[0]?.[0]).toMatchObject({ resource: '/secrets/key' });
    expect(nox.workspace.buffers.get().some((buffer) => buffer.path === '/secrets/key')).toBe(false);
  });

  it('finds the outside path even when inside paths come first', async () => {
    // The boundary only ever tightens, so the member that decides the answer
    // is the outside one wherever it sits in the list.
    const { nox, prompter } = await app('deny');

    await expect(
      nox.commands.execute('explorer.openSelection', ['/w/inside.txt', '/secrets/key'], {
        principal: AGENT,
      }),
    ).rejects.toThrow();

    expect(prompter.mock.calls[0]?.[0]).toMatchObject({ resource: '/secrets/key' });
  });

  it('still allows a list that stays inside the workspace, with no dialog', async () => {
    // The fix must not turn every multi-select into a question. `fs.read` in
    // the folder you opened is the case the `allow` default is for.
    const { nox, prompter } = await app('deny');
    (nox.platform as MemoryPlatform).seedFile('/w/second.txt', 'also inside\n');

    expect(
      await nox.commands.execute('explorer.openSelection', ['/w/inside.txt', '/w/second.txt'], {
        principal: AGENT,
      }),
    ).toBe(true);

    expect(prompter).not.toHaveBeenCalled();
  });

  /**
   * The traversal form of the same attack.
   *
   * The first fix here derived the resource from what `run` acts on and then
   * asked `contains()`, which is a string prefix test that does not resolve
   * `..`. So `/w/../secrets/key` read as being *inside* `/w`, `fs.read` was
   * allowed by policy, and the prompter was never called: the hole this file
   * was written for, reopened by spelling the path differently. The OS
   * resolves the traversal afterwards, which is what makes it easy to miss.
   */
  it('is not fooled by a path that traverses out of the workspace', async () => {
    const { nox, prompter } = await app('deny');

    await expect(
      nox.commands.execute('explorer.openSelection', ['/w/../secrets/key'], { principal: AGENT }),
    ).rejects.toThrow();

    expect(prompter).toHaveBeenCalledTimes(1);
  });

  /**
   * An argument that names nothing must not name *nothing to check*.
   *
   * `permissionTarget` treated any non-array object as the `moveTo` shape, so
   * `{}` produced an empty set and returned `undefined` while `run` went on to
   * act on the lead selection. A request with no resource skips the workspace
   * boundary entirely, so this was a hole rather than a missing label, and it
   * was introduced by the commit that fixed the array one.
   */
  it('falls back to the active target when the argument names no path', async () => {
    const { nox, prompter } = await app('deny');
    await nox.workspace.open('/secrets/key');

    await expect(
      nox.commands.execute('explorer.openSelection', {}, { principal: AGENT }),
    ).rejects.toThrow();

    expect(prompter).toHaveBeenCalledTimes(1);
    expect(prompter.mock.calls[0]?.[0]).toMatchObject({ resource: '/secrets/key' });
  });

  /**
   * The other five commands wired to `permissionTarget`.
   *
   * The first version of this suite covered `openSelection` and `moveTo` only,
   * and reverting `explorer.delete` to the old `resourceFrom` passed the whole
   * repository. Six of the eight sites had no guard at all.
   */
  it.each([
    ['explorer.delete', 'fs.delete'],
    ['explorer.duplicate', 'fs.create'],
    ['explorer.rename', 'fs.write'],
    ['explorer.newFile', 'fs.create'],
    ['explorer.newFolder', 'fs.create'],
  ])('checks %s against the path it was handed', async (commandId) => {
    const { nox, prompter } = await app('deny');

    await expect(
      nox.commands.execute(commandId, ['/secrets/key'], { principal: AGENT }),
    ).rejects.toThrow();

    expect(prompter).toHaveBeenCalled();
    // `newFile`/`newFolder` act on the *directory* of what they were handed,
    // which is inside whatever the named path is, so naming the path itself is
    // the conservative answer rather than the wrong one.
    const resource = prompter.mock.calls[0]?.[0]?.resource;
    expect(typeof resource === 'string' && resource.startsWith('/secrets')).toBe(true);
  });

  it('checks the destination of a move, not the explorer selection', async () => {
    // `explorer.moveTo` carries `{ paths, target }` rather than a path or a
    // list, so the old ternary fell through to the lead selection for it too.
    const { nox, prompter } = await app('deny');

    await expect(
      nox.commands.execute(
        'explorer.moveTo',
        { paths: ['/w/inside.txt'], target: '/secrets' },
        { principal: AGENT },
      ),
    ).rejects.toThrow();

    expect(prompter.mock.calls[0]?.[0]).toMatchObject({ resource: '/secrets' });
  });
});
