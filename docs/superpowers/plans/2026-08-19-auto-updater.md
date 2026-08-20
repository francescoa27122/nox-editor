# Auto-updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A published release with updater artifacts is offered inside Nox, and one consented click installs it and restarts — with silent, graceful absence everywhere a piece (the key, the artifacts, the platform) is missing.

**Architecture:** All network, signature verification and file replacement live in the Rust `tauri-plugin-updater`; the renderer sees only `UpdateInfo | null` through three new Platform methods, so the whole service is testable over `MemoryPlatform` with no network and no cargo. CI signs updater artifacts only when the repository secrets exist — the config that would make a keyless build fail lives in a separate `--config` overlay the workflow applies conditionally.

**Tech Stack:** TypeScript, Svelte 5, Rust (Tauri 2, `tauri-plugin-updater`, `tauri-plugin-process`), GitHub Actions, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-auto-updater-design.md`

## Global Constraints

- **SECURITY — the updater private key never exists here.** No task generates a key, prints a key, or writes a key to any file in this repository. The key ceremony (spec §8) is run by the human operator, elsewhere. If you find yourself about to run `tauri signer generate`, stop: that step is not yours.
- **Consent.** An update is never downloaded or installed without an explicit user action. The background path is check + notify, nothing more.
- **Absence is absence, never an error** (spec envelope §4). `checkForUpdate` never rejects; a manual check that finds nothing says "No update found"; a background one says nothing.
- **`ui/` and `services/` may never import `@tauri-apps/*`.** UI talks to services; services talk to `Platform`. Only `src/platform/tauri.ts` touches the plugins.
- **Baseline to beat:** `npm test` 1257 tests / 76 files, `npm run check` 455 files 0 errors (measured 2026-08-19 in this worktree). Run both before every commit and report the real output.
- **Line endings are LF** (measured 2026-08-19 across `src/app.ts`, `src/services/git.ts`, `.github/workflows/release.yml`; an older plan's CRLF claim is stale).
- **No cargo on this machine.** Rust and workflow changes are compiled/executed by CI only. Say so plainly whenever you commit them.
- **Commit author** is already configured per-repo: `francescoa27122 <42079355+frncescoa27122@users.noreply.github.com>`.
- **Do not push, open a PR, or merge.** Commit locally and stop.
- **Numbers fixed by the spec:** launch-check delay `UPDATE_CHECK_DELAY_MS = 10_000`; the update toast is sticky (`timeout: 0`); the action label is exactly `Install and Restart`.

---

### Task 1: Self-update on the Platform boundary

**Files:**
- Modify: `src/platform/types.ts` (two interfaces, one capability, three `Platform` methods)
- Modify: `src/platform/memory.ts` (capability + honest model + `seedUpdate`)
- Modify: `src/platform/web.ts` (capability literal only — the methods are inherited)
- Test: `tests/update-platform.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface UpdateInfo { version: string; currentVersion: string; notes: string | null }`; `type UpdateProgress = { phase: 'started'; totalBytes: number | null } | { phase: 'progress'; chunkBytes: number } | { phase: 'finished' }`; `capabilities.selfUpdate: boolean`; `Platform.checkForUpdate(): Promise<UpdateInfo | null>`; `Platform.installUpdate(onProgress?: (event: UpdateProgress) => void): Promise<void>`; `Platform.relaunch(): Promise<void>`; `MemoryPlatform.seedUpdate(info: UpdateInfo): void`, `MemoryPlatform.installedUpdate: string | null`, `MemoryPlatform.relaunched: boolean`.

- [ ] **Step 1: Write the failing test**

`tests/update-platform.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/update-platform.test.ts`
Expected: FAIL — `selfUpdate` does not exist on the capabilities type, `checkForUpdate` is not a function.

- [ ] **Step 3: Add the boundary**

In `src/platform/types.ts`, add to `PlatformCapabilities` after `gitState`:

```ts
  /** True when `checkForUpdate` can find a newer build and `installUpdate` can replace this one. */
  selfUpdate: boolean;
```

Add the two types before `export interface Platform` (beside `SaveDialogOptions`):

```ts
/** A newer build the release feed offers. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** Release notes from the manifest, when it carries any. */
  notes: string | null;
}

/** Progress of an update download, as the platform reports it. */
export type UpdateProgress =
  | { phase: 'started'; totalBytes: number | null }
  | { phase: 'progress'; chunkBytes: number }
  | { phase: 'finished' };
```

Add to `interface Platform`, after `onMaximizeChange`:

```ts
  /**
   * Ask the release feed whether a newer build exists.
   *
   * Never rejects: null is the answer to everything that is not an
   * installable newer version — no feed published, feed unreachable, this
   * platform absent from it, already current. Absence of an update is a
   * state, not a failure (the `gitFileBase` argument). Check
   * `capabilities.selfUpdate` before expecting real answers.
   */
  checkForUpdate(): Promise<UpdateInfo | null>;

  /**
   * Download, verify and install the update the last successful
   * `checkForUpdate` found. Throws `PlatformError('not-found')` with
   * nothing in hand, and a real error when the download or its signature
   * fails — the user asked for this one, so failure must say why.
   *
   * Installing may exit the process (the Windows installer closes the app
   * to replace its files), so callers flush everything worth keeping first.
   */
  installUpdate(onProgress?: (event: UpdateProgress) => void): Promise<void>;

  /** Restart the app the way the OS would start it. Used after an install. */
  relaunch(): Promise<void>;
```

In `src/platform/memory.ts`, add `selfUpdate: false` to the capabilities literal after `gitState` with the comment `// A browser tab and a test cannot replace themselves. Tests seed offers with seedUpdate.`, import `UpdateInfo` and `UpdateProgress` from `./types`, and add fields + methods (the seeding helper beside `seedGitBase`, the methods beside `gitFileBase`):

```ts
  /** What `checkForUpdate` will offer. Null until a test seeds one. */
  #update: UpdateInfo | null = null;
  /** Version handed to `installUpdate`, for tests. Null until then. */
  installedUpdate: string | null = null;
  /** Whether `relaunch` was called, for tests. */
  relaunched = false;

  seedUpdate(info: UpdateInfo): void {
    this.#update = info;
  }

  async checkForUpdate(): Promise<UpdateInfo | null> {
    // Absence is the default truth here, not an error — a test simply has
    // no newer Nox unless one was seeded.
    return this.#update;
  }

  async installUpdate(onProgress?: (event: UpdateProgress) => void): Promise<void> {
    const update = this.#update;
    if (!update) {
      throw new PlatformError('no update in hand — check first', 'not-found');
    }
    // The real platform streams; the model replays the smallest honest
    // sequence, so a service that mishandles any phase fails here.
    onProgress?.({ phase: 'started', totalBytes: 3 });
    onProgress?.({ phase: 'progress', chunkBytes: 3 });
    onProgress?.({ phase: 'finished' });
    this.installedUpdate = update.version;
  }

  async relaunch(): Promise<void> {
    this.relaunched = true;
  }
```

In `src/platform/web.ts`, add `selfUpdate: false` to the capabilities literal after `gitState` (comment: `// A browser tab cannot replace itself; the inherited model answers absence.`). `demo-workspace.ts` does not implement `Platform` (it exports demo file contents) — nothing to do there. `src/platform/tauri.ts` will fail `npm run check` until it implements the interface — that implementation is Task 5, so for **this** task add to `tauri.ts` only the capability `selfUpdate: true` (comment: `// The desktop build replaces itself through the updater plugin.`) and three placeholder-free stubs that refuse honestly:

```ts
  async checkForUpdate(): Promise<UpdateInfo | null> {
    // Wired to the updater plugin in the desktop-wiring task. Absence is
    // the honest interim answer, and also the permanent one when no
    // latest.json is published (spec envelope §4).
    return null;
  }

  async installUpdate(): Promise<void> {
    throw new PlatformError('no update in hand — check first', 'not-found');
  }

  async relaunch(): Promise<void> {
    /* Nothing to relaunch into until installUpdate can install. */
  }
```

(Import `UpdateInfo` into `tauri.ts`'s type imports.)

- [ ] **Step 4: Run the test and the type check**

Run: `npx vitest run tests/update-platform.test.ts && npm run check`
Expected: test PASS; 0 errors. `svelte-check` will name every capabilities literal still missing `selfUpdate` — fix each rather than widening the type.

- [ ] **Step 5: Commit**

```bash
npm test
git add src/platform tests/update-platform.test.ts
git commit -m "Put self-update on the platform boundary, absent everywhere but the desktop"
```

---

### Task 2: `UpdateService` — the setting, the check, the toast, the install

One task rather than a check task and an install task on purpose: the
service's private `#jobs` and `#flush` fields exist for `install()`, and
a commit that stores them unread fails `noUnusedLocals`. One file, one
test file, one reviewable unit.

**Files:**
- Create: `src/services/updates.ts`
- Modify: `src/services/config/schema.ts` (one new Workbench setting)
- Test: `tests/update-service.test.ts`

**Interfaces:**
- Consumes: `Platform.checkForUpdate` / `installUpdate` / `relaunch` (Task 1), `ConfigService` (`src/services/config`), `NotificationService.notify/info/dismiss/error` (`src/services/notifications.ts`), `JobRunner.run` (`src/services/jobs.ts:98` — `run<T>(options: JobOptions, body: (context: JobContext) => Promise<T>): Job<T>`, `context.report({ done, total })`, `job.result: Promise<JobOutcome<T>>`).
- Produces: `UPDATE_CHECK_DELAY_MS = 10_000`; `type UpdatePhase = 'idle' | 'checking' | 'available' | 'installing' | 'installed'`; `class UpdateService` with `constructor(platform: Platform, config: ConfigService, notifications: NotificationService, jobs: JobRunner, flush: () => Promise<void>)`, `readonly phase: Signal<UpdatePhase>`, `readonly available: Signal<UpdateInfo | null>`, `get started(): boolean`, `start(): void`, `stop(): void`, `checkNow(options?: { manual?: boolean }): Promise<UpdateInfo | null>`, `install(): Promise<void>`; the setting key `'workbench.checkForUpdates'` (boolean, default true).

- [ ] **Step 1: Add the setting**

In `src/services/config/schema.ts`, after `'workbench.restoreSession'`:

```ts
  'workbench.checkForUpdates': bool(true, {
    label: 'Check for Updates on Launch',
    description:
      'Look for a newer Nox shortly after launch. Finding one only notifies — nothing downloads or installs without your say-so.',
    category: 'Workbench',
  }),
```

- [ ] **Step 2: Write the failing test**

`tests/update-service.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/update-service.test.ts`
Expected: FAIL — cannot resolve `../src/services/updates`.

- [ ] **Step 4: Implement `src/services/updates.ts`**

```ts
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
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run tests/update-service.test.ts && npm run check`
Expected: PASS; 0 errors.

- [ ] **Step 6: Commit**

```bash
npm test
git add src/services/updates.ts src/services/config/schema.ts tests/update-service.test.ts
git commit -m "Check for updates and install behind one click, flushing first"
```

---

### Task 3: Wire the service into the app, with its palette command

**Files:**
- Modify: `src/app.ts` (field, construction, capability-gated start, dispose, one command)
- Test: `tests/update-command.test.ts`

**Interfaces:**
- Consumes: `UpdateService` (Task 2), `capabilities.selfUpdate` (Task 1), `CommandRegistry` (`src/services/commands.ts` — `execute` awaits `command.run`'s return value, which is why the command returns the promise).
- Produces: `NoxApp.updates: UpdateService`; command id `app.checkForUpdates`, title `Check for Updates…`, category `Application`.

- [ ] **Step 1: Write the failing test**

`tests/update-command.test.ts` (node environment, the `tests/git-service.test.ts` pattern — `NoxApp` constructs over a `MemoryPlatform` without jsdom):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';

let app: NoxApp | null = null;

afterEach(() => {
  app?.updates.stop();
  app = null;
});

describe('app.checkForUpdates', () => {
  it('is registered, and disabled until the service starts', () => {
    app = new NoxApp(new MemoryPlatform());
    expect(app.commands.has('app.checkForUpdates')).toBe(true);
    // MemoryPlatform has selfUpdate: false, so the app did not start it —
    // the git pattern: the capability gates the app, tests start directly.
    expect(app.commands.isEnabled('app.checkForUpdates')).toBe(false);
    app.updates.start();
    expect(app.commands.isEnabled('app.checkForUpdates')).toBe(true);
  });

  it('checks, offers, and the one click installs and relaunches', async () => {
    const platform = new MemoryPlatform();
    platform.seedUpdate({ version: '9.9.9', currentVersion: '0.4.3', notes: null });
    app = new NoxApp(platform);
    app.updates.start();

    await app.commands.execute('app.checkForUpdates');
    const toast = app.notifications.items.get().find((n) => n.message === 'Nox 9.9.9 is available');
    expect(toast).toBeDefined();
    expect(toast!.timeout).toBe(0);
    expect(toast!.actions?.[0]?.label).toBe('Install and Restart');

    toast!.actions![0]!.run();
    await vi.waitFor(() => expect(platform.relaunched).toBe(true));
    expect(platform.installedUpdate).toBe('9.9.9');
  });

  it('a manual miss is answered', async () => {
    app = new NoxApp(new MemoryPlatform());
    app.updates.start();
    await app.commands.execute('app.checkForUpdates');
    expect(app.notifications.items.get()[0]?.message).toBe('No update found');
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run tests/update-command.test.ts`
Expected: FAIL — `app.updates` does not exist, command unknown.

- [ ] **Step 3: Wire it**

In `src/app.ts`:

1. Import: `import { UpdateService } from '@services/updates';`
2. Field, beside `readonly notes: NotesService;`:

```ts
  /** Checks for, and installs, newer releases. See `updates.ts`. */
  readonly updates: UpdateService;
```

3. Construction, in the constructor after `this.git = new GitService(...)` and its capability-gated start (around `src/app.ts:228-232`):

```ts
    this.updates = new UpdateService(
      platform,
      this.config,
      this.notifications,
      this.jobs,
      // What quit flushes, in quit's order (see dispose()): the restart an
      // install ends in must not cost a keystroke.
      async () => {
        await this.notes.flush();
        await this.config.flush();
        await this.session.save();
      },
    );
    // Behind the capability, like git: a platform that cannot replace
    // itself would make every check a no-op. Tests start it directly.
    if (platform.capabilities.selfUpdate) this.updates.start();
```

4. In `dispose()`, beside `this.watcher.stop();`:

```ts
    this.updates.stop();
```

5. The command, in `#registerCommands` next to the Preferences block (`src/app.ts:2904`):

```ts
      // --- Application ------------------------------------------------------
      {
        id: 'app.checkForUpdates',
        title: 'Check for Updates…',
        category: 'Application',
        keywords: ['update', 'upgrade', 'version', 'release', 'new'],
        // On the service, not the platform flag — the git.showDiff argument:
        // tests start the service over a memory platform.
        enabled: () => this.updates.started,
        // Returned, not voided: execute() awaits run's return value, and a
        // caller (or test) that awaits the command should see the check done.
        run: () => this.updates.checkNow({ manual: true }),
      },
```

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run tests/update-command.test.ts && npm run check`
Expected: PASS; 0 errors.

- [ ] **Step 5: Commit**

```bash
npm test
git add src/app.ts tests/update-command.test.ts
git commit -m "Wire the update service in, with its palette command"
```

---

### Task 4: The version, visible in the Settings footer

**Files:**
- Modify: `vite.config.ts` (a `define`)
- Create: `src/vite-env.d.ts` (the declaration for it)
- Modify: `src/ui/SettingsPanel.svelte` (footer)
- Test: `tests/settings-version.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the global `__APP_VERSION__: string`, compiled from `package.json`'s `version`.

- [ ] **Step 1: Write the failing test**

`tests/settings-version.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import SettingsPanel from '../src/ui/SettingsPanel.svelte';
import { mountComponent, type Mounted } from './support/component';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('the Settings footer', () => {
  it('shows the version this build was made from', () => {
    // The release gate holds package.json, tauri.conf.json and Cargo.toml
    // to one version, so package.json's — which the define reads — is the
    // bundle's.
    expect(__APP_VERSION__).toMatch(/^\d+\.\d+\.\d+/);
    mounted = mountComponent(SettingsPanel, {});
    expect(mounted.container.textContent).toContain(`Nox ${__APP_VERSION__}`);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run tests/settings-version.test.ts`
Expected: FAIL — `__APP_VERSION__ is not defined`.

- [ ] **Step 3: Define, declare, render**

`vite.config.ts` — add the import and read at the top, the `define` in the config object:

```ts
import { readFileSync } from 'node:fs';
```

```ts
const pkg = JSON.parse(readFileSync(r('./package.json'), 'utf8')) as { version: string };
```

```ts
  define: {
    // The one build-time constant: the version the Settings footer shows.
    // package.json is the source; the release gate already refuses a tag
    // whose three version files disagree, so this is the bundle's version.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
```

Create `src/vite-env.d.ts`:

```ts
/** Build-time constants injected by `define` in vite.config.ts. */

/**
 * The version from package.json — the release gate holds the tag,
 * tauri.conf.json and Cargo.toml to the same value.
 */
declare const __APP_VERSION__: string;
```

`src/ui/SettingsPanel.svelte` — in the existing `<footer>` (line 184), after the two links:

```svelte
    <span class="version">Nox {__APP_VERSION__}</span>
```

And in the `<style>` block, beside `.link`:

```css
  .version {
    margin-left: auto;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-faint);
    font-variant-numeric: tabular-nums;
  }
```

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run tests/settings-version.test.ts && npm run check`
Expected: PASS; 0 errors. Also confirm the browser target still boots: `npm run dev`, open it, Settings footer reads "Nox 0.4.3" right-aligned.

- [ ] **Step 5: Commit**

```bash
npm test
git add vite.config.ts src/vite-env.d.ts src/ui/SettingsPanel.svelte tests/settings-version.test.ts
git commit -m "Show the version in the Settings footer"
```

---

### Task 5: The desktop wiring — plugins, config, and the real platform

**Files:**
- Modify: `package.json` + `package-lock.json` (two `@tauri-apps` plugins)
- Modify: `src-tauri/Cargo.toml` (two crates)
- Modify: `src-tauri/src/lib.rs` (two `.plugin(...)` lines)
- Modify: `src-tauri/capabilities/default.json` (two permissions)
- Modify: `src-tauri/tauri.conf.json` (`plugins.updater`)
- Create: `src-tauri/updater.conf.json` (the CI-only overlay)
- Modify: `src/platform/tauri.ts` (replace Task 1's interim stubs)

**Interfaces:**
- Consumes: `UpdateInfo`, `UpdateProgress`, `PlatformError` (Task 1); `@tauri-apps/plugin-updater`'s `check(): Promise<Update | null>` (`Update` carries `version`, `currentVersion`, `body?`, and `downloadAndInstall(onEvent)` whose events are `{ event: 'Started', data: { contentLength?: number } } | { event: 'Progress', data: { chunkLength: number } } | { event: 'Finished' }`); `@tauri-apps/plugin-process`'s `relaunch()`. (Per the Tauri v2 updater guide — named in the spec header.)
- Produces: a desktop build whose `checkForUpdate`/`installUpdate`/`relaunch` are real.

- [ ] **Step 1: Add the JS dependencies**

```bash
npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

Confirm both landed in `package.json` `dependencies` and `package-lock.json` changed.

- [ ] **Step 2: The Rust side**

`src-tauri/Cargo.toml`, in `[dependencies]` after `tauri-plugin-dialog`:

```toml
# Self-update: checks the signed latest.json on the newest published GitHub
# release and swaps the binary. All network traffic and all signature
# verification live in this plugin — the renderer only ever sees the result.
tauri-plugin-updater = "2"
# One call: relaunch after an install. The capability grants restart only.
tauri-plugin-process = "2"
```

`src-tauri/src/lib.rs`, after `.plugin(tauri_plugin_dialog::init())`:

```rust
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
```

`src-tauri/capabilities/default.json`, appended to `permissions`:

```json
    "updater:default",
    "process:allow-restart"
```

(`process:allow-restart` rather than `process:default`: nothing here needs `allow-exit`.)

- [ ] **Step 3: The config, split by who may fail**

`src-tauri/tauri.conf.json` — add after the `"app"` object, before `"bundle"`:

```json
  "plugins": {
    "updater": {
      "pubkey": "",
      "endpoints": [
        "https://github.com/francescoa27122/nox-editor/releases/latest/download/latest.json"
      ],
      "windows": {
        "installMode": "passive"
      }
    }
  },
```

`pubkey` stays empty until the operator's key ceremony (spec §8) pastes the public half in. Do **not** set `bundle.createUpdaterArtifacts` here — with it set, `tauri build` fails without the private key, and local builds and keyless CI must keep producing installers. It lives alone in the overlay:

Create `src-tauri/updater.conf.json`:

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  }
}
```

(Named `updater.conf.json`, not `tauri.<x>.conf.json`, so Tauri never auto-merges it — only the workflow's explicit `--config` does.)

- [ ] **Step 4: The real platform**

In `src/platform/tauri.ts`, add the imports:

```ts
import { check as checkUpdate, type Update } from '@tauri-apps/plugin-updater';
import { relaunch as processRelaunch } from '@tauri-apps/plugin-process';
```

Add `UpdateProgress` to the type imports from `./types` (Task 1 already imported `UpdateInfo`). Replace the three interim stubs with:

```ts
  /** The update the last successful check found, held for `installUpdate`. */
  #pendingUpdate: Update | null = null;

  async checkForUpdate(): Promise<UpdateInfo | null> {
    try {
      const update = await checkUpdate();
      if (!update) {
        this.#pendingUpdate = null;
        return null;
      }
      this.#pendingUpdate = update;
      return {
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body ?? null,
      };
    } catch {
      // No latest.json published, feed unreachable, this platform absent
      // from it (Linux ships no AppImage, so the plugin's TargetNotFound
      // lands here) — all the same answer. Absence is a state, not a
      // failure. See the spec's envelope §4.
      this.#pendingUpdate = null;
      return null;
    }
  }

  async installUpdate(onProgress?: (event: UpdateProgress) => void): Promise<void> {
    const update = this.#pendingUpdate;
    if (!update) {
      throw new PlatformError('no update in hand — check first', 'not-found');
    }
    try {
      await update.downloadAndInstall((event) => {
        if (!onProgress) return;
        if (event.event === 'Started') {
          onProgress({ phase: 'started', totalBytes: event.data.contentLength ?? null });
        } else if (event.event === 'Progress') {
          onProgress({ phase: 'progress', chunkBytes: event.data.chunkLength });
        } else {
          onProgress({ phase: 'finished' });
        }
      });
      this.#pendingUpdate = null;
    } catch (error) {
      // The plugin throws strings as readily as Errors; normalize so the
      // service's failure toast always carries words.
      throw new PlatformError(error instanceof Error ? error.message : String(error), 'io');
    }
  }

  async relaunch(): Promise<void> {
    await processRelaunch();
  }
```

If the plugin's actual event type names differ from the guide's (`event.data` shape), the compiler will say so — follow the installed package's `.d.ts`, and note the deviation in the commit message.

- [ ] **Step 5: Verify what can be verified here**

```bash
npm run check
npm test
```

Expected: 0 errors, all tests pass. The Rust cannot be compiled on this machine; state plainly in the commit and any report that `lib.rs`/`Cargo.toml` are **unbuilt locally** and CI is the first thing to compile them. One named risk to watch in that first CI run (spec §6): whether `tauri_plugin_updater`'s init tolerates the empty `pubkey` string. If it does not, register the plugin conditionally on a non-empty pubkey and update the spec.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src-tauri src/platform/tauri.ts
git commit -m "Register the updater plugins, and adapt them behind the seam"
```

---

### Task 6: The release workflow signs updates only when it can

**Files:**
- Modify: `.github/workflows/release.yml` (build job only; the gate is untouched)

**Interfaces:**
- Consumes: `src-tauri/updater.conf.json` (Task 5); repository secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (absent until the operator's ceremony — the workflow must be correct in both worlds).
- Produces: with the key — per-platform updater artifacts, signatures, and `latest.json` on the draft release (via `tauri-action`'s `uploadUpdaterJson`, default true); without it — exactly today's release.

- [ ] **Step 1: Add the job-level env**

In the `build` job, after `strategy`, add:

```yaml
    env:
      # Present only after the operator's key ceremony (spec §8 of the
      # auto-updater design). Absent, the step below builds without updater
      # artifacts and without latest.json — a working release, not a failed
      # one. The values are never echoed; tauri reads them from the
      # environment directly.
      TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

- [ ] **Step 2: Add the decision step**

After the `- run: npm ci` step and before the `tauri-action` step:

```yaml
      # Updater artifacts are opt-in per build. createUpdaterArtifacts lives
      # in updater.conf.json rather than tauri.conf.json because with it set,
      # `tauri build` *fails* when the private key is absent — and a
      # contributor's local build, and this workflow before the key ceremony,
      # must keep producing installers.
      - name: Decide whether this build signs updates
        id: updater
        shell: bash
        run: |
          set -eu
          if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
            pubkey=$(node -p "require('./src-tauri/tauri.conf.json').plugins.updater.pubkey")
            if [ -z "$pubkey" ]; then
              echo "TAURI_SIGNING_PRIVATE_KEY is set, but plugins.updater.pubkey is empty."
              echo "Half a keypair signs updates that nothing can verify. Paste the public"
              echo "key from the key ceremony into src-tauri/tauri.conf.json and retag."
              exit 1
            fi
            echo "args=--config src-tauri/updater.conf.json" >> "$GITHUB_OUTPUT"
            echo "Signing key present: updater artifacts will be built and signed."
          else
            echo "args=" >> "$GITHUB_OUTPUT"
            echo "No signing key: installers only, no updater artifacts."
          fi
```

(`shell: bash` matters — the Windows runner defaults to PowerShell.)

- [ ] **Step 3: Thread the flag into the build**

Change the `tauri-action` step's `args` line from:

```yaml
          args: ${{ matrix.args }}
```

to:

```yaml
          args: ${{ matrix.args }} ${{ steps.updater.outputs.args }}
```

Leave `releaseBody` untouched: its `xattr` teaching stays true for first installs, and the spec's key ceremony (§8) is where the "updates skip it" sentence gets added — by the operator, once it is actually true.

- [ ] **Step 4: Verify what can be verified here**

```bash
npx --yes js-yaml .github/workflows/release.yml > /dev/null && echo "YAML parses"
```

Expected: `YAML parses`. Then re-read the diff against three scenarios and say which you checked: (a) no secrets → `args` empty, build identical to today; (b) key + pubkey → overlay applied on all four matrix legs; (c) key without pubkey → the build fails in the decision step with the instruction, before any twenty-minute compile. CI on the next tag is the real test; say so.

- [ ] **Step 5: Commit**

```bash
npm test
git add .github/workflows/release.yml
git commit -m "Sign updater artifacts only when CI holds the key"
```

---

### Task 7: Documentation

**Files:**
- Modify: `ROADMAP.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `WORKLOG.md`

- [ ] **Step 1: Update each**

`ROADMAP.md` — the "Installs like software" row (line 182). Replace the "Where it stands" cell's text with:

> The updater is built and waits on the operator's key ceremony; once a signed release is published, updating never repeats the ritual. First installs still need `xattr -dr` on macOS and "Run anyway" on Windows — that half is the certificates'.

and trim the "What it takes" cell's last sentence ("Tauri's updater and its signing key are free and can land first; unsigned builds can still self-update.") since it has now landed, leaving the certificates sentence.

`ARCHITECTURE.md` — add `updates.ts` to the `services/` section of the module map ("Checks for and installs newer releases; one click consents to download, install and restart"), and state the boundary rule once where the module map explains `platform/`: the updater's network, signature verification and file replacement live in the Rust plugin; the renderer sees `UpdateInfo | null`, and absence is never an error.

`CHANGELOG.md` — under `## [Unreleased]` / `### Added`:

```markdown
- **Nox can update itself.** Ten seconds after launch (behind a new
  Workbench setting), or on *Check for Updates…*, Nox asks the newest
  published release whether a newer build exists and offers it in a
  toast. Nothing downloads or installs without the click — which also
  restarts into the new version with your tabs and unsaved work
  restored. Updates skip the macOS quarantine ritual; first installs
  still need it until code signing arrives. Settings now shows the
  running version in its footer. Requires the operator's one-time key
  ceremony before releases carry update artifacts.
```

`WORKLOG.md` — a new entry on top, in the existing format (Shipped / Verified / Next / Blocked / Confidence), stating what CI has not yet compiled (the Rust plugins, the workflow) and that the key ceremony + first tagged release are the remaining human steps.

- [ ] **Step 2: Verify and commit**

```bash
npm run check && npm test
git add ROADMAP.md ARCHITECTURE.md CHANGELOG.md WORKLOG.md
git commit -m "Write down the auto-updater"
```

---

## Done when

- `npm test` passes with every new test included and the count is stated (baseline was 1257/76).
- `npm run check` reports 0 errors (baseline 455 files).
- The Rust and workflow changes are committed and **declared unrun locally**; CI on the next tag is the first thing to execute them, and the empty-pubkey plugin-init risk (Task 5 Step 5) is on the watch list for that run.
- The private key was never generated, printed, or committed by any step — spec §8 remains a human-only runbook.
- Nothing is pushed, no PR is opened.
