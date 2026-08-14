import { describe, expect, it } from 'vitest';
import { JobRunner } from '../src/services/jobs';

/** A promise plus the handles to settle it, for driving a job step by step. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('JobRunner', () => {
  it('reports a value when the body completes', async () => {
    const runner = new JobRunner();
    const job = runner.run({ title: 'Count' }, async () => 42);

    await expect(job.result).resolves.toEqual({ status: 'done', value: 42 });
    expect(job.status.get()).toBe('done');
    expect(runner.active.get()).toEqual([]);
  });

  it('publishes progress while running', async () => {
    const runner = new JobRunner();
    const gate = deferred<void>();

    const job = runner.run({ title: 'Walk' }, async (context) => {
      context.report({ done: 3, total: 10, message: 'src/main.ts' });
      await gate.promise;
      return 'finished';
    });

    expect(runner.active.get()).toEqual([
      { id: job.id, title: 'Walk', progress: { done: 3, total: 10, message: 'src/main.ts' } },
    ]);

    gate.resolve();
    await job.result;
    expect(runner.active.get()).toEqual([]);
  });

  it('reports cancellation rather than a value', async () => {
    const runner = new JobRunner();
    const gate = deferred<void>();

    const job = runner.run({ title: 'Walk' }, async (context) => {
      await gate.promise;
      // A body that finishes anyway must not smuggle its result through.
      return context.cancelled ? 'noticed' : 'ignored cancellation';
    });

    job.cancel();
    gate.resolve();

    await expect(job.result).resolves.toEqual({ status: 'cancelled' });
    expect(runner.active.get()).toEqual([]);
  });

  it('runs teardown as soon as it is cancelled', async () => {
    const runner = new JobRunner();
    const gate = deferred<void>();
    let tornDown = false;

    const job = runner.run({ title: 'Native search' }, async (context) => {
      context.onCancel(() => {
        tornDown = true;
      });
      await gate.promise;
      return null;
    });

    job.cancel();
    expect(tornDown).toBe(true);

    gate.resolve();
    await job.result;
  });

  it('runs teardown immediately when cancellation already happened', async () => {
    const runner = new JobRunner();
    const started = deferred<void>();
    const gate = deferred<void>();
    let tornDown = false;

    const job = runner.run({ title: 'Slow to hand back a handle' }, async (context) => {
      started.resolve();
      await gate.promise;
      // Registered only *after* the await — the window a naive implementation
      // leaves open, where cancelling would never reach the native handle.
      context.onCancel(() => {
        tornDown = true;
      });
      return null;
    });

    await started.promise;
    job.cancel();
    gate.resolve();
    await job.result;

    expect(tornDown).toBe(true);
  });

  it('supersedes an earlier job with the same key', async () => {
    const runner = new JobRunner();
    const first = deferred<void>();

    const stale = runner.run({ title: 'Search v1', key: 'search' }, async () => {
      await first.promise;
      return 'stale';
    });
    const fresh = runner.run({ title: 'Search v2', key: 'search' }, async () => 'fresh');

    first.resolve();
    await expect(stale.result).resolves.toEqual({ status: 'cancelled' });
    await expect(fresh.result).resolves.toEqual({ status: 'done', value: 'fresh' });
  });

  it('leaves jobs under other keys alone', async () => {
    const runner = new JobRunner();
    const gate = deferred<void>();

    const other = runner.run({ title: 'Replace', key: 'replace' }, async () => {
      await gate.promise;
      return 'kept';
    });
    runner.run({ title: 'Search', key: 'search' }, async () => 'unrelated');

    gate.resolve();
    await expect(other.result).resolves.toEqual({ status: 'done', value: 'kept' });
  });

  it('captures a thrown error instead of rejecting', async () => {
    const runner = new JobRunner();
    const boom = new Error('walk failed');
    const job = runner.run({ title: 'Walk' }, async () => {
      throw boom;
    });

    await expect(job.result).resolves.toEqual({ status: 'failed', error: boom });
    expect(job.status.get()).toBe('failed');
  });

  it('treats a body that throws after cancellation as cancelled', async () => {
    const runner = new JobRunner();
    const gate = deferred<void>();

    const job = runner.run({ title: 'Walk' }, async () => {
      await gate.promise;
      throw new Error('aborted mid-read');
    });

    job.cancel();
    gate.resolve();

    await expect(job.result).resolves.toEqual({ status: 'cancelled' });
  });

  it('exposes an abort signal for anything that speaks one', async () => {
    const runner = new JobRunner();
    const gate = deferred<void>();
    let aborted = false;

    const job = runner.run({ title: 'Fetch' }, async (context) => {
      context.signal.addEventListener('abort', () => {
        aborted = true;
      });
      await gate.promise;
      return null;
    });

    job.cancel();
    gate.resolve();
    await job.result;

    expect(aborted).toBe(true);
  });

  it('settles on cancel without waiting for the body to notice', async () => {
    const runner = new JobRunner();
    // A body that polls nothing and never resolves — the worst case, and the
    // reason the result cannot be tied to the body finishing.
    const job = runner.run({ title: 'Oblivious' }, () => new Promise<string>(() => {}));

    job.cancel();

    await expect(job.result).resolves.toEqual({ status: 'cancelled' });
  });

  it('cancels everything in flight at once', async () => {
    const runner = new JobRunner();
    const gate = deferred<void>();
    const jobs = ['a', 'b', 'c'].map((title) =>
      runner.run({ title }, async () => {
        await gate.promise;
        return title;
      }),
    );

    expect(runner.active.get()).toHaveLength(3);
    runner.cancelAll();
    gate.resolve();

    for (const job of jobs) {
      await expect(job.result).resolves.toEqual({ status: 'cancelled' });
    }
    expect(runner.active.get()).toEqual([]);
  });
});
