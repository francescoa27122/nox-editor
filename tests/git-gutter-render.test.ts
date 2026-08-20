// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { gitGutterField } from '../src/editor/git-gutter';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The git gutter, painted in a real pane over a real service.
 *
 * The service computes hunks from a seeded base; the pane subscribes and
 * dispatches the effect; the gutter renders bars. What jsdom can prove is
 * the DOM — classes on the right gutter elements — not pixel geometry.
 *
 * Mutation-checked on 2026-08-19: the bars test fails when the pane stops
 * subscribing to `git.hunks`; the swap test fails when `paintGitGutter` is
 * not called after `syncToBuffer`'s `setState`; the keystroke test fails
 * when the field stops mapping through `tr.changes`; the setting test
 * fails when the `gitGutter` compartment case ignores the setting.
 */

const CHANGED = '/w/changed.ts';
const CLEAN = '/w/clean.ts';
const BASE = 'one\ntwo\nthree\nfour\n';

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

  platform.seedFile(CHANGED, 'one\nTWO\nthree\nfour\nfive\n');
  platform.seedGitBase(CHANGED, BASE);
  platform.seedFile(CLEAN, BASE);
  platform.seedGitBase(CLEAN, BASE);
  await app.workspace.openFolder('/w');

  const id = (await app.workspace.open(CHANGED))!;
  app.workspace.setActive(id);
  // Let the async base fetch land, then settle Svelte.
  await Promise.resolve();
  await Promise.resolve();
  flush();

  const view = EditorView.findFromDOM(container)!;
  return { app, container, view, id };
}

function bars(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('.cm-gitGutter .nox-git-marker')].map(
    (el) => el.className.replace('nox-git-marker ', ''),
  );
}

describe('the git gutter', () => {
  it('draws a bar for each changed line, with the kind as its class', async () => {
    const { container } = await setup();
    // Line 2 modified (two→TWO), line 5 added (five).
    expect(bars(container)).toEqual(['nox-git-marker-modified', 'nox-git-marker-added']);
  });

  // Swap-back shows bars even without a repaint — the field lives in the
  // buffer's own state and survives the swap. The test after the next one is
  // the one that catches a missing repaint.
  it('clears when the pane swaps to a clean buffer, and returns on swap back', async () => {
    const { app, container, id } = await setup();
    expect(bars(container)).toHaveLength(2);

    const clean = (await app.workspace.open(CLEAN))!;
    app.workspace.setActive(clean);
    await Promise.resolve();
    await Promise.resolve();
    flush();
    expect(bars(container)).toEqual([]);

    app.workspace.setActive(id);
    flush();
    expect(bars(container)).toHaveLength(2);
  });

  it('shifts the bars when a line is inserted above them, before any recompute', async () => {
    const { container, view } = await setup();
    // Freeze time so the service's debounce cannot fire and correct things:
    // what is asserted is the field's own mapping through the change.
    vi.useFakeTimers();

    view.dispatch({ changes: { from: 0, insert: '// new\n' } });
    flush();

    const gutterLinesShown = [
      ...container.querySelectorAll<HTMLElement>('.cm-gitGutter .cm-gutterElement'),
    ].filter((el) => el.querySelector('.nox-git-marker'));
    expect(gutterLinesShown).toHaveLength(2);
    // The modified mark sat on line 2; the insertion pushes it to line 3.
    // jsdom has no layout to read positions from, so the proof is the
    // field: the first mark's offset now sits on document line 3.
    expect(view.state.doc.lineAt(firstMarkPos(view)).number).toBe(3);
  });

  it('repaints on swap for hunks that changed while the buffer was in the background', async () => {
    const { app, container, id } = await setup();
    expect(bars(container)).toHaveLength(2);

    // Look away...
    const clean = (await app.workspace.open(CLEAN))!;
    app.workspace.setActive(clean);
    await Promise.resolve();
    await Promise.resolve();
    flush();

    // ...while the index catches up with the buffer (a stage made in the
    // terminal), with no document change to map the old marks away.
    mounted!.platform.seedGitBase(CHANGED, 'one\nTWO\nthree\nfour\nfive\n');
    await app.git.refreshAll();
    flush();

    // Swapping back must show the new truth, not the marks the buffer's own
    // state remembers — the state swap is exactly when the pane must re-ask.
    app.workspace.setActive(id);
    flush();
    expect(bars(container)).toEqual([]);
  });

  it('disappears when the setting is off, and comes back on', async () => {
    const { app, container } = await setup();
    expect(container.querySelector('.cm-gitGutter')).not.toBeNull();

    app.config.set('editor.gitGutter', false);
    flush();
    expect(container.querySelector('.cm-gitGutter')).toBeNull();

    app.config.set('editor.gitGutter', true);
    flush();
    expect(container.querySelector('.cm-gitGutter')).not.toBeNull();
    expect(bars(container)).toHaveLength(2);
  });

  it('leaves the provenance gutter alone', async () => {
    const { container } = await setup();
    expect(container.querySelectorAll('.cm-provenanceGutter .nox-provenance-marker')).toHaveLength(
      0,
    );
  });
});

function firstMarkPos(view: EditorView): number {
  let pos = -1;
  view.state.field(gitGutterField).between(0, view.state.doc.length, (from) => {
    if (pos === -1) pos = from;
    return false;
  });
  return pos;
}
