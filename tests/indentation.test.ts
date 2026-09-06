// @vitest-environment jsdom
import { indentUnit } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { afterEach, describe, expect, it } from 'vitest';
import { detectIndentation, resolveIndentation } from '../src/core/indentation';
import { buildExtensions } from '../src/editor/extensions';
import { MemoryPlatform } from '../src/platform/memory';
import { defaultSettings, type Settings } from '../src/services/config/schema';
import { WorkspaceService } from '../src/services/workspace';
import EditorPane from '../src/ui/EditorPane.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * A1-004: a file's own indentation, read once when it is opened.
 *
 * The finding it closes is that the indent unit was a pure function of
 * settings, so opening a tab-indented Makefile with the default
 * `editor.insertSpaces` and pressing Enter produced mixed indentation the
 * user never asked for.
 *
 * The rules under test are the ambiguous cases, because those are where a
 * heuristic earns or loses its keep: a file that is both, a file indented by
 * one space, and a file whose only indentation is a block comment. Each has
 * a decision behind it, written out in `core/indentation.ts`.
 */
describe('reading a file for its indentation', () => {
  it('reads tabs, and declines to invent a width for them', () => {
    // A tab's display width is a preference of the reader's. The file says
    // "tabs" and nothing at all about how wide they should look.
    expect(detectIndentation('function a() {\n\treturn 1;\n}\n')).toEqual({
      insertSpaces: false,
      tabSize: null,
    });
  });

  it('reads two spaces', () => {
    expect(detectIndentation('function a() {\n  return 1;\n}\n')).toEqual({
      insertSpaces: true,
      tabSize: 2,
    });
  });

  it('reads four spaces', () => {
    expect(detectIndentation('function a() {\n    return 1;\n}\n')).toEqual({
      insertSpaces: true,
      tabSize: 4,
    });
  });

  /**
   * The reason the width is the most common *step* rather than the most
   * common absolute indent. A continuation lined up under an open bracket is
   * a column, not a level, and an absolute count would let one of them
   * outvote the four real indents around it.
   */
  it('is not fooled by a continuation line aligned to a column', () => {
    const doc = [
      'function a() {',
      '    const value = compute(first,',
      '                          second);',
      '    return value;',
      '}',
      '',
      'function b() {',
      '    return 2;',
      '}',
      '',
    ].join('\n');

    expect(detectIndentation(doc)).toEqual({ insertSpaces: true, tabSize: 4 });
  });

  /**
   * Mixed files: the majority wins, and an exact tie is not an answer.
   *
   * A tie means the file is evenly both, and the user's setting is a better
   * answer than a coin toss. Any tab in a line's leading run makes it a tab
   * line, so a tab file with space-aligned continuations still reads as tabs.
   */
  it('takes the majority when a file mixes tabs and spaces', () => {
    expect(detectIndentation('\tone\n\ttwo\n  three\n')).toEqual({
      insertSpaces: false,
      tabSize: null,
    });
    expect(detectIndentation('\tone\n  two\n  three\n')).toEqual({
      insertSpaces: true,
      tabSize: 2,
    });
  });

  it('says nothing when a file is exactly half tabs and half spaces', () => {
    expect(detectIndentation('\tone\n  two\n')).toBeNull();
  });

  /**
   * One space is spaces, but it is not a width worth believing. Files that
   * really indent by one are vanishingly rare next to the continuation lines
   * and aligned comments that produce a step of one by accident, so the
   * setting supplies the number and the file supplies only "spaces".
   */
  it('accepts single-space indentation as spaces but not as a width', () => {
    expect(detectIndentation('function a() {\n return 1;\n}\n')).toEqual({
      insertSpaces: true,
      tabSize: null,
    });
  });

  /**
   * A file whose only indentation is a block comment. Without the rule that
   * skips lines opening with `*`, the ` * ` of a JSDoc block is a one-space
   * indent and the whole file reads as space-indented on the strength of a
   * comment nobody indented on purpose.
   */
  it('ignores the continuation lines of a block comment', () => {
    const doc = ['/**', ' * A thing.', ' */', 'export const a = 1;', ''].join('\n');
    expect(detectIndentation(doc)).toBeNull();
  });

  /**
   * Whitespace-only lines are blank, not indented. Editors leave trailing
   * spaces on the empty line between two functions all the time, and counting
   * them would let that accident set the width of the file.
   */
  it('does not read a whitespace-only line as an indented line', () => {
    expect(detectIndentation('const a = 1;\n   \nconst b = 2;\n')).toBeNull();
  });

  it('says nothing about a file with no indentation', () => {
    expect(detectIndentation('one\ntwo\nthree\n')).toBeNull();
  });

  it('says nothing about an empty file', () => {
    expect(detectIndentation('')).toBeNull();
    expect(detectIndentation('\n')).toBeNull();
  });

  /**
   * The bound is the point, not a limitation to apologise for: this runs on
   * the path between the click and the text appearing, on files up to 64 MB.
   * Five hundred lines is far past what any heuristic needs and it makes the
   * cost independent of the document, which `tests/complexity.test.ts` holds
   * from the other side.
   *
   * What this does not catch: the byte bound beside the line bound, which is
   * there for the minified bundle that is one 60 MB line. A line cap alone
   * would still walk all of it looking for a newline that never comes.
   */
  it('does not see indentation that only starts past the sample bound', () => {
    const doc = `${'x\n'.repeat(600)}function a() {\n    return 1;\n}\n`;
    expect(detectIndentation(doc)).toBeNull();
  });
});

describe('filling in what a file did not say', () => {
  const fallback = { insertSpaces: true, tabSize: 2 };

  it('uses the setting when nothing was detected', () => {
    expect(resolveIndentation(null, fallback)).toEqual(fallback);
  });

  it('keeps the setting width for a tab-indented file', () => {
    expect(resolveIndentation({ insertSpaces: false, tabSize: null }, fallback)).toEqual({
      insertSpaces: false,
      tabSize: 2,
    });
  });

  it('prefers the detected width over the setting', () => {
    expect(resolveIndentation({ insertSpaces: true, tabSize: 4 }, fallback)).toEqual({
      insertSpaces: true,
      tabSize: 4,
    });
  });
});

/**
 * The seam: detection is only worth anything if it reaches the extension that
 * decides what Enter and Tab insert. `buildExtensions` is the one composer, so
 * this drives the real one against a real `EditorState`, the way
 * `tests/provenance.test.ts` does, and reads the facet CodeMirror indents by.
 */
describe('the buffer a file opens into', () => {
  function open(path: string, content: string, settings: Settings = defaultSettings()) {
    const platform = new MemoryPlatform();
    platform.mkdirp('/w');
    platform.seedFile(path, content);
    const workspace = new WorkspaceService(platform, (args) =>
      buildExtensions(settings, args.indent),
    );
    return { workspace, platform };
  }

  async function stateOf(path: string, content: string, settings?: Settings) {
    const { workspace } = open(path, content, settings);
    const id = await workspace.open(path);
    expect(id).not.toBeNull();
    return { state: workspace.stateOf(id!) as EditorState, workspace, id: id! };
  }

  it('indents with four spaces from a four-space file, whatever the setting says', async () => {
    const settings = { ...defaultSettings(), 'editor.insertSpaces': true, 'editor.tabSize': 2 };
    const { state } = await stateOf('/w/a.ts', 'function a() {\n    return 1;\n}\n', settings);

    expect(state.facet(indentUnit)).toBe('    ');
    expect(state.tabSize).toBe(4);
  });

  it('indents with tabs from a tab-indented file, keeping the setting width', async () => {
    const settings = { ...defaultSettings(), 'editor.insertSpaces': true, 'editor.tabSize': 2 };
    const { state } = await stateOf('/w/a.go', 'func a() {\n\treturn 1\n}\n', settings);

    expect(state.facet(indentUnit)).toBe('\t');
    // The file said tabs and could not say how wide, so the number beside
    // "Tabs:" in the status bar is still the user's.
    expect(state.tabSize).toBe(2);
  });

  it('falls back to the setting when the file shows no indentation', async () => {
    const settings = { ...defaultSettings(), 'editor.insertSpaces': true, 'editor.tabSize': 2 };
    const { state } = await stateOf('/w/a.ts', 'const a = 1;\n', settings);

    expect(state.facet(indentUnit)).toBe('  ');
  });

  it('falls back to a tabs setting when the file shows no indentation', async () => {
    const settings = { ...defaultSettings(), 'editor.insertSpaces': false, 'editor.tabSize': 4 };
    const { state } = await stateOf('/w/a.ts', 'const a = 1;\n', settings);

    expect(state.facet(indentUnit)).toBe('\t');
    expect(state.tabSize).toBe(4);
  });

  it('publishes what was detected so the status bar can show it', async () => {
    const { workspace } = await stateOf('/w/a.go', 'func a() {\n\treturn 1\n}\n');
    expect(workspace.activeSnapshot()?.indent).toEqual({ insertSpaces: false, tabSize: null });
  });

  it('detects nothing for an untitled buffer', () => {
    const { workspace } = open('/w/a.ts', 'const a = 1;\n');
    const id = workspace.newUntitled();
    expect(workspace.buffers.get().find((b) => b.id === id)?.indent).toBeNull();
  });

  /**
   * The hand override. It replaces the detected value rather than clearing
   * it, so a file read as tabs and corrected to spaces keeps the correction
   * for as long as the tab is open, and the setting stays the default for
   * files that say nothing.
   */
  it('lets a hand-set indentation override what was detected', async () => {
    const { workspace, id } = await stateOf('/w/a.go', 'func a() {\n\treturn 1\n}\n');
    workspace.setIndentation(id, { insertSpaces: true, tabSize: 4 });

    expect(workspace.activeSnapshot()?.indent).toEqual({ insertSpaces: true, tabSize: 4 });
  });

  it('announces a hand-set indentation so the open view can reconfigure', async () => {
    const { workspace, id } = await stateOf('/w/a.go', 'func a() {\n\treturn 1\n}\n');
    const seen: string[] = [];
    workspace.events.on('indentation-changed', (event) => seen.push(event.id));

    workspace.setIndentation(id, { insertSpaces: true, tabSize: 4 });

    expect(seen).toEqual([id]);
  });
});

/**
 * The live view, which is the half a headless state cannot check.
 *
 * `EditorPane` re-points one `EditorView` at a different `EditorState` per
 * tab, and `setState` resets every compartment to the state's own
 * configuration, so the pane re-applies the settings on every swap. Without
 * the buffer's indentation travelling with them, that re-application quietly
 * puts the preference back over what the file was read to use, and it does it
 * on a tab switch rather than at open, where nobody would think to look.
 *
 * jsdom has no layout, so nothing here asserts anything geometric. What it
 * reads is the facet CodeMirror indents by, which is state, not pixels.
 */
describe('the pane that shows a detected file', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  /** The indent unit the visible view is currently configured with. */
  function unitOf(app: Mounted['app']): string {
    const view = app.view.get();
    expect(view, 'no editor view registered').not.toBeNull();
    return view!.state.facet(indentUnit);
  }

  async function pane() {
    mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
    const { app, platform } = mounted;
    platform.seedFile('/w/tabs.go', 'func a() {\n\treturn 1\n}\n');
    platform.seedFile('/w/spaces.ts', 'function a() {\n    return 1;\n}\n');
    await app.workspace.openFolder('/w');
    return mounted;
  }

  it('keeps the detected unit across a tab switch', async () => {
    const { app } = await pane();
    const tabs = (await app.workspace.open('/w/tabs.go'))!;
    const spaces = (await app.workspace.open('/w/spaces.ts'))!;
    flush();

    expect(unitOf(app)).toBe('    ');

    app.workspace.setActive(tabs);
    flush();
    expect(unitOf(app)).toBe('\t');

    app.workspace.setActive(spaces);
    flush();
    expect(unitOf(app)).toBe('    ');
  });

  it('follows a hand-set indentation without waiting for a tab switch', async () => {
    const { app } = await pane();
    const tabs = (await app.workspace.open('/w/tabs.go'))!;
    flush();
    expect(unitOf(app)).toBe('\t');

    app.workspace.setIndentation(tabs, { insertSpaces: true, tabSize: 3 });
    flush();

    expect(unitOf(app)).toBe('   ');
  });

  /**
   * And a settings change still reaches a buffer that has no override, which
   * is the path the indentation argument runs alongside rather than replaces.
   */
  it('still follows the setting for a file with no indentation of its own', async () => {
    const { app, platform } = await pane();
    platform.seedFile('/w/flat.ts', 'const a = 1;\n');
    await app.workspace.open('/w/flat.ts');
    flush();
    expect(unitOf(app)).toBe('  ');

    app.config.set('editor.tabSize', 8);
    flush();

    expect(unitOf(app)).toBe('        ');
  });
});
