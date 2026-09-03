// @vitest-environment jsdom
import { ensureSyntaxTree, foldedRanges } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { NoxApp } from '../src/app';
import { languageCompartment, loadLanguage } from '../src/editor/languages';
import { MemoryPlatform } from '../src/platform/memory';
import { flush, mountComponent, type Mounted } from './support/component';
import { installRangeRects } from './support/jsdom-layout';

// `workspace.apply` dispatches with scrollIntoView, and CodeMirror measures
// for it; jsdom has no geometry. See `tests/support/jsdom-layout.ts`.
installRangeRects();

/**
 * One assertion per command that no other test named.
 *
 * `tests/command-coverage.test.ts` holds every command to being named by a
 * test, and this is where the ones with no natural home land: each is
 * executed through the registry and checked for the effect its title
 * promises, or, where the effect needs state no unit test can stage (a
 * staged review, a configured agent, a focused search row), checked for
 * the enablement rule that keeps it off until that state exists.
 *
 * Smoke, by design. A command here is known to be wired to the right
 * operation with the right argument shape; the operation's own edge cases
 * belong to the suite that owns the service.
 */

const A = '/w/a.txt';
const B = '/w/b.txt';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.restoreAllMocks();
});

async function pane(files: Record<string, string> = { [A]: 'one\ntwo\nthree\n' }) {
  mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
  const { app, platform, container } = mounted;
  for (const [path, text] of Object.entries(files)) platform.seedFile(path, text);
  await app.workspace.openFolder('/w');
  const ids: string[] = [];
  for (const path of Object.keys(files)) ids.push((await app.workspace.open(path))!);
  app.workspace.setActive(ids[0]!);
  flush();
  const view = EditorView.findFromDOM(container)!;
  return { app, platform, view, ids };
}

async function withTypescript(view: EditorView) {
  const grammar = await loadLanguage('typescript');
  view.dispatch({ effects: languageCompartment.reconfigure(grammar!) });
  if (ensureSyntaxTree(view.state, view.state.doc.length, 10_000) === null) {
    throw new Error('syntax tree did not finish parsing within 10s');
  }
  view.dispatch({});
}

describe('editor commands', () => {
  it('edit.foldLevel1 to edit.foldLevel5 fold the blocks at that depth', async () => {
    const { app, view } = await pane({
      '/w/main.ts': 'function a() {\n  if (x) {\n    y();\n  }\n}\n',
    });
    await withTypescript(view);

    await app.commands.execute('edit.foldLevel1');
    expect(foldedRanges(view.state).size).toBe(1);
    await app.commands.execute('edit.unfoldAll');
    await app.commands.execute('edit.foldLevel2');
    expect(foldedRanges(view.state).size).toBe(1);
    expect(view.state.doc.lineAt(foldedRanges(view.state).iter().from).number).toBe(2);
    // Nothing sits three deep, so these fold nothing and break nothing.
    for (const id of ['edit.foldLevel3', 'edit.foldLevel4', 'edit.foldLevel5']) {
      await app.commands.execute('edit.unfoldAll');
      expect(await app.commands.execute(id)).toBe(true);
      expect(foldedRanges(view.state).size).toBe(0);
    }
  });

  it('edit.outdent removes one indent unit from the cursor line', async () => {
    const { app, view } = await pane({ [A]: '    x\n' });
    view.dispatch({ selection: { anchor: 5 } });
    await app.commands.execute('edit.outdent');
    expect(view.state.doc.line(1).text).toBe('  x');
  });

  it('edit.selectNextOccurrence adds the next match as a second range', async () => {
    const { app, view } = await pane({ [A]: 'foo bar foo\n' });
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    await app.commands.execute('edit.selectNextOccurrence');
    expect(view.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
      [0, 3],
      [8, 11],
    ]);
  });

  it('edit.addCursorAbove and edit.addCursorBelow add a cursor on the neighbouring line', async () => {
    const { app, view } = await pane();
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    await app.commands.execute('edit.addCursorBelow');
    expect(view.state.selection.ranges).toHaveLength(2);

    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    await app.commands.execute('edit.addCursorAbove');
    expect(view.state.selection.ranges).toHaveLength(2);
    expect(view.state.selection.ranges[0]!.from).toBe(0);
  });

  it('nav.documentStart and nav.documentEnd move the cursor to the ends', async () => {
    const { app, view } = await pane();
    view.dispatch({ selection: { anchor: 5 } });
    await app.commands.execute('nav.documentEnd');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    await app.commands.execute('nav.documentStart');
    expect(view.state.selection.main.head).toBe(0);
  });

  it('nav.focusEditor asks the pane for focus', async () => {
    const { app } = await pane();
    const before = app.ui.focusEditorRequest.get();
    await app.commands.execute('nav.focusEditor');
    expect(app.ui.focusEditorRequest.get()).toBe(before + 1);
  });

  it('notes.newFromSelection makes a note out of the selected text', async () => {
    const { app, view } = await pane({ [A]: 'remember this line\n' });
    expect(app.commands.get('notes.newFromSelection')?.enabled?.()).toBe(false);
    view.dispatch({ selection: { anchor: 0, head: 8 } });

    await app.commands.execute('notes.newFromSelection');
    const notes = app.notes.notes.get();
    expect(notes).toHaveLength(1);
    expect(`${notes[0]!.title}\n${notes[0]!.body}`).toContain('remember');
  });

  it('provenance.nextChange and provenance.previousChange wait for a change to exist', async () => {
    const { app } = await pane();
    expect(await app.commands.execute('provenance.nextChange')).toBe(false);
    expect(await app.commands.execute('provenance.previousChange')).toBe(false);
  });
});

describe('view commands', () => {
  it.each([
    ['view.toggleLineNumbers', 'editor.lineNumbers'],
    ['view.toggleRelativeLineNumbers', 'editor.relativeLineNumbers'],
  ] as const)('%s flips %s', async (id, key) => {
    const { app } = await pane();
    const before = app.config.get(key);
    await app.commands.execute(id);
    expect(app.config.get(key)).toBe(!before);
  });

  it('the group commands cycle focus, move the editor, and flip the orientation', async () => {
    // Two files, so the split (which carries the active buffer into the new
    // group) leaves one buffer that lives in the first group only.
    const { app, ids } = await pane({ [A]: 'a', [B]: 'b' });
    const [a, b] = ids;
    app.workspace.setActive(b!);
    expect(await app.commands.execute('view.focusNextGroup')).toBe(false);

    await app.commands.execute('view.splitEditor');
    expect(app.workspace.groups.get()).toHaveLength(2);
    const first = app.workspace.activeGroupId.get();

    await app.commands.execute('view.focusNextGroup');
    expect(app.workspace.activeGroupId.get()).not.toBe(first);
    await app.commands.execute('view.focusPreviousGroup');
    expect(app.workspace.activeGroupId.get()).toBe(first);

    const groupsHolding = (id: string) =>
      app.workspace.groups.get().filter((g) => g.tabs.some((t) => t.id === id)).map((g) => g.id);
    app.workspace.focusGroup('group-1');
    app.workspace.setActive(a!);
    expect(groupsHolding(a!)).toEqual(['group-1']);
    await app.commands.execute('view.moveEditorToNextGroup');
    expect(groupsHolding(a!)).toEqual(['group-2']);
    // Which group "previous" lands in when the one it left has since closed
    // is the groups service's rule (`tests/groups.test.ts`); here it is
    // enough that the editor moved again, to exactly one group, and left.
    await app.commands.execute('view.moveEditorToPreviousGroup');
    expect(groupsHolding(a!)).toHaveLength(1);
    expect(groupsHolding(a!)).not.toEqual(['group-2']);

    const orientation = app.config.get('workbench.splitOrientation');
    await app.commands.execute('view.toggleSplitOrientation');
    expect(app.config.get('workbench.splitOrientation')).not.toBe(orientation);
  });
});

describe('workspace and file commands', () => {
  it('file.saveAll writes every dirty buffer', async () => {
    const { app, platform, ids } = await pane({ [A]: 'a', [B]: 'b' });
    for (const id of ids) {
      const state = app.workspace.stateOf(id)!;
      app.workspace.applyTransaction(id, state.update({ changes: { from: 0, insert: 'x' } }));
    }
    await app.commands.execute('file.saveAll');
    expect(await platform.readTextFile(A)).toBe('xa\n');
    expect(await platform.readTextFile(B)).toBe('xb\n');
  });

  it('prefs.openWorkspaceSettings creates .nox/settings.json and opens it', async () => {
    const { app, platform } = await pane();
    await app.commands.execute('prefs.openWorkspaceSettings');
    expect(await platform.readTextFile('/w/.nox/settings.json')).toBe('{}\n');
    expect(app.workspace.activeSnapshot()?.path).toBe('/w/.nox/settings.json');
  });

  it('explorer.openSelection opens what the tree has selected', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile(A, 'a');
    const app = new NoxApp(platform);
    await app.workspace.openFolder('/w');
    await app.files.setRoot('/w');
    app.ui.explorer.set(A);

    expect(await app.commands.execute('explorer.openSelection')).toBe(true);
    expect(app.workspace.activeSnapshot()?.path).toBe(A);
  });

  it('explorer.moveTo moves the named paths into the target folder', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile(A, 'a');
    platform.mkdirp('/w/sub');
    const app = new NoxApp(platform);
    await app.workspace.openFolder('/w');

    await app.commands.execute('explorer.moveTo', { paths: [A], target: '/w/sub' });
    expect(await platform.exists('/w/sub/a.txt')).toBe(true);
    expect(await platform.exists(A)).toBe(false);
  });

  it('plugins.openSettingsFile names the file, whether or not it can open it', async () => {
    // `MemoryPlatform` has no config directory to open a file from, so the
    // command takes its browser branch and says where the settings live.
    const app = new NoxApp(new MemoryPlatform());
    await app.commands.execute('plugins.openSettingsFile');
    const messages = app.notifications.items.get().map((n) => n.message);
    expect(messages.some((message) => message.includes('plugin-settings.json'))).toBe(true);
  });
});

describe('overlay commands', () => {
  it.each([
    ['nav.commandPalette', 'palette'],
    ['nav.goToSymbol', 'go-to-symbol'],
  ] as const)('%s opens the %s overlay', async (id, kind) => {
    const { app } = await pane();
    await app.commands.execute(id);
    expect(app.ui.overlay.get()).toBe(kind);
  });
});

describe('search commands', () => {
  it.each([
    ['search.toggleCase', 'caseSensitive'],
    ['search.toggleWholeWord', 'wholeWord'],
    ['search.toggleRegexp', 'regexp'],
    ['search.togglePreserveCase', 'preserveCase'],
    ['search.toggleGitIgnore', 'respectGitIgnore'],
  ] as const)('%s flips the %s option', async (id, key) => {
    const app = new NoxApp(new MemoryPlatform());
    const before = app.search.options.get()[key];
    await app.commands.execute(id);
    expect(app.search.options.get()[key]).toBe(!before);
  });

  it('search.rerun runs the current query again', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile(A, 'needle');
    const app = new NoxApp(platform);
    await app.workspace.openFolder('/w');
    app.search.setQuery('needle');
    const run = vi.spyOn(app.search, 'run').mockResolvedValue(undefined);

    expect(await app.commands.execute('search.rerun')).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('search.dismissResult and search.undoReplace wait for something to act on', async () => {
    const app = new NoxApp(new MemoryPlatform());
    expect(await app.commands.execute('search.dismissResult')).toBe(false);
    expect(await app.commands.execute('search.undoReplace')).toBe(false);
  });
});

describe('tool commands', () => {
  it('git.refreshGutter asks git for status and gutters once started', async () => {
    const app = new NoxApp(new MemoryPlatform());
    expect(await app.commands.execute('git.refreshGutter')).toBe(false);

    app.git.start();
    const status = vi.spyOn(app.git, 'refreshStatus').mockResolvedValue(undefined);
    const all = vi.spyOn(app.git, 'refreshAll').mockResolvedValue(undefined);
    expect(await app.commands.execute('git.refreshGutter')).toBe(true);
    expect(status).toHaveBeenCalledOnce();
    expect(all).toHaveBeenCalledOnce();
  });

  it('review.keepAll and review.rejectAll wait for a staged review', async () => {
    const app = new NoxApp(new MemoryPlatform());
    expect(await app.commands.execute('review.keepAll')).toBe(false);
    expect(await app.commands.execute('review.rejectAll')).toBe(false);
  });

  it('agents.reloadConfig reads agents.json and reports the count', async () => {
    const app = new NoxApp(new MemoryPlatform());
    await app.commands.execute('agents.reloadConfig');
    expect(app.notifications.items.get().map((n) => n.message)).toContain('0 agents configured');
  });

  it.each([
    'agents.runOnSelection',
    'agents.askAboutSelection',
    'agents.explainSelection',
  ])('%s stays off with no agent configured', async (id) => {
    const { app, view } = await pane();
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    expect(app.commands.get(id)?.enabled?.()).toBe(false);
    expect(await app.commands.execute(id)).toBe(false);
  });
});
