import type { Platform } from '@platform/types';

/**
 * What Nox can tell you about a failure after the fact.
 *
 * The release webview has no devtools console, so before this existed a
 * failure left nothing behind at all: `console.error` wrote to a console
 * nobody could open, and a toast is gone the moment it is dismissed. A bug
 * report could only ever be prose.
 *
 * Everything here is a *failure* path. Nothing in this file runs per
 * keystroke, per scroll or per cursor move — recording is driven by
 * notifications, which are already the rare, human-facing events, and the
 * write behind it is coalesced. That is the whole of its relationship with
 * rule 5.
 */

/** One thing worth telling someone about after the fact. */
export interface DiagnosticEntry {
  /** Epoch milliseconds. */
  at: number;
  kind: 'warning' | 'error';
  message: string;
  detail?: string;
}

/** Beside `settings.json`, `notes.json` and the rest: Nox's own files live in one place. */
export const LOG_FILE = 'diagnostics.log';

/**
 * Lines kept, in memory and on disk.
 *
 * A *line* bound rather than an entry bound, because an entry carrying a
 * stack trace spans several and the point of the cap is that the file cannot
 * grow without limit. Nothing rotates this file, so the cap is the only thing
 * bounding it.
 */
export const MAX_LINES = 400;

/** A burst of failures is one write, not one write each. */
export const FLUSH_MS = 1000;

/**
 * Replace the user's home directory with `~`.
 *
 * Paths are the one piece of user data that reliably ends up in an error
 * message, and the home directory is the part of a path that names a person.
 * This runs on the way *in*, so the untouched string is never held in memory
 * or written to disk.
 *
 * `split`/`join` rather than a `RegExp`: a Windows home directory is full of
 * backslashes, and building a pattern from it would need escaping that is
 * easy to get subtly wrong. Both separator spellings are replaced because a
 * path that has been through an LSP URI or a config file may come back with
 * the other one.
 *
 * Known limit: the match is case-sensitive, so `c:\users\name` is not
 * redacted when the home directory reports as `C:\Users\name`. Recorded in
 * the debt table rather than solved with a case-insensitive scan, because
 * paths that reach here come from the same OS APIs that produced the home
 * directory and match it exactly.
 */
export function redactHome(text: string, home: string | null): string {
  if (!home) return text;
  const trimmed = home.replace(/[/\\]+$/, '');
  if (trimmed.length === 0) return text;

  let out = text;
  for (const variant of new Set([
    trimmed,
    trimmed.replace(/\\/g, '/'),
    trimmed.replace(/\//g, '\\'),
  ])) {
    out = out.split(variant).join('~');
  }
  return out;
}

/**
 * One entry as it appears in the file and in the report.
 *
 * A detail is indented onto continuation lines rather than folded into one,
 * because the detail that matters most is a stack trace and a stack trace on
 * one line is unreadable. The indent is what makes the file still legible as
 * a flat list.
 */
export function formatEntry(entry: DiagnosticEntry): string {
  const at = new Date(entry.at).toISOString();
  const head = `${at}  ${entry.kind.padEnd(7)}  ${entry.message}`;
  if (!entry.detail) return head;
  return `${head}\n    ${entry.detail.split('\n').join('\n    ')}`;
}

export class DiagnosticsService {
  #platform: Platform;
  #now: () => number;
  #entries: DiagnosticEntry[] = [];
  /** Lines an earlier session left behind. Already redacted when written. */
  #carried: string[] = [];
  #home: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;

  constructor(platform: Platform, now: () => number = () => Date.now()) {
    this.#platform = platform;
    this.#now = now;
  }

  /**
   * Learn what to redact, then pick up what earlier sessions left.
   *
   * That order is load-bearing: everything recorded after this point is
   * redacted on the way in, so reading the home directory second would leave
   * a window in which a failure is written verbatim. Both reads may fail
   * without consequence — diagnostics that stop the editor starting would be
   * a worse bug than the one they were added to explain.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    try {
      this.#home = await this.#platform.homeDir();
    } catch {
      this.#home = null;
    }

    try {
      const raw = await this.#platform.readConfigFile(LOG_FILE);
      if (raw) {
        this.#carried = raw
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .slice(-MAX_LINES);
      }
    } catch {
      // A damaged or unreadable log is not worth a word to the user: the
      // next flush overwrites it, and saying so would be the editor
      // complaining about its own bookkeeping.
    }
  }

  /** Record a failure. Never throws, and never awaits. */
  record(kind: DiagnosticEntry['kind'], message: string, detail?: string): void {
    const entry: DiagnosticEntry = {
      at: this.#now(),
      kind,
      message: redactHome(message, this.#home),
    };
    if (detail) entry.detail = redactHome(detail, this.#home);

    this.#entries.push(entry);
    // Bounded by lines for the same reason the file is, so a session that
    // produces one enormous stack trace cannot outgrow the cap here either.
    while (this.#lineCount() > MAX_LINES && this.#entries.length > 1) this.#entries.shift();

    this.#schedule();
  }

  /** This session's entries, oldest first. */
  entries(): readonly DiagnosticEntry[] {
    return this.#entries;
  }

  /**
   * The whole thing, assembled for pasting into a bug report.
   *
   * `header` is supplied by the caller rather than read here: the version is
   * a build-time constant and the capability list belongs to the platform, and
   * a service that reached for either would stop being testable against a
   * fake. Redacted again on the way out — cheap, and it covers both the
   * header and any carried line written before redaction existed.
   */
  report(header: Record<string, string>): string {
    const lines: string[] = Object.entries(header).map(([key, value]) => `${key}: ${value}`);

    if (this.#carried.length > 0) {
      lines.push('', '-- earlier sessions --', ...this.#carried);
    }

    lines.push('', '-- this session --');
    if (this.#entries.length === 0) {
      lines.push('(nothing recorded)');
    } else {
      for (const entry of this.#entries) lines.push(...formatEntry(entry).split('\n'));
    }

    return redactHome(lines.join('\n'), this.#home);
  }

  /**
   * Write the log out now, cancelling any pending write.
   *
   * Swallows its own failure on purpose. This is the path that explains other
   * failures; turning it into a second visible failure would be the editor
   * telling you it could not tell you something.
   */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#entries.length === 0) return;

    const body = [...this.#carried, ...this.#entries.flatMap((e) => formatEntry(e).split('\n'))]
      .slice(-MAX_LINES)
      .join('\n');

    try {
      await this.#platform.writeConfigFile(LOG_FILE, `${body}\n`);
    } catch {
      /* See above. */
    }
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #lineCount(): number {
    let total = 0;
    for (const entry of this.#entries) total += entry.detail ? entry.detail.split('\n').length + 1 : 1;
    return total;
  }

  #schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, FLUSH_MS);
  }
}
