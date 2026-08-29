import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/**
 * The Nox editor theme.
 *
 * Every colour is a CSS custom property from `styles/tokens.css`, so the
 * editor surface and the app chrome can never drift apart, and switching
 * themes is a single attribute flip on <html> with no CodeMirror reconfigure.
 */

export interface ThemeOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: 'line' | 'block' | 'underline';
  cursorBlink: boolean;
}

function cursorRules(style: ThemeOptions['cursorStyle']): Record<string, string> {
  switch (style) {
    case 'block':
      return {
        borderLeft: 'none',
        width: '1ch',
        background: 'var(--nox-cursor)',
        opacity: '0.42',
      };
    case 'underline':
      return {
        borderLeft: 'none',
        width: '1ch',
        borderBottom: '2px solid var(--nox-cursor)',
      };
    case 'line':
    default:
      return {
        borderLeft: '2px solid var(--nox-cursor)',
        marginLeft: '-1px',
      };
  }
}

export function noxTheme(options: ThemeOptions): Extension {
  const view = EditorView.theme(
    {
      '&': {
        color: 'var(--nox-text)',
        backgroundColor: 'var(--nox-bg-editor)',
        height: '100%',
        fontSize: `${options.fontSize}px`,
        fontFamily: options.fontFamily,
      },

      '.cm-scroller': {
        fontFamily: 'inherit',
        lineHeight: String(options.lineHeight),
        overflow: 'auto',
        // Slightly looser tracking makes small monospace text far more legible.
        letterSpacing: '0.01em',
      },

      '.cm-content': {
        caretColor: 'transparent',
        padding: '10px 0',
      },

      '.cm-line': {
        padding: '0 var(--nox-sp-5) 0 var(--nox-sp-4)',
      },

      // --- Cursor ---------------------------------------------------------
      '.cm-cursor, .cm-dropCursor': cursorRules(options.cursorStyle),
      '.cm-cursor': {
        animation: options.cursorBlink ? '' : 'none !important',
      },
      '&.cm-focused .cm-cursor': {
        // A faint bloom sells the "command center" feel without costing a repaint.
        boxShadow: options.cursorStyle === 'line' ? '0 0 6px var(--nox-accent-glow)' : 'none',
      },
      '.cm-dropCursor': {
        borderLeftColor: 'var(--nox-violet)',
      },

      // --- Selection ------------------------------------------------------
      '.cm-selectionBackground, ::selection': {
        background: 'var(--nox-selection-blur)',
      },
      '&.cm-focused .cm-selectionBackground, &.cm-focused ::selection': {
        background: 'var(--nox-selection)',
      },
      '.cm-selectionMatch': {
        background: 'rgba(125, 211, 224, 0.11)',
        borderRadius: '2px',
      },

      // --- Gutters --------------------------------------------------------
      '.cm-gutters': {
        backgroundColor: 'var(--nox-bg-editor)',
        color: 'var(--nox-gutter-fg)',
        border: 'none',
        borderRight: '1px solid transparent',
        userSelect: 'none',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 var(--nox-sp-4) 0 var(--nox-sp-6)',
        minWidth: '2.5ch',
        fontVariantNumeric: 'tabular-nums',
        fontSize: '0.92em',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--nox-gutter-active-fg)',
      },
      // --- Fold gutter -----------------------------------------------------
      // Arrows stay hidden until the gutter is hovered, so the column reads as
      // empty space rather than a permanent row of chevrons down the file.
      '.cm-foldGutter': {
        minWidth: '14px',
      },
      '.cm-foldGutter .cm-gutterElement': {
        padding: '0',
        color: 'var(--nox-gutter-fg)',
        cursor: 'pointer',
      },
      '.cm-foldGutter .nox-fold-marker': {
        display: 'grid',
        placeItems: 'center',
        height: '100%',
        opacity: '0',
        transition: 'opacity var(--nox-dur-fast) var(--nox-ease), color var(--nox-dur-fast) var(--nox-ease)',
      },
      '&:hover .cm-foldGutter .nox-fold-marker': {
        opacity: '0.65',
      },
      // A closed fold always shows: it marks hidden content, so it must be
      // visible whether or not the pointer is anywhere near the gutter.
      '.cm-foldGutter .nox-fold-marker.nox-fold-closed': {
        opacity: '1',
        color: 'var(--nox-accent)',
      },
      '.cm-foldGutter .cm-gutterElement:hover .nox-fold-marker': {
        opacity: '1',
        color: 'var(--nox-text-bright)',
      },
      // --- Provenance gutter ------------------------------------------------
      '.cm-provenanceGutter': {
        width: '3px',
        padding: '0',
      },
      // Quiet on purpose: this is somewhere to look when you are curious, not
      // something that competes for attention while you work.
      '.cm-provenanceGutter .nox-provenance-marker': {
        display: 'block',
        width: '2px',
        height: '100%',
        background: 'var(--nox-violet-dim)',
      },

      // --- Git gutter -------------------------------------------------------
      '.cm-gitGutter': {
        width: '3px',
        padding: '0',
      },
      '.cm-gitGutter .nox-git-marker': {
        display: 'block',
        width: '2px',
        height: '100%',
      },
      '.cm-gitGutter .nox-git-marker-added': {
        background: 'var(--nox-success)',
      },
      '.cm-gitGutter .nox-git-marker-modified': {
        background: 'var(--nox-warning)',
      },
      // A removal is a point, not a range: a short thick mark at the top of
      // the line below where the lines used to be.
      '.cm-gitGutter .nox-git-marker-removed': {
        width: '3px',
        height: '6px',
        background: 'var(--nox-danger)',
      },

      // --- Blame gutter -----------------------------------------------------
      // Present only while blame is switched on for the buffer (the pane
      // reconfigures `blameCompartment`), so this column costs nothing when
      // it is off.
      '.cm-blameGutter': {
        // The line-number gutter's own left inset. Blame is the leftmost
        // column when it is on, so this is the editor's left margin, and it
        // sat flush against the window edge until it matched.
        padding: '0 var(--nox-sp-4) 0 var(--nox-sp-6)',
        // The dividing rule is the gutter's, not each row's: a border on the
        // elements would break at every line boundary.
        borderRight: '1px solid var(--nox-border)',
      },
      '.cm-blameGutter .nox-blame-entry': {
        display: 'block',
        color: 'var(--nox-gutter-fg)',
        // The line-number gutter's size, so the three columns down the left
        // read as one apparatus rather than as code that has been indented.
        fontSize: '0.92em',
        // Pre, because the label is padded to a fixed width and the column's
        // stability depends on those spaces surviving. `nowrap` alone would
        // still collapse them.
        whiteSpace: 'pre',
      },
      // A line no commit holds is dimmer still: it is the absence of an
      // answer, and it must not read as loudly as a name.
      '.cm-blameGutter .nox-blame-uncommitted': {
        opacity: '0.6',
        fontStyle: 'italic',
      },

      // --- Active line ----------------------------------------------------
      '.cm-activeLine': {
        backgroundColor: 'var(--nox-line-active)',
      },

      // --- Brackets & search ----------------------------------------------
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: 'var(--nox-match-bracket)',
        outline: '1px solid rgba(125, 211, 224, 0.4)',
        borderRadius: '2px',
      },
      '.cm-nonmatchingBracket': {
        color: 'var(--nox-danger)',
        backgroundColor: 'rgba(240, 97, 109, 0.12)',
        borderRadius: '2px',
      },
      '.cm-searchMatch': {
        backgroundColor: 'var(--nox-search-match)',
        outline: '1px solid rgba(227, 179, 65, 0.32)',
        borderRadius: '2px',
      },
      // The active match takes an explicit foreground, and the descendant
      // selector is the point of it: syntax highlighting paints the spans
      // *inside* this mark, so colouring the mark alone changes nothing.
      //
      // Without it the match keeps whatever syntax colour it had, over a 45%
      // yellow wash. A comment came out at 1.63:1 — the one piece of text the
      // user is definitely looking at, and the least readable on screen.
      // --nox-text-bright measures 5.91:1 on that composite in Eclipse and
      // 6.61:1 in Umbra. Losing the syntax hue inside the active match is the
      // trade, and it is the one every editor makes here.
      '.cm-searchMatch.cm-searchMatch-selected, .cm-searchMatch.cm-searchMatch-selected span':
        {
          color: 'var(--nox-text-bright)',
        },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'var(--nox-search-match-active)',
        outline: '1px solid rgba(227, 179, 65, 0.7)',
      },

      // --- Whitespace & specials ------------------------------------------
      '.cm-specialChar': {
        color: 'var(--nox-danger)',
      },
      '.cm-highlightSpace:before': {
        color: 'var(--nox-text-faint)',
        opacity: '0.5',
      },
      '.cm-highlightTab': {
        backgroundImage: 'none',
        borderLeft: '1px solid var(--nox-border-strong)',
      },

      // --- Fold placeholder -----------------------------------------------
      '.cm-foldPlaceholder': {
        background: 'var(--nox-selected)',
        border: '1px solid var(--nox-violet-dim)',
        borderRadius: 'var(--nox-r-sm)',
        color: 'var(--nox-text-muted)',
        padding: '0 var(--nox-sp-3)',
        margin: '0 var(--nox-sp-2)',
        cursor: 'pointer',
        fontSize: '0.85em',
        lineHeight: '1',
        transition:
          'background var(--nox-dur-fast) var(--nox-ease), color var(--nox-dur-fast) var(--nox-ease)',
      },
      '.cm-foldPlaceholder:hover': {
        background: 'var(--nox-selected-strong)',
        color: 'var(--nox-text-bright)',
      },

      // --- Tooltips (autocomplete, hovers) --------------------------------
      '.cm-tooltip': {
        background: 'var(--nox-bg-raised)',
        border: '1px solid var(--nox-border-strong)',
        borderRadius: 'var(--nox-r-md)',
        boxShadow: 'var(--nox-shadow-md)',
        color: 'var(--nox-text)',
        fontFamily: 'var(--nox-font-ui)',
        fontSize: 'var(--nox-fs-sm)',
      },
      // CodeMirror ships a glyph for each of its own thirteen completion
      // types and none for `snippet`, which is Nox's. Without this the row
      // keeps the reserved icon column and draws nothing in it, so a snippet
      // reads as an item whose kind failed to load rather than as a snippet.
      /*
         Plugin decorations. Four kinds, and the plugin picks one rather than
         a colour — it names what it means, Nox decides how that is drawn.

         Underlines rather than backgrounds for the three that report
         something: a background competes with the selection and with the
         search highlight, and a plugin's opinion should not outrank either.
         `highlight` is the one that does fill, because that is what asking
         for a highlight means.
      */
      '.cm-nox-plugin-error': {
        textDecoration: 'underline wavy var(--nox-danger)',
        textUnderlineOffset: '3px',
      },
      '.cm-nox-plugin-warning': {
        textDecoration: 'underline wavy var(--nox-warning)',
        textUnderlineOffset: '3px',
      },
      '.cm-nox-plugin-info': {
        textDecoration: 'underline dotted var(--nox-info)',
        textUnderlineOffset: '3px',
      },
      '.cm-nox-plugin-highlight': {
        background: 'var(--nox-plugin-highlight)',
        borderRadius: 'var(--nox-r-sm)',
      },

      '.cm-completionIcon-snippet:after': {
        content: "'⌗'",
        color: 'var(--nox-accent)',
      },
      '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'var(--nox-border-strong)' },
      '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--nox-bg-raised)' },

      // `.cm-tooltip` sets background/border/colour/font but no padding —
      // autocomplete only reads as padded because CM styles its own
      // `ul li` rows, which a plain `<div>` here does not inherit. Left
      // bare, this text sits flush against the 1px border with no width
      // limit, so a long description (e.g. `Replace "<long query>"`) grows
      // the tooltip to match.
      '.cm-tooltip-provenance': {
        padding: 'var(--nox-sp-3) var(--nox-sp-4)',
        maxWidth: '320px',
        lineHeight: 'var(--nox-lh-ui)',
      },

      // CodeMirror's bottom panels are unused — Nox draws its own find UI —
      // so hide them defensively, the same guard this rule always was. Top
      // panels are no longer blanket-hidden: sticky scroll (`editor/sticky.ts`)
      // is a deliberate `showPanel` consumer and needs its container to
      // render. Its background and text colour replace CM's own hardcoded
      // ones so nothing here ever shows an untokened colour, painted or not.
      '.cm-panels-bottom': { display: 'none' },
      '.cm-panels-top': {
        backgroundColor: 'transparent',
        color: 'inherit',
      },

      // --- Sticky scroll ---------------------------------------------------
      // The panel container itself carries no border or padding — only
      // `.nox-sticky-scroll` does, and it collapses to nothing via `:empty`
      // when there is nothing to pin, so an empty file never shows a bare
      // strip.
      '.nox-sticky-scroll': {
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--nox-bg-editor)',
        borderBottom: '1px solid var(--nox-border)',
      },
      '.nox-sticky-scroll:empty': {
        display: 'none',
        border: 'none',
      },
      '.nox-sticky-row': {
        display: 'block',
        width: '100%',
        border: 'none',
        background: 'transparent',
        textAlign: 'left',
        color: 'var(--nox-text-muted)',
        fontFamily: 'inherit',
        fontSize: '0.92em',
        lineHeight: String(options.lineHeight),
        padding: '0 var(--nox-sp-5) 0 var(--nox-sp-4)',
        cursor: 'pointer',
        whiteSpace: 'pre',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      '.nox-sticky-row:hover': {
        background: 'var(--nox-hover)',
        color: 'var(--nox-text-bright)',
      },
    },
    { dark: true },
  );

  return [view, syntaxHighlighting(noxHighlightStyle)];
}

/**
 * Syntax colours. The rule behind the palette: structure is violet, data is
 * warm, identity is cyan, and everything inert recedes toward the background.
 */
export const noxHighlightStyle = HighlightStyle.define(
  [
    { tag: [t.comment, t.blockComment, t.lineComment], color: 'var(--nox-syn-comment)', fontStyle: 'italic' },
    { tag: [t.docComment], color: 'var(--nox-syn-comment)', fontStyle: 'italic' },

    { tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword], color: 'var(--nox-syn-keyword)' },
    { tag: [t.operatorKeyword, t.definitionKeyword], color: 'var(--nox-syn-keyword)' },
    { tag: [t.self, t.null], color: 'var(--nox-syn-keyword)' },

    { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--nox-syn-string)' },
    { tag: [t.escape], color: 'var(--nox-syn-constant)' },

    { tag: [t.number, t.integer, t.float], color: 'var(--nox-syn-number)' },
    { tag: [t.bool, t.atom, t.constant(t.name), t.standard(t.name)], color: 'var(--nox-syn-constant)' },

    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--nox-syn-function)' },
    { tag: [t.definition(t.function(t.variableName))], color: 'var(--nox-syn-function)' },
    { tag: [t.macroName], color: 'var(--nox-syn-function)' },

    { tag: [t.typeName, t.className, t.namespace], color: 'var(--nox-syn-type)' },
    { tag: [t.definition(t.typeName)], color: 'var(--nox-syn-type)' },
    { tag: [t.annotation], color: 'var(--nox-syn-type)' },

    { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--nox-syn-variable)' },
    { tag: [t.propertyName, t.attributeName], color: 'var(--nox-syn-property)' },
    { tag: [t.labelName], color: 'var(--nox-syn-property)' },

    { tag: [t.operator, t.compareOperator, t.arithmeticOperator, t.logicOperator], color: 'var(--nox-syn-operator)' },
    { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket], color: 'var(--nox-syn-punctuation)' },
    { tag: [t.derefOperator], color: 'var(--nox-syn-punctuation)' },

    { tag: [t.tagName], color: 'var(--nox-syn-tag)' },
    { tag: [t.angleBracket], color: 'var(--nox-syn-punctuation)' },

    // Markdown and prose
    { tag: [t.heading], color: 'var(--nox-syn-heading)', fontWeight: '600' },
    { tag: [t.heading1], color: 'var(--nox-syn-heading)', fontWeight: '700' },
    { tag: [t.link, t.url], color: 'var(--nox-syn-link)', textDecoration: 'underline' },
    { tag: [t.emphasis], fontStyle: 'italic' },
    { tag: [t.strong], fontWeight: '700', color: 'var(--nox-text-bright)' },
    { tag: [t.strikethrough], textDecoration: 'line-through', color: 'var(--nox-text-muted)' },
    { tag: [t.quote], color: 'var(--nox-text-muted)', fontStyle: 'italic' },
    { tag: [t.monospace], color: 'var(--nox-syn-string)' },
    { tag: [t.contentSeparator], color: 'var(--nox-text-faint)' },
    { tag: [t.list], color: 'var(--nox-syn-keyword)' },

    { tag: [t.meta, t.processingInstruction], color: 'var(--nox-text-muted)' },
    { tag: [t.invalid], color: 'var(--nox-syn-invalid)', textDecoration: 'underline wavy' },
    { tag: [t.deleted], color: 'var(--nox-danger)' },
    { tag: [t.inserted], color: 'var(--nox-success)' },
    { tag: [t.changed], color: 'var(--nox-warning)' },
  ],
  { themeType: 'dark' },
);
