import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import type { UpdateInfo } from '../src/platform/types';
import { ConfigService } from '../src/services/config';
import { JobRunner } from '../src/services/jobs';
import { NotificationService } from '../src/services/notifications';
import { UPDATE_CHECK_DELAY_MS, UpdateService } from '../src/services/updates';

const INFO: UpdateInfo = { version: '9.9.9', currentVersion: '0.4.3', notes: null };

class CountingPlatform extends MemoryPlatform {
  checks = 0;
  override async checkForUpdate(): Promise<UpdateInfo | null> {
    this.checks += 1;
    return super.checkForUpdate();
  }
}

function make(platform: MemoryPlatform = new CountingPlatform()) {
  const config = new ConfigService(platform);
  const notifications = new NotificationService();
  const jobs = new JobRunner();
  const flushes: string[] = [];
  const service = new UpdateService(platform, config, notifications, jobs, async () => {
    flushes.push('flush');
  });
  return { platform, config, notifications, jobs, flushes, service };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the launch check', () => {
  it('fires once, UPDATE_CHECK_DELAY_MS after start, and not before', async () => {
    const { platform, service } = make();
    const counting = platform as CountingPlatform;
    service.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS - 1);
    expect(counting.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(counting.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS * 10);
    expect(counting.checks).toBe(1);
  });

  it('is turned off by the setting, read at fire time', async () => {
    const { platform, config, service } = make();
    service.start();
    // Set after start: the schedule must not have captured the old value.
    config.set('workbench.checkForUpdates', false);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect((platform as CountingPlatform).checks).toBe(0);
  });

  it('is cancelled by stop', async () => {
    const { platform, service } = make();
    service.start();
    service.stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect((platform as CountingPlatform).checks).toBe(0);
  });

  it('finding nothing says nothing', async () => {
    const { notifications, service } = make();
    service.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect(notifications.items.get()).toEqual([]);
  });

  it('finding an update raises a sticky toast with the one consented action', async () => {
    const { platform, notifications, service } = make();
    platform.seedUpdate(INFO);
    service.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    const items = notifications.items.get();
    expect(items).toHaveLength(1);
    expect(items[0]!.message).toBe('Nox 9.9.9 is available');
    expect(items[0]!.timeout).toBe(0);
    expect(items[0]!.actions?.map((a) => a.label)).toEqual(['Install and Restart']);
    expect(service.available.get()).toEqual(INFO);
    expect(service.phase.get()).toBe('available');
  });
});

describe('the manual check', () => {
  it('answers a miss honestly, covering "current" and "unreachable" alike', async () => {
    const { notifications, service } = make();
    await service.checkNow({ manual: true });
    const items = notifications.items.get();
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('info');
    expect(items[0]!.message).toBe('No update found');
  });

  it('treats a throwing platform as absence, never an error', async () => {
    class ThrowingPlatform extends MemoryPlatform {
      override async checkForUpdate(): Promise<never> {
        throw new Error('boom');
      }
    }
    const { notifications, service } = make(new ThrowingPlatform());
    await expect(service.checkNow({ manual: true })).resolves.toBeNull();
    expect(notifications.items.get()[0]!.message).toBe('No update found');
    expect(notifications.items.get().some((n) => n.kind === 'error')).toBe(false);
  });

  it('replaces the earlier update toast rather than stacking a second', async () => {
    const { platform, notifications, service } = make();
    platform.seedUpdate(INFO);
    await service.checkNow({ manual: true });
    await service.checkNow({ manual: true });
    const offers = notifications.items.get().filter((n) => n.message.includes('available'));
    expect(offers).toHaveLength(1);
  });

  it('joins an in-flight check instead of starting a second', async () => {
    let release!: (value: UpdateInfo | null) => void;
    let calls = 0;
    class SlowPlatform extends MemoryPlatform {
      override checkForUpdate(): Promise<UpdateInfo | null> {
        calls += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    }
    const { service } = make(new SlowPlatform());
    const first = service.checkNow();
    const second = service.checkNow();
    release(null);
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });
});

describe('install', () => {
  it('flushes before the platform installs, and again before relaunch', async () => {
    const order: string[] = [];
    class RecordingPlatform extends MemoryPlatform {
      override async installUpdate(): Promise<void> {
        order.push('install');
      }
      override async relaunch(): Promise<void> {
        order.push('relaunch');
      }
    }
    const platform = new RecordingPlatform();
    platform.seedUpdate(INFO);
    const service = new UpdateService(
      platform,
      new ConfigService(platform),
      new NotificationService(),
      new JobRunner(),
      async () => {
        order.push('flush');
      },
    );
    await service.checkNow();
    await service.install();
    // Before install, not before relaunch: on Windows the installer closes
    // the app itself, and a flush scheduled after that never runs.
    expect(order).toEqual(['flush', 'install', 'flush', 'relaunch']);
  });

  it('runs the download as a job named for the version', async () => {
    const { platform, jobs, service } = make();
    platform.seedUpdate(INFO);
    const titles: string[] = [];
    jobs.active.subscribe((list) => {
      for (const job of list) titles.push(job.title);
    });
    await service.checkNow();
    await service.install();
    expect(titles).toContain('Updating to Nox 9.9.9');
  });

  it('a failure says why, and the offer survives for another try', async () => {
    class FailingPlatform extends MemoryPlatform {
      override async installUpdate(): Promise<void> {
        throw new Error('signature mismatch');
      }
    }
    const platform = new FailingPlatform();
    platform.seedUpdate(INFO);
    const { notifications, service } = make(platform);
    await service.checkNow();
    await service.install();
    const error = notifications.items.get().find((n) => n.kind === 'error');
    expect(error?.message).toBe('The update could not be installed');
    expect(error?.detail).toContain('signature mismatch');
    expect(service.phase.get()).toBe('available');
    expect(platform.relaunched).toBe(false);
  });

  it('with nothing available is a no-op', async () => {
    const { platform, flushes, service } = make();
    await service.install();
    expect(flushes).toEqual([]);
    expect(platform.installedUpdate).toBeNull();
  });
});
