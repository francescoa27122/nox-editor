import { flushSync, mount, unmount as svelteUnmount, type Component } from 'svelte';
import { NoxApp } from '../../src/app';
import { MemoryPlatform } from '../../src/platform/memory';
import Harness from './Harness.svelte';

export interface Mounted {
  /** The element the component rendered into. Query this, not `document`. */
  container: HTMLElement;
  /** The same app the component is reading through context. */
  app: NoxApp;
  /** The app's platform, for seeding files with `mkdirp` / `seedFile`. */
  platform: MemoryPlatform;
  /** Tears the component down, running its `$effect` cleanups. */
  unmount(): void;
}

/**
 * Mount `Component` with a real app in context.
 *
 * Pass `app` to drive the same app the component is reading from; omit it
 * and one is built as `new NoxApp(new MemoryPlatform())` — constructed, not
 * booted, so there is no demo workspace and no platform detection to fight
 * under jsdom. See the spec's §5.
 *
 * Calling `unmount()` is the caller's responsibility; it does not run on
 * its own. A test whose assertions can throw before reaching a bare
 * `unmount()` at the end should call it from a `finally` or an `afterEach`
 * instead.
 *
 * Pass props via `options.props`; `Harness.svelte` spreads them onto
 * `Component` as `<Rendered {...props} />`. Props-free components need not
 * pass the option at all.
 *
 * Declared as an overload rather than one generic signature: callers see
 * only the first, checked against the real `P` of whatever component they
 * pass — `AnswersPanel`'s `{}` or `ConfirmDialog`'s `{ request:
 * ConfirmRequest }`. The implementation signature underneath is deliberately
 * wider (`Record<string, unknown>`, matching `Harness.svelte`'s own prop
 * type), which is what lets the body hand `Component` and `options.props`
 * to `Harness` without a cast.
 */
export function mountComponent<P extends Record<string, unknown>>(
  Component: Component<P>,
  options?: { props?: P; app?: NoxApp },
): Mounted;
export function mountComponent(
  Component: Component<Record<string, unknown>>,
  options?: { props?: Record<string, unknown>; app?: NoxApp },
): Mounted {
  const app = options?.app ?? new NoxApp(new MemoryPlatform());

  // A container in the document, not a detached one: `AnswersPanel` (and
  // components like it) have a focus effect, and only elements attached to
  // `document.body` can hold focus in jsdom.
  const container = document.createElement('div');
  document.body.appendChild(container);

  const instance = mount(Harness, {
    target: container,
    props: { app, component: Component, props: options?.props ?? {} },
  });

  return {
    container,
    app,
    // The app was just constructed above with a `MemoryPlatform`, or the
    // caller built it that way to pass in — see the doc comment on `app`.
    platform: app.platform as MemoryPlatform,
    unmount: () => {
      // Fire-and-forget: without `{ outro: true }` there is nothing to await.
      void svelteUnmount(instance);
      // Not because a leftover container would be reachable through the next
      // test's `container.querySelector` — that only searches descendants,
      // and a sibling container is not one. The real reasons: without
      // `svelteUnmount` above, the component stays subscribed to whatever
      // signals it reads. Without removing the container, it stays a child
      // of `document.body` for the rest of the file — `document.body` itself
      // accumulates one per test, and `document.activeElement` (or any other
      // `document`-level query) can still reach it, which matters because
      // lines 52-56 deliberately attach it there so the focus effect works.
      container.remove();
    },
  };
}

/** Settle Svelte's reactivity. `flushSync`, named for what a test means by it. */
export function flush(): void {
  flushSync();
}
