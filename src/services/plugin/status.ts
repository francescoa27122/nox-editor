import { PLUGIN_COMMAND_PREFIX } from '@core/plugin-manifest';
import { Signal } from '@core/signal';

/**
 * What plugins have put on the status bar.
 *
 * A store rather than state inside `PluginHost`, because the thing that owns
 * it and the thing that draws it should not have to know about each other —
 * and because every rule below is worth testing without a plugin, a process or
 * a DOM.
 *
 * The bar is a **shared surface with no scrollbar**, which is what all of the
 * limits here are about. A plugin in a loop is the ordinary way this goes
 * wrong, and unlike a panel the status bar cannot scroll its way out of
 * trouble: one plugin writing a paragraph, or five hundred items, breaks the
 * row for everything else on it.
 */

/** How many items one plugin may own. Enough for a linter; not a toolbar. */
export const MAX_ITEMS_PER_PLUGIN = 3;

/**
 * How long an item's text may be.
 *
 * Sized for the readouts already on the bar — "3 unsaved", "Changed on disk",
 * "rust-analyzer — Indexing 3/840 20%" — which is the longest thing Nox itself
 * puts there.
 */
export const MAX_TEXT_LENGTH = 40;

export interface StatusItemSpec {
  /** The plugin's own name for it. Namespaced before it is stored. */
  name: string;
  text: string;
  tooltip?: string;
  /** A command id to run when clicked. Checked at click time, not here. */
  command?: string;
  /** Higher sorts earlier. Defaults to 0. */
  priority?: number;
}

export interface StatusItem {
  /** `plugin.<pluginId>.<name>`, the same namespacing commands get. */
  id: string;
  pluginId: string;
  text: string;
  tooltip?: string;
  command?: string;
  priority: number;
}

/** The id an item is stored under — namespaced exactly as a command is. */
function statusItemId(pluginId: string, name: string): string {
  return `${PLUGIN_COMMAND_PREFIX}.${pluginId}.${name}`;
}

function same(a: StatusItem, b: StatusItem): boolean {
  return (
    a.text === b.text &&
    a.tooltip === b.tooltip &&
    a.command === b.command &&
    a.priority === b.priority
  );
}

export class PluginStatusStore {
  readonly items = new Signal<StatusItem[]>([]);

  /**
   * Insertion order, which is the tiebreak within a priority.
   *
   * Kept separately from the sorted output so that **updating an item does not
   * move it**. Without this an item that updates often walks along the bar and
   * the whole row shifts under the pointer each time it does.
   */
  #order: string[] = [];
  #byId = new Map<string, StatusItem>();

  set(pluginId: string, spec: StatusItemSpec): void {
    const id = statusItemId(pluginId, spec.name);
    const existing = this.#byId.get(id);

    if (!existing) {
      const owned = this.#order.filter((key) => this.#byId.get(key)?.pluginId === pluginId);
      // The cap applies to *new* items only. Refusing an update to one it
      // already owns would freeze a plugin's readouts at whatever they
      // happened to say when it hit the limit.
      if (owned.length >= MAX_ITEMS_PER_PLUGIN) return;
      this.#order.push(id);
    }

    const item: StatusItem = {
      id,
      pluginId,
      text: spec.text.slice(0, MAX_TEXT_LENGTH),
      ...(spec.tooltip === undefined ? {} : { tooltip: spec.tooltip.slice(0, MAX_TEXT_LENGTH * 4) }),
      ...(spec.command === undefined ? {} : { command: spec.command }),
      priority: spec.priority ?? 0,
    };

    // A plugin that polls and reports the same thing should cost nothing. The
    // bar re-renders on every emission, so an unchanged set that emitted would
    // make a well-behaved poller as expensive as a badly-behaved one.
    if (existing && same(existing, item)) return;

    this.#byId.set(id, item);
    this.#publish();
  }

  clear(pluginId: string, name: string): void {
    this.#remove([statusItemId(pluginId, name)]);
  }

  /**
   * Take back everything one plugin owns.
   *
   * Called when a plugin stops, however it stopped. A crashed plugin otherwise
   * leaves its readout on the bar saying something that stopped being true,
   * with nothing left running to correct it.
   */
  clearFor(pluginId: string): void {
    this.#remove(
      [...this.#byId.values()].filter((item) => item.pluginId === pluginId).map((item) => item.id),
    );
  }

  #remove(ids: readonly string[]): void {
    let removed = false;
    for (const id of ids) {
      if (this.#byId.delete(id)) removed = true;
    }
    if (!removed) return;

    this.#order = this.#order.filter((id) => this.#byId.has(id));
    this.#publish();
  }

  #publish(): void {
    const sorted = this.#order
      .map((id) => this.#byId.get(id))
      .filter((item): item is StatusItem => item !== undefined)
      // A stable sort, so equal priorities keep insertion order — which is
      // what makes "updating does not move it" true.
      .sort((a, b) => b.priority - a.priority);

    this.items.set(sorted);
  }
}
