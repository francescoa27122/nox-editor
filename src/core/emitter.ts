/**
 * Typed event emitter. `Events` maps an event name to its payload type.
 * Constrained to `object` rather than `Record<string, unknown>` so plain
 * interfaces (which have no index signature) can be used as event maps.
 */
export class Emitter<Events extends object> {
  #handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => {
      set!.delete(handler as (payload: never) => void);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) (handler as (p: Events[K]) => void)(payload);
  }

  clear(): void {
    this.#handlers.clear();
  }
}
