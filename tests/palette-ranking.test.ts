// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import CommandPalette from '../src/ui/CommandPalette.svelte';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * What Enter runs in the command palette, over the *real* command registry.
 *
 * This guards a ranking bug that was worse than a mis-sort. The palette
 * scored the rendered `"Category: Title"` label as one string and sorted on
 * score alone, so every tie fell to `Array.sort` being stable — which is to
 * say, to registration order in `app.ts`, by accident. Measured before the
 * fix, with a folder and a file open:
 *
 * - ">undo" ran `agents.undoLastSession`, which reverts an agent's edits
 *   across several files with no confirmation, instead of `edit.undo`. It is
 *   enabled exactly when an agent session has un-reverted changes — i.e. when
 *   a user typing "undo" most likely means their own last keystroke.
 * - ">close" ran `file.closeFolder` and dropped the whole workspace, instead
 *   of `file.close`.
 * - ">reference" ran `prefs.open`: "Preferences" contains r-e-f-e-r-e-n-c-e
 *   from index 0 and collects the first-character bonus, while "Language:
 *   Show References" pays the leading penalty for its category prefix. That
 *   is category *length* deciding the winner.
 * - ">rename", with no folder open, ran `notes.rename` over
 *   `lsp.renameSymbol` for the same reason: "Notes: " is a shorter prefix
 *   than "Language: ".
 *
 * Two fixtures because the two dangerous cases need opposite states: the
 * `close` case only bites once a folder is open, and the `rename` case only
 * shows once the Explorer command is out of the way.
 *
 * Assertions are on the rendered top row, not on a scoring helper, because
 * what Enter runs is the whole point.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  flush();
}

/** A real app with a folder and a file open — the ordinary working state. */
async function withFolder(): Promise<NoxApp> {
  const platform = new MemoryPlatform();
  platform.seedFile('/w/a.ts', 'const a = 1;\n');
  const app = new NoxApp(platform);
  await app.workspace.openFolder('/w');
  await app.files.setRoot('/w');
  await app.workspace.open('/w/a.ts');
  await settle();
  return app;
}

/** A real app with nothing open — how Nox starts. */
function empty(): NoxApp {
  return new NoxApp(new MemoryPlatform());
}

function open(app: NoxApp): HTMLElement {
  mounted = mountComponent(CommandPalette, { props: { mode: 'palette' as const }, app });
  flush();
  return mounted.container;
}

function setQuery(container: HTMLElement, value: string): void {
  const input = container.querySelector('input')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flush();
}

/** The label Enter would run: the first row, which is where the cursor sits. */
function topRow(container: HTMLElement, query: string): string {
  setQuery(container, `>${query}`);
  return container.querySelector('.row .label')?.textContent?.trim() ?? '';
}

describe('command palette ranking, with a folder and a file open', () => {
  const table: [query: string, expected: string][] = [
    ['undo', 'Edit: Undo'],
    ['close', 'File: Close File'],
    ['reference', 'Language: Show References'],
    ['save', 'File: Save'],
    ['rename', 'Explorer: Rename…'],
  ];

  for (const [query, expected] of table) {
    it(`">${query}" puts "${expected}" first`, async () => {
      const container = open(await withFolder());
      expect(topRow(container, query)).toBe(expected);
    });
  }
});

describe('command palette ranking, with nothing open', () => {
  it('">rename" prefers the shortest equally-good title, not the shortest category', () => {
    // All three Rename commands are disabled here, so nothing but the ranking
    // separates them. Before the fix "Notes: Rename Note" won on the strength
    // of a five-character category.
    const container = open(empty());
    expect(topRow(container, 'rename')).toBe('Explorer: Rename…');
  });

  it('">undo" still refuses to put the agent undo first', () => {
    const container = open(empty());
    expect(topRow(container, 'undo')).toBe('Edit: Undo');
  });
});

describe('command palette ranking, on synthetic commands', () => {
  it('a title hit beats a category hit of the same word', () => {
    const app = empty();
    app.commands.register({
      id: 'zz.category',
      title: 'Open Thing',
      category: 'Zebrastripe',
      run: () => {},
    });
    app.commands.register({
      id: 'zz.title',
      title: 'Zebrastripe Thing',
      category: 'Zz',
      run: () => {},
    });

    const container = open(app);
    expect(topRow(container, 'zebrastripe')).toBe('Zz: Zebrastripe Thing');
  });

  it('a tie is broken by the id, not by which command registered first', () => {
    const app = empty();
    // Registered late-id-first: with the old score-only sort, `Array.sort`
    // being stable meant this order *was* the ranking.
    app.commands.register({ id: 'zz.two', title: 'Widget Two', category: 'Zz', run: () => {} });
    app.commands.register({ id: 'zz.one', title: 'Widget One', category: 'Zz', run: () => {} });

    const container = open(app);
    expect(topRow(container, 'widget')).toBe('Zz: Widget One');
  });

  it('recency breaks a tie the query cannot, and never outranks a better match', async () => {
    const app = empty();
    app.commands.register({ id: 'zz.one', title: 'Widget One', category: 'Zz', run: () => {} });
    app.commands.register({ id: 'zz.two', title: 'Widget Two', category: 'Zz', run: () => {} });
    app.commands.register({ id: 'zz.three', title: 'Widget', category: 'Zz', run: () => {} });

    // `zz.two` would lose the id tie-break to `zz.one`; having just run it
    // puts it first — but only among rows the query scored identically.
    await app.commands.execute('zz.two');

    const container = open(app);
    expect(topRow(container, 'widget one')).toBe('Zz: Widget One');
    // "Widget" is the shorter title, so it wins before recency is consulted.
    expect(topRow(container, 'widget')).toBe('Zz: Widget');
  });
});

describe('the palette empty state', () => {
  it('names the query and points at an escape hatch instead of saying "No matches"', () => {
    const container = open(empty());
    setQuery(container, '>minimap');

    expect(container.querySelectorAll('.row').length).toBe(0);
    const empty_ = container.querySelector('.nox-empty')!;
    expect(empty_.querySelector('.empty-query')!.textContent).toContain('minimap');
    // The escape hatch: the prefixes that switch mode mid-typing.
    expect(empty_.querySelector('.empty-hint')!.textContent).toContain('@');
  });
});

describe('a disabled palette row', () => {
  it('says on hover that it is unavailable, and what usually causes that', () => {
    // Nothing is open, so every File: Save row is disabled.
    const container = open(empty());
    setQuery(container, '>save');

    const row = [...container.querySelectorAll('.row')].find(
      (r) => r.querySelector('.label')?.textContent?.trim() === 'File: Save',
    );
    expect(row).toBeDefined();
    expect(row!.classList.contains('disabled')).toBe(true);
    expect(row!.getAttribute('title')).toContain('unavailable right now');
  });

  it('an enabled row carries its chord in the tooltip', () => {
    const app = empty();
    const container = open(app);
    setQuery(container, '>go to file');

    const row = [...container.querySelectorAll('.row')].find(
      (r) => r.querySelector('.label')?.textContent?.trim() === 'Go: Go to File…',
    );
    expect(row).toBeDefined();
    const tooltip = row!.getAttribute('title') ?? '';
    expect(tooltip).toContain('Go: Go to File…');
    expect(tooltip).toContain(app.keymap.displayFor('nav.quickOpen')!);
    expect(tooltip).not.toContain('unavailable');
  });
});
