import { describe, expect, it } from 'vitest';
import {
  activeLanguageStatus,
  serverStatusLabel,
  serverStatusTitle,
} from '../src/ui/lsp-status';
import type { SessionStatusRow } from '../src/services/lsp';

/**
 * What the status bar says about a language server.
 *
 * The label lives here rather than in the component because the interesting
 * half is a decision — what a failed server should say — and a decision worth
 * making is worth asserting.
 */

function row(overrides: Partial<SessionStatusRow> = {}): SessionStatusRow {
  return {
    name: 'typescript-language-server',
    status: 'running',
    languages: ['typescript', 'javascript'],
    error: null,
    stderr: [],
    ...overrides,
  };
}

describe('the label', () => {
  it('is nothing at all when no server is configured', () => {
    // Not "0 servers". Someone who has never configured one should not be
    // told about a subsystem they are not using.
    expect(serverStatusLabel([])).toBeNull();
  });

  it('names the single running server', () => {
    expect(serverStatusLabel([row()])).toBe('typescript-language-server');
  });

  it('counts them once there is more than one', () => {
    expect(serverStatusLabel([row(), row({ name: 'rust-analyzer' })])).toBe('2 servers');
  });

  it('says a server is starting, because a cold tsserver takes long enough to doubt', () => {
    expect(serverStatusLabel([row({ status: 'initializing' })])).toBe(
      'typescript-language-server — starting',
    );
  });

  it('says which server failed, rather than that something did', () => {
    expect(serverStatusLabel([row({ status: 'failed' })])).toBe(
      'typescript-language-server — failed',
    );
  });

  it('reports a failure even when another server is fine', () => {
    // A silent partial failure is the one people notice weeks later, when
    // they wonder why one language never had diagnostics.
    const label = serverStatusLabel([row(), row({ name: 'rust-analyzer', status: 'failed' })]);

    expect(label).toBe('rust-analyzer — failed');
  });
});

/**
 * The defect these guard: `serverStatusLabel` took only `sessions` and picked
 * the worst of them, so with `typescript-language-server` running, opening
 * `main.py` left the bar reading `typescript-language-server` — a global
 * aggregate wearing a per-file label, in the one place a user reads as
 * "language intelligence for this file". `SessionStatusRow` could not have
 * done better: it carried no `languages` field, so the active buffer's
 * language was not an input and could not be.
 */
describe('the label, once it knows which file is in front of you', () => {
  it('never names a server that has nothing to do with this file', () => {
    const label = serverStatusLabel([row({ languages: ['typescript'] })], 'python');

    expect(label).not.toContain('typescript-language-server');
    // A count names nobody, and keeps the tooltip — which lists every
    // server's real state — reachable.
    expect(label).toBe('1 server');
  });

  it('names the server that does serve this file', () => {
    const label = serverStatusLabel(
      [row({ name: 'pylsp', languages: ['python'] }), row()],
      'python',
    );

    expect(label).toBe('pylsp');
  });

  it('says "starting" only about the server this file is waiting on', () => {
    const label = serverStatusLabel(
      [row({ name: 'pylsp', languages: ['python'], status: 'initializing' }), row()],
      'python',
    );

    expect(label).toBe('pylsp — starting');
  });

  it('does not report another language\'s cold start as this file\'s', () => {
    const label = serverStatusLabel(
      [row({ name: 'pylsp', languages: ['python'] }), row({ status: 'initializing' })],
      'python',
    );

    expect(label).toBe('pylsp');
  });

  it('still reports a failure anywhere, because a dead server is an alarm', () => {
    // Not a claim about this file: the word "failed" makes that unambiguous,
    // and a partial failure nobody is told about is the one people notice
    // weeks later, wondering why one language never had diagnostics.
    const label = serverStatusLabel(
      [row({ name: 'pylsp', languages: ['python'] }), row({ status: 'failed' })],
      'python',
    );

    expect(label).toBe('typescript-language-server — failed');
  });

  it('is unchanged when no file is open', () => {
    expect(serverStatusLabel([row()], null)).toBe('typescript-language-server');
  });
});

/**
 * The per-file item, which is where "no server for this language" is said out
 * loud. It reuses the control that already carried exactly this class of fact
 * — `"Python — no grammar installed"` — rather than inventing a second one.
 */
describe('the language item', () => {
  const python = { id: 'python', name: 'Python', hasGrammar: true };

  it('is a plain name when a server is serving it', () => {
    const status = activeLanguageStatus(python, [row({ name: 'pylsp', languages: ['python'] })]);

    expect(status.title).toBe('Python — pylsp');
    expect(status.tone).toBe('normal');
    expect(status.commandId).toBeNull();
  });

  it('says out loud that this language has no server, and where to fix it', () => {
    const status = activeLanguageStatus(python, [row()]);

    expect(status.title).toBe('Python — no language server configured');
    expect(status.tone).toBe('muted');
    // Not a dead end: the Language commands grey out on this file, which
    // reads as "not applicable" rather than "not configured".
    expect(status.commandId).toBe('lsp.configure');
  });

  it('says nothing about servers to someone who has configured none', () => {
    // The same stance the label takes: do not advertise a subsystem to
    // someone who is not using it.
    expect(activeLanguageStatus(python, [])).toEqual({
      title: 'Python',
      tone: 'normal',
      commandId: null,
    });
  });

  it('keeps the grammar sentence it already had', () => {
    const status = activeLanguageStatus({ id: 'nix', name: 'Nix', hasGrammar: false }, []);

    expect(status.title).toBe('Nix — no grammar installed');
    expect(status.tone).toBe('muted');
  });

  it('says both when neither a grammar nor a server is installed', () => {
    const status = activeLanguageStatus({ id: 'nix', name: 'Nix', hasGrammar: false }, [row()]);

    expect(status.title).toBe('Nix — no grammar installed, no language server configured');
    expect(status.commandId).toBe('lsp.configure');
  });

  it('warns rather than mutes when this language\'s own server died', () => {
    const status = activeLanguageStatus(python, [
      row({ name: 'pylsp', languages: ['python'], status: 'failed' }),
    ]);

    expect(status.title).toBe('Python — pylsp failed');
    expect(status.tone).toBe('warn');
  });

  it('says its server is still starting', () => {
    const status = activeLanguageStatus(python, [
      row({ name: 'pylsp', languages: ['python'], status: 'initializing' }),
    ]);

    expect(status.title).toBe('Python — pylsp starting');
    expect(status.tone).toBe('normal');
  });
});

describe('the tooltip', () => {
  it('carries the error and the last words on stderr', () => {
    const title = serverStatusTitle([
      row({
        status: 'failed',
        error: 'tsserver exited with code 1',
        stderr: ['Cannot find module "typescript"'],
      }),
    ]);

    expect(title).toContain('tsserver exited with code 1');
    expect(title).toContain('Cannot find module "typescript"');
  });

  it('is a plain summary when everything is running', () => {
    expect(serverStatusTitle([row()])).toBe('typescript-language-server: running');
  });
});

describe('announcing a failure', () => {
  /**
   * Mirrors `App.#reportFailedServers`: which failures are new, given what has
   * already been announced. Extracted here because the rule — announce once,
   * announce again if the reason changes, forget once recovered — is the part
   * that can be wrong, and the notification call itself cannot.
   */
  function newlyFailed(
    sessions: readonly SessionStatusRow[],
    reported: ReadonlySet<string>,
  ): { announce: string[]; next: Set<string> } {
    const next = new Set<string>();
    const announce: string[] = [];

    for (const session of sessions) {
      if (session.status !== 'failed') continue;
      const key = `${session.name}: ${session.error ?? ''}`;
      next.add(key);
      if (!reported.has(key)) announce.push(key);
    }

    return { announce, next };
  }

  const failed = (name: string, error: string | null): SessionStatusRow => ({
    name,
    status: 'failed',
    languages: ['typescript'],
    error,
    stderr: [],
  });

  it('announces a failure the first time', () => {
    const { announce } = newlyFailed([failed('tsls', 'no TypeScript')], new Set());

    expect(announce).toEqual(['tsls: no TypeScript']);
  });

  it('stays quiet when the same status is republished', () => {
    // `sessions` republishes whenever any server changes state, so without
    // this the same failure would be announced on every republication.
    const first = newlyFailed([failed('tsls', 'no TypeScript')], new Set());
    const again = newlyFailed([failed('tsls', 'no TypeScript')], first.next);

    expect(again.announce).toEqual([]);
  });

  it('announces again when the same server fails for a different reason', () => {
    const first = newlyFailed([failed('tsls', 'no TypeScript')], new Set());
    const second = newlyFailed([failed('tsls', 'port in use')], first.next);

    expect(second.announce).toEqual(['tsls: port in use']);
  });

  it('forgets a failure once the server recovers, so a later one is announced', () => {
    const first = newlyFailed([failed('tsls', 'no TypeScript')], new Set());
    const recovered = newlyFailed([row({ name: 'tsls' })], first.next);
    const relapsed = newlyFailed([failed('tsls', 'no TypeScript')], recovered.next);

    expect(recovered.announce).toEqual([]);
    expect(relapsed.announce).toEqual(['tsls: no TypeScript']);
  });

  it('says nothing about servers that are running', () => {
    const { announce } = newlyFailed([row(), row({ name: 'rust-analyzer' })], new Set());

    expect(announce).toEqual([]);
  });
});
