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
 */
export function mountComponent(
  Component: Component<Record<string, never>>,
  options?: { app?: NoxApp },
): Mounted {
  const app = options?.app ?? new NoxApp(new MemoryPlatform());

  // A container in the document, not a detached one: `AnswersPanel` (and
  // components like it) have a focus effect, and only elements attached to
  // `document.body` can hold focus in jsdom.
  const container = document.createElement('div');
  document.body.appendChild(container);

  const instance = mount(Harness, {
    target: container,
    props: { app, component: Component },
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
      // jsdom's `document` persists across tests in a file. Leaving the
      // container behind would let the next test's `container.querySelector`
      // find this test's DOM instead of its own.
      container.remove();
    },
  };
}

/** Settle Svelte's reactivity. `flushSync`, named for what a test means by it. */
export function flush(): void {
  flushSync();
}
