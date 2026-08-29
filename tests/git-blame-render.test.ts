// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { gitBlameField } from '../src/editor/git-blame';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The blame gutter, painted in a real pane over a real service.
 *
 * The service parses what the memory platform renders as porcelain; the pane
 * installs the gutter and dispatches the marks; the gutter draws labels. What
 * jsdom can prove is the DOM and the field — not pixel geometry, so nothing
 * here asserts where a column sits.
 *
 * The one thing this file exists for that no headless test can reach: the
 * gutter is installed by *runtime state* rather than by a setting, through a
 * compartment the pane reconfigures. That wiring — install on toggle, remove
 * on toggle, re-apply after a `setState` that resets every compartment — has
 * no other coverage.
 */

const FILE = '/w/blamed.ts';
const OTHER = '/w/other.ts';
const TEXT = 'one\ntwo\nthree\n';

const FIRST = 'a'.repeat(40);
const SECOND = 'b'.repeat(40);
const SEED = [
  { hash: FIRST, author: 'Jane Doe', summary: 'Add three lines' },
  { hash: SECOND, author: 'Bo', summary: 'Shout the middle one' },
  { hash: FIRST, author: 'Jane Doe', summary: 'Add three lines' },
];

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
});

async function setup() {
  mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
  const { app, platform, container } = mounted;
  app.git.start();

  platform.seedFile(FILE, TEXT);
  platform.seedGitBase(FILE, TEXT);
  platform.seedGitBlame(FILE, SEED);
  platform.seedFile(OTHER, TEXT);
  platform.seedGitBase(OTHER, TEXT);
  await app.workspace.openFolder('/w');

  const id = (await app.workspace.open(FILE))!;
  app.workspace.setActive(id);
  await Promise.resolve();
  await Promise.resolve();
  flush();

  const view = EditorView.findFromDOM(container)!;
  return { app, container, view, id };
}

/**
 * The gutter's real entries, in order.
 *
 * The first `.nox-blame-entry` in the column is CodeMirror's width spacer —
 * `initialSpacer`, which it renders with `visibility: hidden` so the column
 * holds its width before any marks arrive. Its label is all spaces, which is
 * what separates it from a real one here.
 */
function entries(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.cm-blameGutter .nox-blame-entry')].filter(
    (el) => el.textContent.trim().length > 0,
  );
}

/** Their labels, trimmed of the padding that keeps the column still. */
function labels(container: HTMLElement): string[] {
  return entries(container).map((el) => el.textContent.trim());
}

function firstMarkPos(view: EditorView): number {
  let pos = -1;
  view.state.field(gitBlameField).between(0, view.state.doc.length, (from) => {
    if (pos === -1) pos = from;
    return false;
  });
  return pos;
}

describe('the blame gutter', () => {
  it('is absent until blame is switched on, then names a commit per line', async () => {
    const { app, container, id } = await setup();
    expect(container.querySelector('.cm-blameGutter')).toBeNull();

    await app.git.toggleBlame(id);
    flush();

    expect(labels(container)).toEqual([
      'aaaaaaa Jane Doe',
      'bbbbbbb Bo',
      'aaaaaaa Jane Doe',
    ]);
  });

  it('carries the full identity and subject in the hover text', async () => {
    const { app, container, id } = await setup();
    await app.git.toggleBlame(id);
    flush();

    const first = entries(container)[0]!;
    expect(first.title).toContain('Jane Doe <dev@example.com>');
    expect(first.title).toContain('Add three lines');
  });

  it('takes the whole column away again when blame is switched off', async () => {
    const { app, container, id } = await setup();
    await app.git.toggleBlame(id);
    flush();
    expect(container.querySelector('.cm-blameGutter')).not.toBeNull();

    await app.git.toggleBlame(id);
    flush();
    expect(container.querySelector('.cm-blameGutter')).toBeNull();
  });

  /**
   * Between fetches the marks map through edits rather than being recomputed
   * — recomputing means spawning `git blame`. An inserted line pushes every
   * mark down and takes none for itself, which is the honest answer: nobody
   * has committed that line, and the gutter must not lend it the name of the
   * line it displaced.
   */
  it('shifts its marks when a line is inserted above them, and claims none for it', async () => {
    const { app, container, view, id } = await setup();
    await app.git.toggleBlame(id);
    flush();
    // Freeze time so nothing the service schedules can fire and correct
    // things: what is asserted is the field's own mapping.
    vi.useFakeTimers();

    view.dispatch({ changes: { from: 0, insert: '// new\n' } });
    flush();

    expect(view.state.doc.lineAt(firstMarkPos(view)).number).toBe(2);
    // Still three names for three blamed lines — the new line took none.
    expect(labels(container)).toHaveLength(3);
  });

  /**
   * `setState` resets every compartment to the state's own configuration, so
   * the gutter has to be re-applied on each swap — the trap `lspCompartment`
   * documents. Swapping to a buffer blame is off for must take the column
   * away, and swapping back must bring it and the names with it.
   */
  it('follows the buffer across a tab swap, in both directions', async () => {
    const { app, container, id } = await setup();
    await app.git.toggleBlame(id);
    flush();
    expect(labels(container)).toHaveLength(3);

    const other = (await app.workspace.open(OTHER))!;
    app.workspace.setActive(other);
    await Promise.resolve();
    await Promise.resolve();
    flush();
    expect(container.querySelector('.cm-blameGutter')).toBeNull();

    app.workspace.setActive(id);
    flush();
    expect(labels(container)).toHaveLength(3);
  });

  /**
   * The gutter and the git gutter are siblings that must be able to
   * disagree: one answers "what does git not have yet", the other "who wrote
   * this". Switching blame on must not disturb the bars beside it.
   */
  it('leaves the git gutter alone', async () => {
    const { app, container, id } = await setup();
    expect(container.querySelector('.cm-gitGutter')).not.toBeNull();

    await app.git.toggleBlame(id);
    flush();

    expect(container.querySelector('.cm-gitGutter')).not.toBeNull();
    expect(container.querySelector('.cm-blameGutter')).not.toBeNull();
  });
});
