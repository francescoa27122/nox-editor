// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { PermissionError } from '../src/services/permissions';

/**
 * What the app does with a failure nobody caught.
 *
 * The gap this covers: `CommandRegistry.execute` logged to the console and
 * rethrew, every one of the ~40 call sites discarded the promise with `void`,
 * and nothing anywhere listened for `unhandledrejection` — so in the release
 * webview, which has no devtools, a failed command produced no artefact of any
 * kind. jsdom rather than Node because the backstop is a `globalThis` event
 * listener, which Node has no `addEventListener` for.
 */

let app: NoxApp | null = null;

afterEach(async () => {
  await app?.dispose();
  app = null;
});

const messages = (instance: NoxApp) =>
  instance.notifications.items.get().map((item) => item.message);

describe('a command that fails', () => {
  it('raises an error notification naming the command', async () => {
    app = new NoxApp(new MemoryPlatform());
    app.commands.register({
      id: 'test.explode',
      title: 'Do The Thing',
      run: () => {
        throw new Error('no space left on device');
      },
    });

    await expect(app.commands.execute('test.explode')).rejects.toThrow();

    const toast = app.notifications.items.get().find((item) => item.message === 'Do The Thing failed');
    expect(toast).toBeDefined();
    expect(toast!.kind).toBe('error');
    expect(toast!.detail).toBe('no space left on device');
  });

  /**
   * A refusal is the permission model working. Telling the user their own
   * "Deny" was an error would train them to ignore the toasts that matter.
   */
  it('says nothing when the failure is a refused permission', async () => {
    app = new NoxApp(new MemoryPlatform());
    app.commands.register({
      id: 'test.refused',
      title: 'Refused',
      run: () => {
        throw new PermissionError({
          principal: { kind: 'agent', sessionId: 's1', label: 'Test agent' },
          capability: 'fs.write',
        });
      },
    });

    await expect(app.commands.execute('test.refused')).rejects.toThrow(PermissionError);
    expect(messages(app)).toEqual([]);
  });

  /**
   * `execute` reports and then rethrows, and almost every caller discards the
   * promise — so the backstop below sees the same error a moment later. One
   * failure must not produce two toasts.
   */
  it('is reported once, even though the rethrow reaches the backstop', async () => {
    app = new NoxApp(new MemoryPlatform());
    const error = new Error('same object, twice');
    app.commands.register({
      id: 'test.twice',
      title: 'Twice',
      run: () => {
        throw error;
      },
    });

    await expect(app.commands.execute('test.twice')).rejects.toThrow();
    dispatchRejection(error);

    expect(messages(app)).toEqual(['Twice failed']);
  });
});

describe('the unhandled-rejection backstop', () => {
  it('turns a rejection nothing caught into an error notification', () => {
    app = new NoxApp(new MemoryPlatform());

    dispatchRejection(new Error('the drop listener fell over'));

    const toast = app.notifications.items.get()[0];
    expect(toast?.message).toBe('Something went wrong');
    expect(toast?.kind).toBe('error');
    expect(toast?.detail).toBe('the drop listener fell over');
  });

  it('stops listening once the app is disposed', async () => {
    const instance = new NoxApp(new MemoryPlatform());
    await instance.dispose();

    dispatchRejection(new Error('after the window went away'));
    expect(messages(instance)).toEqual([]);
  });
});

/**
 * Fire what the browser fires. jsdom does not construct
 * `PromiseRejectionEvent`, and the handler reads only `reason` — which is why
 * it is typed structurally rather than against the DOM event.
 */
function dispatchRejection(reason: unknown): void {
  const event = new Event('unhandledrejection');
  Object.assign(event, { reason });
  globalThis.dispatchEvent(event);
}
