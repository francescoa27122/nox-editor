// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { flush, mountComponent, type Mounted } from './support/component';
import { installRangeRects } from './support/jsdom-layout';

// `workspace.apply` dispatches with scrollIntoView, and CodeMirror measures
// for it; jsdom has no geometry. See `tests/support/jsdom-layout.ts`.
installRangeRects();

/**
 * After-delay autosave, through the real pane and an in-memory disk.
 *
 * Guards A1-002: the timer read the pane's *current* buffer when it fired,
 * so typing in A and switching to B inside the delay saved B (clean, so
 * nothing) and left A dirty until it was edited again. The buffer the timer
 * is armed for is now captured when it is armed, and leaving that buffer
 * flushes the pending save rather than leaving a timer aimed at a tab the
 * pane no longer shows.
 *
 * Does not catch: the on-focus-change mode, or a pane destroyed with a
 * pending save (that timer is still cleared, not flushed).
 */

const A = '/w/a.txt';
const B = '/w/b.txt';

let mounted: Mounted | null = null;

afterEach(() => {
  vi.useRealTimers();
  mounted?.unmount();
  mounted = null;
});

async function setup() {
  mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
  const { app, platform, container } = mounted;
  platform.seedFile(A, 'alpha');
  platform.seedFile(B, 'beta');
  await app.workspace.openFolder('/w');
  app.config.set('files.autoSave', 'afterDelay');
  app.config.set('files.autoSaveDelay', 1000);

  const a = (await app.workspace.open(A))!;
  const b = (await app.workspace.open(B))!;
  app.workspace.setActive(a);
  flush();
  const view = EditorView.findFromDOM(container)!;
  return { app, platform, view, a, b };
}

function typeInto(view: EditorView, text: string) {
  view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input.type' });
  flush();
}

describe('after-delay autosave', () => {
  it('saves the buffer that was edited, not the one the pane shows when the delay elapses', async () => {
    const { app, platform, view, a, b } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    typeInto(view, ' typed');
    // Well inside the delay: the timer is still pending when the pane moves on.
    app.workspace.setActive(b);
    flush();

    await vi.advanceTimersByTimeAsync(1100);

    // The trailing newline is `files.insertFinalNewline`, applied by the save.
    expect(await platform.readTextFile(A)).toBe('alpha typed\n');
    expect(app.workspace.buffers.get().find((buffer) => buffer.id === a)?.isDirty).toBe(false);
    expect(await platform.readTextFile(B)).toBe('beta');
  });

  it('saves the edited buffer after the delay when the pane stays on it', async () => {
    const { platform, view } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    typeInto(view, ' typed');
    await vi.advanceTimersByTimeAsync(500);
    expect(await platform.readTextFile(A)).toBe('alpha');

    await vi.advanceTimersByTimeAsync(600);
    expect(await platform.readTextFile(A)).toBe('alpha typed\n');
  });
});
