/**
 * `git blame --porcelain` parsing, in TypeScript where it is testable
 * without a repo. The same split `core/git-status.ts` makes, and for the
 * same reason: the Rust side owns spawning git and nothing else.
 *
 * **Why `--porcelain` and not `--line-porcelain`.** The line variant repeats
 * every commit header for every line, which on a file with a handful of
 * commits multiplies the payload crossing the IPC boundary by the number of
 * lines each commit touched. `--porcelain` emits a commit's metadata the
 * first time it appears and only the per-line header afterwards, so the cost
 * is one block per *commit* rather than one per line. The price is that this
 * parser has to remember commits, which is the `commits` map below.
 *
 * **One object per commit, shared by every line it owns.** A blamed line
 * holds a reference to the same `BlameCommit` as its neighbours from the
 * same commit, so a file with 200,000 lines and 80 commits in its history
 * costs 80 objects and 200,000 references rather than 200,000 objects. It
 * also means metadata that arrives late, since git states a commit once at
 * its first group, is visible to the lines parsed before it, because they hold
 * the object rather than a copy of it.
 *
 * See `docs/superpowers/specs/2026-08-29-git-blame-design.md`.
 */

/**
 * One commit, as blame describes it.
 *
 * `hash` is whatever width git printed: 40 hex characters for SHA-1, 64 for
 * a SHA-256 repository. It is never assumed to be 40 anywhere here.
 */
export interface BlameCommit {
  readonly hash: string;
  /** `hash` cut to git's own default short length. What the gutter shows. */
  readonly abbrev: string;
  readonly author: string;
  /** From `author-mail`, angle brackets removed. Empty when git gave none. */
  readonly email: string;
  /** `author-time`, epoch seconds, or null when git gave none. */
  readonly authorTime: number | null;
  /** `author-tz` as minutes east of UTC. Zero when git gave none. */
  readonly authorTzMinutes: number;
  /** The commit subject, from git's `summary` header. */
  readonly summary: string;
  /**
   * True for the all-zero object name git gives a line that is in the text
   * being blamed but in no commit. Not an error: with `--contents` it is the
   * honest answer for a line the user has just typed, and the gutter says so
   * rather than attributing it to whoever wrote the lines around it.
   *
   * Detected from the hash rather than from the author, because the author
   * of such a line is git's own plumbing detail and it varies: blaming a
   * dirty worktree gives "Not Committed Yet", blaming supplied contents
   * gives "External file (--contents)". Neither belongs on screen.
   */
  readonly uncommitted: boolean;
}

/** One blamed line: a 1-based line in the text blamed, and its commit. */
export interface BlameLine {
  readonly line: number;
  readonly commit: BlameCommit;
}

/**
 * The per-line header every porcelain record opens with: the object name,
 * the line number in the original file, the line number in the final file,
 * and, only on the line that starts a group, how many lines the group runs
 * for.
 *
 * The group count is matched and then ignored. Every line gets its own
 * header line regardless, so reading the final-line number off each header
 * is both simpler and more robust than trusting a count to describe lines
 * this parser would otherwise never see.
 */
const HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/;

/** git's own default short-hash length, and so the gutter's. */
export const BLAME_HASH_WIDTH = 7;

/**
 * How much of the author's name the gutter shows.
 *
 * Fixed-width rather than CSS-elided: the gutter sits in a monospaced grid,
 * and a column whose width follows its widest *visible* marker changes width
 * as you scroll, shifting the code beside it. Padding here makes every
 * marker the same length, so the column cannot move.
 *
 * **Twelve, and the number came from looking at it.** Sixteen was the first
 * guess and it is wrong in a way no test could report: a fixed column is
 * sized for the longest name it will ever hold, so every character of it is
 * dead space beside every name shorter than that, and the dead space sits
 * between the name and the code, which is where it is most visible. At
 * sixteen the gap was wider than the label. Twelve still holds `Jane Doe`,
 * `bmarshall` and `Alex Chen` whole, and cuts the rest where a name is
 * usually already recognisable.
 */
export const BLAME_AUTHOR_WIDTH = 12;

/** The width every label is padded to: hash, a space, author. */
export const BLAME_LABEL_WIDTH = BLAME_HASH_WIDTH + 1 + BLAME_AUTHOR_WIDTH;

/** What the gutter shows for a line no commit holds. */
const UNCOMMITTED_LABEL = 'Uncommitted';

interface MutableCommit {
  hash: string;
  abbrev: string;
  author: string;
  email: string;
  authorTime: number | null;
  authorTzMinutes: number;
  summary: string;
  uncommitted: boolean;
}

/**
 * Blamed lines, in the order git printed them, one entry per line of the
 * text that was blamed.
 *
 * Anything unrecognised is skipped rather than thrown on: blame is a read,
 * and a parser that refused a stream it half-understood would lose the lines
 * it *did* understand. A stream that is not blame output at all yields an
 * empty list, which the service reads as "no blame for this file": the same
 * degraded state as no repository.
 */
export function parseGitBlame(raw: string): BlameLine[] {
  const commits = new Map<string, MutableCommit>();
  const lines: BlameLine[] = [];
  const rows = raw.split('\n');

  let i = 0;
  while (i < rows.length) {
    const header = HEADER.exec(trimCr(rows[i]!));
    if (!header) {
      // Not a header where one was expected. Skip it rather than stop: the
      // next header re-synchronises, and losing one record beats losing
      // every line after it.
      i++;
      continue;
    }
    i++;

    const hash = header[1]!;
    const finalLine = Number(header[3]);

    let commit = commits.get(hash);
    if (!commit) {
      commit = blankCommit(hash);
      commits.set(hash, commit);
    }

    // Metadata runs until the line's content, which git prefixes with a tab.
    // A header found here instead means the stream lost its content line;
    // breaking without consuming it lets the outer loop read it as the
    // header it is, rather than swallowing a whole record as a malformed key.
    while (i < rows.length && !rows[i]!.startsWith('\t')) {
      const row = trimCr(rows[i]!);
      if (HEADER.test(row)) break;
      i++;
      const space = row.indexOf(' ');
      const key = space === -1 ? row : row.slice(0, space);
      const value = space === -1 ? '' : row.slice(space + 1);
      applyHeader(commit, key, value);
    }
    if (i < rows.length && rows[i]!.startsWith('\t')) i++;

    if (Number.isInteger(finalLine) && finalLine > 0) lines.push({ line: finalLine, commit });
  }

  return lines;
}

/**
 * The author-local calendar date, `YYYY-MM-DD`, or empty when git gave no
 * time.
 *
 * Shifted by `author-tz` and then read in UTC, which is what makes the date
 * the author's own rather than the reader's. A commit made at 23:30 in
 * Berlin is dated the day it was made, not the day before it was in London.
 * That is `git blame`'s own default. The alternative, the reader's local
 * timezone, would make one line show two different dates on two machines
 * looking at the same repository.
 */
export function blameDate(commit: BlameCommit): string {
  if (commit.authorTime === null) return '';
  const shifted = new Date((commit.authorTime + commit.authorTzMinutes * 60) * 1000);
  if (Number.isNaN(shifted.getTime())) return '';
  return shifted.toISOString().slice(0, 10);
}

/**
 * The gutter's text: short hash, then author, padded to a stable width.
 *
 * The date is deliberately not here. Every character of this column is taken
 * from the code beside it, and the row this answers is *blame*: who wrote
 * this line. The date, the email and the subject are one hover away in
 * `blameTitle`.
 */
export function blameLabel(commit: BlameCommit): string {
  if (commit.uncommitted) return fit(UNCOMMITTED_LABEL, BLAME_LABEL_WIDTH);
  return `${fit(commit.abbrev, BLAME_HASH_WIDTH)} ${fit(commit.author, BLAME_AUTHOR_WIDTH)}`;
}

/** Everything the gutter had no room for, for the marker's `title`. */
export function blameTitle(commit: BlameCommit): string {
  if (commit.uncommitted) return 'Not committed yet';
  const who = commit.email ? `${commit.author} <${commit.email}>` : commit.author;
  const parts = [commit.abbrev, who, blameDate(commit)].filter((part) => part.length > 0);
  const heading = parts.join(' · ');
  return commit.summary ? `${heading}\n${commit.summary}` : heading;
}

function blankCommit(hash: string): MutableCommit {
  return {
    hash,
    abbrev: hash.slice(0, BLAME_HASH_WIDTH),
    author: '',
    email: '',
    authorTime: null,
    authorTzMinutes: 0,
    summary: '',
    // Matched by shape rather than against a 40-zero literal, because a
    // SHA-256 repository prints 64 of them.
    uncommitted: /^0+$/.test(hash),
  };
}

function applyHeader(commit: MutableCommit, key: string, value: string): void {
  switch (key) {
    case 'author':
      commit.author = value;
      break;
    case 'author-mail':
      // git wraps it in angle brackets; an empty identity arrives as `<>`.
      commit.email = value.replace(/^<|>$/g, '');
      break;
    case 'author-time': {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) commit.authorTime = seconds;
      break;
    }
    case 'author-tz':
      commit.authorTzMinutes = tzMinutes(value);
      break;
    case 'summary':
      commit.summary = value;
      break;
    default:
      // `committer*`, `previous`, `filename`, `boundary`: read and dropped.
      // None of them changes who wrote the line.
      break;
  }
}

/** `+0530` to 330. Zero for anything that is not that shape. */
function tzMinutes(value: string): number {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(value);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/** Pad to `width`, or cut to it with an ellipsis in the last cell. */
function fit(text: string, width: number): string {
  if (text.length === width) return text;
  if (text.length < width) return text.padEnd(width);
  return `${text.slice(0, width - 1)}…`;
}

function trimCr(row: string): string {
  return row.endsWith('\r') ? row.slice(0, -1) : row;
}
