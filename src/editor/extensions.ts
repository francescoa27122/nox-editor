import { acceptCompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  standardKeymap,
} from '@codemirror/commands';
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language';
import { highlightSelectionMatches, search, selectNextOccurrence } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection,
  scrollPastEnd,
} from '@codemirror/view';
import type { Settings } from '@services/config/schema';
import { addCursorAbove, addCursorBelow } from './commands';
import { foldingExtension } from './folding';
import { gitGutter, gitGutterField } from './git-gutter';
import { lspDiagnosticsExtension } from './lsp';

/**
 * Holds every language-server editor extension.
 *
 * One compartment rather than one per feature: they all need the *pane's*
 * current buffer, and `buildExtensions` is a workspace-level factory that has
 * no idea which one that is. `EditorPane` reconfigures it, the way it already
 * does for the grammar — so the next feature on this door is an entry in an
 * array rather than another wiring path.
 */
export const lspCompartment = new Compartment();
import { languageCompartment } from './languages';
import { provenanceField, provenanceGutter, provenanceTooltip } from './provenance';
import { searchHighlighter } from './search-highlight';
import { stickyScrollExtension } from './sticky';
import { noxTheme } from './theme';

/**
 * Composes the CodeMirror extension set from Nox settings.
 *
 * Every setting-driven extension sits in its own Compartment so a preference
 * change is a targeted `reconfigure` rather than a state rebuild. Rebuilding
 * would discard undo history and scroll position, which users notice
 * immediately and never forgive.
 */

const compartments = {
  theme: new Compartment(),
  tabSize: new Compartment(),
  indentUnit: new Compartment(),
  wrap: new Compartment(),
  lineNumbers: new Compartment(),
  activeLine: new Compartment(),
  brackets: new Compartment(),
  closeBrackets: new Compartment(),
  whitespace: new Compartment(),
  scrollPastEnd: new Compartment(),
  autoIndent: new Compartment(),
  folding: new Compartment(),
  provenance: new Compartment(),
  gitGutter: new Compartment(),
  sticky: new Compartment(),
} as const;

type CompartmentName = keyof typeof compartments;

/** Which compartments each setting feeds. Drives targeted reconfiguration. */
const SETTING_TO_COMPARTMENTS: Partial<Record<keyof Settings, CompartmentName[]>> = {
  'editor.fontFamily': ['theme'],
  'editor.fontSize': ['theme'],
  'editor.lineHeight': ['theme'],
  'editor.cursorStyle': ['theme'],
  'editor.cursorBlink': ['theme'],
  'editor.tabSize': ['tabSize', 'indentUnit'],
  'editor.insertSpaces': ['indentUnit'],
  'editor.wordWrap': ['wrap'],
  'editor.lineNumbers': ['lineNumbers'],
  'editor.relativeLineNumbers': ['lineNumbers'],
  'editor.highlightActiveLine': ['activeLine'],
  'editor.bracketMatching': ['brackets'],
  'editor.autoCloseBrackets': ['closeBrackets'],
  'editor.renderWhitespace': ['whitespace'],
  'editor.scrollBeyondLastLine': ['scrollPastEnd'],
  'editor.autoIndent': ['autoIndent'],
  'editor.codeFolding': ['folding'],
  'workbench.showChangeMarks': ['provenance'],
  'editor.gitGutter': ['gitGutter'],
  'editor.stickyScroll': ['sticky'],
};

// --- Per-compartment content ------------------------------------------------

function themeExtension(s: Settings): Extension {
  return noxTheme({
    fontFamily: s['editor.fontFamily'],
    fontSize: s['editor.fontSize'],
    lineHeight: s['editor.lineHeight'],
    cursorStyle: s['editor.cursorStyle'],
    cursorBlink: s['editor.cursorBlink'],
  });
}

function indentExtension(s: Settings): Extension {
  return indentUnit.of(s['editor.insertSpaces'] ? ' '.repeat(s['editor.tabSize']) : '\t');
}

function lineNumbersExtension(s: Settings): Extension {
  if (!s['editor.lineNumbers']) return [];
  if (!s['editor.relativeLineNumbers']) return lineNumbers();

  return lineNumbers({
    formatNumber(lineNo, state) {
      const cursorLine = state.doc.lineAt(state.selection.main.head).number;
      if (lineNo === cursorLine) return String(lineNo);
      return String(Math.abs(lineNo - cursorLine));
    },
  });
}

function whitespaceExtension(s: Settings): Extension {
  switch (s['editor.renderWhitespace']) {
    case 'all':
      return highlightWhitespace();
    case 'trailing':
      return highlightTrailingWhitespace();
    default:
      return [];
  }
}

function compartmentContent(name: CompartmentName, s: Settings): Extension {
  switch (name) {
    case 'theme':
      return themeExtension(s);
    case 'tabSize':
      return EditorState.tabSize.of(s['editor.tabSize']);
    case 'indentUnit':
      return indentExtension(s);
    case 'wrap':
      return s['editor.wordWrap'] ? EditorView.lineWrapping : [];
    case 'lineNumbers':
      return lineNumbersExtension(s);
    case 'activeLine':
      return s['editor.highlightActiveLine']
        ? [highlightActiveLine(), highlightActiveLineGutter()]
        : [];
    case 'brackets':
      return s['editor.bracketMatching'] ? bracketMatching() : [];
    case 'closeBrackets':
      return s['editor.autoCloseBrackets'] ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : [];
    case 'whitespace':
      return whitespaceExtension(s);
    case 'scrollPastEnd':
      return s['editor.scrollBeyondLastLine'] ? scrollPastEnd() : [];
    case 'autoIndent':
      return s['editor.autoIndent'] ? indentOnInput() : [];
    case 'folding':
      return foldingExtension(s['editor.codeFolding']);
    case 'provenance':
      return s['workbench.showChangeMarks'] ? [provenanceGutter(), provenanceTooltip()] : [];
    case 'gitGutter':
      return s['editor.gitGutter'] ? gitGutter() : [];
    case 'sticky':
      return stickyScrollExtension(s['editor.stickyScroll']);
  }
}

// --- Public API --------------------------------------------------------------

/**
 * The keymap CodeMirror owns.
 *
 * Application shortcuts (open, save, palette) live in `services/keymap.ts`.
 * Splitting them this way means exactly one layer claims any given chord, so
 * there is never a race over `preventDefault`.
 */
function editorKeymap(): Extension {
  return keymap.of([
    { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
    { key: 'Mod-Alt-ArrowUp', run: addCursorAbove, preventDefault: true },
    { key: 'Mod-Alt-ArrowDown', run: addCursorBelow, preventDefault: true },
    ...standardKeymap,
    ...defaultKeymap,
    ...historyKeymap,
    // Tab accepts the highlighted completion, and otherwise indents.
    //
    // One key, two jobs, and no mode flag: `acceptCompletion` returns false
    // when no picker is open, so the binding below it runs instead. Ordering
    // is the whole mechanism — earlier entries are tried first — which is why
    // this sits above `indentWithTab` rather than anywhere tidier.
    { key: 'Tab', run: acceptCompletion },
    // Tab indents rather than moving focus. Shift-Tab still outdents; users
    // who need to escape the editor by keyboard use ⌘⇧E to focus the explorer.
    indentWithTab,
  ]);
}

/** Extensions that never change and carry no settings. */
function staticExtensions(): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    highlightSpecialChars(),
    highlightSelectionMatches({ minSelectionLength: 2, wholeWords: false }),
    // Present so Nox's own find panel can drive setSearchQuery/findNext.
    // CodeMirror's built-in panel is never opened; we paint matches ourselves.
    search({ top: true }),
    searchHighlighter(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of((event) => event.altKey),
    editorKeymap(),
    // The field is unconditional; only its rendering is compartmentalised.
    // A compartment reconfigured to nothing removes its extensions, and
    // removing a StateField destroys the state it holds — so gating the field
    // on the setting would throw every mark away the moment it was toggled off.
    provenanceField,
    // Same split, same reason: the hunks survive a settings toggle.
    gitGutterField,
  ];
}

/**
 * Build the full extension list for a new buffer state. Passed to
 * `WorkspaceService` as its `StateFactory`.
 */
export function buildExtensions(settings: Settings): Extension[] {
  const configured = (Object.keys(compartments) as CompartmentName[]).map((name) =>
    compartments[name].of(compartmentContent(name, settings)),
  );
  return [
    ...staticExtensions(),
    ...configured,
    // The gutter marks. Squiggles arrive per batch through `setDiagnostics`,
    // so nothing here is conditional on a server being configured — with none
    // running there are simply no diagnostics, and the gutter stays empty.
    lspDiagnosticsExtension(),
    // Empty until a pane fills it in; see `lspCompartment`.
    lspCompartment.of([]),
    // Empty until the grammar resolves; see `editor/languages.ts`.
    languageCompartment.of([]),
  ];
}

/**
 * Reconfiguration effects for the settings that changed. Passing the changed
 * keys keeps a font-size tweak from rebuilding the grammar and gutters too.
 */
export function reconfigureEffects(settings: Settings, changed: ReadonlySet<string>) {
  const names = new Set<CompartmentName>();
  for (const key of changed) {
    for (const name of SETTING_TO_COMPARTMENTS[key as keyof Settings] ?? []) names.add(name);
  }
  return [...names].map((name) => compartments[name].reconfigure(compartmentContent(name, settings)));
}

/** Reconfigure every compartment — used when a whole settings file loads. */
export function reconfigureAllEffects(settings: Settings) {
  return (Object.keys(compartments) as CompartmentName[]).map((name) =>
    compartments[name].reconfigure(compartmentContent(name, settings)),
  );
}
