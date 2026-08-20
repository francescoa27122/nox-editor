import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import type { UpdateInfo } from '../src/platform/types';

const INFO: UpdateInfo = { version: '9.9.9', currentVersion: '0.4.3', notes: 'notes' };

describe('updates on a platform that cannot replace itself', () => {
  it('says so in its capabilities', () => {
    expect(new MemoryPlatform().capabilities.selfUpdate).toBe(false);
  });

  it('answers a check with absence, not an error', async () => {
    // The gitFileBase argument: no feed is a state, not a failure.
    await expect(new MemoryPlatform().checkForUpdate()).resolves.toBeNull();
  });

  it('refuses to install what no check has found', async () => {
    await expect(new MemoryPlatform().installUpdate()).rejects.toThrow(/check first/);
  });
});

describe('the seeded model', () => {
  it('returns the seeded update from a check', async () => {
    const platform = new MemoryPlatform();
    platform.seedUpdate(INFO);
    await expect(platform.checkForUpdate()).resolves.toEqual(INFO);
  });

  it('installs the seeded update, reporting progress in order', async () => {
    const platform = new MemoryPlatform();
    platform.seedUpdate(INFO);
    const phases: string[] = [];
    await platform.installUpdate((event) => phases.push(event.phase));
    expect(phases).toEqual(['started', 'progress', 'finished']);
    expect(platform.installedUpdate).toBe('9.9.9');
  });

  it('records a relaunch', async () => {
    const platform = new MemoryPlatform();
    expect(platform.relaunched).toBe(false);
    await platform.relaunch();
    expect(platform.relaunched).toBe(true);
  });
});
