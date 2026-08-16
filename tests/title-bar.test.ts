// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import TitleBar from '../src/ui/TitleBar.svelte';
import { flush, mountComponent } from './support/component';

/**
 * A workspace at `/w` with one file three directories deep, opened.
 *
 * The depth is the point: a trail of one segment cannot tell "clicked the
 * folder" from "clicked the file", and this feature is entirely about which
 * segment was clicked.
 */
async function setup() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w/src/ui');
  platform.seedFile('/w/src/ui/TitleBar.svelte', '<script></script>\n');
  platform.seedFile('/w/README.md', '# w\n');

  const app = new NoxApp(platform);
  await app.workspace.openFolder('/w');
  await app.files.setRoot('/w');
  await app.workspace.open('/w/src/ui/TitleBar.svelte');

  return { app, platform };
}

/**
 * Let the click handler's promise chain finish.
 *
 * The handler is fire-and-forget in the component — a click cannot await —
 * and revealing awaits several directory reads. A microtask is not enough;
 * a macrotask is, because `MemoryPlatform` reads resolve immediately rather
 * than doing real I/O.
 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The breadcrumb's segments, in order, whatever element they render as. */
const crumbTexts = (container: HTMLElement): (string | null)[] =>
  [...container.querySelectorAll('.crumb')].map((node) => node.textContent);

describe('the breadcrumb trail', () => {
  /**
   * The failure this prevents: a trail that renders the whole absolute path,
   * or the bare filename, either of which stops answering "where am I in this
   * project" — the question the title bar exists to answer.
   */
  it('shows the file path relative to the workspace root', async () => {
    const { app } = await setup();
    const { container, unmount } = mountComponent(TitleBar, { app });
    flush();

    expect(crumbTexts(container)).toEqual(['src', 'ui', 'TitleBar.svelte']);

    unmount();
  });
});

describe('clicking a breadcrumb segment', () => {
  /**
   * The failure this prevents: `files.reveal()` stops one directory short by
   * design — its comment says "The final segment is the file itself, so stop
   * one short" — so revealing `/w/src/ui` expands `/w/src` and leaves `ui`
   * itself closed. Clicking a folder and watching only its parent open is the
   * whole feature failing quietly.
   *
   * `collapseAll()` first, and that is the substance of the test rather than
   * setup noise. Opening a file already expands every ancestor — `app.ts`
   * reveals on `buffer-opened` so the tree never disagrees with the active
   * tab — and every folder crumb *is* an ancestor of the open file. So with a
   * freshly opened file the folder is expanded before anything is clicked,
   * and an assertion made there passes against a component that does nothing
   * at all. Collapsing first is what makes the click the only thing that
   * could have opened it.
   */
  it('expands the clicked folder itself, not just its parent', async () => {
    const { app } = await setup();
    app.files.collapseAll();
    expect(app.files.isExpanded('/w/src/ui')).toBe(false);

    const { container, unmount } = mountComponent(TitleBar, { app });
    flush();

    const ui = [...container.querySelectorAll('.crumb')][1] as HTMLElement;
    ui.click();
    await settled();
    flush();

    expect(app.files.isExpanded('/w/src/ui')).toBe(true);
    // Its parent too, which is what makes the folder reachable in the tree.
    expect(app.files.isExpanded('/w/src')).toBe(true);

    unmount();
  });

  /**
   * The failure this prevents: expanding the folder offscreen. The explorer
   * only scrolls its lead row into view (`ExplorerPanel.svelte`), so without
   * setting the lead the tree opens somewhere the user cannot see, which
   * reads as nothing having happened.
   */
  it('selects the folder so the explorer scrolls to it', async () => {
    const { app } = await setup();
    const { container, unmount } = mountComponent(TitleBar, { app });
    flush();

    const ui = [...container.querySelectorAll('.crumb')][1] as HTMLElement;
    ui.click();
    await settled();
    flush();

    expect(app.ui.explorer.lead.get()).toBe('/w/src/ui');

    unmount();
  });

  /**
   * The failure this prevents: revealing into a panel that is not on screen.
   * `file.revealInExplorer` turns the setting on for exactly this reason, and
   * a second entry point that forgets to would work only when the explorer
   * happened to be open already.
   */
  it('opens the explorer if it was hidden', async () => {
    const { app } = await setup();
    app.config.set('workbench.showExplorer', false);
    const { container, unmount } = mountComponent(TitleBar, { app });
    flush();

    const ui = [...container.querySelectorAll('.crumb')][1] as HTMLElement;
    ui.click();
    await settled();
    flush();

    expect(app.config.get('workbench.showExplorer')).toBe(true);

    unmount();
  });

  /**
   * The failure this prevents: treating the last segment as a directory and
   * asking the tree to expand a file. The leaf is the file you are already
   * looking at; revealing it is what `file.revealInExplorer` already does,
   * and expanding it is meaningless.
   */
  /**
   * The failure this prevents: offering a button for a file that is not in
   * the workspace. `files.reveal` returns early when the path is not under
   * the root, so such a crumb would highlight on hover, take the click, and
   * do nothing — worse than plain text, which at least promises nothing.
   *
   * A file outside the root is ordinary: the explorer watches one root, and
   * opening anything from elsewhere on disk lands here.
   */
  it('does not make a crumb clickable for a file outside the workspace', async () => {
    const { app, platform } = await setup();
    platform.mkdirp('/elsewhere');
    platform.seedFile('/elsewhere/notes.md', 'outside the workspace\n');
    await app.workspace.open('/elsewhere/notes.md');
    const { container, unmount } = mountComponent(TitleBar, { app });
    flush();

    expect(crumbTexts(container)).toEqual(['elsewhere', 'notes.md']);
    expect(container.querySelectorAll('button.crumb')).toHaveLength(0);

    unmount();
  });

  it('reveals the file without expanding it when the leaf is clicked', async () => {
    const { app } = await setup();
    // Same reason as the folder case: without collapsing, the open file's
    // ancestors are already expanded and the assertion below proves nothing.
    app.files.collapseAll();

    const { container, unmount } = mountComponent(TitleBar, { app });
    flush();

    const leaf = [...container.querySelectorAll('.crumb')][2] as HTMLElement;
    leaf.click();
    await settled();
    flush();

    expect(app.ui.explorer.lead.get()).toBe('/w/src/ui/TitleBar.svelte');
    expect(app.files.isExpanded('/w/src/ui/TitleBar.svelte')).toBe(false);
    // Its containing directory is open, which is what "reveal" means.
    expect(app.files.isExpanded('/w/src/ui')).toBe(true);

    unmount();
  });
});
