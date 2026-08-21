import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { CommandRegistry } from '../src/services/commands';
import { ConfigService } from '../src/services/config';
import { KeymapService } from '../src/services/keymap';
import { SessionService } from '../src/services/session';
import { WorkspaceService } from '../src/services/workspace';

/**
 * The three config-directory writes that used to fail in silence.
 *
 * What these guard: a `catch {}` with a comment saying the failure must not
 * break the session. That part is right and stays — none of these throw. What
 * did not follow is that the failure must not be *mentioned*: a settings file
 * that cannot be written means every preference is lost at quit, and a session
 * file that cannot be written voids README.md's "It does not lose your work.
 * Ever." — with no quit prompt to fall back on, because there deliberately is
 * none. `NotesService` already had this shape; these three now match it.
 */

/** A platform whose named config writes fail, the way a full disk would. */
class UnwritablePlatform extends MemoryPlatform {
  readonly failing = new Set<string>();
  /** Every write attempted, landed or not — what a retry is counted from. */
  readonly attempts: string[] = [];

  override async writeConfigFile(name: string, contents: string): Promise<void> {
    this.attempts.push(name);
    if (this.failing.has(name)) throw new Error('disk is full');
    return super.writeConfigFile(name, contents);
  }
}

describe('a settings write that fails', () => {
  it('is published on `error`, and cleared by the next write that lands', async () => {
    const platform = new UnwritablePlatform();
    platform.failing.add('settings.json');
    const config = new ConfigService(platform);

    config.set('editor.fontSize', 20);
    await config.flush();
    expect(config.error.get()).toBe('disk is full');
    // The value is still live: reporting is not refusing.
    expect(config.get('editor.fontSize')).toBe(20);

    platform.failing.clear();
    config.set('editor.fontSize', 21);
    await config.flush();
    expect(config.error.get()).toBeNull();
  });
});

describe('a keybindings write that fails', () => {
  it('is published on `error`, and the rebind still applies in memory', async () => {
    const platform = new UnwritablePlatform();
    platform.failing.add('keybindings.json');
    const keymap = new KeymapService(new CommandRegistry(), platform);

    keymap.assign('file.save', 'Mod+Alt+P');
    await keymap.flush();

    expect(keymap.error.get()).toBe('disk is full');
    expect(keymap.lookup('Mod+Alt+P')[0]?.commandId).toBe('file.save');
  });
});

describe('a session write that fails', () => {
  it('is published on `error`', async () => {
    const platform = new UnwritablePlatform();
    platform.failing.add('session.json');
    platform.mkdirp('/work');
    platform.seedFile('/work/a.ts', 'const a = 1;\n');

    const workspace = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, workspace);
    session.markReady();
    await workspace.openFolder('/work');
    await workspace.open('/work/a.ts');

    await session.save();
    expect(session.error.get()).toBe('disk is full');
  });

  /**
   * The failure this guards: a backup write that fails while its bookkeeping
   * entry is left in place. `#backUp` records the buffer's revision before the
   * write resolves, so the "has this buffer moved?" check would skip it on
   * every later save — the unsaved text would never reach disk again, which is
   * the exact opposite of what the backup exists for.
   */
  it('retries a backup that did not land on the next save', async () => {
    const platform = new UnwritablePlatform();
    const workspace = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, workspace);
    session.markReady();

    const id = workspace.newUntitled({ content: 'work in progress' });
    // One good save, to learn the name this buffer's backup was given.
    await session.save();
    const backup = platform.attempts.find((name) => name.startsWith('unsaved-'));
    expect(backup).toBeDefined();

    platform.failing.add(backup!);
    workspace.setEol(id, '\r\n'); // Moves the buffer without touching its text.
    await session.save();
    expect(session.error.get()).toBe('disk is full');

    platform.failing.clear();
    await session.save();
    expect(session.error.get()).toBeNull();
    // Three attempts, not two: the failed write left the buffer looking
    // unchanged, and the third save is the one that would never have happened.
    expect(platform.attempts.filter((name) => name === backup).length).toBe(3);
  });
});

describe('NoxApp', () => {
  /**
   * The failure this guards: a service that reports its write failure into a
   * signal nobody subscribes to, which is the same silence in a longer form.
   */
  it('turns each of the three write failures into an error notification', async () => {
    const platform = new UnwritablePlatform();
    platform.failing.add('settings.json');
    platform.failing.add('keybindings.json');
    platform.failing.add('session.json');
    const app = new NoxApp(platform);

    app.config.set('editor.fontSize', 20);
    await app.config.flush();
    app.keymap.assign('file.save', 'Mod+Alt+P');
    await app.keymap.flush();
    app.session.markReady();
    await app.session.save();

    const messages = app.notifications.items.get().map((item) => item.message);
    expect(messages).toContain('Could not save your settings');
    expect(messages).toContain('Could not save your keyboard shortcuts');
    expect(messages).toContain('Could not save your session');
    // Errors are the sticky kind; a warning about lost work must not expire.
    for (const item of app.notifications.items.get()) expect(item.timeout).toBe(0);
  });
});
