// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import CommandPalette from '../src/ui/CommandPalette.svelte';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Phase C of the UI audit: the command palette's missing conventions.
 *
 * Three contracts pinned here:
 *
 * 1. **Command MRU.** With an empty query, this session's recently executed
 *    commands float to the top most-recent-first, skipping any that are
 *    disabled right now. With a query the ranking is pure fuzzy score — no
 *    recency blending (decision: predictability over cleverness on a small
 *    command set).
 * 2. **Keyword-hit honesty.** A command matched only through its `keywords`
 *    renders a chip naming the keyword, so a row with zero highlighted
 *    characters does not look like a mis-hit. Title matches get no chip.
 * 3. **True counts.** The header count reads the real match total, not the
 *    sliced row count: plain "N" when everything is shown, "first M of N"
 *    when the display cap truncated.
 *
 * Mutation-checked on 2026-08-19: removing the MRU float in
 * `commandRows` (empty-query order reverts to registration order) fails the
 * first two tests; returning `total: rows.length` from `commandRows` (the
 * pre-fix behaviour) fails the capped-count test with "200" instead of
 * "first 200 of N".
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/** A fresh unbooted app, same construction `mountComponent` would use. */
function makeApp(): NoxApp {
  return new NoxApp(new MemoryPlatform());
}

function rowLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.row .label')].map((el) => el.textContent?.trim() ?? '');
}

function setQuery(container: HTMLElement, value: string): void {
  const input = container.querySelector('input')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flush();
}

describe('command MRU', () => {
  it('floats recently executed commands to the top at empty query, skipping disabled ones', async () => {
    const app = makeApp();
    let gammaEnabled = true;
    app.commands.register({ id: 'test.alpha', title: 'Alpha', category: 'MRU', run: () => {} });
    app.commands.register({ id: 'test.beta', title: 'Beta', category: 'MRU', run: () => {} });
    app.commands.register({
      id: 'test.gamma',
      title: 'Gamma',
      category: 'MRU',
      enabled: () => gammaEnabled,
      run: () => {},
    });

    await app.commands.execute('test.alpha');
    await app.commands.execute('test.beta');
    await app.commands.execute('test.gamma');
    // Executed while enabled, disabled since: it must not float.
    gammaEnabled = false;

    mounted = mountComponent(CommandPalette, { props: { mode: 'palette' as const }, app });
    flush();

    const labels = rowLabels(mounted.container);
    expect(labels[0]).toBe('MRU: Beta');
    expect(labels[1]).toBe('MRU: Alpha');
    // Gamma is still listed (greyed), just not floated.
    expect(labels.slice(0, 2)).not.toContain('MRU: Gamma');
    expect(labels).toContain('MRU: Gamma');
  });

  it('ranks by fuzzy score alone once a query is typed', async () => {
    const app = makeApp();
    app.commands.register({ id: 'test.alpha', title: 'Alphaword', category: 'MRU', run: () => {} });
    app.commands.register({ id: 'test.beta', title: 'Betaword', category: 'MRU', run: () => {} });

    // Alpha is the most recent — at an empty query it would rank first.
    await app.commands.execute('test.beta');
    await app.commands.execute('test.alpha');

    mounted = mountComponent(CommandPalette, { props: { mode: 'palette' as const }, app });
    flush();
    expect(rowLabels(mounted.container)[0]).toBe('MRU: Alphaword');

    // But the query names Beta, and the query wins outright.
    setQuery(mounted.container, '>betaword');
    expect(rowLabels(mounted.container)[0]).toBe('MRU: Betaword');
  });
});

describe('keyword-hit honesty', () => {
  it('shows a chip naming the keyword on a keyword-won match, and none on a title match', () => {
    const app = makeApp();
    app.commands.register({
      id: 'test.kw',
      title: 'Plainname',
      category: 'MRU',
      keywords: ['zebrastripe'],
      run: () => {},
    });

    mounted = mountComponent(CommandPalette, { props: { mode: 'palette' as const }, app });
    flush();

    const rowFor = (label: string) =>
      [...mounted!.container.querySelectorAll('.row')].find(
        (row) => row.querySelector('.label')?.textContent?.trim() === label,
      );

    // Matched only through the keyword: the chip says why the row is here.
    setQuery(mounted.container, '>zebrastripe');
    let row = rowFor('MRU: Plainname');
    expect(row).toBeDefined();
    expect(row!.querySelector('.keyword')?.textContent?.trim()).toBe('zebrastripe');

    // Matched by title: highlights carry the explanation, no chip.
    setQuery(mounted.container, '>plainname');
    row = rowFor('MRU: Plainname');
    expect(row).toBeDefined();
    expect(row!.querySelector('.keyword')).toBeNull();
  });
});

describe('true counts', () => {
  it('renders the plain total when nothing was sliced off', () => {
    const app = makeApp();
    app.commands.register({
      id: 'test.kw',
      title: 'Plainname',
      category: 'MRU',
      keywords: ['zebrastripe'],
      run: () => {},
    });

    mounted = mountComponent(CommandPalette, { props: { mode: 'palette' as const }, app });
    flush();
    setQuery(mounted.container, '>zebrastripe');

    const shown = mounted.container.querySelectorAll('.row').length;
    const count = mounted.container.querySelector('.result-count')!.textContent.trim();
    expect(count).toBe(String(shown));
    expect(count).not.toContain('first');
  });

  it('says "first M of N" when the 200-command cap truncates the list', () => {
    const app = makeApp();
    for (let i = 0; i < 210; i++) {
      app.commands.register({ id: `bulk.${i}`, title: `Bulk ${i}`, run: () => {} });
    }

    mounted = mountComponent(CommandPalette, { props: { mode: 'palette' as const }, app });
    flush();

    expect(mounted.container.querySelectorAll('.row').length).toBe(200);
    const count = mounted.container.querySelector('.result-count')!.textContent.trim();
    const parsed = /^first 200 of (\d+)$/.exec(count);
    expect(parsed, count).not.toBeNull();
    // The real total: the 210 bulk commands plus whatever the app registers.
    expect(Number(parsed![1])).toBeGreaterThanOrEqual(210);
  });
});
