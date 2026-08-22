import { describe, expect, it } from 'vitest';
import type { GitStatusLetter } from '../src/core/git-status';
import { rollUpLetters, rollUpPaths } from '../src/core/folder-marks';

/**
 * What a *folder* is allowed to say about the files inside it.
 *
 * The tree marked changed and unsaved files and nothing else, so collapsing
 * `src/` over forty changes made it read exactly like one hiding none — the
 * `ARCHITECTURE.md` §7 row this module closes. The roll-up is built from the
 * status list and the open-buffer list, never by walking the tree, which is
 * the property that lets it answer for a folder the lazy loader has never
 * expanded.
 *
 * Two things this suite exists to hold beyond "ancestors get marked":
 *
 * 1. **The worst letter wins, and C wins over everything.** A folder holding
 *    a conflict and thirty ordinary edits must say `C`: staging a conflict is
 *    the one action that is actively harmful, which is the same argument
 *    `core/git-status.ts` makes for spending a scarce letter on it.
 * 2. **The monotone early exit must not swallow an upgrade.** Climbing stops
 *    once an ancestor already holds a letter at least as severe, because the
 *    walk that set it also set everything above it. A stricter stop — break
 *    on *any* existing letter — leaves a conflict invisible above the first
 *    folder some earlier modified file had already claimed.
 */

/** A map in a chosen insertion order, because the fold's order is the point. */
const letters = (...pairs: [string, GitStatusLetter][]) => new Map(pairs);

describe('rollUpLetters', () => {
  it('marks every folder between the file and the root', () => {
    const rolled = rollUpLetters(letters(['/w/a/b/one.ts', 'M']), '/w');
    expect(rolled.get('/w/a/b')).toBe('M');
    expect(rolled.get('/w/a')).toBe('M');
  });

  it('never marks the root, which has no row of its own', () => {
    const rolled = rollUpLetters(letters(['/w/a/b/one.ts', 'M']), '/w');
    expect(rolled.has('/w')).toBe(false);
  });

  it('rolls a file at the top level up to nothing', () => {
    const rolled = rollUpLetters(letters(['/w/one.ts', 'M']), '/w');
    expect(rolled.size).toBe(0);
  });

  it('ignores a path outside the root', () => {
    const rolled = rollUpLetters(letters(['/elsewhere/a/one.ts', 'M']), '/w');
    expect(rolled.size).toBe(0);
  });

  it('gives a folder holding both a conflict and an edit the conflict', () => {
    const rolled = rollUpLetters(
      letters(['/w/a/one.ts', 'M'], ['/w/a/two.ts', 'C']),
      '/w',
    );
    expect(rolled.get('/w/a')).toBe('C');
  });

  it('keeps the conflict when the milder letter arrives second', () => {
    const rolled = rollUpLetters(
      letters(['/w/a/two.ts', 'C'], ['/w/a/one.ts', 'M']),
      '/w',
    );
    expect(rolled.get('/w/a')).toBe('C');
  });

  /**
   * The early exit's one failure mode, and the reason it compares severity
   * rather than mere presence: the modified file claims `/w/a` first, and a
   * conflict two folders down must still reach it.
   */
  it('carries a worse letter past a folder a milder file already claimed', () => {
    const rolled = rollUpLetters(
      letters(['/w/a/one.ts', 'M'], ['/w/a/b/two.ts', 'C']),
      '/w',
    );
    expect(rolled.get('/w/a/b')).toBe('C');
    expect(rolled.get('/w/a')).toBe('C');
  });

  /**
   * The full order, pinned end to end. Only the two ends carry an argument —
   * C first because acting on it is harmful, U last because untracked is the
   * letter that floods a folder of build output — but a middle that reshuffles
   * silently would change what a folder says without anyone deciding to.
   */
  it.each([
    ['C', 'D'],
    ['D', 'M'],
    ['M', 'R'],
    ['R', 'A'],
    ['A', 'U'],
  ] as [GitStatusLetter, GitStatusLetter][])('gives %s precedence over %s', (worse, milder) => {
    expect(rollUpLetters(letters(['/w/a/x', milder], ['/w/a/y', worse]), '/w').get('/w/a')).toBe(
      worse,
    );
  });

  it('marks ancestors across Windows separators', () => {
    const rolled = rollUpLetters(letters(['C:\\w\\a\\b\\one.ts', 'M']), 'C:\\w');
    expect(rolled.get('C:\\w\\a\\b')).toBe('M');
    expect(rolled.get('C:\\w\\a')).toBe('M');
  });
});

describe('rollUpPaths', () => {
  it('marks every folder above an unsaved file', () => {
    const rolled = rollUpPaths(['/w/a/b/one.ts'], '/w');
    expect([...rolled].sort()).toEqual(['/w/a', '/w/a/b']);
  });

  it('rolls a top-level file up to nothing, and ignores paths outside the root', () => {
    expect(rollUpPaths(['/w/one.ts', '/elsewhere/a/two.ts'], '/w').size).toBe(0);
  });
});
