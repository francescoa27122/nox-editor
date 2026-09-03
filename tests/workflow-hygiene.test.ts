import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What this guards.
 *
 * A8-011 in the ship-readiness audit: every action in both workflows was
 * pinned by a major tag (`@v7`, `@stable`), ci.yml declared no permissions,
 * and no dependency bot existed. A moved tag runs arbitrary code with the
 * default token on every pull request, and a moved tag is not a thing the
 * repository would notice. These hold the pins and the permissions, which
 * are exactly the lines a well-meant "bump the action" edit undoes.
 *
 * What this does not catch: a pinned SHA that is itself malicious, or a
 * job-level `permissions:` widening what the top level grants. It reads the
 * shape, not the intent.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const workflows = join(root, '.github', 'workflows');

function read(...parts: string[]): string {
  return readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

const files = readdirSync(workflows).filter((name) => name.endsWith('.yml'));

describe('A8-011: workflow hygiene', () => {
  it('has both workflows to check', () => {
    expect(files).toContain('ci.yml');
    expect(files).toContain('release.yml');
  });

  it('pins every third-party action to a full commit SHA', () => {
    for (const file of files) {
      const text = read('.github', 'workflows', file);
      const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? '');
      expect(uses.length, file).toBeGreaterThan(0);
      // A local composite action is part of the tree and has nothing to pin.
      const unpinned = uses.filter((u) => !u.startsWith('./') && !/@[0-9a-f]{40}$/.test(u));
      expect(unpinned, file).toEqual([]);
    }
  });

  it('starts every workflow read-only and widens only where the job needs it', () => {
    for (const file of files) {
      const text = read('.github', 'workflows', file);
      expect(text, file).toMatch(/^permissions:\n {2}contents: read$/m);
    }
    // The one job that uploads to a release is the one that may write.
    const release = read('.github', 'workflows', 'release.yml');
    expect(release.match(/contents: write/g)?.length).toBe(1);
    expect(read('.github', 'workflows', 'ci.yml')).not.toContain('contents: write');
  });

  it('has a Dependabot config for the three ecosystems the build has', () => {
    const path = join(root, '.github', 'dependabot.yml');
    expect(existsSync(path)).toBe(true);
    const config = read('.github', 'dependabot.yml');
    for (const ecosystem of ['npm', 'cargo', 'github-actions']) {
      expect(config).toContain(`package-ecosystem: ${ecosystem}`);
    }
  });

  /**
   * The rust job audits the graph but is not allowed to block on it: with
   * `enforce_admins` on there is no override for an advisory whose fix is
   * unreleased. The comment beside the step says so; this holds the flag so
   * the step cannot be quietly promoted, or quietly dropped.
   */
  it('audits the crate graph without blocking on it', () => {
    const ci = read('.github', 'workflows', 'ci.yml');
    const step = /- name: Audit the dependency graph\n(?:.*\n)*?\s+run: \|\n(?:.*\n)*?\s+cargo audit\n/.exec(ci);
    expect(step?.[0]).toBeDefined();
    expect(step?.[0]).toContain('continue-on-error: true');
  });
});
