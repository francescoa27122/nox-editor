// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import TabBar from '../src/ui/TabBar.svelte';
import { flush, mountComponent } from './support/component';

/**
 * Keyboard navigation across the tab strip.
 *
 * What this guards: the strip is a `role="tablist"` with a roving tabindex —
 * every tab but the active one is `tabindex="-1"` — and it had no arrow-key
 * handling at all. Inside the widget, no tab other than the active one was
 * reachable from the keyboard by any means, which is a tablist promising a
 * contract it does not honour.
 */

let app: NoxApp | null = null;
let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
  app = null;
});

async function mountStrip() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  for (const name of ['a.ts', 'b.ts', 'c.ts']) platform.seedFile(`/w/${name}`, '\n');

  app = new NoxApp(platform);
  await app.workspace.openFolder('/w');
  const ids: string[] = [];
  for (const name of ['a.ts', 'b.ts', 'c.ts']) {
    const id = await app.workspace.open(`/w/${name}`);
    if (id) ids.push(id);
  }

  const groupId = app.workspace.groups.get()[0]!.id;
  const mounted = mountComponent(TabBar, { props: { groupId }, app });
  teardown = mounted.unmount;
  flush();
  return { app, ids, container: mounted.container };
}

const tabs = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];

/** Press a key on whichever tab is currently active, and settle the strip. */
async function press(container: HTMLElement, key: string): Promise<void> {
  const focused = tabs(container).find((tab) => tab.getAttribute('aria-selected') === 'true');
  focused?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  flush();
  // The focus move is queued as a microtask, so the roving tabindex has
  // already been rewritten by the time it runs.
  await Promise.resolve();
  flush();
}

describe('the tab strip', () => {
  it('moves along the strip with Left and Right, wrapping at both ends', async () => {
    const { app: instance, ids, container } = await mountStrip();
    expect(instance.workspace.activeId.get()).toBe(ids[2]);

    await press(container, 'ArrowRight');
    expect(instance.workspace.activeId.get()).toBe(ids[0]);

    await press(container, 'ArrowRight');
    expect(instance.workspace.activeId.get()).toBe(ids[1]);

    await press(container, 'ArrowLeft');
    expect(instance.workspace.activeId.get()).toBe(ids[0]);

    await press(container, 'ArrowLeft');
    expect(instance.workspace.activeId.get()).toBe(ids[2]);
  });

  it('jumps to the ends with Home and End', async () => {
    const { app: instance, ids, container } = await mountStrip();

    await press(container, 'Home');
    expect(instance.workspace.activeId.get()).toBe(ids[0]);

    await press(container, 'End');
    expect(instance.workspace.activeId.get()).toBe(ids[2]);
  });

  /**
   * The half that makes the rest usable: focus has to follow, because the tab
   * that was focused stops being focusable the moment it stops being active.
   * Without this the first arrow press would strand focus on the document.
   */
  it('takes focus with it, so the next arrow press has somewhere to land', async () => {
    const { container } = await mountStrip();

    await press(container, 'Home');
    expect(document.activeElement).toBe(tabs(container)[0]);
    expect(tabs(container)[0]?.getAttribute('tabindex')).toBe('0');
    expect(tabs(container)[1]?.getAttribute('tabindex')).toBe('-1');

    await press(container, 'ArrowRight');
    expect(document.activeElement).toBe(tabs(container)[1]);
  });

  it('leaves Enter and Space alone', async () => {
    const { app: instance, ids, container } = await mountStrip();

    await press(container, 'Enter');
    expect(instance.workspace.activeId.get()).toBe(ids[2]);
  });
});
