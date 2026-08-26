import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * What this guards.
 *
 * `release.yml` hardcoded its `releaseBody`, so v0.1.0 through v0.10.0 all
 * shipped the same Install blurb and **no release page ever said what changed
 * in it**. 0.10.0's notes were written onto the draft by hand, which works
 * exactly once. `scripts/release-notes.mjs` reads the section out of
 * CHANGELOG.md instead, and the gate refuses a tag whose section is missing.
 *
 * Driven as a child process rather than imported, because the contract the
 * workflow depends on is the exit code and the bytes on stdout — a function
 * that returned the right string while exiting 0 on a missing section would
 * pass an import-based test and ship an empty release page.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(root, 'scripts', 'release-notes.mjs');

function run(version: string, changelog?: string) {
  const args = changelog === undefined ? [SCRIPT, version] : [SCRIPT, version, changelog];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('release notes from the changelog', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nox-notes-'));
    path = join(dir, 'CHANGELOG.md');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Writes a changelog fixture and returns what the script makes of it. */
  function notesFor(version: string, changelog: string) {
    writeFileSync(path, changelog);
    return run(version, path);
  }

  const TWO_RELEASES = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [0.10.0] — 2026-08-26',
    '',
    'Language servers stop guessing.',
    '',
    '### Added',
    '',
    '- **Servers can read settings.** A `servers.json` entry takes them.',
    '',
    '## [0.9.1] — 2026-08-24',
    '',
    '### Fixed',
    '',
    "- A fresh install no longer opens with an error that isn't one.",
    '',
    '[0.9.1]: https://example.invalid/compare/v0.9.0...v0.9.1',
    '',
  ].join('\n');

  it('prints one section, without its heading', () => {
    const { status, stdout } = notesFor('0.10.0', TWO_RELEASES);

    expect(status).toBe(0);
    expect(stdout).toContain('Language servers stop guessing.');
    expect(stdout).toContain('### Added');
    // The heading is dropped: GitHub already titles the page `Nox v0.10.0`,
    // and the version repeated under it reads like a mistake.
    expect(stdout).not.toContain('## [0.10.0]');
    // And it stops at the next release rather than running to the bottom.
    expect(stdout).not.toContain('0.9.1');
    expect(stdout).not.toContain('### Fixed');
  });

  it('reads a section that is not the newest one', () => {
    const { status, stdout } = notesFor('0.9.1', TWO_RELEASES);

    expect(status).toBe(0);
    expect(stdout).toContain('### Fixed');
    expect(stdout).not.toContain('Language servers stop guessing.');
  });

  it('leaves the link-reference block behind', () => {
    // Keep a Changelog puts `[0.9.1]: https://…` definitions at the bottom of
    // the file, so they fall inside the *last* section's range without
    // belonging to it — and a definition nothing references renders as
    // literal text on the release page.
    const { stdout } = notesFor('0.9.1', TWO_RELEASES);

    expect(stdout).not.toContain('https://example.invalid');
    expect(stdout.trimEnd()).toMatch(/isn't one\.$/);
  });

  it('refuses a version the changelog has never heard of', () => {
    const { status, stderr, stdout } = notesFor('0.11.0', TWO_RELEASES);

    // Exit 1 is the whole point: this runs in the gate, so a forgotten
    // changelog costs seconds rather than twenty minutes of binaries.
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('0.11.0');
    expect(stderr).toContain('Unreleased');
  });

  it('refuses a heading with nothing under it', () => {
    const { status, stderr } = notesFor(
      '0.11.0',
      ['## [0.11.0] — 2026-09-01', '', '## [0.10.0] — 2026-08-26', '', 'Something.', ''].join('\n'),
    );

    // The heading exists, so the "never heard of" check passes and this is the
    // one that has to fire. An empty body ships a page that says nothing.
    expect(status).toBe(1);
    expect(stderr).toContain('nothing under it');
  });

  it('reads a heading whose date is separated by a plain hyphen', () => {
    // Keep a Changelog's own examples use `-`; this file uses an em dash.
    // Failing a release over a typographic choice would be absurd.
    const { status, stdout } = notesFor(
      '0.4.1',
      ['## [0.4.1] - 2026-08-17', '', '### Fixed', '', '- Something.', ''].join('\n'),
    );

    expect(status).toBe(0);
    expect(stdout).toContain('### Fixed');
  });

  it('reads a file with CRLF line endings', () => {
    // Not hypothetical: git checks this repository out with CRLF on Windows,
    // where the notes are written, and with LF on the runner that reads them.
    const { status, stdout } = notesFor('0.10.0', TWO_RELEASES.split('\n').join('\r\n'));

    expect(status).toBe(0);
    expect(stdout).toContain('Language servers stop guessing.');
    expect(stdout).not.toContain('\r');
  });

  it('does not mistake a subsection for a release', () => {
    // `### Added` starts with `##`. If it counted as a heading, every section
    // would be truncated at its first subsection — the release page would
    // carry the summary paragraph and nothing else, which is the kind of
    // failure that looks like a formatting choice.
    const { stdout } = notesFor('0.10.0', TWO_RELEASES);

    expect(stdout).toContain('**Servers can read settings.**');
  });

  it('says how to be used when it is used wrong', () => {
    const missingVersion = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(missingVersion.status).toBe(1);
    expect(missingVersion.stderr).toContain('Usage:');

    const missingFile = run('0.10.0', join(dir, 'absent.md'));
    expect(missingFile.status).toBe(1);
    expect(missingFile.stderr).toContain('Cannot read');
  });

  it('has notes ready for the version this repository is on', () => {
    // The invariant that would have caught the gap in the first place: the
    // three version files and CHANGELOG.md have to agree about what the
    // current version *is*, not just what it is called. Bumping the version
    // without writing the section fails here, on a branch, rather than in the
    // gate twenty minutes into a tag.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const { status, stdout, stderr } = run(pkg.version);

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout.trim().length).toBeGreaterThan(0);
  });
});

describe('the workflow that publishes them', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');

  it('asks the gate for an output the gate declares', () => {
    // The failure this exists for is silent. A typo in `needs.gate.outputs.x`
    // is not an error in Actions — it evaluates to the empty string, and the
    // release ships with the Install blurb alone, which is precisely the state
    // this whole change exists to leave behind.
    const referenced = [...workflow.matchAll(/needs\.gate\.outputs\.([A-Za-z0-9_-]+)/g)].map(
      (match) => match[1],
    );

    expect(referenced.length).toBeGreaterThan(0);

    const block = /^ {4}outputs:\r?\n((?: {6}\S.*\r?\n)+)/m.exec(workflow);
    const declared = [...(block?.[1] ?? '').matchAll(/^ {6}([A-Za-z0-9_-]+):/gm)].map(
      (match) => match[1],
    );

    for (const name of referenced) expect(declared).toContain(name);
  });

  it('calls the script these tests cover', () => {
    expect(workflow).toContain('node scripts/release-notes.mjs');
  });
});
