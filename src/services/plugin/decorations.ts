import { normaliseDecorations, type PluginDecoration } from '@core/plugin-decorations';
import { Signal } from '@core/signal';
import type { BufferId } from '../workspace';

/**
 * What plugins have asked to have drawn, by buffer.
 *
 * Several plugins may decorate one buffer — a linter and a spell checker have
 * no reason to know about each other — so this merges them, and merges them
 * **in a stable order**: a set that reshuffled on every update would make
 * CodeMirror rebuild marks that had not changed.
 *
 * The store holds the plugin's own coordinates. Mapping them forward through
 * edits belongs to the `StateField` in `editor/plugin-decorations.ts`, because
 * only the editor knows what changed; this layer stays headless and testable
 * against numbers.
 */

export class PluginDecorationStore {
  /** Bumped whenever any buffer's decorations change. */
  readonly revision = new Signal(0);

  /** bufferId → pluginId → that plugin's decorations, in insertion order. */
  #byBuffer = new Map<BufferId, Map<string, PluginDecoration[]>>();

  /**
   * Replace one plugin's decorations for one buffer.
   *
   * Returns how many were unusable, so the caller can tell the plugin rather
   * than leave it wondering why half its marks never appeared.
   */
  set(pluginId: string, bufferId: BufferId, raw: unknown, documentLength: number): number {
    const { decorations, dropped } = normaliseDecorations(raw, documentLength);

    let forBuffer = this.#byBuffer.get(bufferId);
    if (!forBuffer) {
      forBuffer = new Map();
      this.#byBuffer.set(bufferId, forBuffer);
    }

    if (decorations.length === 0) forBuffer.delete(pluginId);
    else forBuffer.set(pluginId, decorations);

    if (forBuffer.size === 0) this.#byBuffer.delete(bufferId);
    this.revision.update((n) => n + 1);
    return dropped;
  }

  /** Everything drawn in one buffer, merged and in document order. */
  forBuffer(bufferId: BufferId): PluginDecoration[] {
    const forBuffer = this.#byBuffer.get(bufferId);
    if (!forBuffer) return [];

    // Re-sorted after merging, because `RangeSet.of` needs the *combined*
    // list ordered and each plugin only sorted its own.
    return [...forBuffer.values()]
      .flat()
      .sort((a, b) => a.from - b.from || a.to - b.to);
  }

  /** Which buffers a plugin has decorated, so a change can be aimed. */
  buffersFor(pluginId: string): BufferId[] {
    return [...this.#byBuffer.entries()]
      .filter(([, forBuffer]) => forBuffer.has(pluginId))
      .map(([bufferId]) => bufferId);
  }

  clearBuffer(bufferId: BufferId): void {
    if (this.#byBuffer.delete(bufferId)) this.revision.update((n) => n + 1);
  }

  /**
   * Take back everything one plugin drew.
   *
   * Called when a plugin stops, however it stopped: a mark asserting something
   * about the code, left behind by a process that is gone, is worse than no
   * mark — nothing is coming to correct it and it looks exactly like a live
   * one.
   */
  clearFor(pluginId: string): void {
    let changed = false;
    for (const [bufferId, forBuffer] of [...this.#byBuffer.entries()]) {
      if (!forBuffer.delete(pluginId)) continue;
      changed = true;
      if (forBuffer.size === 0) this.#byBuffer.delete(bufferId);
    }
    if (changed) this.revision.update((n) => n + 1);
  }
}
