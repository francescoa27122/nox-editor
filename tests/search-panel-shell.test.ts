// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import SearchPanel from '../src/ui/SearchPanel.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The search panel's shell — its header and its three empty states.
 *
 * A UI walk on 2026-08-23 found Search was the one sidebar panel with neither.
 * Notes, Problems, References and Git all announce themselves in a
 * `PanelHeader` and all say what they are waiting for in a `PanelEmpty`;
 * Search opened straight onto an input with a blank rectangle under it, and
 * the rectangle looked identical whether you had typed nothing or had typed
 * something with no matches.
 *
 * Nothing geometric here — the windowing tests next door own that, and they
 * are the ones that need `clientHeight` stubbed.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  flush();
}

const text = () => mounted!.container.textContent!.replace(/\s+/g, ' ');

describe('the search panel shell', () => {
  it('names itself, like every other panel', () => {
    mounted = mountComponent(SearchPanel);
    flush();

    const header = mounted.container.querySelector('.panel-header h2');
    expect(header?.textContent?.trim()).toBe('Search');
  });

  it('asks for a folder before it asks for a query', () => {
    mounted = mountComponent(SearchPanel);
    flush();

    expect(mounted.container.querySelector('.panel-empty')).not.toBeNull();
    expect(text()).toContain('Open a folder to search it.');
  });

  it('says what it will do rather than showing an empty list', async () => {
    mounted = mountComponent(SearchPanel);
    mounted.platform.seedFile('/w/a.ts', 'needle\n');
    await mounted.app.workspace.openFolder('/w');
    await settle();

    // A folder, no query: the state that used to be a blank rectangle.
    expect(mounted.container.querySelector('.panel-empty')).not.toBeNull();
    expect(text()).toContain('Search every file in');
    // Named, so it is obvious *which* folder is about to be searched.
    expect(text()).toContain('w');
    expect(mounted.container.querySelector('.results')).toBeNull();
  });

  it('distinguishes "no matches" from "nothing typed yet"', async () => {
    mounted = mountComponent(SearchPanel);
    mounted.platform.seedFile('/w/a.ts', 'haystack\n');
    await mounted.app.workspace.openFolder('/w');
    mounted.app.search.query.set('needle');
    await mounted.app.search.run();
    await settle();

    expect(text()).toContain('No matches for');
    expect(text()).toContain('needle');
    // and it points at the reason a match might have been missed
    expect(text()).toContain('regular expressions');
  });

  it('shows the result list, and a header count, once there are matches', async () => {
    mounted = mountComponent(SearchPanel);
    mounted.platform.seedFile('/w/a.ts', 'needle here\nneedle again\n');
    await mounted.app.workspace.openFolder('/w');
    mounted.app.search.query.set('needle');
    await mounted.app.search.run();
    await settle();

    expect(mounted.container.querySelector('.results')).not.toBeNull();
    expect(mounted.container.querySelector('.panel-empty')).toBeNull();
    expect(mounted.container.querySelector('.panel-header .summary')?.textContent?.trim()).toBe(
      '2 in 1',
    );
  });

  /**
   * The header count is the glanceable half; the status line under the
   * controls owns the detail. An idle header must not assert a number.
   */
  it('keeps the header count blank while idle', async () => {
    mounted = mountComponent(SearchPanel);
    mounted.platform.seedFile('/w/a.ts', 'needle\n');
    await mounted.app.workspace.openFolder('/w');
    await settle();

    expect(mounted.container.querySelector('.panel-header .summary')).toBeNull();
  });
});
