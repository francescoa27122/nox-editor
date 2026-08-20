/**
 * Porcelain v2 parsing, in TypeScript where it is testable without a repo.
 *
 * The Rust side ships raw `git status --porcelain=v2 --branch -z` output
 * across the boundary; everything that understands it lives here. `-z`
 * because filenames contain anything (records are NUL-terminated, and a
 * rename's original path arrives as the *next* NUL token); porcelain v2
 * because it carries branch info and rename detail in one call.
 *
 * Letters follow porcelain: M, A, D, R for tracked changes, U for untracked.
 * Porcelain's C (copied) maps to R — a copy is a rename-shaped fact — and an
 * unmerged (`u`) record lands in unstaged as M: a conflicted file silently
 * missing from the list would be worse than an imprecise letter. Anything
 * unrecognised degrades to M for the same reason.
 *
 * See docs/superpowers/specs/2026-08-19-git-stage-commit-design.md §4.
 */

export type GitStatusLetter = 'M' | 'A' | 'D' | 'R' | 'U';

export interface FileEntry {
  /** Relative to the repository toplevel, exactly as git printed it. */
  path: string;
  status: GitStatusLetter;
  /** A rename's source, when there is one. */
  origPath?: string;
}

export interface GitStatus {
  /** Current branch name, or null when HEAD is detached. */
  branch: string | null;
  /** Full HEAD oid, or null in a repository with no commits yet. */
  oid: string | null;
  detached: boolean;
  staged: FileEntry[];
  unstaged: FileEntry[];
}

/** Everything after the nth space — the path field, which may itself contain spaces. */
function tailAfter(record: string, spaces: number): string {
  let index = 0;
  for (let n = 0; n < spaces; n++) {
    index = record.indexOf(' ', index) + 1;
    if (index === 0) return '';
  }
  return record.slice(index);
}

function letter(code: string): GitStatusLetter {
  if (code === 'A' || code === 'D' || code === 'R') return code;
  if (code === 'C') return 'R';
  return 'M';
}

export function parseGitStatus(raw: string): GitStatus {
  const records = raw.split('\0');
  const status: GitStatus = { branch: null, oid: null, detached: false, staged: [], unstaged: [] };

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;

    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length);
      status.oid = oid === '(initial)' ? null : oid;
    } else if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length);
      if (head === '(detached)') status.detached = true;
      else status.branch = head;
    } else if (record.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const x = record[2]!;
      const y = record[3]!;
      const path = tailAfter(record, 8);
      if (x !== '.') status.staged.push({ path, status: letter(x) });
      if (y !== '.') status.unstaged.push({ path, status: letter(y) });
    } else if (record.startsWith('2 ')) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <origPath>
      const x = record[2]!;
      const y = record[3]!;
      const path = tailAfter(record, 9);
      const origPath = records[++i] ?? '';
      if (x !== '.') status.staged.push({ path, status: letter(x), origPath });
      if (y !== '.') status.unstaged.push({ path, status: letter(y) });
    } else if (record.startsWith('? ')) {
      status.unstaged.push({ path: record.slice(2), status: 'U' });
    } else if (record.startsWith('u ')) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      status.unstaged.push({ path: tailAfter(record, 10), status: 'M' });
    }
    // '!' (ignored entries) never appear without --ignored; anything else is
    // a future porcelain addition and is skipped rather than guessed at.
  }

  return status;
}

/**
 * `git branch --list --format=%(refname:short)`, one name per line. On a
 * detached HEAD git still emits a "(HEAD detached at …)" pseudo-entry;
 * a real branch name can never start with "(", so those are dropped.
 */
export function parseGitBranches(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('('));
}
