// @vitest-environment jsdom
import { search } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import FindPanel from '../src/ui/FindPanel.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Who holds focus after the find panel does something.
 *
 * These need a real `EditorView`, which §7 of ARCHITECTURE.md says cannot be
 * mounted through a component: jsdom has no layout engine. That applies to
 * components that *measure* — `EditorPane` asks for geometry. Focus does not:
 * `contentDOM.focus()` and `document.activeElement` are plain DOM, and the
 * view is built here directly rather than through the component tree, so
 * nothing asks jsdom for a rectangle it cannot produce.
 */

let mounted: Mounted | null = null;
let view: EditorView | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  view?.destroy();
  view = null;
});

/** Panel, view and query, wired the way the running app wires them. */
function openFindOn(doc: string, query: string) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  // `search()` is the one extension these need. `findNext`/`findPrevious` read
  // the query out of its state field and silently do nothing when the field is
  // absent — which looks exactly like a focus fix that broke navigation, so
  // leaving it out would make these tests lie in the most confusing direction.
  // Replace is unaffected: it walks the `SearchQuery` cursor itself.
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [search({ top: true })] }),
    parent: target,
  });

  mounted = mountComponent(FindPanel);
  mounted.app.find.attach(view);
  mounted.app.ui.findReplaceMode.set(true);
  mounted.app.find.setQuery(query);
  flush();

  const field = (label: string) => {
    const input = mounted!.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!input) throw new Error(`no input labelled ${label}`);
    return input;
  };
  return { find: field('Find'), replace: field('Replace with'), content: view.contentDOM };
}

/** A real Enter, the way the browser delivers it to a focused input. */
function pressEnter(input: HTMLInputElement, options: KeyboardEventInit = {}) {
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...options }));
  flush();
}

describe('focus after a find-panel keystroke', () => {
  /**
   * The failure this prevents, and it reaches real files: Enter in the Find
   * field used to hand focus to the editor, so pressing it twice to step
   * through two matches typed a newline into the document on the second
   * press. Stepping through matches is the whole point of the field, and
   * "the caret went somewhere else" is not something a user checks for
   * before typing again.
   */
  it('leaves focus in the Find field so a second Enter is another match', () => {
    const { find, content } = openFindOn('alpha one\nalpha two\n', 'alpha');

    pressEnter(find);
    expect(document.activeElement).toBe(find);
    expect(document.activeElement).not.toBe(content);

    pressEnter(find);
    expect(document.activeElement).toBe(find);
  });

  /**
   * The failure this prevents: the same escape, one field over. Enter here
   * *replaces*, so a stolen focus puts the next keystroke into a document
   * that was just edited — the worst place to lose track of the caret.
   */
  it('leaves focus in the Replace field', () => {
    const { replace, content } = openFindOn('alpha one\nalpha two\n', 'alpha');
    mounted!.app.find.setReplacement('beta');
    flush();

    pressEnter(replace);
    expect(document.activeElement).toBe(replace);
    expect(document.activeElement).not.toBe(content);
  });

  /**
   * The failure this prevents: fixing the two above by deleting focus
   * handling outright. Replace All is still a panel action and still must
   * not move the caret out from under the user.
   */
  it('leaves focus in the Replace field after Replace All', () => {
    const { replace } = openFindOn('alpha one\nalpha two\n', 'alpha');
    mounted!.app.find.setReplacement('beta');
    flush();

    pressEnter(replace, { ctrlKey: true });
    expect(document.activeElement).toBe(replace);
    expect(view!.state.doc.toString()).toBe('beta one\nbeta two\n');
  });

  /**
   * The failure this prevents: over-correcting. Select All Matches exists to
   * hand you a cursor per match so you can *type*, so it is the one find
   * command that must still take focus. It keeps its own `view.focus()`.
   */
  it('still gives the editor focus on Select All Matches', () => {
    const { content } = openFindOn('alpha one\nalpha two\n', 'alpha');

    expect(mounted!.app.find.selectAllMatches()).toBe(true);
    expect(document.activeElement).toBe(content);
  });
});

describe('what the keystroke did, not just where focus went', () => {
  /**
   * The failure this prevents: a focus fix that satisfies the tests above by
   * making Enter do nothing at all. Focus staying put only counts if the
   * work still happened.
   */
  it('still advances through matches', () => {
    const { find } = openFindOn('alpha one\nalpha two\n', 'alpha');

    pressEnter(find);
    expect([view!.state.selection.main.from, view!.state.selection.main.to]).toEqual([0, 5]);

    pressEnter(find);
    expect([view!.state.selection.main.from, view!.state.selection.main.to]).toEqual([10, 15]);
  });

  /** And ⇧Enter still walks back up, from the match Enter just landed on. */
  it('still walks backwards on Shift+Enter', () => {
    const { find } = openFindOn('alpha one\nalpha two\n', 'alpha');

    pressEnter(find);
    pressEnter(find);
    pressEnter(find, { shiftKey: true });
    expect([view!.state.selection.main.from, view!.state.selection.main.to]).toEqual([0, 5]);
  });
});
