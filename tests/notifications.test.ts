import { describe, expect, it, vi } from 'vitest';
import { NotificationService } from '../src/services/notifications';

/**
 * A4-011: sticky notifications (timeout 0, i.e. errors) had no bound at all.
 * The four-slot eviction a few lines up only ever looked at the
 * auto-dismissing kinds, deliberately — a sticky one is shown sticky because
 * it must be read, and a burst of routine successes must not silently evict
 * it. But autosave retried against a read-only file, or a formatter failing
 * on every save, raises one sticky error per attempt and none of them
 * auto-dismiss, so the toast column grew without bound over a long session.
 */
describe('sticky notifications', () => {
  it('caps at MAX_STICKY, evicting the oldest first', () => {
    const service = new NotificationService();

    const ids: number[] = [];
    for (let i = 0; i < 60; i++) ids.push(service.error(`failure ${i}`));

    const items = service.items.get();
    expect(items).toHaveLength(50);
    // The oldest ten are gone; the rest survive, oldest-of-the-survivors
    // first, exactly the way the existing transient eviction reads.
    expect(items[0]?.message).toBe('failure 10');
    expect(items.at(-1)?.message).toBe('failure 59');
    expect(items.map((n) => n.id)).not.toContain(ids[0]);
    expect(items.map((n) => n.id)).toContain(ids.at(-1));
  });

  it('does not cap a handful of sticky notifications', () => {
    const service = new NotificationService();
    for (let i = 0; i < 5; i++) service.error(`failure ${i}`);
    expect(service.items.get()).toHaveLength(5);
  });

  /**
   * The two eviction bounds are independent: neither kind should be able to
   * push the other one out. A burst of successes evicts among themselves
   * (the pre-existing four-slot rule); a burst of errors evicts among
   * themselves (`MAX_STICKY`); the sticky cap must not count transient
   * notifications toward its own fifty, or a handful of successes sitting in
   * the list would make room for fewer errors than the constant promises.
   */
  it('keeps the sticky and transient bounds independent of each other', () => {
    const service = new NotificationService();
    service.success('ok 1');
    service.success('ok 2');
    for (let i = 0; i < 50; i++) service.error(`failure ${i}`);

    const items = service.items.get();
    const sticky = items.filter((n) => n.timeout === 0);
    const transient = items.filter((n) => n.timeout > 0);
    expect(sticky).toHaveLength(50);
    expect(transient).toHaveLength(2);
  });

  it('clears a ghost timer for an evicted sticky notification (there is none, but dismiss must still be a no-op)', () => {
    // Sticky notifications never get a timer (timeout 0 skips the branch
    // that sets one), so eviction has nothing to clear here — this pins that
    // evicting one is not an error and a later `dismiss` of it is inert.
    const service = new NotificationService();
    const first = service.error('failure 0');
    for (let i = 1; i < 51; i++) service.error(`failure ${i}`);

    expect(service.items.get().find((n) => n.id === first)).toBeUndefined();
    expect(() => service.dismiss(first)).not.toThrow();
  });
});

/**
 * Not part of A4-011, but the seam the fix runs through: this is what
 * "sticky" means in the first place, and it is worth pinning that the fix
 * did not quietly change it.
 */
describe('timeouts', () => {
  it('defaults an error to sticky (timeout 0) and a success to auto-dismiss', () => {
    vi.useFakeTimers();
    try {
      const service = new NotificationService();
      service.error('bad');
      service.success('fine');

      const [errorItem, successItem] = service.items.get();
      expect(errorItem?.timeout).toBe(0);
      expect(successItem?.timeout).toBeGreaterThan(0);

      vi.advanceTimersByTime(10_000);
      const remaining = service.items.get();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.kind).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });
});
