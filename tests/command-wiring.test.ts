// @vitest-environment jsdom
import { ensureSyntaxTree, foldedRanges } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { NoxApp } from '../src/app';
import { languageCompartment, loadLanguage } from '../src/editor/languages';
import { MemoryPlatform } from '../src/platform/memory';
import type { PlatformCapabilities } from '../src/platform/types';
import { flush, mountComponent, type Mounted } from './support/component';
import { installRangeRects } from './support/jsdom-layout';

// `workspace.apply` dispatches with scrollIntoView, and CodeMirror measures
// for it; jsdom has no geometry. See `tests/support/jsdom-layout.ts`.
installRangeRects();

/**
 * The commands the 2026-09 audit found no test naming (A1-012), each
 * executed through the registry against a real pane and checked for the
 * effect its title promises.
 *
 * Most are one-line delegations to CodeMirror or to a workspace method that
 * is tested on its own, so what this pins is the wiring: the id reaches the
 * right operation with the right argument shape. Does not catch the
 * operation's own edge cases; those belong to the suites that own them.
 */

const A = '/w/a.txt';
const B = '/w/b.txt';
const C = '/w/c.txt';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.restoreAllMocks();
});

async function setup(files: Record<string, string> = { [A]: 'one\ntwo\nthree\n' }) {
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

function lines(view: EditorView): string[] {
  return view.state.doc.toString().split('\n');
}

describe('line commands', () => {
  it('edit.moveLineUp and edit.moveLineDown move the cursor line', async () => {
    const { app, view } = await setup();
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });

    await app.commands.execute('edit.moveLineUp');
    expect(lines(view)).toEqual(['two', 'one', 'three', '']);
    await app.commands.execute('edit.moveLineDown');
    expect(lines(view)).toEqual(['one', 'two', 'three', '']);
  });

  it('edit.duplicateLine copies the cursor line below itself', async () => {
    const { app, view } = await setup();
    view.dispatch({ selection: { anchor: 0 } });

    await app.commands.execute('edit.duplicateLine');
    expect(lines(view)).toEqual(['one', 'one', 'two', 'three', '']);
  });

  it('edit.deleteLine removes the cursor line', async () => {
    const { app, view } = await setup();
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });

    await app.commands.execute('edit.deleteLine');
    expect(lines(view)).toEqual(['one', 'three', '']);
  });
});

describe('fold commands', () => {
  it('edit.foldAll folds every block and edit.unfoldAll opens them again', async () => {
    const { app, view } = await setup({
      '/w/main.ts': 'function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n',
    });
    const grammar = await loadLanguage('typescript');
    view.dispatch({ effects: languageCompartment.reconfigure(grammar!) });
    if (ensureSyntaxTree(view.state, view.state.doc.length, 10_000) === null) {
      throw new Error('syntax tree did not finish parsing within 10s');
    }
    view.dispatch({});

    await app.commands.execute('edit.foldAll');
    expect(foldedRanges(view.state).size).toBe(2);

    await app.commands.execute('edit.unfoldAll');
    expect(foldedRanges(view.state).size).toBe(0);
  });
});

describe('tab commands', () => {
  it('nav.nextTab and nav.previousTab cycle the active tab', async () => {
    const { app, ids } = await setup({ [A]: 'a', [B]: 'b', [C]: 'c' });
    const [a, b, c] = ids;

    await app.commands.execute('nav.nextTab');
    expect(app.workspace.activeId.get()).toBe(b);
    await app.commands.execute('nav.nextTab');
    expect(app.workspace.activeId.get()).toBe(c);
    await app.commands.execute('nav.nextTab');
    expect(app.workspace.activeId.get()).toBe(a);
    await app.commands.execute('nav.previousTab');
    expect(app.workspace.activeId.get()).toBe(c);
  });

  it('nav.switchBuffer opens the buffer switcher', async () => {
    const { app } = await setup();
    await app.commands.execute('nav.switchBuffer');
    expect(app.ui.overlay.get()).toBe('buffers');
  });

  it('file.closeToRight keeps the anchor tab and everything left of it', async () => {
    const { app, ids } = await setup({ [A]: 'a', [B]: 'b', [C]: 'c' });
    const [a, b] = ids;
    app.workspace.setActive(b!);

    await app.commands.execute('file.closeToRight');
    expect(app.workspace.buffers.get().map((buffer) => buffer.id)).toEqual([a, b]);
  });

  it('file.closeSaved closes the clean tabs and keeps the dirty one', async () => {
    const { app, ids } = await setup({ [A]: 'a', [B]: 'b', [C]: 'c' });
    const [, b] = ids;
    const state = app.workspace.stateOf(b!)!;
    app.workspace.applyTransaction(b!, state.update({ changes: { from: 0, insert: 'x' } }));

    await app.commands.execute('file.closeSaved');
    expect(app.workspace.buffers.get().map((buffer) => buffer.id)).toEqual([b]);
  });
});

describe('view commands', () => {
  it('view.toggleStatusBar flips the setting', async () => {
    const { app } = await setup();
    const before = app.config.get('workbench.showStatusBar');

    await app.commands.execute('view.toggleStatusBar');
    expect(app.config.get('workbench.showStatusBar')).toBe(!before);
    await app.commands.execute('view.toggleStatusBar');
    expect(app.config.get('workbench.showStatusBar')).toBe(before);
  });

  it('view.reloadWindow says so before the page goes', async () => {
    const { app } = await setup();
    await app.commands.execute('view.reloadWindow');
    expect(app.notifications.items.get().map((n) => n.message)).toContain('Reloading…');
  });
});

describe('explorer.revealInFileManager', () => {
  /** A platform that claims to reveal, so the command is neither hidden nor disabled. */
  class RevealingPlatform extends MemoryPlatform {
    override readonly capabilities: PlatformCapabilities = {
      ...new MemoryPlatform().capabilities,
      revealInFileManager: true,
    };
  }

  it('reveals the explorer selection, or the active file without one', async () => {
    const platform = new RevealingPlatform();
    mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' }, app: new NoxApp(platform) });
    const { app } = mounted;
    platform.seedFile(A, 'a');
    await app.workspace.openFolder('/w');
    await app.workspace.open(A);
    const reveal = vi.spyOn(platform, 'reveal').mockResolvedValue(undefined);

    expect(await app.commands.execute('explorer.revealInFileManager')).toBe(true);
    expect(reveal).toHaveBeenCalledWith(A);

    await app.commands.execute('explorer.revealInFileManager', '/w');
    expect(reveal).toHaveBeenLastCalledWith('/w');
  });
});
