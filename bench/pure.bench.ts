import { bench, describe } from 'vitest';
import { diffText } from '../src/core/diff';
import { fuzzyFilter, fuzzyMatchPath } from '../src/core/fuzzy';
import { placeMenu } from '../src/core/menu-placement';
import { computeReplacements } from '../src/core/replace';
import { buildSearchRegex, findMatches } from '../src/core/search-match';
import { objectSpans, unfence } from '../src/services/agent/ollama';
import {
  editedInTheMiddle,
  modelReply,
  projectPaths,
  sourceFile,
} from '../tests/support/corpus';

/**
 * Numbers for a human. Run with `npm run bench`.
 *
 * **Nothing fails because of this file, and nothing should.** Production
 * readiness §4 is explicit: *"Do not gate CI on wall-clock. Shared runners are
 * too noisy for that to mean anything."* The gate lives in
 * `tests/complexity.test.ts`, which measures a ratio and therefore survives a
 * runner being three times slower than the machine a number here was taken on.
 *
 * What this is for is the question a ratio cannot answer: **is it fast enough
 * at all?** A function can be perfectly linear and still be far too slow, and
 * the only way to know is to look at a duration next to a budget you care
 * about. The budget worth caring about here is a **16 ms frame** — the figure
 * `symbols.ts` already measures itself against.
 *
 * Sizes are chosen to be the largest thing plausibly met, not an average: a
 * 16,000-line file is a big real source file, and 16,000 paths is a big real
 * project index. If the worst case fits in a frame, the common case is not
 * worth arguing about.
 */

const matcher = () =>
  buildSearchRegex('return', { caseSensitive: false, wholeWord: false, regexp: false });

describe('editing a large file', () => {
  const before = sourceFile(16_000);
  const after = editedInTheMiddle(before);
  const text = sourceFile(16_000);
  const search = matcher();

  // The git gutter path. Runs on save and on external change, not per
  // keystroke — but on the largest file the editor will open.
  bench('diffText, 16k lines, one line changed', () => {
    diffText(before, after);
  });

  bench('findMatches, 16k lines', () => {
    findMatches(text, search);
  });

  bench('computeReplacements, 16k lines', () => {
    computeReplacements(text, search, 'yield');
  });
});

describe('typing into the palette', () => {
  const paths = projectPaths(16_000);
  const commands = projectPaths(200).map((p) => `Command: ${p}`);

  /**
   * Quick-open, per keystroke, against a 16,000-file index. This is the
   * closest thing to a typing path that runs without a view, and the one
   * number in this file most worth watching: it happens between a key going
   * down and a frame being drawn.
   */
  bench('fuzzyFilter, 16k paths', () => {
    fuzzyFilter('wspc', paths, (p) => p);
  });

  // The command palette's own list is ~173 entries. Included to show the gap:
  // the two are the same function against inputs two orders of magnitude apart.
  bench('fuzzyFilter, 200 commands', () => {
    fuzzyFilter('opn', commands, (c) => c);
  });

  bench('fuzzyMatchPath, one deep path', () => {
    fuzzyMatchPath('wspc', 'src/services/workspace/session/buffer.ts', 34);
  });
});

describe('reading a model reply', () => {
  const braces = modelReply(16_000);
  const truncated = '```json\n' + ' '.repeat(512_000);

  // Both of these have shipped super-linear before; see the notes on them in
  // ollama.ts and the guards in tests/complexity.test.ts.
  bench('objectSpans, 16k braces in prose', () => {
    objectSpans(braces);
  });

  bench('unfence, 512kb unclosed fence', () => {
    unfence(truncated);
  });
});

describe('placing a menu', () => {
  /**
   * Named by §4's fix list, and included so the number is on record rather
   * than assumed — but it is a dozen comparisons and no allocation, and the
   * result below is the harness measuring itself. Nothing here will ever be
   * the reason a frame is late; the row exists so that the next person to
   * wonder does not have to find out again.
   */
  bench('placeMenu', () => {
    placeMenu({
      anchorX: 900,
      anchorY: 600,
      width: 280,
      naturalHeight: 700,
      viewportWidth: 1280,
      viewportHeight: 720,
    });
  });
});
