import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What this guards.
 *
 * The things a stranger meets before they meet the editor: where to report a
 * hole, what a bug report should carry, whose code is in the bundle. None of
 * it is behaviour, so none of it had a test, and the ship-readiness audit
 * (AUDIT/A8-ship-readiness.md) found each of them missing or stale. A file
 * that exists today can be deleted in a tidy-up tomorrow; these hold the
 * ones that must not be.
 *
 * What this does not catch: prose going stale inside a file that still
 * exists. It checks the load-bearing string in each, not the paragraph
 * around it.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

/** Normalised to LF: a Windows checkout with autocrlf on hands back CRLF. */
function read(...parts: string[]): string {
  return readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

describe('A8-004: a disclosure route and issue templates', () => {
  it('SECURITY.md points at private vulnerability reporting, not an inbox', () => {
    const security = read('SECURITY.md');
    expect(security).toContain(
      'https://github.com/francescoa27122/nox-editor/security/advisories/new',
    );
    // No personal address: the route is the repository's, so it survives a
    // change of maintainer and cannot be scraped off the tree.
    expect(security).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(security).toMatch(/latest release/i);
  });

  it('both issue templates exist and the bug report asks for Copy Diagnostics first', () => {
    const templates = join(root, '.github', 'ISSUE_TEMPLATE');
    expect(existsSync(join(templates, 'bug_report.md'))).toBe(true);
    expect(existsSync(join(templates, 'feature_request.md'))).toBe(true);

    const bug = read('.github', 'ISSUE_TEMPLATE', 'bug_report.md');
    // The first section, because the README already asks for it and reports
    // arrived without it: a field nobody sees until after the prose is one
    // nobody fills.
    const firstHeading = bug.split('\n').find((line) => line.startsWith('## '));
    expect(firstHeading).toBe('## Copy Diagnostics');
    expect(bug).toMatch(/^name: /m);
    expect(read('.github', 'ISSUE_TEMPLATE', 'feature_request.md')).toMatch(/^name: /m);
  });
});
