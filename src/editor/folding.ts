import {
  codeFolding,
  foldable,
  foldAll,
  foldCode,
  foldEffect,
  foldGutter,
  foldedRanges,
  unfoldAll,
  unfoldCode,
  unfoldEffect,
} from '@codemirror/language';
import type { EditorState, Extension, StateEffect } from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';

/**
 * Code folding.
 *
 * The ranges come from the language grammar via CodeMirror's fold service, so
 * folding is only available for languages Nox ships a parser for. That is
 * honest rather than limiting: indentation-guessed folds are wrong often
 * enough to be worse than none, and the gutter simply shows no arrow where
 * there is nothing to fold.
 *
 * Fold state lives in the `EditorState`, which the workspace owns per buffer —
 * so folds survive a tab switch for free, the same way selection and undo do.
 */

/** Chevron markers, matching the explorer's twisty rather than CM's default. */
function markerDOM(open: boolean): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = `nox-fold-marker${open ? '' : ' nox-fold-closed'}`;
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.title = open ? 'Fold' : 'Unfold';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', open ? 'M3.5 6 8 10.5 12.5 6' : 'M6 3.5 10.5 8 6 12.5');
  svg.appendChild(path);
  wrapper.appendChild(svg);
  return wrapper;
}

/** The `⋯` shown in place of folded text. Clicking it unfolds. */
function placeholderDOM(_view: EditorView, onclick: (event: Event) => void): HTMLElement {
  const element = document.createElement('span');
  element.className = 'cm-foldPlaceholder';
  element.textContent = '⋯';
  element.title = 'Click to unfold';
  element.setAttribute('role', 'button');
  element.setAttribute('tabindex', '0');
  element.onclick = onclick;
  element.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onclick(event);
    }
  };
  return element;
}

export function foldingExtension(enabled: boolean): Extension {
  if (!enabled) return [];
  return [
    codeFolding({ placeholderDOM }),
    foldGutter({
      markerDOM,
      // The gutter is otherwise a dead column of hover targets on files with
      // nothing foldable.
      openText: '',
      closedText: '',
    }),
  ];
}

/**
 * Foldable ranges whose nesting depth equals `level - 1`.
 *
 * Pure and independent of any view, which is what lets it be tested against a
 * real parse. A single scan with a stack of enclosing end positions gives the
 * depth of each candidate without re-walking the tree per line.
 */
export function foldRangesAtLevel(
  state: EditorState,
  level: number,
): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  const enclosing: number[] = [];

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber++) {
    const line = state.doc.line(lineNumber);
    while (enclosing.length > 0 && enclosing[enclosing.length - 1]! < line.from) enclosing.pop();

    const range = foldable(state, line.from, line.to);
    if (!range) continue;

    if (enclosing.length === level - 1) ranges.push(range);
    enclosing.push(range.to);
  }

  return ranges;
}

/** Fold everything at one nesting level, leaving other levels alone. */
export function foldToLevel(level: number): Command {
  return (view) => {
    const ranges = foldRangesAtLevel(view.state, level);
    if (ranges.length === 0) return false;
    view.dispatch({ effects: ranges.map((range) => foldEffect.of(range)) });
    return true;
  };
}

/** True when anything in the document is currently folded. */
export function hasFolds(state: EditorState): boolean {
  let found = false;
  foldedRanges(state).between(0, state.doc.length, () => {
    found = true;
    return false;
  });
  return found;
}

/** Unfold every range that contains the cursor, outermost first. */
export const unfoldAtCursor: Command = (view) => {
  const position = view.state.selection.main.head;
  const effects: StateEffect<{ from: number; to: number }>[] = [];

  foldedRanges(view.state).between(position, position, (from, to) => {
    effects.push(unfoldEffect.of({ from, to }));
  });

  if (effects.length === 0) return false;
  view.dispatch({ effects });
  return true;
};

export { foldAll, foldCode, unfoldAll, unfoldCode };
