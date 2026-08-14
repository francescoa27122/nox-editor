/**
 * A minimal observable value.
 *
 * Deliberately not a framework store: it implements the Svelte store contract
 * (`subscribe(fn) => unsubscribe`) so components can write `$signal`, but it
 * has zero imports and runs unchanged in Node under Vitest. This is the seam
 * that keeps every service framework-independent — see ARCHITECTURE.md.
 */
export type Subscriber<T> = (value: T) => void;
export type Unsubscribe = () => void;

export class Signal<T> {
  #value: T;
  #subscribers = new Set<Subscriber<T>>();
  #equals: (a: T, b: T) => boolean;

  constructor(initial: T, equals: (a: T, b: T) => boolean = Object.is) {
    this.#value = initial;
    this.#equals = equals;
  }

  get(): T {
    return this.#value;
  }

  set(next: T): void {
    if (this.#equals(this.#value, next)) return;
    this.#value = next;
    this.#emit();
  }

  /** Replace the value via a producer. Always emits — use for mutable structures. */
  update(fn: (current: T) => T): void {
    this.#value = fn(this.#value);
    this.#emit();
  }

  /** Announce that a mutable value changed in place. */
  touch(): void {
    this.#emit();
  }

  /** Svelte store contract: calls immediately with the current value. */
  subscribe(run: Subscriber<T>): Unsubscribe {
    this.#subscribers.add(run);
    run(this.#value);
    return () => {
      this.#subscribers.delete(run);
    };
  }

  #emit(): void {
    // Copy first: a subscriber may unsubscribe itself while we iterate.
    for (const run of [...this.#subscribers]) run(this.#value);
  }
}

/** A derived, read-only signal. Recomputes eagerly when any source changes. */
export function derived<T>(
  sources: Signal<unknown>[],
  compute: () => T,
): { subscribe: (run: Subscriber<T>) => Unsubscribe; get: () => T } {
  const out = new Signal<T>(compute());
  let live = 0;
  let disposers: Unsubscribe[] = [];

  return {
    get: () => (live > 0 ? out.get() : compute()),
    subscribe(run) {
      if (live === 0) {
        disposers = sources.map((s) => s.subscribe(() => out.set(compute())));
      }
      live++;
      const off = out.subscribe(run);
      return () => {
        off();
        if (--live === 0) {
          disposers.forEach((d) => d());
          disposers = [];
        }
      };
    },
  };
}
