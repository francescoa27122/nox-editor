import { describe, expect, it } from 'vitest';
import {
  blameDate,
  blameLabel,
  blameTitle,
  parseGitBlame,
  BLAME_LABEL_WIDTH,
} from '../src/core/git-blame';

/**
 * The porcelain parser, against output real git actually produced.
 *
 * `PORCELAIN` below is `git blame --porcelain` from git 2.43 over a
 * three-line file committed twice, with a fourth line added and not
 * committed, captured verbatim and pasted, not composed. That matters more
 * here than in most fixtures: the parser's whole difficulty is a format with
 * two asymmetries nobody would invent when writing an example by hand. A
 * commit's metadata block appears **once**, so the third record, the first
 * commit's second group, is a bare header and a content line with no author
 * anywhere near it; and the group count is on a group's first line only.
 * `src-tauri/src/git.rs` holds the tripwire that asserts both against real
 * git on every CI platform, so this fixture cannot quietly drift into a
 * shape git stopped producing.
 */

const PORCELAIN = [
  '2a9700fa588828e1244ce40dea66f9b6e77753b9 1 1 1',
  'author Jane Doe',
  'author-mail <jane@example.com>',
  'author-time 1787976621',
  'author-tz +0000',
  'committer Jane Doe',
  'committer-mail <jane@example.com>',
  'committer-time 1787976621',
  'committer-tz +0000',
  'summary Add the first three lines',
  // A root commit is a boundary, and git says so with a valueless header.
  'boundary',
  'filename app.ts',
  '\talpha',
  '43e67dc0f13dcf65ff2388e4c12b77ced4f92c08 2 2 1',
  'author Bo',
  'author-mail <bo@example.com>',
  'author-time 1787976621',
  'author-tz +0000',
  'committer Bo',
  'committer-mail <bo@example.com>',
  'committer-time 1787976621',
  'committer-tz +0000',
  'summary Shout the middle one',
  'previous 2a9700fa588828e1244ce40dea66f9b6e77753b9 app.ts',
  'filename app.ts',
  '\tBRAVO',
  // The first commit again: header and content, nothing else. This record
  // is the one that decides whether the parser remembers commits.
  '2a9700fa588828e1244ce40dea66f9b6e77753b9 3 3 1',
  '\tcharlie',
  '0000000000000000000000000000000000000000 4 4 1',
  'author Not Committed Yet',
  'author-mail <not.committed.yet>',
  'author-time 1787976622',
  'author-tz +0000',
  'committer Not Committed Yet',
  'committer-mail <not.committed.yet>',
  'committer-time 1787976622',
  'committer-tz +0000',
  'summary Version of app.ts from app.ts',
  'previous 43e67dc0f13dcf65ff2388e4c12b77ced4f92c08 app.ts',
  'filename app.ts',
  '\tdelta',
  '',
].join('\n');

describe('parsing git blame porcelain', () => {
  it('reports one entry per line, numbered as git numbered them', () => {
    const lines = parseGitBlame(PORCELAIN);
    expect(lines.map((l) => l.line)).toEqual([1, 2, 3, 4]);
  });

  /**
   * Guards the defect the format invites: git states a commit once, so a
   * parser that read metadata only from the record in front of it would give
   * line 3 a blank author and an empty summary. Line 3 is the *same* commit
   * as line 1, and must know everything line 1 knows.
   */
  it('carries a commit forward to its later groups, which git does not restate', () => {
    const [first, , third] = parseGitBlame(PORCELAIN);
    expect(third!.commit.author).toBe('Jane Doe');
    expect(third!.commit.summary).toBe('Add the first three lines');
    // The same object, not merely equal: that identity is what the gutter's
    // per-commit marker cache and `BlameValue.eq` are built on.
    expect(third!.commit).toBe(first!.commit);
  });

  it('reads the author, the email and the subject off the header block', () => {
    const [, second] = parseGitBlame(PORCELAIN);
    expect(second!.commit.author).toBe('Bo');
    expect(second!.commit.email).toBe('bo@example.com');
    expect(second!.commit.summary).toBe('Shout the middle one');
    expect(second!.commit.abbrev).toBe('43e67dc');
    expect(second!.commit.uncommitted).toBe(false);
  });

  /**
   * The sentinel is the hash, never the author. git names that author
   * differently depending on how it was asked: "Not Committed Yet" when it
   * blames a dirty worktree, "External file (--contents)" when it blames
   * supplied text, which is how Nox always asks. Keying on the name would
   * have worked in this fixture and failed in the product.
   */
  it('calls a line with the all-zero object name uncommitted', () => {
    const last = parseGitBlame(PORCELAIN)[3]!;
    expect(last.commit.uncommitted).toBe(true);
    expect(blameLabel(last.commit).trim()).toBe('Uncommitted');
    expect(blameTitle(last.commit)).toBe('Not committed yet');
  });

  it('takes anything it cannot read as no blame at all', () => {
    expect(parseGitBlame('')).toEqual([]);
    expect(parseGitBlame('fatal: no such path\n')).toEqual([]);
  });

  it('reads output whose lines are CRLF-terminated', () => {
    const lines = parseGitBlame(PORCELAIN.replace(/\n/g, '\r\n'));
    expect(lines.map((l) => l.line)).toEqual([1, 2, 3, 4]);
    expect(lines[0]!.commit.author).toBe('Jane Doe');
    expect(lines[0]!.commit.summary).toBe('Add the first three lines');
  });

  it('re-synchronises on the next header rather than losing the rest', () => {
    const damaged = PORCELAIN.replace('author Jane Doe\n', 'author Jane Doe\n???\n');
    expect(parseGitBlame(damaged).map((l) => l.line)).toEqual([1, 2, 3, 4]);
  });
});

describe('presenting a blamed commit', () => {
  function commitWith(tz: string, time: number) {
    const raw = [
      `${'a'.repeat(40)} 1 1 1`,
      'author Ada',
      'author-mail <ada@example.com>',
      `author-time ${time}`,
      `author-tz ${tz}`,
      'summary Do the thing',
      'filename a.ts',
      '\tcode',
      '',
    ].join('\n');
    return parseGitBlame(raw)[0]!.commit;
  }

  /**
   * The date is the author's, not the reader's. 1700000000 is
   * 2023-11-14T22:13:20Z, so an author in +0530 wrote it on the 15th and one
   * in -0800 on the 14th, and both see that same answer wherever they read
   * it later. Reading the timestamp in the *reader's* zone instead would
   * make one line show two dates on two machines, which is the failure this
   * pins.
   */
  it('dates a commit in the author´s timezone, not the reader´s', () => {
    expect(blameDate(commitWith('+0530', 1_700_000_000))).toBe('2023-11-15');
    expect(blameDate(commitWith('-0800', 1_700_000_000))).toBe('2023-11-14');
    expect(blameDate(commitWith('+0000', 1_700_000_000))).toBe('2023-11-14');
  });

  /**
   * Every label is the same length, which is what stops the gutter column
   * changing width as different names scroll into view and shoving the code
   * sideways. CSS elision cannot do this: it bounds the width, it does not
   * fix it.
   */
  it('pads every label to one width, however long the name', () => {
    const short = parseGitBlame(PORCELAIN)[1]!.commit;
    const long = commitWith('+0000', 1_700_000_000);
    const uncommitted = parseGitBlame(PORCELAIN)[3]!.commit;
    for (const commit of [short, long, uncommitted]) {
      expect(blameLabel(commit)).toHaveLength(BLAME_LABEL_WIDTH);
    }
  });

  it('cuts a name too long for the column and marks the cut', () => {
    const raw = [
      `${'b'.repeat(40)} 1 1 1`,
      'author Bartholomew Fortescue-Smythe',
      'author-mail <b@example.com>',
      'summary A commit',
      'filename a.ts',
      '\tcode',
      '',
    ].join('\n');
    const label = blameLabel(parseGitBlame(raw)[0]!.commit);
    expect(label).toHaveLength(BLAME_LABEL_WIDTH);
    expect(label).toBe('bbbbbbb Bartholomew…');
  });

  it('puts the identity, the date and the subject in the hover text', () => {
    const title = blameTitle(parseGitBlame(PORCELAIN)[1]!.commit);
    expect(title).toBe('43e67dc · Bo <bo@example.com> · 2026-08-29\nShout the middle one');
  });
});
