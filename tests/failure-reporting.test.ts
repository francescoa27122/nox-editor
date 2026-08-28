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
 * The other half of the backstop, and for a long time there was only one.
 *
 * `unhandledrejection` fires for a rejected promise. A *synchronous* throw —
 * from a Svelte effect, a DOM event handler, a CodeMirror extension — fires
 * `error` instead, and nothing listened for it: no toast, no log, and no
 * console to read in the release webview. The only symptom was the UI
 * quietly stopping.
 */
describe('the uncaught-error backstop', () => {
  it('turns a synchronous throw nothing caught into an error notification', () => {
    app = new NoxApp(new MemoryPlatform());

    dispatchError({ error: new Error('an effect threw') });

    const toast = app.notifications.items.get()[0];
    expect(toast?.message).toBe('Something went wrong');
    expect(toast?.kind).toBe('error');
    expect(toast?.detail).toBe('an effect threw');
  });

  /**
   * A cross-origin script error is sanitised by the spec to a bare message
   * with no `error` object. Reporting the message is still better than
   * reporting nothing.
   */
  it('falls back to the message when the error object was withheld', () => {
    app = new NoxApp(new MemoryPlatform());

    dispatchError({ message: 'Script error.' });

    expect(app.notifications.items.get()[0]?.detail).toBe('Script error.');
  });

  /**
   * A failed image or lazily imported chunk raises `error` too, carrying
   * neither field. Turning those into "Something went wrong" would put a
   * sticky error toast on screen for something that is not a script failure.
   */
  it('says nothing for a resource error, which carries neither field', () => {
    app = new NoxApp(new MemoryPlatform());

    dispatchError({});

    expect(messages(app)).toEqual([]);
  });

  /**
   * The regression 0.9.0 shipped, reported from a real first launch.
   *
   * `ResizeObserver loop …` is not a failure. The browser raises it when an
   * observer callback resizes something and the loop needs another pass, and
   * the specification calls for exactly that. It arrives with a message and
   * no `error` object — the same shape as a cross-origin script error — so
   * the fallback for that case reported it, and a new user's first launch
   * opened with a red "Something went wrong". Nox has five `ResizeObserver`s
   * and start-up is when panels measure themselves, so first launch is where
   * it is likeliest.
   */
  it('says nothing about a ResizeObserver loop, which is not a failure', () => {
    app = new NoxApp(new MemoryPlatform());

    dispatchError({ message: 'ResizeObserver loop completed with undelivered notifications.' });
    // The older spelling, which Chrome used before the current one.
    dispatchError({ message: 'ResizeObserver loop limit exceeded' });

    expect(messages(app)).toEqual([]);
  });

  /**
   * The same thing again, through a **real `ErrorEvent`** rather than a plain
   * `Event` with fields assigned onto it.
   *
   * This is the test that was missing, and its absence is why the filter above
   * passed for a release while the toast kept appearing. `dispatchError` builds
   * an `Event` and `Object.assign`s what the caller names, so an unnamed
   * `error` is *absent* — `undefined`. A real `ErrorEvent` has `error` as an
   * own property, initialised to **null** when there is no exception object.
   *
   * `null !== undefined`, so the guard that read `error === undefined` never
   * fired in a browser. Found by forcing a ResizeObserver loop in the dev
   * server on 2026-08-28 and watching the red toast appear anyway.
   */
  it('says nothing about a ResizeObserver loop delivered as a real ErrorEvent', () => {
    app = new NoxApp(new MemoryPlatform());

    dispatchErrorEvent('ResizeObserver loop completed with undelivered notifications.');
    dispatchErrorEvent('ResizeObserver loop limit exceeded');

    expect(messages(app)).toEqual([]);
  });

  /**
   * The other half, also through a real event: a cross-origin script error is
   * sanitised to a bare message and `error: null` too, and must still report.
   * Without this, "ignore anything whose error is null" would look correct.
   */
  it('still reports a real ErrorEvent that is not a ResizeObserver loop', () => {
    app = new NoxApp(new MemoryPlatform());

    dispatchErrorEvent('Script error.');

    expect(app.notifications.items.get()[0]?.detail).toBe('Script error.');
  });

  /**
   * The narrow half of that filter. Code inside an observer callback can fail
   * like any other code, and that arrives *with* an `error` object — so
   * matching on the message alone would have silenced a real exception for
   * having the word ResizeObserver in it.
   */
  it('still reports a real error thrown inside an observer callback', () => {
    app = new NoxApp(new MemoryPlatform());

    dispatchError({
      error: new Error('ResizeObserver loop: measure() read a null element'),
      message: 'ResizeObserver loop: measure() read a null element',
    });

    expect(app.notifications.items.get()[0]?.message).toBe('Something went wrong');
  });

  it('stops listening once the app is disposed', async () => {
    const instance = new NoxApp(new MemoryPlatform());
    await instance.dispose();

    dispatchError({ error: new Error('after the window went away') });
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

/**
 * Same trick for `error`. Built from a plain `Event` rather than
 * `ErrorEvent` so a resource error — which carries neither field — can be
 * fired as well, which `new ErrorEvent()` would not let us express.
 *
 * Cancelled before it is fired, which is bookkeeping rather than behaviour:
 * the default action of an uncancelled `error` event is "report the
 * exception", and jsdom honours that by escalating it into a failure of
 * whichever test happens to be running. Nox's own handler does not cancel the
 * event in production, where the default action is a console line nobody can
 * read anyway.
 */
/**
 * A real `ErrorEvent`, which is what a browser actually delivers.
 *
 * Separate from `dispatchError` rather than replacing it: the synthetic shape
 * that helper builds is a genuine one too — Nox's own `globalThis` listener
 * sees plain `Event`s for resource failures — so both are worth covering. What
 * was missing was this one, where `error` is `null` rather than absent.
 */
function dispatchErrorEvent(message: string, error?: unknown): void {
  const event = new ErrorEvent('error', {
    message,
    cancelable: true,
    ...(error === undefined ? {} : { error }),
  });

  const cancel = (fired: Event) => fired.preventDefault();
  globalThis.addEventListener('error', cancel);
  try {
    globalThis.dispatchEvent(event);
  } finally {
    globalThis.removeEventListener('error', cancel);
  }
}

function dispatchError(fields: { error?: unknown; message?: string }): void {
  const event = new Event('error', { cancelable: true });
  Object.assign(event, fields);

  // Cancelled from *inside* the dispatch: the canceled flag does not survive
  // being set beforehand, so this has to be a listener like any other. Order
  // does not matter — Nox's handler and this one both run, and one
  // `preventDefault` is enough.
  const cancel = (fired: Event) => fired.preventDefault();
  globalThis.addEventListener('error', cancel);
  try {
    globalThis.dispatchEvent(event);
  } finally {
    globalThis.removeEventListener('error', cancel);
  }
}
