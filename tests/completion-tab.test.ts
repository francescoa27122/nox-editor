// @vitest-environment jsdom
import { autocompletion, completionStatus, startCompletion } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExtensions } from '../src/editor/extensions';
import { defaultSettings } from '../src/services/config/schema';

/**
 * Tab accepts a completion, and otherwise indents.
 *
 * One key doing two jobs, decided by whether a picker is open. Tested through
 * a real view and a real key event rather than by inspecting the keymap,
 * because the thing that can break is the *order* of two bindings that both
 * claim Tab — and a structural test would pass with them the wrong way round.
 */

/**
 * Longer than CodeMirror's `interactionDelay` (75ms), which makes
 * `acceptCompletion` refuse for a moment after a picker opens so a keypress
 * cannot accidentally accept something that appeared under the user's
 * fingers. Pressing Tab instantly measures that guard rather than this
 * binding — it is not flake padding.
 */
const AFTER_INTERACTION_DELAY = 120;

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string, extra: readonly unknown[] = []): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);

  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [...buildExtensions(defaultSettings()), ...(extra as never[])],
    }),
  });
  return view;
}

/** A real Tab keypress, through the same path the browser uses. */
function pressTab(target: EditorView): void {
  target.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }),
  );
}

describe('with no completion open', () => {
  it('indents, as it always did', () => {
    const editor = mount('const a = 1;');
    editor.dispatch({ selection: { anchor: 0 } });

    pressTab(editor);

    // Whatever the indent unit is, the line must have grown. The point is
    // that Tab still reaches `indentWithTab` when the picker is closed.
    expect(editor.state.doc.toString().length).toBeGreaterThan('const a = 1;'.length);
  });
});

describe('with a completion open', () => {
  it('accepts the highlighted option instead of indenting', async () => {
    const editor = mount('con', [
      autocompletion({
        override: [
          (context) => ({
            from: context.pos - 3,
            options: [{ label: 'console' }],
          }),
        ],
      }),
    ]);
    editor.dispatch({ selection: { anchor: 3 } });

    startCompletion(editor);
    await vi.waitFor(() => expect(completionStatus(editor.state)).toBe('active'));
    await new Promise((resolve) => setTimeout(resolve, AFTER_INTERACTION_DELAY));

    pressTab(editor);

    // Accepted, not indented: the document is the completion, with no tab
    // character anywhere in it.
    expect(editor.state.doc.toString()).toBe('console');
  });

  it('leaves the document untabbed, which is the failure mode if the order is wrong', async () => {
    const editor = mount('con', [
      autocompletion({
        override: [
          (context) => ({ from: context.pos - 3, options: [{ label: 'console' }] }),
        ],
      }),
    ]);
    editor.dispatch({ selection: { anchor: 3 } });

    startCompletion(editor);
    await vi.waitFor(() => expect(completionStatus(editor.state)).toBe('active'));
    await new Promise((resolve) => setTimeout(resolve, AFTER_INTERACTION_DELAY));
    pressTab(editor);

    expect(editor.state.doc.toString()).not.toContain('\t');
    expect(editor.state.doc.toString()).not.toMatch(/^ {2,}/);
  });
});
