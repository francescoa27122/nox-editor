import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { MAX_DIFF_BYTES } from '../src/services/git';

/**
 * GitService over a real workspace and a MemoryPlatform with seeded bases.
 *
 * Started directly, the way tests start the LSP service — the app only
 * starts it behind `capabilities.gitState`, which the memory platform
 * rightly reports false.
 *
 * Fake timers drive the 300 ms debounce; `flush()` is not used for the
 * typing test on purpose, so the debounce itself is what is proved.
 */

const FILE = '/w/main.ts';
const BASE = 'one\ntwo\nthree\n';

let app: NoxApp;
let platform: MemoryPlatform;

beforeEach(() => {
  vi.useFakeTimers();
  platform = new MemoryPlatform();
  app = new NoxApp(platform);
  app.git.start();
});

afterEach(() => {
  app.git.dispose();
  vi.useRealTimers();
});

async function openSeeded(text = BASE, base: string | null = BASE) {
  platform.seedFile(FILE, text);
  if (base !== null) platform.seedGitBase(FILE, base);
  await app.workspace.openFolder('/w');
  const id = (await app.workspace.open(FILE))!;
  // buffer-opened kicks off an async base fetch; let it land.
  await vi.runAllTimersAsync();
  return id;
}

describe('the git service', () => {
  it('has hunks for an opened file that differs from its base', async () => {
    const id = await openSeeded('one\nTWO\nthree\n');
    const entry = app.git.hunks.get().get(id)!;
    expect(entry).toBeDefined();
    expect(entry.hunks).toEqual([{ fromLine: 1, removed: ['two\n'], added: ['TWO\n'] }]);
    expect(entry.revision).toBe(app.workspace.revisionOf(id));
  });

  it('has no entry for a file that matches its base, or has no base', async () => {
    const same = await openSeeded(BASE, BASE);
    expect(app.git.hunks.get().has(same)).toBe(false);

    platform.seedFile('/w/loose.ts', 'untracked\n');
    const loose = (await app.workspace.open('/w/loose.ts'))!;
    await vi.runAllTimersAsync();
    expect(app.git.hunks.get().has(loose)).toBe(false);
  });

  it('recomputes after the debounce when the buffer changes', async () => {
    const id = await openSeeded();
    expect(app.git.hunks.get().has(id)).toBe(false);

    const state = app.workspace.stateOf(id)!;
    app.workspace.applyTransaction(id, state.update({ changes: { from: 0, insert: 'zero\n' } }));

    // Inside the debounce window: nothing yet.
    await vi.advanceTimersByTimeAsync(200);
    expect(app.git.hunks.get().has(id)).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    const entry = app.git.hunks.get().get(id)!;
    expect(entry.hunks).toEqual([{ fromLine: 0, removed: [], added: ['zero\n'] }]);
  });

  it('refetches the base on save, so a base changed behind its back is seen', async () => {
    const id = await openSeeded('one\nTWO\nthree\n');
    expect(app.git.hunks.get().has(id)).toBe(true);

    // The index moves (a stage made elsewhere): the buffer's text is now
    // exactly what git holds.
    platform.seedGitBase(FILE, 'one\nTWO\nthree\n');
    await app.workspace.save(id);
    await vi.runAllTimersAsync();

    expect(app.git.hunks.get().has(id)).toBe(false);
  });

  it('drops the entry when the buffer closes', async () => {
    const id = await openSeeded('one\nTWO\nthree\n');
    expect(app.git.hunks.get().has(id)).toBe(true);
    app.workspace.close(id, { force: true });
    expect(app.git.hunks.get().has(id)).toBe(false);
  });

  it('skips a base past the size guard', async () => {
    const id = await openSeeded('x\n', 'y\n'.repeat(MAX_DIFF_BYTES / 2 + 1));
    expect(app.git.hunks.get().has(id)).toBe(false);
  });

  it('does not invent hunks from a CRLF base against the LF buffer', async () => {
    const id = await openSeeded(BASE, '﻿one\r\ntwo\r\nthree\r\n');
    expect(app.git.hunks.get().has(id)).toBe(false);
  });

  it('re-asks for every base on refreshAll', async () => {
    const id = await openSeeded(BASE, BASE);
    expect(app.git.hunks.get().has(id)).toBe(false);

    // A commit in the terminal: the index now differs from the buffer.
    platform.seedGitBase(FILE, 'one\n');
    await app.git.refreshAll();
    await vi.runAllTimersAsync();

    const entry = app.git.hunks.get().get(id)!;
    expect(entry.hunks).toEqual([{ fromLine: 1, removed: [], added: ['two\n', 'three\n'] }]);
  });
});
