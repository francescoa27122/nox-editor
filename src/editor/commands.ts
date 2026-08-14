import { EditorSelection, type Line } from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';

/**
 * Editing commands CodeMirror does not ship.
 *
 * Everything else — undo, indent, line moves, comment toggling — comes from
 * `@codemirror/commands`. Only write a command here when the upstream package
 * genuinely lacks it.
 */

/**
 * Add a cursor on the line above or below the outermost existing cursor,
 * preserving the visual column. This is the multi-cursor gesture people reach
 * for constantly (⌥⌘↑ / ⌥⌘↓) and it is conspicuously missing from CM6.
 */
function addCursorVertically(view: EditorView, direction: -1 | 1): boolean {
  const { state } = view;
  const ranges = state.selection.ranges;

  // Grow from the edge in the direction of travel, so repeated presses fan out.
  const anchorRange = direction === -1
    ? ranges.reduce((a, b) => (a.head <= b.head ? a : b))
    : ranges.reduce((a, b) => (a.head >= b.head ? a : b));

  const line = state.doc.lineAt(anchorRange.head);
  const column = anchorRange.head - line.from;

  const targetNumber = line.number + direction;
  if (targetNumber < 1 || targetNumber > state.doc.lines) return false;

  const target: Line = state.doc.line(targetNumber);
  const head = Math.min(target.from + column, target.to);

  // Do not stack two cursors on the same spot.
  if (ranges.some((r) => r.empty && r.head === head)) return false;

  view.dispatch({
    selection: EditorSelection.create(
      [...ranges, EditorSelection.cursor(head)],
      state.selection.mainIndex,
    ),
    scrollIntoView: true,
  });
  return true;
}

export const addCursorAbove: Command = (view) => addCursorVertically(view, -1);
export const addCursorBelow: Command = (view) => addCursorVertically(view, 1);

/** Collapse a multi-cursor selection back to the primary cursor. */
export const collapseToPrimary: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.length <= 1) return false;
  view.dispatch({ selection: EditorSelection.create([state.selection.main]) });
  return true;
};

/** Place a cursor at the end of every line the selection touches. */
export const cursorAtEachSelectedLine: Command = (view) => {
  const { state } = view;
  const cursors = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) cursors.push(EditorSelection.cursor(state.doc.line(n).to));
  }
  if (cursors.length <= 1) return false;
  view.dispatch({ selection: EditorSelection.create(cursors) });
  return true;
};

/** Move the primary cursor to a 1-based line and optional 1-based column. */
export function goToLine(view: EditorView, lineNumber: number, column = 1): boolean {
  const { doc } = view.state;
  const clamped = Math.min(Math.max(1, Math.floor(lineNumber)), doc.lines);
  const line = doc.line(clamped);
  const position = Math.min(line.from + Math.max(0, column - 1), line.to);

  view.dispatch({
    selection: EditorSelection.cursor(position),
    scrollIntoView: true,
    effects: [],
  });
  view.focus();
  return true;
}

/** Cursor position for the status bar. Columns are 1-based, tabs count as one. */
export function cursorInfo(view: EditorView): {
  line: number;
  column: number;
  selectionLength: number;
  selectionLines: number;
  cursors: number;
} {
  const { state } = view;
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);

  let selectionLength = 0;
  for (const range of state.selection.ranges) selectionLength += range.to - range.from;

  const selectionLines = main.empty
    ? 0
    : state.doc.lineAt(main.to).number - state.doc.lineAt(main.from).number + 1;

  return {
    line: line.number,
    column: main.head - line.from + 1,
    selectionLength,
    selectionLines,
    cursors: state.selection.ranges.length,
  };
}
