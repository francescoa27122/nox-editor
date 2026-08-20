// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConfirmDialog from '../src/ui/ConfirmDialog.svelte';
import TabBar from '../src/ui/TabBar.svelte';
import { NotificationService } from '../src/services/notifications';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Phase A of the 2026-08-19 UI audit — the behavioral fixes, pinned.
 *
 * (The focus plumbing for Problems/References is tested beside the panels'
 * own suites; the pure-CSS fixes — hover states, truncation, the dirty-dot
 * hover swap — are assertable only as markup here, and the markup bits are.)
 *
 * Mutation-checked on 2026-08-19: the sticky test fails when `notify` goes
 * back to `slice(-4)`; the safe-focus test fails when `ConfirmDialog`
 * focuses button 0 unconditionally; the drop-end test fails when the
 * strip's `drop-end` class binding is removed. The evicted-timer cleanup in
 * `notify` is NOT mutation-killable — a ghost timer's `dismiss` is a no-op
 * and the map self-heals when it fires — so it is hygiene, not behavior,
 * and no test claims otherwise.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
});

describe('notifications under a burst', () => {
  it('never evicts a sticky notification to make room for transient ones', () => {
    vi.useFakeTimers();
    const service = new NotificationService();
    service.notify('error', 'the one that matters');
    for (let i = 0; i < 6; i++) service.notify('success', `routine ${i}`);

    const kinds = service.items.get().map((n) => n.kind);
    expect(kinds).toContain('error');
    // The transient stack is still capped at 4.
    expect(kinds.filter((k) => k === 'success')).toHaveLength(4);
  });

  it('drains cleanly after an eviction burst', () => {
    vi.useFakeTimers();
    const service = new NotificationService();
    for (let i = 0; i < 6; i++) service.notify('success', `routine ${i}`);
    expect(service.items.get()).toHaveLength(4);
    vi.runAllTimers();
    expect(service.items.get()).toHaveLength(0);
  });

  it('still auto-dismisses transients and keeps errors', () => {
    vi.useFakeTimers();
    const service = new NotificationService();
    service.notify('success', 'quick');
    service.notify('error', 'sticky');
    vi.advanceTimersByTime(10_000);
    expect(service.items.get().map((n) => n.kind)).toEqual(['error']);
  });
});

describe('the confirm dialog default', () => {
  function confirm(choices: { id: string; label: string; danger?: boolean }[]) {
    mounted = mountComponent(ConfirmDialog, {
      props: { request: { title: 't', message: 'm', choices, resolve: () => {} } },
    });
    flush();
    return document.activeElement?.textContent?.trim();
  }

  it('focuses the first safe choice when any choice is destructive', () => {
    expect(confirm([
      { id: 'delete', label: 'Delete', danger: true },
      { id: 'cancel', label: 'Cancel' },
    ])).toBe('Cancel');
  });

  it('still focuses the first choice when nothing is destructive', () => {
    expect(confirm([
      { id: 'save', label: 'Save' },
      { id: 'cancel', label: 'Cancel' },
    ])).toBe('Save');
  });
});

describe('the tab strip', () => {
  async function strip() {
    mounted = mountComponent(TabBar, { props: { groupId: 'group-1' } });
    const { app, platform } = mounted;
    platform.seedFile('/w/a.ts', 'a\n');
    platform.seedFile('/w/b.ts', 'b\n');
    await app.workspace.openFolder('/w');
    await app.workspace.open('/w/a.ts');
    const b = (await app.workspace.open('/w/b.ts'))!;
    flush();
    return { app, b };
  }

  it('marks the strip when a drag hovers past the last tab, so the drop has an indicator', async () => {
    const { app, b } = await strip();
    expect(mounted!.container.querySelector('.strip.drop-end')).toBeNull();

    app.ui.tabDrag.set({ bufferId: b, overGroupId: 'group-1', overIndex: 2 });
    flush();
    expect(mounted!.container.querySelector('.strip.drop-end')).not.toBeNull();

    app.ui.tabDrag.set(null);
    flush();
    expect(mounted!.container.querySelector('.strip.drop-end')).toBeNull();
  });

  it("gives a dirty tab's close button the class the dot-holding CSS keys on", async () => {
    const { app, b } = await strip();
    expect(mounted!.container.querySelector('.close.dirty')).toBeNull();

    const state = app.workspace.stateOf(b)!;
    app.workspace.applyTransaction(b, state.update({ changes: { from: 0, insert: 'x' } }));
    flush();
    expect(mounted!.container.querySelector('.close.dirty')).not.toBeNull();
    expect(mounted!.container.querySelector('.close.dirty .dot')).not.toBeNull();
  });
});
