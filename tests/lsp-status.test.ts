import { describe, expect, it } from 'vitest';
import { serverStatusLabel, serverStatusTitle } from '../src/ui/lsp-status';
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
