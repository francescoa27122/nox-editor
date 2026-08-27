import { RangeSet, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, hoverTooltip, type DecorationSet } from '@codemirror/view';
import type { PluginDecoration } from '@core/plugin-decorations';

/**
 * Marks a plugin asked for, drawn by Nox.
 *
 * A `StateField`, and by the same test `provenance.ts` applies: is this
 * *derivable* from the document? It is not. Nothing in the text remembers that
 * a plugin thought line 40 was suspicious, so it has to be recorded when the
 * plugin says so and carried forward afterwards — which a `RangeSet` in state
 * does for free.
 *
 * **Carried forward is the point.** A plugin is in another process and cannot
 * be asked to re-decorate between one keystroke and the next. Mapping the set
 * through each change is what keeps its marks over the text they were about
 * while the user keeps typing, until the plugin sends a fresh set. The
 * alternative — dropping them on the first edit — would make a decoration
 * flash out of existence the moment anyone touched the file.
 *
 * **The typing-path cost is that mapping and nothing else.** It is
 * proportional to how many marks there are, which is why
 * `core/plugin-decorations.ts` caps them, and it is the same cost the git
 * gutter and provenance already pay. There is no scan, no parse and no
 * per-keystroke call into a plugin.
 */

/** Replace this buffer's plugin marks wholesale. */
export const setPluginDecorations = StateEffect.define<readonly PluginDecoration[]>();

/**
 * The classes Nox draws each kind as.
 *
 * A closed map rather than anything the plugin supplies: a plugin naming its
 * own class would be a plugin styling the editor, and the arrangement is that
 * it names what it *means* while Nox decides how that looks.
 */
const MARKS = {
  error: Decoration.mark({ class: 'cm-nox-plugin-error' }),
  warning: Decoration.mark({ class: 'cm-nox-plugin-warning' }),
  info: Decoration.mark({ class: 'cm-nox-plugin-info' }),
  highlight: Decoration.mark({ class: 'cm-nox-plugin-highlight' }),
} as const;

/** The messages behind the marks, for the hover. Kept beside the set. */
interface Marks {
  set: DecorationSet;
  /** Message by `from` offset, in the coordinates the set was built in. */
  messages: readonly PluginDecoration[];
}

const EMPTY: Marks = { set: Decoration.none, messages: [] };

function build(decorations: readonly PluginDecoration[]): Marks {
  // Already sorted, clamped and bounded by `normaliseDecorations` — which is
  // load-bearing rather than tidy: `RangeSet.of` throws on unsorted input and
  // CodeMirror throws on a range past the end of the document.
  return {
    set: RangeSet.of(
      decorations.map((decoration) => MARKS[decoration.kind].range(decoration.from, decoration.to)),
      true,
    ),
    messages: decorations,
  };
}

export const pluginDecorationField = StateField.define<Marks>({
  create: () => EMPTY,
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPluginDecorations)) return build(effect.value);
    }
    if (!tr.docChanged) return marks;

    // Mapped, then filtered: `RangeSet.map` collapses a mark that sat over
    // deleted text into a zero-width range rather than dropping it, exactly as
    // `provenance.ts` documents. A zero-width mark draws nothing and still
    // costs a mapping on every subsequent edit.
    return {
      set: marks.set.map(tr.changes).update({ filter: (from, to) => to > from }),
      messages: marks.messages,
    };
  },
  provide: (field) => EditorView.decorations.from(field, (marks) => marks.set),
});

/**
 * The hover for a decorated range.
 *
 * Reads the *mapped* set for the range under the pointer and the unmapped list
 * for its text, which is why `messages` rides along: the offsets in it go
 * stale as the user types, but the order does not, and the mapped set is what
 * says where each one is now.
 */
function decorationHover(): Extension {
  return hoverTooltip((view, pos) => {
    const marks = view.state.field(pluginDecorationField, false);
    if (!marks || marks.messages.length === 0) return null;

    let found: { from: number; to: number; index: number } | null = null;
    let index = 0;
    marks.set.between(pos, pos, (from, to) => {
      if (found === null) found = { from, to, index };
      index += 1;
      return undefined;
    });
    if (found === null) return null;

    const hit = found as { from: number; to: number; index: number };
    const message = marks.messages[hit.index]?.message;
    if (!message) return null;

    return {
      pos: hit.from,
      end: hit.to,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-tooltip-provenance';
        // Text, never HTML. A plugin's message is a third party's string, and
        // parsing it into a live DOM would buy typography with an injection
        // surface — the same call `editor/hover.ts` makes about a language
        // server's markdown.
        dom.textContent = message;
        return { dom };
      },
    };
  });
}

/** The field and its hover. Unconditional — see `extensions.ts`. */
export function pluginDecorationExtension(): Extension {
  return [pluginDecorationField, decorationHover()];
}

/** Push a fresh set into a view. The one way marks get in. */
export function applyPluginDecorations(
  view: EditorView,
  decorations: readonly PluginDecoration[],
): void {
  view.dispatch({ effects: setPluginDecorations.of(decorations) });
}
