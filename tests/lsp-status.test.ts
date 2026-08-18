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
