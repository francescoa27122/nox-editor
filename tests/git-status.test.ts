import { describe, expect, it } from 'vitest';
import { parseGitBranches, parseGitStatus } from '../src/core/git-status';

// Captured from a real `git status --porcelain=v2 --branch -z` (2026-08-19).
const FIXTURE = [
  '# branch.oid 42772c8fbd3f6b6b5ed5d5358a0a7bdf89c99edb',
  '# branch.head main',
  '1 MM N... 100644 100644 100644 5626abf0f72e58d7a153368ba57db4c673c0e171 814f4a422927b82f5f8a43f8fab6d3839e3983f2 a.txt',
  '1 .M N... 100644 100644 100644 2fa992c0b8b5c6acd2bdd4fa31de29d29799bdd5 2fa992c0b8b5c6acd2bdd4fa31de29d29799bdd5 b.txt',
  '2 R. N... 100644 100644 100644 286c5f5776916d7d7d5849988ca9d83e722cf9c2 286c5f5776916d7d7d5849988ca9d83e722cf9c2 R100 mv-to.txt',
  'mv-from.txt',
  '? new\nline.txt',
  '? untracked.txt',
  '',
].join('\0');

// Captured from a detached HEAD in the same repo.
const DETACHED = [
  '# branch.oid e11ea47bca5991343e292175cbc91646cab62bd1',
  '# branch.head (detached)',
  '',
].join('\0');

describe('parseGitStatus', () => {
  it('reads the branch headers', () => {
    const status = parseGitStatus(FIXTURE);
    expect(status.branch).toBe('main');
    expect(status.detached).toBe(false);
    expect(status.oid).toBe('42772c8fbd3f6b6b5ed5d5358a0a7bdf89c99edb');
  });

  it('puts a file staged and re-edited (MM) in both lists', () => {
    const status = parseGitStatus(FIXTURE);
    expect(status.staged).toContainEqual({ path: 'a.txt', status: 'M' });
    expect(status.unstaged).toContainEqual({ path: 'a.txt', status: 'M' });
  });

  it('puts a worktree-only edit (.M) in unstaged only', () => {
    const status = parseGitStatus(FIXTURE);
    expect(status.staged.some((e) => e.path === 'b.txt')).toBe(false);
    expect(status.unstaged).toContainEqual({ path: 'b.txt', status: 'M' });
  });

  it('reads a rename with its NUL-separated original path', () => {
    const status = parseGitStatus(FIXTURE);
    expect(status.staged).toContainEqual({ path: 'mv-to.txt', status: 'R', origPath: 'mv-from.txt' });
  });

  it('labels untracked files U, a newline in the name included', () => {
    const status = parseGitStatus(FIXTURE);
    expect(status.unstaged).toContainEqual({ path: 'untracked.txt', status: 'U' });
    expect(status.unstaged).toContainEqual({ path: 'new\nline.txt', status: 'U' });
  });

  it('reports a detached HEAD with its oid', () => {
    const status = parseGitStatus(DETACHED);
    expect(status.branch).toBeNull();
    expect(status.detached).toBe(true);
    expect(status.oid).toBe('e11ea47bca5991343e292175cbc91646cab62bd1');
  });

  it('reads the synthetic # git.toplevel record Rust prefixes onto the raw output', () => {
    const withToplevel = `# git.toplevel /Users/x/repo\0${FIXTURE}`;
    const status = parseGitStatus(withToplevel);
    expect(status.toplevel).toBe('/Users/x/repo');
    // The rest still parses with the prefix present.
    expect(status.branch).toBe('main');
    expect(status.staged).toContainEqual({ path: 'a.txt', status: 'M' });
  });

  it('leaves toplevel null when the record is absent', () => {
    expect(parseGitStatus(FIXTURE).toplevel).toBeNull();
  });

  it('parses an empty repo status (headers only) to empty lists', () => {
    const status = parseGitStatus('# branch.oid (initial)\0# branch.head main\0');
    expect(status.branch).toBe('main');
    expect(status.oid).toBeNull();
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
  });

  it('maps porcelain C (copied) to R with origPath', () => {
    const copied = [
      '# branch.oid 42772c8fbd3f6b6b5ed5d5358a0a7bdf89c99edb',
      '# branch.head main',
      '2 C. N... 100644 100644 100644 286c5f5776916d7d7d5849988ca9d83e722cf9c2 286c5f5776916d7d7d5849988ca9d83e722cf9c2 C100 copied-to.txt',
      'copied-from.txt',
      '',
    ].join('\0');
    const status = parseGitStatus(copied);
    expect(status.staged).toContainEqual({ path: 'copied-to.txt', status: 'R', origPath: 'copied-from.txt' });
    expect(status.unstaged.some((e) => e.path === 'copied-to.txt')).toBe(false);
  });

  it('gives an unmerged u-record its own letter, not M', () => {
    // Guards the distinction itself: this record used to land in unstaged as
    // M, which made a file full of conflict markers render exactly like one
    // the user edited — same list, same amber letter, same enabled Stage
    // button. Asserting C rather than "not M" is deliberate: the panel
    // keys a section, a colour and a disabled action off this letter.
    const unmerged = [
      '# branch.oid 42772c8fbd3f6b6b5ed5d5358a0a7bdf89c99edb',
      '# branch.head main',
      'u UU N... 100644 100644 100644 100644 5626abf0f72e58d7a153368ba57db4c673c0e171 5626abf0f72e58d7a153368ba57db4c673c0e171 5626abf0f72e58d7a153368ba57db4c673c0e171 conflicted.txt',
      '',
    ].join('\0');
    const status = parseGitStatus(unmerged);
    expect(status.unstaged).toContainEqual({ path: 'conflicted.txt', status: 'C' });
    expect(status.staged.some((e) => e.path === 'conflicted.txt')).toBe(false);
  });

  it('keeps C free of porcelain\'s copied meaning — a copy is still R', () => {
    // The letter collision this fix had to route around: porcelain spends C
    // on "copied", and untracked already owns U here. Copies are folded into
    // R *before* a FileEntry exists, which is what leaves C spendable on
    // conflicted; if that folding were ever dropped, one letter would mean
    // two things and this fails.
    const copied = [
      '# branch.head main',
      '2 C. N... 100644 100644 100644 286c5f5776916d7d7d5849988ca9d83e722cf9c2 286c5f5776916d7d7d5849988ca9d83e722cf9c2 C100 copied-to.txt',
      'copied-from.txt',
      '',
    ].join('\0');
    const status = parseGitStatus(copied);
    expect(status.staged.every((e) => e.status !== 'C')).toBe(true);
  });
});

describe('parseGitBranches', () => {
  it('splits lines and keeps order', () => {
    expect(parseGitBranches('feature/x\nmain\n')).toEqual(['feature/x', 'main']);
  });

  it('drops the "(HEAD detached at …)" pseudo-entry a detached HEAD emits', () => {
    // Verified live: `--format=%(refname:short)` still prints this line.
    expect(parseGitBranches('(HEAD detached at refs/heads/main)\nfeature/x\nmain\n')).toEqual([
      'feature/x',
      'main',
    ]);
  });

  it('handles empty output (a repo with no commits)', () => {
    expect(parseGitBranches('')).toEqual([]);
  });
});

describe('a submodule record', () => {
  /**
   * The record below is verbatim from a real repository with a dirty
   * submodule at `sub` — captured, not composed.
   *
   * The trap it guards: a submodule path carries **no trailing slash**, so it
   * is indistinguishable from a file by its text. Porcelain's third field is
   * the only signal — `N...` for a path, `S<c><m><u>` for a submodule — and
   * the parser used to discard it. The Git panel then offered Open and Show
   * Changes on a row that can only answer "sub is a folder."
   */
  const RECORD =
    '1 .M S.M. 160000 160000 160000 ' +
    '0ea11d91d8a6c09c24e521992f048f01736ffadc ' +
    '0ea11d91d8a6c09c24e521992f048f01736ffadc sub';

  it('is flagged as a submodule, though its path looks like a file', () => {
    const status = parseGitStatus(`# branch.head main\0${RECORD}\0`);
    expect(status.unstaged).toEqual([{ path: 'sub', status: 'M', submodule: true }]);
  });

  it('leaves an ordinary path unflagged, so the signal means something', () => {
    const ordinary = '1 .M N... 100644 100644 100644 aaa bbb readme.md';
    const status = parseGitStatus(`# branch.head main\0${ordinary}\0`);
    expect(status.unstaged).toEqual([{ path: 'readme.md', status: 'M', submodule: undefined }]);
  });
});
