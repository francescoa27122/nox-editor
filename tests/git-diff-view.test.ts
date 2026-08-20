// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import DiffView from '../src/ui/DiffView.svelte';
import EditorPane from '../src/ui/EditorPane.svelte';
import { flush, mountComponent, type Mounted } from './support/component';
import { installRangeRects } from './support/jsdom-layout';

// The gutter's mousedown path runs a measure, and jsdom's `Range` lacks
// `getClientRects`. See `tests/support/jsdom-layout.ts` for what is invented.
installRangeRects();

/**
 * The diff view over a real app, a real GitService and seeded bases.
 *
 * Mutation-checked on 2026-08-19 against the component and `src/app.ts`:
 * the follow test fails when the view stops deriving from `activeId`; the
 * layout test fails when the toggle stops writing the setting; the
 * clean-file bump lives in `tests/git-service.test.ts` (jsdom cannot stage
 * the race — the base lands before the first paint); the surface test
 * fails when `showDiff` stops clearing
 * `agentsOpen`; the gutter test fails when the pane's mousedown filter is
 * removed.
 */

const CHANGED = '/w/changed.ts';
const CLEAN = '/w/clean.ts';
const LOOSE = '/w/loose.ts';
const BASE = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';
const EDITED = 'one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nten\n';

let pane: Mounted | null = null;
let panel: Mounted | null = null;

afterEach(() => {
  panel?.unmount();
  pane?.unmount();
  panel = pane = null;
});

async function setup() {
  pane = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
  const { app, platform } = pane;
  app.git.start();
  panel = mountComponent(DiffView, { app });

  platform.seedFile(CHANGED, EDITED);
  platform.seedGitBase(CHANGED, BASE);
  platform.seedFile(CLEAN, BASE);
  platform.seedGitBase(CLEAN, BASE);
  platform.seedFile(LOOSE, 'untracked\n');
  await app.workspace.openFolder('/w');

  const id = (await app.workspace.open(CHANGED))!;
  app.workspace.setActive(id);
  await Promise.resolve();
  await Promise.resolve();
  flush();
  return { app, id, platform };
}

function body(): string {
  return panel!.container.textContent!.replace(/\s+/g, ' ');
}

describe('the surface', () => {
  it('opens through Show Changes, clearing the other editor-area surfaces', async () => {
    const { app } = await setup();
    app.ui.agentsOpen.set(true);

    await app.commands.execute('git.showDiff');

    expect(app.ui.diffOpen.get()).toBe(true);
    expect(app.ui.agentsOpen.get()).toBe(false);
    expect(app.ui.reviewOpen.get()).toBe(false);
  });

  it('is dismissed by dismissTop, below review in the order', async () => {
    const { app } = await setup();
    app.ui.showDiff();
    expect(app.ui.hasDismissible()).toBe(true);
    expect(app.ui.dismissTop()).toBe(true);
    expect(app.ui.diffOpen.get()).toBe(false);
  });

  it('survives a tab switch — the deliberate deviation from review and agents', async () => {
    const { app } = await setup();
    app.ui.showDiff();

    const clean = (await app.workspace.open(CLEAN))!;
    app.workspace.setActive(clean);
    flush();

    expect(app.ui.diffOpen.get()).toBe(true);
  });
});

describe('the rendering', () => {
  it('shows the changed line in both columns with real line numbers', async () => {
    await setup();
    flush();

    const removed = panel!.container.querySelector<HTMLElement>('.cell.text.removed');
    const added = panel!.container.querySelector<HTMLElement>('.cell.text.added');
    expect(removed?.textContent).toBe('five');
    expect(added?.textContent).toBe('FIVE');
    // Line 5 on both sides; the numbers around the change are visible.
    const nums = [...panel!.container.querySelectorAll<HTMLElement>('.cell.num')].map(
      (el) => el.textContent,
    );
    expect(nums).toContain('5');
    expect(body()).toContain('1 change against the index');
  });

  it('folds the far context and expands on click', async () => {
    await setup();
    flush();

    // Ten lines, one change at line 5 with 3 context either side: lines 1
    // and 9-10 fold — one line hidden above, two below... the exact counts
    // are the core suite's business; what this proves is a fold exists and
    // the click removes every fold.
    const fold = panel!.container.querySelector<HTMLElement>('.fold');
    expect(fold).not.toBeNull();
    fold!.click();
    flush();
    expect(panel!.container.querySelector('.fold')).toBeNull();
    // Every line is now present.
    expect(body()).toContain('ten');
  });

  it('switches layout through the toggle, and the toggle writes the setting', async () => {
    const { app } = await setup();
    flush();
    expect(panel!.container.querySelector('.table.side')).not.toBeNull();

    const inlineButton = [...panel!.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Inline',
    )!;
    inlineButton.click();
    flush();

    expect(app.config.get('workbench.diffLayout')).toBe('inline');
    expect(panel!.container.querySelector('.table.inline')).not.toBeNull();
    // Inline shows a − row then a + row for the one hunk.
    const texts = [...panel!.container.querySelectorAll<HTMLElement>('.cell.text')].map((el) =>
      el.textContent?.trim(),
    );
    expect(texts).toContain('−five');
    expect(texts).toContain('+FIVE');
    app.config.set('workbench.diffLayout', 'side-by-side');
  });

  it('follows the active buffer to a clean file and says there is nothing', async () => {
    const { app } = await setup();
    app.ui.showDiff();
    flush();
    expect(body()).toContain('1 change');

    const clean = (await app.workspace.open(CLEAN))!;
    app.workspace.setActive(clean);
    await Promise.resolve();
    await Promise.resolve();
    flush();

    expect(body()).toContain('No changes');
  });

  it('says so for an untracked file rather than guessing', async () => {
    const { app } = await setup();
    const loose = (await app.workspace.open(LOOSE))!;
    app.workspace.setActive(loose);
    await Promise.resolve();
    await Promise.resolve();
    flush();

    expect(body()).toContain('Git has no base for this file');
  });
});

describe('the gutter opening', () => {
  it('opens the view on a mousedown in the git gutter', async () => {
    const { app } = await setup();
    expect(app.ui.diffOpen.get()).toBe(false);

    const gutter = pane!.container.querySelector<HTMLElement>('.cm-gitGutter');
    expect(gutter).not.toBeNull();
    gutter!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await Promise.resolve();
    flush();

    expect(app.ui.diffOpen.get()).toBe(true);
  });

  it('leaves other mousedowns alone', async () => {
    const { app } = await setup();
    const content = pane!.container.querySelector<HTMLElement>('.cm-content');
    content?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await Promise.resolve();
    expect(app.ui.diffOpen.get()).toBe(false);
  });
});
