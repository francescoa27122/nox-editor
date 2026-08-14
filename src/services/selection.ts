import { contains } from '@core/path';
import { Signal } from '@core/signal';

/**
 * Explorer selection.
 *
 * Three pieces of state, which is what every real file manager tracks:
 *
 * - `paths`  — what is selected
 * - `lead`   — the focused row; arrows move it, single-target commands use it
 * - `anchor` — where a Shift-range started
 *
 * Keeping `anchor` separate from `lead` is what makes Shift+Arrow behave: the
 * range grows and *shrinks* from a fixed point instead of ratcheting outward.
 *
 * Range operations take the ordered list of visible paths as an argument
 * rather than reaching for the tree, so this stays a pure, testable model with
 * no dependency on `FileTreeService`.
 */
export class ExplorerSelection {
  readonly paths = new Signal<ReadonlySet<string>>(new Set());
  readonly lead = new Signal<string | null>(null);
  readonly anchor = new Signal<string | null>(null);

  get size(): number {
    return this.paths.get().size;
  }

  has(path: string): boolean {
    return this.paths.get().has(path);
  }

  isEmpty(): boolean {
    return this.paths.get().size === 0;
  }

  /** Replace the selection with a single path. The plain-click behaviour. */
  set(path: string | null): void {
    if (path === null) {
      this.clear();
      return;
    }
    this.paths.set(new Set([path]));
    this.lead.set(path);
    this.anchor.set(path);
  }

  /** Add or remove one path, leaving the rest alone. Cmd/Ctrl-click. */
  toggle(path: string): void {
    const next = new Set(this.paths.get());
    if (next.has(path)) next.delete(path);
    else next.add(path);

    this.paths.set(next);
    this.lead.set(path);
    // A toggle re-anchors, so a following Shift-click ranges from here.
    this.anchor.set(path);
  }

  /** Select every path between the anchor and `path`, inclusive. Shift-click. */
  extendTo(path: string, ordered: readonly string[]): void {
    const anchor = this.anchor.get() ?? path;
    const from = ordered.indexOf(anchor);
    const to = ordered.indexOf(path);

    // Either endpoint may have been collapsed out of view since the anchor
    // was set; falling back to a single selection beats a silent no-op.
    if (from === -1 || to === -1) {
      this.set(path);
      return;
    }

    const [start, end] = from <= to ? [from, to] : [to, from];
    this.paths.set(new Set(ordered.slice(start, end + 1)));
    this.lead.set(path);
    // `anchor` deliberately untouched: that is what lets the range shrink.
  }

  /** Add a range to the existing selection. Cmd+Shift-click. */
  addRangeTo(path: string, ordered: readonly string[]): void {
    const existing = this.paths.get();
    this.extendTo(path, ordered);
    this.paths.set(new Set([...existing, ...this.paths.get()]));
  }

  selectAll(ordered: readonly string[]): void {
    if (ordered.length === 0) return;
    this.paths.set(new Set(ordered));
    this.lead.set(this.lead.get() ?? ordered[0]!);
    this.anchor.set(this.anchor.get() ?? ordered[0]!);
  }

  /** Collapse a multi-selection back to the focused row. */
  collapseToLead(): void {
    const lead = this.lead.get();
    if (lead) this.set(lead);
    else this.clear();
  }

  clear(): void {
    this.paths.set(new Set());
    this.lead.set(null);
    this.anchor.set(null);
  }

  /** Remove specific paths, and anything beneath them. Used after a delete. */
  remove(removed: readonly string[]): void {
    if (removed.length === 0) return;
    const next = new Set(
      [...this.paths.get()].filter(
        (path) => !removed.some((root) => path === root || contains(root, path)),
      ),
    );
    this.paths.set(next);

    const lead = this.lead.get();
    if (lead && removed.some((root) => lead === root || contains(root, lead))) {
      this.lead.set(null);
      this.anchor.set(null);
    }
  }

  /**
   * Drop everything beneath `folder` (but not the folder itself). Called when
   * a directory collapses: rows you can no longer see must not stay selected,
   * or Delete would act on things that are not on screen.
   */
  removeUnder(folder: string): void {
    const next = new Set([...this.paths.get()].filter((path) => !contains(folder, path) || path === folder));
    if (next.size === this.paths.get().size) return;
    this.paths.set(next);

    const lead = this.lead.get();
    if (lead && lead !== folder && contains(folder, lead)) this.lead.set(folder);
  }

  /** The selection in the order the given list defines. */
  ordered(ordered: readonly string[]): string[] {
    const selected = this.paths.get();
    if (selected.size === 0) return [];

    const visible = ordered.filter((path) => selected.has(path));
    // Anything selected but currently scrolled out of the model still counts.
    const hidden = [...selected].filter((path) => !visible.includes(path));
    return [...visible, ...hidden];
  }
}
