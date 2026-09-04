import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import {
  DiagnosticsService,
  FLUSH_MS,
  LOG_FILE,
  MAX_LINES,
  PANIC_FILE,
  formatEntry,
  lastEntry,
  redactHome,
} from '../src/services/diagnostics';

/**
 * What Nox can tell you about a failure after the fact.
 *
 * The gap this covers: the release webview has no devtools console, so before
 * this existed a failure left nothing behind at all. A toast is gone when it
 * is dismissed and `console.error` wrote somewhere nobody could open, which
 * meant a bug report against a published release could only ever be prose.
 *
 * Two things are worth more attention than the rest, and both have their own
 * block below. **Redaction happens on the way in**, so the untouched path is
 * never held in memory or written to disk — a redaction applied only at the
 * report would leave the user's name sitting in a file on their machine. And
 * **the write is coalesced**, because the moment worth logging is usually a
 * burst.
 */

/** A clock the tests own, so an entry's timestamp is an assertion, not a race. */
function fixedClock(start = 1_700_000_000_000): () => number {
  let now = start;
  return () => (now += 1000);
}

describe('redactHome', () => {
  it('replaces the home directory with a tilde', () => {
    expect(redactHome('could not open /home/ada/notes.txt', '/home/ada')).toBe(
      'could not open ~/notes.txt',
    );
  });

  /**
   * A Windows home is full of backslashes, and the same directory comes back
   * with forward slashes from anything that has been through a URI — an LSP
   * `textDocument/didOpen`, a config file. Both spellings redact.
   */
  it('replaces a Windows home written with either separator', () => {
    const home = 'C:\\Users\\ada';
    expect(redactHome('EPERM: C:\\Users\\ada\\project\\a.ts', home)).toBe('EPERM: ~\\project\\a.ts');
    expect(redactHome('file:///C:/Users/ada/project/a.ts', home)).toBe('file:///~/project/a.ts');
  });

  it('tolerates a trailing separator on the home directory', () => {
    expect(redactHome('/home/ada/x', '/home/ada/')).toBe('~/x');
  });

  it('leaves the text alone when the home directory is unknown', () => {
    expect(redactHome('/home/ada/x', null)).toBe('/home/ada/x');
    expect(redactHome('/home/ada/x', '')).toBe('/home/ada/x');
  });
});

describe('formatEntry', () => {
  /**
   * A detail is indented onto continuation lines rather than folded onto one,
   * because the detail that matters most is a stack trace.
   */
  it('indents a multi-line detail under its entry', () => {
    const text = formatEntry({
      at: 0,
      kind: 'error',
      message: 'Save failed',
      detail: 'Error: nope\n  at write',
    });

    expect(text.split('\n')).toEqual([
      '1970-01-01T00:00:00.000Z  error    Save failed',
      '    Error: nope',
      '      at write',
    ]);
  });
});

describe('lastEntry', () => {
  /** An entry is one unindented line plus the indented lines under it. */
  it('returns the final unindented line and its continuation lines', () => {
    expect(lastEntry(['a', '    a1', 'b', '    b1', '    b2'])).toEqual(['b', '    b1', '    b2']);
    expect(lastEntry(['only'])).toEqual(['only']);
    expect(lastEntry([])).toEqual([]);
    // A file that opens mid-entry (a cap that cut the head off) still yields
    // what is there rather than nothing.
    expect(lastEntry(['    orphan'])).toEqual(['    orphan']);
  });
});

describe('DiagnosticsService', () => {
  let platform: MemoryPlatform;

  beforeEach(() => {
    platform = new MemoryPlatform({ home: '/home/ada' });
  });

  it('redacts on the way in, not merely on the way out', async () => {
    const diagnostics = new DiagnosticsService(platform, fixedClock());
    await diagnostics.start();

    diagnostics.record('error', 'Could not open /home/ada/secret.txt');

    // The stored entry, not the report: a redaction applied only at the
    // report would leave the untouched path in memory and in the file.
    expect(diagnostics.entries()[0]?.message).toBe('Could not open ~/secret.txt');
  });

  it('redacts the detail as well as the message', async () => {
    const diagnostics = new DiagnosticsService(platform, fixedClock());
    await diagnostics.start();

    diagnostics.record('error', 'Save failed', 'EACCES: /home/ada/notes.txt');

    expect(diagnostics.entries()[0]?.detail).toBe('EACCES: ~/notes.txt');
  });

  it('picks up what an earlier session left, and says which is which', async () => {
    await platform.writeConfigFile(LOG_FILE, 'from the session before\n');
    const diagnostics = new DiagnosticsService(platform, fixedClock());
    await diagnostics.start();

    diagnostics.record('warning', 'from this one');

    const report = diagnostics.report({ Nox: '0.8.3' });
    expect(report).toContain('Nox: 0.8.3');
    expect(report).toContain('-- earlier sessions --');
    expect(report).toContain('from the session before');
    expect(report).toContain('-- this session --');
    expect(report).toContain('from this one');
  });

  /**
   * A8-002. The host process writes `panic.log` from its panic hook, because
   * `diagnostics.log` is the renderer's and the renderer dies with the
   * process. Only the last entry is carried: the report is for a bug about
   * the crash that just happened, and the file keeps its own history.
   *
   * What this does not catch: the Rust side writing a shape this cannot
   * parse. `panic_log.rs` has its own test for the shape, and the two are
   * held together by the indented continuation line both sides use.
   */
  it('carries the last host panic into the report', async () => {
    await platform.writeConfigFile(
      PANIC_FILE,
      [
        '2026-09-01T10:00:00Z  panic    an earlier crash',
        '    at src/pty.rs:10:1',
        '2026-09-02T10:00:00Z  panic    watcher gave up on /home/ada/project',
        '    at src/watcher.rs:42:7',
        '',
      ].join('\n'),
    );
    const diagnostics = new DiagnosticsService(platform, fixedClock());
    await diagnostics.start();

    const report = diagnostics.report({ Nox: '0.11.0' });
    expect(report).toContain('-- last host panic --');
    expect(report).toContain('watcher gave up on ~/project');
    expect(report).toContain('    at src/watcher.rs:42:7');
    expect(report).not.toContain('an earlier crash');
    expect(report.indexOf('-- last host panic --')).toBeLessThan(report.indexOf('-- this session --'));
  });

  it('says nothing about host panics when there have been none', async () => {
    const diagnostics = new DiagnosticsService(platform, fixedClock());
    await diagnostics.start();

    expect(diagnostics.report({ Nox: '0.11.0' })).not.toContain('host panic');
  });

  it('reports something rather than nothing when no failure has happened', async () => {
    const diagnostics = new DiagnosticsService(platform, fixedClock());
    await diagnostics.start();

    const report = diagnostics.report({ Nox: '0.8.3' });
    expect(report).toContain('(nothing recorded)');
    expect(report).not.toContain('-- earlier sessions --');
  });

  /**
   * Nothing rotates this file, so the cap is the only thing bounding it. The
   * bound is on *lines* because one entry carrying a stack trace is many.
   */
  it('is bounded, so a failing loop cannot grow the log without limit', async () => {
    const diagnostics = new DiagnosticsService(platform, fixedClock());
    await diagnostics.start();

    for (let i = 0; i < MAX_LINES * 2; i += 1) diagnostics.record('error', `failure ${i}`);

    expect(diagnostics.entries().length).toBeLessThanOrEqual(MAX_LINES);
    // The newest survive, which is the half that explains what just happened.
    const last = diagnostics.entries().at(-1);
    expect(last?.message).toBe(`failure ${MAX_LINES * 2 - 1}`);
  });

  /**
   * A log that cannot be written must not become a second visible failure —
   * that would be the editor telling you it could not tell you something.
   */
  it('survives a platform that cannot read or write its file', async () => {
    const broken = new MemoryPlatform({ home: '/home/ada' });
    broken.readConfigFile = () => Promise.reject(new Error('disk gone'));
    broken.writeConfigFile = () => Promise.reject(new Error('disk gone'));

    const diagnostics = new DiagnosticsService(broken, fixedClock());
    await expect(diagnostics.start()).resolves.toBeUndefined();
    diagnostics.record('error', 'something');
    await expect(diagnostics.flush()).resolves.toBeUndefined();
  });

  it('survives a platform whose home directory cannot be read', async () => {
    const broken = new MemoryPlatform({ home: '/home/ada' });
    broken.homeDir = () => Promise.reject(new Error('no home'));

    const diagnostics = new DiagnosticsService(broken, fixedClock());
    await expect(diagnostics.start()).resolves.toBeUndefined();

    // Unredacted rather than lost: a path in the log is worth more than a
    // failure that went unrecorded because redaction was unavailable.
    diagnostics.record('error', '/home/ada/x');
    expect(diagnostics.entries()[0]?.message).toBe('/home/ada/x');
  });
});

describe('the write behind it', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The moment worth logging is usually a burst — one broken file watcher
   * raising the same failure per event. Writing per entry would turn that
   * into a write storm on the user's disk at the exact moment the app is
   * already unhappy.
   */
  it('coalesces a burst into one write', async () => {
    const platform = new MemoryPlatform({ home: '/home/ada' });
    const writes = vi.spyOn(platform, 'writeConfigFile');

    const diagnostics = new DiagnosticsService(platform, fixedClock());
    await diagnostics.start();

    for (let i = 0; i < 20; i += 1) diagnostics.record('error', `failure ${i}`);
    expect(writes).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FLUSH_MS);

    expect(writes).toHaveBeenCalledTimes(1);
    const written = await platform.readConfigFile(LOG_FILE);
    expect(written).toContain('failure 0');
    expect(written).toContain('failure 19');
    diagnostics.dispose();
  });

  /**
   * The guard is a **throttle, not a debounce**, and the difference is the
   * whole point of it.
   *
   * A debounce restarts the clock on every record, so a failure arriving
   * steadily — a broken watcher, a server reconnecting in a loop — postpones
   * the write for as long as it keeps happening, and a crash in the middle of
   * that loses every entry. The throttle fires `FLUSH_MS` after the *first*
   * record whatever else arrives.
   *
   * Written after mutation testing: the burst test above passes under both,
   * because twenty synchronous records leave one timer either way. This is
   * the assertion that actually holds the guard down.
   */
  it('is not starved by a stream of failures that never stops', async () => {
    const platform = new MemoryPlatform({ home: '/home/ada' });
    const writes = vi.spyOn(platform, 'writeConfigFile');

    const diagnostics = new DiagnosticsService(platform, fixedClock());
    await diagnostics.start();

    // Two records either side of the window's midpoint. A debounce would have
    // pushed the write out to 0.6 + 1.0 and still be waiting at 1.2; the
    // throttle has already fired at 1.0.
    diagnostics.record('error', 'first');
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 0.6);
    diagnostics.record('error', 'second');
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 0.6);

    expect(writes).toHaveBeenCalledTimes(1);
    expect(await platform.readConfigFile(LOG_FILE)).toContain('first');
    diagnostics.dispose();
  });

  it('writes nothing at all when nothing was recorded', async () => {
    const platform = new MemoryPlatform({ home: '/home/ada' });
    const writes = vi.spyOn(platform, 'writeConfigFile');

    const diagnostics = new DiagnosticsService(platform, fixedClock());
    await diagnostics.start();
    await diagnostics.flush();

    expect(writes).not.toHaveBeenCalled();
  });

  it('stops the pending write when disposed', async () => {
    const platform = new MemoryPlatform({ home: '/home/ada' });
    const writes = vi.spyOn(platform, 'writeConfigFile');

    const diagnostics = new DiagnosticsService(platform, fixedClock());
    await diagnostics.start();
    diagnostics.record('error', 'failure');
    diagnostics.dispose();

    await vi.advanceTimersByTimeAsync(FLUSH_MS * 2);
    expect(writes).not.toHaveBeenCalled();
  });
});

/**
 * The wiring, which is the part that decides whether any of the above ever
 * runs. One tap on `NotificationService.notify` rather than a `record` call
 * beside each of the hundred-odd places that raise one — so a failure added
 * later is covered by default rather than by someone remembering.
 */
describe('what the app feeds it', () => {
  let app: NoxApp | null = null;

  afterEach(async () => {
    await app?.dispose();
    app = null;
  });

  it('records the failures the user was shown', async () => {
    app = new NoxApp(new MemoryPlatform());
    app.notifications.error('Save failed', 'no space left on device');

    const entry = app.diagnostics.entries()[0];
    expect(entry?.kind).toBe('error');
    expect(entry?.message).toBe('Save failed');
    expect(entry?.detail).toBe('no space left on device');
  });

  it('records warnings too, which are the near-misses', async () => {
    app = new NoxApp(new MemoryPlatform());
    app.notifications.warn('Format on save timed out');

    expect(app.diagnostics.entries()[0]?.kind).toBe('warning');
  });

  /**
   * Confirmations of things that worked are chatter, and the file is bounded
   * — every "Saved" recorded is a failure pushed out of it.
   */
  it('ignores the confirmations', async () => {
    app = new NoxApp(new MemoryPlatform());
    app.notifications.success('Copied path');
    app.notifications.info('Nothing to commit');

    expect(app.diagnostics.entries()).toEqual([]);
  });

  it('offers the report as a command', async () => {
    app = new NoxApp(new MemoryPlatform());
    const command = app.commands.get('app.copyDiagnostics');

    expect(command).toBeDefined();
    expect(command?.title).toBe('Copy Diagnostics');
  });
});
