import { Signal } from '@core/signal';

/**
 * Long-running background work: progress, streamed partial results, and
 * cancellation that cannot leave anything half-done.
 *
 * The rule that makes cancellation safe is structural rather than a matter of
 * discipline: **a job never mutates a buffer.** It computes and returns a
 * result — for editing work, a change set — and applying it happens on the
 * main path once the job has resolved. Cancelling is therefore `discard`,
 * with no per-job correctness argument to get wrong.
 *
 * See AGENT-PLATFORM.md §2.7.
 */

export type JobId = string;
export type JobStatus = 'running' | 'done' | 'cancelled' | 'failed';

export interface JobProgress {
  /** Units finished. Meaningful on its own when `total` is unknown. */
  done: number;
  /** Total units, when the job can know it up front. */
  total?: number;
  /** What it is doing right now, e.g. the file being scanned. */
  message?: string;
}

/**
 * What a job says about itself, for rendering. A plain snapshot rather than
 * the live job, so a component cannot reach in and drive it.
 */
export interface JobSnapshot {
  id: JobId;
  title: string;
  progress: JobProgress;
  /** Whether the UI may offer to cancel this job. See `JobOptions.cancellable`. */
  cancellable: boolean;
}

/**
 * How a job ended.
 *
 * A discriminated union rather than a value-or-null, because a caller that
 * forgets cancellation exists is exactly the bug this milestone is about: the
 * shape makes you look.
 */
export type JobOutcome<T> =
  | { status: 'done'; value: T }
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown };

/** What the job body is handed. */
export interface JobContext {
  /** Poll this inside loops; cancellation is cooperative. */
  readonly cancelled: boolean;
  /** For handing to anything that already speaks `AbortSignal`. */
  readonly signal: AbortSignal;
  /** Publish progress. Ignored once the job has been cancelled. */
  report(progress: Partial<JobProgress>): void;
  /**
   * Run `fn` when the job is cancelled — for tearing down something native,
   * like a running search on the Rust side.
   *
   * Runs immediately if cancellation already happened, which closes the window
   * between starting an operation and getting a handle back to cancel it.
   */
  onCancel(fn: () => void): void;
}

export interface Job<T> {
  readonly id: JobId;
  readonly title: string;
  readonly progress: Signal<JobProgress>;
  readonly status: Signal<JobStatus>;
  cancel(): void;
  /** Settles with an outcome. Never rejects. */
  readonly result: Promise<JobOutcome<T>>;
}

export interface JobOptions {
  title: string;
  /**
   * Starting a job with a key cancels whatever is already running under it.
   *
   * This is what a search-as-you-type wants, and it belongs here rather than
   * in every caller: a hand-rolled generation counter is the same idea with
   * more chances to forget a check.
   */
  key?: string;
  /**
   * Whether cancellation is offered at all. Default `true`.
   *
   * Cancellation here is cooperative and best-effort (see the module doc):
   * it settles the *result* as `cancelled`, but a body that polls nothing —
   * or one wrapping an operation with no abort path of its own, like a
   * platform install already underway — keeps running regardless. For a job
   * like that, offering to cancel is worse than not offering: the click
   * shows silence while the real thing proceeds unseen. `false` here keeps
   * `cancel()` from doing anything to this job at all, so nothing — the
   * status bar, a keybinding, a command — can act like it worked when it
   * didn't.
   */
  cancellable?: boolean;
}

export class JobRunner {
  /** Jobs currently running, oldest first. Finished ones drop off. */
  readonly active = new Signal<JobSnapshot[]>([]);

  #jobs = new Map<
    JobId,
    { job: Job<unknown>; controller: AbortController; cancellable: boolean }
  >();
  #byKey = new Map<string, JobId>();
  #nextId = 1;

  run<T>(options: JobOptions, body: (context: JobContext) => Promise<T>): Job<T> {
    if (options.key) {
      const previous = this.#byKey.get(options.key);
      if (previous) this.cancel(previous);
    }

    const id: JobId = `job-${this.#nextId++}`;
    const cancellable = options.cancellable ?? true;
    const controller = new AbortController();
    const progress = new Signal<JobProgress>({ done: 0 });
    const status = new Signal<JobStatus>('running');
    const cleanups: (() => void)[] = [];

    const context: JobContext = {
      get cancelled() {
        return controller.signal.aborted;
      },
      signal: controller.signal,
      report: (update) => {
        if (controller.signal.aborted) return;
        progress.update((current) => ({ ...current, ...update }));
        this.#publish();
      },
      onCancel: (fn) => {
        if (controller.signal.aborted) fn();
        else cleanups.push(fn);
      },
    };

    controller.signal.addEventListener('abort', () => {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch {
          /* A teardown that throws must not stop the others running. */
        }
      }
    });

    const settled = (async (): Promise<JobOutcome<T>> => {
      try {
        const value = await body(context);
        // A job that ran to completion after being cancelled still counts as
        // cancelled: its caller has already been told not to use the result.
        if (controller.signal.aborted) return { status: 'cancelled' };
        status.set('done');
        return { status: 'done', value };
      } catch (error) {
        if (controller.signal.aborted) return { status: 'cancelled' };
        status.set('failed');
        return { status: 'failed', error };
      } finally {
        this.#retire(id, options.key);
      }
    })();

    /**
     * Cancellation settles the *result* immediately, without waiting for the
     * body to notice.
     *
     * Cooperative cancellation means a body can be mid-`await` and take a
     * while to come back — or, if it polls nothing, never. The caller has
     * already been told the outcome is `cancelled`; making it wait on a
     * function whose value it has been instructed to ignore only spreads one
     * unresponsive job into everything downstream of it.
     *
     * The body keeps running until it returns, and its value is discarded.
     * That is safe precisely because a job never mutates a buffer.
     */
    const result = Promise.race([
      settled,
      new Promise<JobOutcome<T>>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve({ status: 'cancelled' }));
      }),
    ]);

    const job: Job<T> = {
      id,
      title: options.title,
      progress,
      status,
      cancel: () => this.cancel(id),
      result,
    };

    this.#jobs.set(id, { job, controller, cancellable });
    if (options.key) this.#byKey.set(options.key, id);
    this.#publish();
    return job;
  }

  cancel(id: JobId): void {
    const entry = this.#jobs.get(id);
    if (!entry || entry.controller.signal.aborted) return;
    // Guarded here, not only in the UI: this is the one place every caller
    // — the status bar's click, the palette command, a keybinding — funnels
    // through, so it is the one place that has to hold.
    if (!entry.cancellable) return;
    entry.job.status.set('cancelled');
    entry.controller.abort();
    // Dropped from the active list now rather than when the body notices:
    // cancellation is immediate as far as the user is concerned.
    this.#jobs.delete(id);
    this.#publish();
  }

  /** Cancel whatever is running under a key, if anything is. */
  cancelActive(key: string): void {
    const id = this.#byKey.get(key);
    if (id) this.cancel(id);
  }

  cancelAll(): void {
    for (const id of [...this.#jobs.keys()]) this.cancel(id);
  }

  /** The job to offer to cancel, when the UI has room for exactly one. */
  foremost(): JobSnapshot | null {
    return this.active.get()[0] ?? null;
  }

  #retire(id: JobId, key?: string): void {
    this.#jobs.delete(id);
    if (key && this.#byKey.get(key) === id) this.#byKey.delete(key);
    this.#publish();
  }

  #publish(): void {
    this.active.set(
      [...this.#jobs.values()].map(({ job, cancellable }) => ({
        id: job.id,
        title: job.title,
        progress: job.progress.get(),
        cancellable,
      })),
    );
  }
}
