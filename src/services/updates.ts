import { Signal } from '@core/signal';
import type { Platform, UpdateInfo } from '@platform/types';
import type { ConfigService } from './config';
import type { JobRunner } from './jobs';
import type { NotificationService } from './notifications';

/**
 * Checks for newer releases, and installs one — behind one explicit click.
 *
 * The consent rule this service exists to enforce: the background path is a
 * *check*, one small JSON fetch whose entire output is a notification. The
 * download, the install and the restart all hang off the toast's single
 * action button, whose label names all three. There is no auto-install
 * setting, and none arrives later.
 *
 * Absence is absence: the platform maps every check failure to null (no
 * feed, unreachable, this platform not offered), so "no update" is the one
 * degraded state and it is never an error.
 *
 * See `docs/superpowers/specs/2026-08-19-auto-updater-design.md`.
 */

/**
 * How long after launch the background check waits. Long enough that it can
 * never contend with startup or the first keystrokes; the result is a toast,
 * so nobody is waiting on it.
 */
export const UPDATE_CHECK_DELAY_MS = 10_000;

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'installing' | 'installed';

export class UpdateService {
  readonly phase = new Signal<UpdatePhase>('idle');
  readonly available = new Signal<UpdateInfo | null>(null);

  #platform: Platform;
  #config: ConfigService;
  #notifications: NotificationService;
  #jobs: JobRunner;
  /** What quit flushes — notes, settings, session. Filled by `app.ts`. */
  #flush: () => Promise<void>;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: Promise<UpdateInfo | null> | null = null;
  /** The current offer toast, so a re-check replaces rather than stacks. */
  #noticeId: number | null = null;
  #started = false;

  constructor(
    platform: Platform,
    config: ConfigService,
    notifications: NotificationService,
    jobs: JobRunner,
    flush: () => Promise<void>,
  ) {
    this.#platform = platform;
    this.#config = config;
    this.#notifications = notifications;
    this.#jobs = jobs;
    this.#flush = flush;
  }

  get started(): boolean {
    return this.#started;
  }

  /** Schedule the one launch check. Idempotent. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    // The setting is read when the timer fires, not here: start() runs in
    // the app constructor, before the persisted settings have loaded, and
    // a value captured now would be the default rather than the user's.
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#config.settings.get()['workbench.checkForUpdates']) return;
      void this.checkNow();
    }, UPDATE_CHECK_DELAY_MS);
  }

  /** Cancel a pending launch check. Called from `app.dispose()`. */
  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * Ask the feed. Single-flight: a second call while one runs joins it.
   * Manual misses are answered; background misses are silent.
   */
  checkNow(options: { manual?: boolean } = {}): Promise<UpdateInfo | null> {
    if (this.#inFlight) return this.#inFlight;
    const phase = this.phase.get();
    if (phase === 'installing' || phase === 'installed') {
      return Promise.resolve(this.available.get());
    }
    this.phase.set('checking');
    this.#inFlight = this.#check(options).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #check(options: { manual?: boolean }): Promise<UpdateInfo | null> {
    let info: UpdateInfo | null = null;
    try {
      info = await this.#platform.checkForUpdate();
    } catch {
      // The platform promises never to throw; this is the belt to that
      // promise's braces. Absence, never an error (spec envelope §4).
      info = null;
    }
    this.available.set(info);
    this.phase.set(info ? 'available' : 'idle');
    if (info) {
      this.#announce(info);
    } else if (options.manual) {
      this.#notifications.info(
        'No update found',
        'Either this is the latest Nox, or the release feed could not be reached.',
      );
    }
    return info;
  }

  #announce(info: UpdateInfo): void {
    if (this.#noticeId !== null) this.#notifications.dismiss(this.#noticeId);
    // Sticky on purpose: a burst of routine toasts must not evict the offer.
    this.#noticeId = this.#notifications.notify('info', `Nox ${info.version} is available`, {
      detail: 'Installing restarts Nox. Your tabs and unsaved work are restored.',
      timeout: 0,
      actions: [{ label: 'Install and Restart', run: () => void this.install() }],
    });
  }

  /** Download, verify, install, restart — the toast's one action. */
  async install(): Promise<void> {
    const info = this.available.get();
    const phase = this.phase.get();
    if (!info || phase === 'installing' || phase === 'installed') return;
    this.phase.set('installing');

    // Everything worth keeping, before anything moves: on Windows the
    // installer closes the app as part of installing. The session records
    // unsaved work and restores it after the restart — the same no-prompt
    // philosophy as quit (`app.ts`'s close handler).
    await this.#flush();

    const job = this.#jobs.run({ title: `Updating to Nox ${info.version}` }, async (context) => {
      let received = 0;
      await this.#platform.installUpdate((event) => {
        if (event.phase === 'started' && event.totalBytes !== null) {
          context.report({ done: 0, total: event.totalBytes });
        } else if (event.phase === 'progress') {
          received += event.chunkBytes;
          context.report({ done: received });
        }
      });
    });

    const outcome = await job.result;
    if (outcome.status === 'done') {
      this.phase.set('installed');
      // Cheap and safe to flush twice; a keystroke may have landed during
      // the download, and the restart must not cost it.
      await this.#flush();
      await this.#platform.relaunch();
      return;
    }

    // Failed or cancelled: the offer stands — the user can try again.
    this.phase.set('available');
    if (outcome.status === 'failed') {
      const error = outcome.error;
      this.#notifications.error(
        'The update could not be installed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
