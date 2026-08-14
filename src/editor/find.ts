import {
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { Signal } from '@core/signal';

/**
 * Drives CodeMirror's search engine from Nox's own find panel.
 *
 * CodeMirror ships a perfectly good search *engine* and a panel that looks
 * nothing like Nox. We keep the engine and draw our own UI — this class is the
 * seam between them.
 */

/** Counting stops here; past this a file is better served by project search. */
const MAX_COUNTED_MATCHES = 10_000;

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
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

export class FindController {
  readonly query = new Signal('');
  readonly replacement = new Signal('');
  readonly options = new Signal<FindOptions>({
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
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
    this.#run(replaceNext);
  }

  replaceEvery(): void {
    this.#run(replaceAll);
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
