import { PLUGIN_COMMAND_PREFIX } from '@core/plugin-manifest';
import { Signal } from '@core/signal';

/**
 * What plugins have put in their sidebar panels.
 *
 * Rows, not markup. A plugin cannot ship a component — it is in another
 * process — and handing it a way to describe arbitrary DOM would hand it the
 * render loop, which is the thing the whole architecture is arranged to keep.
 * Rows are also what Nox's own panels already are: Problems, References and
 * Search are all a list of "here is a thing, click it to go there".
 *
 * The caps are looser than the status bar's because a panel scrolls and the
 * bar does not. They still exist: a plugin returning a million rows should
 * cost a truncated list and a note, not a frozen window.
 */

/** How many rows one panel may hold. Beyond this the list is truncated. */
export const MAX_ROWS = 500;

/** How long a row's text may be before it is cut. */
export const MAX_ROW_TEXT = 200;

export interface PanelRow {
  text: string;
  /** Dimmed, after the text — a path, a count, a rule name. */
  detail?: string;
  /** A command id to run when the row is chosen. Checked at click time. */
  command?: string;
  /** Passed to that command. */
  arg?: unknown;
}

export interface PanelContents {
  rows: PanelRow[];
  /**
   * How many rows the plugin sent beyond the cap.
   *
   * Kept so the panel can say "showing 500 of 12,000" rather than quietly
   * presenting a truncated list as a complete one — the same rule project
   * search follows with its `10000+`.
   */
  dropped: number;
}

/** The view id a panel is shown under — namespaced exactly as a command is. */
export function panelViewId(pluginId: string, name: string): string {
  return `${PLUGIN_COMMAND_PREFIX}.${pluginId}.${name}`;
}

function normaliseRow(value: unknown): PanelRow | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.text !== 'string' || row.text.length === 0) return null;

  return {
    text: row.text.slice(0, MAX_ROW_TEXT),
    ...(typeof row.detail === 'string' ? { detail: row.detail.slice(0, MAX_ROW_TEXT) } : {}),
    ...(typeof row.command === 'string' ? { command: row.command } : {}),
    ...(row.arg === undefined ? {} : { arg: row.arg }),
  };
}

export class PluginPanelStore {
  /** Contents by view id. A panel with no entry has never been filled. */
  readonly contents = new Signal<ReadonlyMap<string, PanelContents>>(new Map());

  set(pluginId: string, name: string, rows: unknown): void {
    const list = Array.isArray(rows) ? rows : [];
    const usable: PanelRow[] = [];

    for (const value of list) {
      if (usable.length >= MAX_ROWS) break;
      const row = normaliseRow(value);
      // A malformed row is skipped rather than failing the panel: a plugin
      // that gets one row wrong should not lose the other nine hundred.
      if (row) usable.push(row);
    }

    this.#write(panelViewId(pluginId, name), {
      rows: usable,
      dropped: Math.max(0, list.length - usable.length),
    });
  }

  clear(pluginId: string, name: string): void {
    this.#remove([panelViewId(pluginId, name)]);
  }

  /**
   * Empty every panel one plugin owns.
   *
   * The rail button stays — it comes from the manifest, and the panel can be
   * refilled by starting the plugin again. What goes is the *content*, which
   * stopped being true when the plugin stopped.
   */
  clearFor(pluginId: string): void {
    const prefix = `${PLUGIN_COMMAND_PREFIX}.${pluginId}.`;
    this.#remove([...this.contents.get().keys()].filter((id) => id.startsWith(prefix)));
  }

  #write(id: string, contents: PanelContents): void {
    const next = new Map(this.contents.get());
    next.set(id, contents);
    this.contents.set(next);
  }

  #remove(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const next = new Map(this.contents.get());
    let removed = false;
    for (const id of ids) {
      if (next.delete(id)) removed = true;
    }
    if (removed) this.contents.set(next);
  }
}
