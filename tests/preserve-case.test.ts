import { describe, expect, it } from 'vitest';
import { computeReplacements, preserveCase } from '../src/core/replace';

describe('shaping a replacement to the case it is replacing', () => {
  /**
   * The failure this prevents: the whole feature. A case-insensitive search
   * finds three spellings and replaces them with one, and the user then fixes
   * the capitals by hand — which is the work the search was supposed to save.
   */
  it('follows the three patterns it recognises', () => {
    expect(preserveCase('scheduler', 'dispatcher')).toBe('dispatcher');
    expect(preserveCase('SCHEDULER', 'dispatcher')).toBe('DISPATCHER');
    expect(preserveCase('Scheduler', 'dispatcher')).toBe('Dispatcher');
  });

  /**
   * The failure this prevents: lower-casing the remainder of the replacement,
   * which turns `dispatcherService` into `Dispatcherservice`. Capitalized
   * means "make the first character upper", not "make everything else lower".
   */
  it('leaves the rest of the replacement alone when capitalising', () => {
    expect(preserveCase('Scheduler', 'dispatcherService')).toBe('DispatcherService');
  });

  /**
   * The failure this prevents: guessing at a shape that is not one of the
   * three. Irregular casing is deliberate often enough that rewriting it is
   * worse than leaving it, and there is no rule that would be right.
   */
  it('leaves an irregularly cased match verbatim', () => {
    expect(preserveCase('sChEdUlEr', 'dispatcher')).toBe('dispatcher');
    expect(preserveCase('scheduleR', 'dispatcher')).toBe('dispatcher');
  });

  /**
   * The failure this prevents, and it is the one that reaches real files: a
   * string with no letters equals both its upper- and lower-cased form. A
   * rule written as `matched === matched.toUpperCase()` alone upper-cases
   * every replacement in a numeric or punctuation search.
   */
  it('leaves a match with no letters verbatim', () => {
    expect(preserveCase('123', 'dispatcher')).toBe('dispatcher');
    expect(preserveCase('---', 'Dispatcher')).toBe('Dispatcher');
    expect(preserveCase('', 'dispatcher')).toBe('dispatcher');
  });

  /**
   * The failure this prevents: an ordering bug the spec did not settle. `S`
   * satisfies "all upper" *and* "first upper, rest lower" — its rest is
   * empty, which is trivially lower. Capitalized is checked first, so one
   * capital letter reads as a capitalised word rather than a shout. `SS` has
   * a non-lower remainder and so is unambiguous.
   */
  it('treats a single capital as capitalised, not as all-upper', () => {
    expect(preserveCase('S', 'dispatcher')).toBe('Dispatcher');
    expect(preserveCase('SS', 'dispatcher')).toBe('DISPATCHER');
    expect(preserveCase('s', 'dispatcher')).toBe('dispatcher');
  });

  /** An empty replacement has no case to shape, and must not throw. */
  it('handles an empty replacement', () => {
    expect(preserveCase('SCHEDULER', '')).toBe('');
  });

  /**
   * The failure this prevents: an ASCII-only "has letters" guard, such as
   * `/[a-zA-Z]/.test(matched)`. A script with no ASCII letters at all —
   * Cyrillic, here — has no character that regex would count as cased, so
   * that guard would treat every match as letterless and return the
   * replacement verbatim in all three cases. Accented Latin would not catch
   * this: `École` still contains plain ASCII letters (`c`, `o`, `l`, `e`), so
   * an ASCII regex passes it through by accident. Comparing
   * `toUpperCase()`/`toLowerCase()` gets this right for any script, because
   * those methods know casing beyond ASCII.
   */
  it('shapes a match written in a script with no ASCII letters', () => {
    expect(preserveCase('график', 'dispatcher')).toBe('dispatcher');
    expect(preserveCase('График', 'dispatcher')).toBe('Dispatcher');
    expect(preserveCase('ГРАФИК', 'dispatcher')).toBe('DISPATCHER');
  });

  /**
   * The failure this prevents: checking Capitalized before all-lower. An
   * uncased leading character such as `_` trivially satisfies
   * `first === first.toUpperCase()` (there is no case to change), so
   * `_scheduler`'s remainder (`scheduler`) being lower-case would make the
   * whole match look Capitalized if that check ran first — upper-casing the
   * replacement's first letter for a match that is actually all lower-case.
   * All-lower must be checked first so a leading uncased character does not
   * get misread as a capital.
   */
  it('prefers all-lower over Capitalized when the leading character is uncased', () => {
    expect(preserveCase('_scheduler', 'dispatcher')).toBe('dispatcher');
    expect(preserveCase('_SCHEDULER', 'dispatcher')).toBe('DISPATCHER');
  });

  /**
   * This is spec-conformant, not a gap: Capitalized requires the *entire*
   * remainder to be lower-case, and `_Scheduler`'s remainder is `Scheduler`,
   * which is not `scheduler`. So this falls through every pattern to
   * verbatim. It is the rule's least intuitive output — worth pinning so a
   * future reader does not "fix" it into the Capitalized branch and take
   * `_scheduler` (the previous test) down with it.
   */
  it('leaves an underscore-prefixed capitalised-looking match verbatim', () => {
    expect(preserveCase('_Scheduler', 'dispatcher')).toBe('dispatcher');
  });
});

describe('preserve case through a replace run', () => {
  const text = 'scheduler\nScheduler\nSCHEDULER\nsChEdUlEr\n';
  const matcher = () => /scheduler/gi;

  /**
   * The failure this prevents: applying one shape to the whole run instead of
   * one shape per match. The point of the feature is that a single
   * replacement string comes out differently on each line.
   */
  it('shapes each match independently', () => {
    const result = computeReplacements(text, matcher(), 'dispatcher', { preserveCase: true });
    expect(result.text).toBe('dispatcher\nDispatcher\nDISPATCHER\ndispatcher\n');
    expect(result.count).toBe(4);
  });

  /**
   * The failure this prevents: the option changing behaviour when it is off.
   * `tests/replace.test.ts`'s 43 tests all run without it, so this pins that
   * the default path is untouched by the feature's existence.
   */
  it('changes nothing when the option is off', () => {
    const result = computeReplacements(text, matcher(), 'dispatcher');
    expect(result.text).toBe('dispatcher\ndispatcher\ndispatcher\ndispatcher\n');
  });

  /** A mixed-case match is verbatim even when the replacement expands. */
  it('leaves an expanded replacement alone for a mixed-case match', () => {
    const result = computeReplacements('SCHEDULER_service\n', /(\w+)_service/g, '$1_client', {
      expand: true,
      preserveCase: true,
    });
    expect(result.text).toBe('SCHEDULER_client\n');
  });

  /**
   * The failure this prevents: casing the *template* instead of the expanded
   * string — spec §7's order.
   *
   * Worth knowing why this test uses a named group, because the obvious
   * version does not work. For `$1` and `$&` the two orders agree: those
   * tokens survive `toUpperCase()` unchanged, and an ALL-UPPER match has
   * ALL-UPPER captures, so upper-casing before or after expansion lands in
   * the same place. A test built on `$1` would pass against both orders and
   * prove nothing.
   *
   * A named group is where they diverge. Casing the template rewrites
   * `$<word>` to `$<WORD>`, which names a group that does not exist, and
   * `expandReplacement` resolves an unknown name to the empty string — so the
   * captured text vanishes rather than being cased. That is silent data loss
   * in the part of the codebase that can destroy work.
   */
  it('applies the rule to the expanded replacement, not the template', () => {
    const result = computeReplacements('SCHEDULER\n', /(?<word>SCHED)ULER/g, '$<word>_x', {
      expand: true,
      preserveCase: true,
    });
    expect(result.text).toBe('SCHED_X\n');
  });

  /**
   * The failure this prevents: `skip` and `preserveCase` interfering with
   * each other at the call sites Tasks 2-3 build. They are independent by
   * construction — `skip` decides whether an edit is emitted at all,
   * `preserveCase` only shapes edits that are — but nothing pinned that
   * before. A skipped match must stay untouched in the source text, and a
   * kept match must still get its case shaped.
   */
  it('applies skip and preserveCase independently', () => {
    const result = computeReplacements('scheduler\nScheduler\n', /scheduler/gi, 'dispatcher', {
      preserveCase: true,
      skip: new Set([0]),
    });
    expect(result.text).toBe('scheduler\nDispatcher\n');
    expect(result.count).toBe(1);
  });
});
