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

  it('runs the download as a job that cannot be cancelled', async () => {
    // Cancellation here is cooperative, and nothing in the install job polls
    // it — the platform has no abort path once downloadAndInstall starts.
    // Offering the affordance would show silence while it kept going anyway.
    const { platform, jobs, service } = make();
    platform.seedUpdate(INFO);
    const cancellableFlags: boolean[] = [];
    jobs.active.subscribe((list) => {
      for (const job of list) cancellableFlags.push(job.cancellable);
    });
    await service.checkNow();
    await service.install();
    expect(cancellableFlags).toContain(false);
    expect(cancellableFlags).not.toContain(true);
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

  it('a flush that throws leaves the offer standing, not stuck', async () => {
    let flushCalls = 0;
    const platform = new MemoryPlatform();
    platform.seedUpdate(INFO);
    const notifications = new NotificationService();
    const service = new UpdateService(
      platform,
      new ConfigService(platform),
      notifications,
      new JobRunner(),
      async () => {
        flushCalls += 1;
        if (flushCalls === 1) throw new Error('disk full');
      },
    );
    await service.checkNow();

    // The pre-install flush throws. Without the fix this is an unhandled
    // rejection and phase sticks at 'installing' forever.
    await service.install();
    expect(service.phase.get()).toBe('available');
    const error = notifications.items.get().find((n) => n.kind === 'error');
    expect(error?.message).toBe('The update could not be installed');
    expect(error?.detail).toBe('disk full');
    expect(platform.installedUpdate).toBeNull();

    // Nothing is stuck: a second attempt, with flush working this time,
    // completes normally.
    await service.install();
    expect(service.phase.get()).toBe('installed');
    expect(platform.installedUpdate).toBe(INFO.version);
    expect(platform.relaunched).toBe(true);
  });

  it('a post-install flush or relaunch failure also recovers instead of sticking', async () => {
    let flushCalls = 0;
    const platform = new MemoryPlatform();
    platform.seedUpdate(INFO);
    const notifications = new NotificationService();
    const service = new UpdateService(
      platform,
      new ConfigService(platform),
      notifications,
      new JobRunner(),
      async () => {
        flushCalls += 1;
        // The second flush is the one after the job succeeds, before relaunch.
        if (flushCalls === 2) throw new Error('write failed');
      },
    );
    await service.checkNow();
    await service.install();

    expect(service.phase.get()).toBe('available');
    // The install itself already succeeded on disk; only the post-install
    // flush failed, and relaunch was never reached.
    expect(platform.installedUpdate).toBe(INFO.version);
    expect(platform.relaunched).toBe(false);
    const error = notifications.items.get().find((n) => n.kind === 'error');
    expect(error?.detail).toBe('write failed');
  });
});

describe('a check racing an install', () => {
  it('does not clobber it: no second announce, no phase clobber, install completes once', async () => {
    let checkCalls = 0;
    let releaseSecondCheck!: (value: UpdateInfo | null) => void;
    class SlowSecondCheckPlatform extends MemoryPlatform {
      override checkForUpdate(): Promise<UpdateInfo | null> {
        checkCalls += 1;
        // The first check (the one that seeds the offer) answers normally;
        // the second — the one racing the install — stays pending until the
        // test releases it.
        if (checkCalls === 1) return super.checkForUpdate();
        return new Promise((resolve) => {
          releaseSecondCheck = resolve;
        });
      }
    }
    const platform = new SlowSecondCheckPlatform();
    platform.seedUpdate(INFO);
    const { notifications, service } = make(platform);

    await service.checkNow();
    expect(service.phase.get()).toBe('available');

    // A second, slow manual check starts — still in flight when install is
    // asked to run. install() must wait it out before doing anything, per
    // the fix, rather than racing it.
    const slowCheck = service.checkNow({ manual: true });
    expect(checkCalls).toBe(2);
    const installing = service.install();

    releaseSecondCheck(INFO);
    await slowCheck;
    await installing;

    expect(service.phase.get()).toBe('installed');
    expect(platform.installedUpdate).toBe(INFO.version);
    expect(platform.relaunched).toBe(true);

    // The offer toast was replaced at most once at a time, never stacked —
    // and the install's own error/second-announce path never fired.
    const offers = notifications.items.get().filter((n) => n.message.includes('available'));
    expect(offers).toHaveLength(1);
    expect(notifications.items.get().some((n) => n.kind === 'error')).toBe(false);
  });
});
