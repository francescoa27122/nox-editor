// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { mirroredAnnotation } from '../src/services/transactions';
import { WorkspaceService } from '../src/services/workspace';

/**
 * Where the cursor is after a save reformats the document, and after an
 * external reload.
 *
 * Guards A3-005. Both paths used to replace `[0, length)` with the new text
 * as one change, and CodeMirror maps every position strictly inside a
 * replaced range to its start: the cursor landed at offset 0 on every save
 * of a file lacking its final newline, and on every external rewrite. Save
 * then also emitted `buffer-reset`, which made the pane `setState` and lose
 * its scroll position.
 *
 * A real `EditorView` is needed, because only the view's own selection shows
 * the mapping; a bare `EditorState` in `tests/workspace.test.ts` would pass
 * the save half by construction. Wired the way `EditorPane.svelte` wires it:
 * every transaction is routed through `applyTransaction`, a view dispatcher
 * accepts the buffer, and `buffer-reset` is answered with `setState`.
 *
 * Does not catch a cursor *inside* the span an external rewrite changed,
 * which lands at the start of that span; nor scroll position, which jsdom
 * cannot measure.
 */

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function setup(path: string, contents: string) {
  const platform = new MemoryPlatform();
  platform.seedFile(path, contents);
  const workspace = new WorkspaceService(platform, () => []);
  return { platform, workspace };
}

async function paneFor(workspace: WorkspaceService, path: string) {
  const id = (await workspace.open(path))!;
  const parent = document.createElement('div');
  document.body.appendChild(parent);

  const view: EditorView = new EditorView({
    state: workspace.stateOf(id)!,
    parent,
    dispatchTransactions: (transactions, instance) => {
      instance.update(transactions);
      for (const transaction of transactions) {
        if (transaction.annotation(mirroredAnnotation)) continue;
        workspace.applyTransaction(id, transaction, instance);
      }
    },
  });
  views.push(view);

  workspace.addViewDispatcher(
    (target, spec) => {
      if (target !== id) return false;
      view.dispatch(spec);
      return true;
    },
    { owner: view },
  );

  const resets: string[] = [];
  workspace.events.on('buffer-reset', ({ id: reset }) => {
    resets.push(reset);
    if (reset === id) view.setState(workspace.stateOf(id)!);
  });

  return { id, view, resets };
}

describe('the cursor across a save that reformats', () => {
  it('stays put when the final newline is added', async () => {
    const { platform, workspace } = setup('/w/a.txt', 'line one\nline two\nline three');
    const { id, view, resets } = await paneFor(workspace, '/w/a.txt');

    // An edit on the second line, cursor left just after it.
    view.dispatch({ changes: { from: 9, insert: 'X' }, selection: { anchor: 10 } });
    expect(view.state.selection.main.head).toBe(10);

    expect(await workspace.save(id, { insertFinalNewline: true })).toBe(true);

    expect(await platform.readTextFile('/w/a.txt')).toBe('line one\nXline two\nline three\n');
    expect(view.state.doc.toString()).toBe('line one\nXline two\nline three\n');
    expect(view.state.selection.main.head).toBe(10);
    expect(workspace.activeSnapshot()?.isDirty).toBe(false);
    // No `setState` for the pane: the newline arrived as a change.
    expect(resets).toEqual([]);
  });

  it('stays put when trailing whitespace before it is trimmed', async () => {
    const { platform, workspace } = setup('/w/a.txt', 'one   \ntwo\nthree\n');
    const { id, view } = await paneFor(workspace, '/w/a.txt');

    // Cursor on the third line: the trim on line one shifts it by three.
    view.dispatch({ selection: { anchor: 13 } });

    expect(await workspace.save(id, { trimTrailingWhitespace: true })).toBe(true);

    expect(await platform.readTextFile('/w/a.txt')).toBe('one\ntwo\nthree\n');
    expect(view.state.selection.main.head).toBe(10);
    expect(workspace.activeSnapshot()?.isDirty).toBe(false);
  });
});

describe('the cursor across an external reload', () => {
  it('stays put when a line is appended after it', async () => {
    const { platform, workspace } = setup('/w/a.txt', 'line one\nline two\nline three\n');
    const { id, view } = await paneFor(workspace, '/w/a.txt');
    view.dispatch({ selection: { anchor: 14 } });

    platform.seedFile('/w/a.txt', 'line one\nline two\nline three\nline four\n');
    expect(await workspace.reloadFromDisk(id)).toBe(true);

    expect(view.state.doc.toString()).toBe('line one\nline two\nline three\nline four\n');
    expect(view.state.selection.main.head).toBe(14);
    expect(workspace.activeSnapshot()?.isDirty).toBe(false);
  });

  it('maps through a rewrite of an earlier line', async () => {
    const { platform, workspace } = setup('/w/a.txt', 'line one\nline two\nline three\n');
    const { id, view } = await paneFor(workspace, '/w/a.txt');
    view.dispatch({ selection: { anchor: 14 } });

    // A formatter shortened the first line by two characters.
    platform.seedFile('/w/a.txt', 'line 1\nline two\nline three\n');
    expect(await workspace.reloadFromDisk(id)).toBe(true);

    expect(view.state.selection.main.head).toBe(12);
  });

  /**
   * The trimmed change must not cut between the halves of a surrogate pair,
   * where the two emoji share their high surrogate. The document is right
   * either way; what this holds is the cursor after it, which would otherwise
   * be mapped to a boundary inside the pair.
   */
  it('keeps a whole surrogate pair inside the rewritten span', async () => {
    const { platform, workspace } = setup('/w/a.txt', 'a\u{1F600}b\n');
    const { id, view } = await paneFor(workspace, '/w/a.txt');
    view.dispatch({ selection: { anchor: 3 } });

    platform.seedFile('/w/a.txt', 'a\u{1F601}b\n');
    expect(await workspace.reloadFromDisk(id)).toBe(true);

    expect(view.state.doc.toString()).toBe('a\u{1F601}b\n');
    expect(view.state.selection.main.head).toBe(3);
  });
});
