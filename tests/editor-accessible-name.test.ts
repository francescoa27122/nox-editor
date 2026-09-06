// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import EditorPane from '../src/ui/EditorPane.svelte';
import { flush, mountComponent, type Mounted } from './support/component';
import { installRangeRects } from './support/jsdom-layout';

/**
 * What a screen reader calls the editor.
 *
 * What this guards: the focusable element is CodeMirror's `contentDOM`, a
 * `role="textbox"`, and nothing gave it a name, so its accessible name was
 * its own first line. A tab walk reported the editor stop as
 * `DIV[textbox] '# Engineering notes## Scheduli'`, which tells a screen
 * reader user nothing about which file they are in. The `<section
 * aria-label="Editor">` around it does not help: the section is not the
 * thing that takes focus.
 *
 * The name is the buffer's, applied through a compartment on every swap,
 * because `setState` resets every compartment to the state's own
 * configuration. What this does not catch: the label surviving a rename
 * that does not go through `saved`.
 */

installRangeRects();

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function pane() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/main.ts', 'const a = 1;\n');
  platform.seedFile('/w/notes.md', '# Engineering notes\n');

  const app = new NoxApp(platform);
  await app.workspace.openFolder('/w');

  mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' }, app });
  const view = () => EditorView.findFromDOM(mounted!.container)!;
  return { app, view };
}

const nameOf = (view: EditorView) => view.contentDOM.getAttribute('aria-label');

describe('the editor textbox', () => {
  it('is named after the file it holds', async () => {
    const { app, view } = await pane();
    const id = (await app.workspace.open('/w/main.ts'))!;
    app.workspace.setActive(id);
    flush();

    expect(nameOf(view())).toBe('main.ts editor');
  });

  it('is renamed when the pane switches file', async () => {
    const { app, view } = await pane();
    const main = (await app.workspace.open('/w/main.ts'))!;
    const notes = (await app.workspace.open('/w/notes.md'))!;
    app.workspace.setActive(main);
    flush();
    expect(nameOf(view())).toBe('main.ts editor');

    app.workspace.setActive(notes);
    flush();
    expect(nameOf(view())).toBe('notes.md editor');

    app.workspace.setActive(main);
    flush();
    expect(nameOf(view())).toBe('main.ts editor');
  });

  it('is renamed when the file is saved under another name', async () => {
    const { app, view } = await pane();
    const id = (await app.workspace.open('/w/main.ts'))!;
    app.workspace.setActive(id);
    flush();

    await app.workspace.saveAs(id, '/w/renamed.ts');
    flush();
    expect(nameOf(view())).toBe('renamed.ts editor');
  });
});
