// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { buildExtensions, tabKeyCompartment, tabKeyExtension } from '../src/editor/extensions';
import { MemoryPlatform } from '../src/platform/memory';
import { defaultSettings } from '../src/services/config/schema';
import StatusBar from '../src/ui/StatusBar.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Tab can be made to leave the editor.
 *
 * A5-009: the editor was a keyboard trap. `indentWithTab` claims Tab, so a
 * keyboard user who lands in the editor has no documented way out, and the
 * status bar's buttons, which are ordinary tab stops, are unreachable. The
 * answer every editor gives is a mode, not a rebinding: Tab indents until you
 * say otherwise, and then it moves focus, the way it does in every other
 * control on the page.
 */

let view: EditorView | null = null;
let mounted: Mounted | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  mounted?.unmount();
  mounted = null;
});

function mount(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: buildExtensions(defaultSettings()) }),
  });
  return view;
}

/** A real Tab keypress, and whether the editor claimed it. */
function pressTab(target: EditorView): boolean {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    code: 'Tab',
    bubbles: true,
    cancelable: true,
  });
  target.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('the mode', () => {
  it('is off until asked for, and the command flips it', async () => {
    const app = new NoxApp(new MemoryPlatform());
    expect(app.ui.tabMovesFocus.get()).toBe(false);

    expect(await app.commands.execute('view.toggleTabFocus')).toBe(true);
    expect(app.ui.tabMovesFocus.get()).toBe(true);

    await app.commands.execute('view.toggleTabFocus');
    expect(app.ui.tabMovesFocus.get()).toBe(false);
  });

  /**
   * `Ctrl+M` on every platform, which is the chord VS Code and the Monaco
   * family use. Not `Mod+M`: on macOS ⌘M minimises the window at the OS
   * level, so the mode would have taken a chord the system already owns.
   */
  it('is bound to Ctrl+M everywhere', () => {
    const app = new NoxApp(new MemoryPlatform());
    const event = {
      code: 'KeyM',
      key: '',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as KeyboardEvent;
    expect(app.keymap.resolve(event)).toBe('view.toggleTabFocus');
  });
});

describe('the editor', () => {
  it('indents on Tab while the mode is off', () => {
    const editor = mount('const a = 1;');
    editor.dispatch({ selection: { anchor: 0 } });

    expect(pressTab(editor)).toBe(true);
    expect(editor.state.doc.toString().length).toBeGreaterThan('const a = 1;'.length);
  });

  /**
   * The failure this guards: a keydown the editor neither handles nor
   * prevents is the only way the browser's own focus navigation runs. If any
   * binding still claims Tab in this configuration, focus is trapped again
   * and no other test here would notice.
   */
  it('lets Tab through untouched once the mode is on', () => {
    const editor = mount('const a = 1;');
    editor.dispatch({ selection: { anchor: 0 } });
    editor.dispatch({ effects: tabKeyCompartment.reconfigure(tabKeyExtension(true)) });

    expect(pressTab(editor)).toBe(false);
    expect(editor.state.doc.toString()).toBe('const a = 1;');
  });
});

describe('the status bar', () => {
  const readout = (container: HTMLElement) =>
    [...container.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Tab Moves Focus'),
    );

  /**
   * Shown only while the mode is on, the way VS Code does it: the one moment
   * a person needs telling is when Tab has stopped indenting and they do not
   * remember why.
   */
  it('says so while the mode is on, and the readout turns it off again', async () => {
    const app = new NoxApp(new MemoryPlatform());
    mounted = mountComponent(StatusBar, { app });
    flush();
    expect(readout(mounted.container)).toBeUndefined();

    await app.commands.execute('view.toggleTabFocus');
    flush();
    const item = readout(mounted.container);
    expect(item).toBeDefined();

    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    flush();
    expect(app.ui.tabMovesFocus.get()).toBe(false);
  });
});
