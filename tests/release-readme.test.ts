import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * What this guards.
 *
 * The release gate held the three version files to each other and to the tag,
 * and every one of them could agree while the README described the release
 * before it. That happened rather than being imagined: plugins landed on main
 * across four pull requests while README §Status still ended *"Not there yet:
 * plugins"*, and the test count in the same paragraph was two hundred short.
 * Nothing in the repository would have caught either at the tag —
 * `CONTRIBUTING.md` did not mention the README, and no checklist existed.
 *
 * Prose is not checkable. The `**vX.Y.**` the section opens with is, and it
 * sits in the same paragraph as the prose, so a gate on it means someone
 * opened the paragraph where the stale sentence is.
 *
 * Driven as a child process rather than imported, for the reason
 * `release-notes.test.ts` gives: the contract the workflow depends on is the
 * exit code and the bytes on stdout, and a function returning the right string
 * while exiting 0 on a missing line would pass an import-based test and let
 * the tag through.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(root, 'scripts', 'readme-series.mjs');

function run(readme?: string) {
  const args = readme === undefined ? [SCRIPT] : [SCRIPT, readme];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

describe('the series the README claims', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nox-readme-'));
    path = join(dir, 'README.md');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function withBody(body: string) {
    writeFileSync(path, body, 'utf8');
    return run(path);
  }

  it('reads the version the Status section opens with', () => {
    const result = withBody('# Nox\n\n## Status\n\n**v0.10.** It is young.\n');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('0.10');
  });

  it('takes the first one, so a later mention cannot shadow it', () => {
    const result = withBody('## Status\n\n**v0.10.** Young.\n\nOnce, **v0.9.** was current.\n');

    expect(result.stdout).toBe('0.10');
  });

  it('reads a two-digit minor rather than stopping at one', () => {
    // `v0.9` and `v0.10` differ in width, and a pattern written for the first
    // release series would have truncated every one after it.
    expect(withBody('**v1.24.** Mature.\n').stdout).toBe('1.24');
  });

  it('refuses a README with no such line, rather than passing an empty string', () => {
    // The failure that matters: exiting 0 with nothing on stdout makes the
    // gate compare "" against the series, which fails for the wrong reason
    // and sends whoever reads the log looking in the wrong place.
    const result = withBody('# Nox\n\nA text editor.\n');

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Status section/);
  });

  it('refuses a file it cannot read', () => {
    const result = run(join(dir, 'absent.md'));

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Could not read/);
  });
});

describe('the README in this repository', () => {
  /**
   * The check the gate makes, made here too — so a README reworded in a pull
   * request fails in CI rather than at the tag, where the cost is a release
   * that has already started.
   */
  it('opens its Status section with the series the version files configure', () => {
    const configured = JSON.parse(
      readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    ).version as string;
    const series = configured.split('.').slice(0, 2).join('.');

    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(series);
  });

  /**
   * The other half of the same paragraph, and the one a version check cannot
   * reach. Deliberately a *floor* rather than the exact count: pinning the
   * number would make every pull request that adds a test edit the README,
   * which is a tax on the wrong people. A floor still catches the failure
   * that actually happened — a number left behind for months while the suite
   * grew by hundreds — and needs updating only when it is embarrassingly low.
   */
  it('does not claim fewer tests than it had two releases ago', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const claimed = readme.match(/([\d,]+) tests/)?.[1];

    expect(claimed).toBeDefined();
    expect(Number(claimed?.replace(/,/g, ''))).toBeGreaterThanOrEqual(2300);
  });
});
