import {
  findNext,
  findPrevious,
  RegExpCursor,
  SearchCursor,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import { type ChangeSpec, EditorSelection, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { expandReplacement, preserveCase } from '@core/replace';
import { Signal } from '@core/signal';

/**
 * Drives CodeMirror's search engine from Nox's own find panel.
 *
 * CodeMirror ships a perfectly good search *engine* and a panel that looks
 * nothing like Nox. We keep the engine and draw our own UI — this class is the
 * seam between them.
 *
 * The split is deliberate and was arrived at the hard way: **matching stays on
 * `SearchQuery`, only the replacement text is ours.** `SearchQuery` carries a
 * multi-line regex cursor, `\n`/`\t` unquoting of the find field, and a
 * Unicode character categorizer behind whole-word — none of which a
 * line-based matcher of our own would reproduce. Because the counter, the
 * highlights and replace all walk the *same* query, they cannot disagree
 * about what a match is. What we do own is the string each match is replaced
 * with, which comes from `@core/replace` so that ⌘F and ⌘⇧F write the same
 * text for the same match.
 */

/** Counting stops here; past this a file is better served by project search. */
const MAX_COUNTED_MATCHES = 10_000;

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  preserveCase: boolean;
}

export interface FindStatus {
  /** Total matches, capped at MAX_COUNTED_MATCHES. */
  total: number;
  /** 1-based index of the match at the cursor, or 0 when not on one. */
  current: number;
  capped: boolean;
  /** Set when `regexp` is on and the pattern does not compile. */
  invalidPattern: string | null;
}

const EMPTY: FindStatus = { total: 0, current: 0, capped: false, invalidPattern: null };

/** One match, with everything the replacement needs, read off CodeMirror's cursor. */
interface FoundMatch {
  from: number;
  to: number;
  /**
   * False when the range covers characters that are not wholly part of the
   * match — a normalized character that expands to several. CodeMirror
   * refuses to replace those, and so do we: the range would eat text either
   * side of the match.
   */
  precise: boolean;
  /** The regex match, for a regex query — the only source of `$1`/`$&`/`$<name>`. */
  match: RegExpExecArray | null;
}

/**
 * Advance a `SearchQuery` cursor and read the whole match off it.
 *
 * `getCursor` is typed as a bare `Iterator<{from, to}>`, but it only ever
 * returns one of the two exported cursor classes, and both publish `precise`
 * (and, for the regex one, the match) on `value`. Narrowing on the class is
 * how we get at them without a cast — and without building a second matcher.
 */
function step(cursor: Iterator<{ from: number; to: number }>): FoundMatch | null {
  const result = cursor.next();
  if (result.done) return null;
  if (cursor instanceof RegExpCursor) {
    const { from, to, precise, match } = cursor.value;
    return { from, to, precise, match };
  }
  if (cursor instanceof SearchCursor) {
    const { from, to, precise } = cursor.value;
    return { from, to, precise, match: null };
  }
  return { from: result.value.from, to: result.value.to, precise: true, match: null };
}

/**
 * Turn `\n`, `\r`, `\t` and `\\` in the replace field into real characters.
 *
 * `SearchQuery` does exactly this to both fields, but its `unquote` is
 * internal and absent from the published types, so the replace side has to
 * repeat it. Kept identical to `SearchQuery.unquote` in @codemirror/search
 * 6.7.1; it is not a matcher, and the find field still unquotes inside
 * `SearchQuery` as before.
 */
function unquote(text: string): string {
  return text.replace(/\\([nrt\\])/g, (_, ch: string) =>
    ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : '\\',
  );
}

export class FindController {
  readonly query = new Signal('');
  readonly replacement = new Signal('');
  readonly options = new Signal<FindOptions>({
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
    preserveCase: false,
  });
  readonly status = new Signal<FindStatus>(EMPTY);

  #view: EditorView | null = null;

  attach(view: EditorView | null): void {
    this.#view = view;
    if (view) this.#sync();
    else this.status.set(EMPTY);
  }

  setQuery(text: string): void {
    this.query.set(text);
    this.#sync();
  }

  setReplacement(text: string): void {
    this.replacement.set(text);
    this.#sync();
  }

  toggle(option: keyof FindOptions): void {
    this.options.update((current) => ({ ...current, [option]: !current[option] }));
    this.#sync();
  }

  /** Seed the field from the selection, the way every editor does on ⌘F. */
  seedFromSelection(): void {
    const view = this.#view;
    if (!view) return;
    const main = view.state.selection.main;
    if (main.empty || main.to - main.from > 200) return;
    const text = view.state.sliceDoc(main.from, main.to);
    if (text.includes('\n')) return;
    this.query.set(text);
    this.#sync();
  }

  next(): void {
    this.#run(findNext);
  }

  previous(): void {
    this.#run(findPrevious);
  }

  replaceCurrent(): void {
    this.#run((view) => this.#replaceNext(view));
  }

  replaceEvery(): void {
    this.#run((view) => this.#replaceAll(view));
  }

  /** Put a cursor on every match — find's multi-cursor payoff. */
  selectAllMatches(): boolean {
    const view = this.#view;
    const built = this.#build();
    if (!view || !built || this.query.get().length === 0) return false;

    const ranges: { from: number; to: number }[] = [];
    const cursor = built.getCursor(view.state);
    for (let value = cursor.next(); !value.done; value = cursor.next()) {
      ranges.push({ from: value.value.from, to: value.value.to });
      if (ranges.length >= 1000) break;
    }
    if (ranges.length === 0) return false;

    view.dispatch({
      selection: EditorSelection.create(ranges.map((r) => EditorSelection.range(r.from, r.to))),
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }

  /** Clear the highlight so closing the panel leaves a clean editor. */
  clear(): void {
    const view = this.#view;
    if (!view) return;
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
    this.status.set(EMPTY);
  }

  #build(): SearchQuery | null {
    const { caseSensitive, wholeWord, regexp } = this.options.get();
    const search = this.query.get();
    const query = new SearchQuery({
      search,
      caseSensitive,
      wholeWord,
      regexp,
      replace: this.replacement.get(),
    });
    return query.valid || search.length === 0 ? query : null;
  }

  /**
   * The new text for one match: unquoted, then expanded, then cased.
   *
   * Everything after the unquoting comes from `@core/replace`, the same 43
   * tests' worth of code the project-search replace runs through. Case is
   * applied last, to the *expanded* string — casing the template instead
   * would rewrite `$<word>` to `$<WORD>` and lose the capture.
   */
  #replacementFor(state: EditorState, found: FoundMatch): string {
    const { regexp, preserveCase: shouldPreserveCase } = this.options.get();
    const template = unquote(this.replacement.get());
    const expanded =
      regexp && found.match ? expandReplacement(template, found.match, true) : template;
    if (!shouldPreserveCase) return expanded;
    return preserveCase(state.sliceDoc(found.from, found.to), expanded);
  }

  /**
   * The first match at or after `to`, wrapping to the top of the document.
   *
   * This is `@codemirror/search`'s internal `nextMatch`, rebuilt on the one
   * cursor its public surface gives us. Null when the wrap lands back on the
   * range we started from — a lone match must not read as "advanced".
   */
  #nextMatch(query: SearchQuery, state: EditorState, from: number, to: number): FoundMatch | null {
    const forward = step(query.getCursor(state, to));
    if (forward) return forward;
    const wrapped = step(query.getCursor(state, 0));
    if (!wrapped || (wrapped.from === from && wrapped.to === to)) return null;
    return wrapped;
  }

  /**
   * Replace the match under the selection, then move to the next one.
   *
   * Mirrors `replaceNext`: the match is replaced only when the selection
   * covers it exactly — otherwise this just advances, which is what makes
   * ⌘F's Replace safe to lean on — the following match is located in the
   * *old* document and mapped through the change, and change plus selection
   * go out as a single transaction, so one undo takes it back.
   */
  #replaceNext(view: EditorView): boolean {
    const query = this.#build();
    const { state } = view;
    if (!query || !query.valid || state.readOnly) return false;

    const { from, to } = state.selection.main;
    const match = this.#nextMatch(query, state, from, from);
    if (!match) return false;

    const changes: ChangeSpec[] = [];
    let next: FoundMatch | null = match;
    if (!match.precise) {
      next = this.#nextMatch(query, state, match.from, match.to);
    } else if (match.from === from && match.to === to) {
      changes.push({ from: match.from, to: match.to, insert: this.#replacementFor(state, match) });
      next = this.#nextMatch(query, state, match.from, match.to);
    }

    const changeSet = state.changes(changes);
    view.dispatch({
      changes: changeSet,
      selection: next ? EditorSelection.single(next.from, next.to).map(changeSet) : undefined,
      scrollIntoView: next !== null,
      userEvent: 'input.replace',
    });
    return true;
  }

  /**
   * Replace every match in one transaction, so one undo takes the whole run
   * back — `replaceAll`'s contract, with our replacement text.
   */
  #replaceAll(view: EditorView): boolean {
    const query = this.#build();
    const { state } = view;
    if (!query || !query.valid || state.readOnly) return false;

    const changes: ChangeSpec[] = [];
    const cursor = query.getCursor(state);
    for (let found = step(cursor); found; found = step(cursor)) {
      if (!found.precise) continue;
      changes.push({ from: found.from, to: found.to, insert: this.#replacementFor(state, found) });
    }
    if (changes.length === 0) return false;

    view.dispatch({ changes, userEvent: 'input.replace.all' });
    return true;
  }

  #run(command: (view: EditorView) => boolean): void {
    const view = this.#view;
    if (!view || this.query.get().length === 0) return;
    command(view);
    view.focus();
    this.#count();
  }

  #sync(): void {
    const view = this.#view;
    if (!view) return;
    const query = this.#build();
    if (query) view.dispatch({ effects: setSearchQuery.of(query) });
    this.#count();
  }

  /** Recount matches and locate the cursor within them. */
  #count(): void {
    const view = this.#view;
    const search = this.query.get();
    if (!view || search.length === 0) {
      this.status.set(EMPTY);
      return;
    }

    const { regexp } = this.options.get();
    if (regexp) {
      try {
        new RegExp(search);
      } catch (error) {
        this.status.set({
          total: 0,
          current: 0,
          capped: false,
          invalidPattern: error instanceof Error ? error.message : 'Invalid pattern',
        });
        return;
      }
    }

    const query = this.#build();
    if (!query) {
      this.status.set({ ...EMPTY, invalidPattern: 'Invalid pattern' });
      return;
    }

    const cursorPosition = view.state.selection.main.from;
    let total = 0;
    let current = 0;
    let capped = false;

    const cursor = query.getCursor(view.state);
    for (let value = cursor.next(); !value.done; value = cursor.next()) {
      total++;
      if (current === 0 && value.value.from >= cursorPosition) current = total;
      if (total >= MAX_COUNTED_MATCHES) {
        capped = true;
        break;
      }
    }

    this.status.set({ total, current, capped, invalidPattern: null });
  }

  /** Called by the editor host on every doc/selection change. */
  refresh(): void {
    if (this.query.get().length > 0) this.#count();
  }
}
