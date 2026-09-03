import { parser as jsParser } from '@lezer/javascript';
import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { diffText } from '../src/core/diff';
import { parseGitBlame } from '../src/core/git-blame';
import { fuzzyFilter } from '../src/core/fuzzy';
import { buildSearchRegex, findMatches } from '../src/core/search-match';
import { computeReplacements } from '../src/core/replace';
import { enclosingSymbols } from '../src/core/symbols';
import { objectSpans, unfence } from '../src/services/agent/ollama';
import {
  blamePorcelain,
  editedInTheMiddle,
  modelReply,
  projectPaths,
  sourceFile,
} from './support/corpus';
import { describeGrowth, growth } from './support/growth';

/**
 * The guard the benchmarks cannot be.
 *
 * `npm run bench` produces numbers a human reads. Nothing reads them, and on a
 * shared runner nothing honestly could — the plan says so in as many words.
 * What CI *can* check is the thing wall-clock was only ever a proxy for:
 * whether a function still scales the way its comment claims.
 *
 * That this is worth having is not a hunch. Two functions in `ollama.ts` have
 * already shipped with accidental super-linear behaviour and been fixed for
 * it, and both say so in their own doc comments: `unfence` went cubic on an
 * unclosed fence (8 KB of trailing whitespace took over three minutes), and
 * `objectSpans` went quadratic on a run of braces (256 K braces measured at
 * 75 seconds). Both are inputs a small model produces by *looping*, which is
 * to say: on the day it happens, it happens a lot. Both are guarded below.
 *
 * **The budget is 24x everywhere, and it comes from measurement.** Across 90
 * local runs — fifteen of each guard — the ratios at 8x the input fell between
 * **7.3x and 12.4x**, which is linear plus noise. A quadratic implementation
 * at the same sizes would produce ~64x. So 24x sits at twice the worst thing
 * observed and at a third of the thing being watched for, and the gap on both
 * sides is the margin.
 *
 * Loose on purpose. The failure this catches is an exponent changing, not a
 * constant factor; a budget tight enough to catch a 20% slowdown would be a
 * budget that fails on a busy runner. Rejecting a good change is much worse
 * here than missing a small regression, because `enforce_admins` is on and a
 * flaky required check blocks everyone with no override.
 */
describe('the pure layers still scale', () => {
  /**
   * Catches quadratic work added anywhere on the diff path. Verified: a nested
   * loop over the line array reports **51.2x** and fails this.
   *
   * **It does not catch removing the prefix/suffix trim in `diffLines`, and
   * that is worth knowing before you assume otherwise.** Probed three ways,
   * all of which passed: disabling both trims, and adding a naive O(N*M) LCS
   * table after them. The reason is that Myers is O((N+M)*D), and a one-line
   * edit keeps D at 2 whatever the file size — so the trim is a large constant
   * factor here, not an exponent. `diffText` on a big file with a small edit
   * is structurally linear, which is a property of the design rather than a
   * gap in this test.
   *
   * Measured over 15 local runs at 8x the input: **7.3x-10.3x**.
   */
  it('diffs a small edit in proportion to the file, not the file squared', () => {
    const g = growth(
      (lines) => {
        const before = sourceFile(lines);
        return [before, editedInTheMiddle(before)] as const;
      },
      ([before, after]) => void diffText(before, after),
      2_000,
      16_000,
    );

    expect(g.ratio, describeGrowth('diffText', g, 24)).toBeLessThan(24);
  });

  /**
   * Blame output is the largest single string that crosses the IPC boundary
   * in this codebase (every line of a file, plus a header line each, plus a
   * metadata block per commit) and it is parsed in one pass in the
   * renderer. Nothing on the typing path calls it, so wall-clock is not the
   * worry; the exponent is.
   *
   * Verified: replacing the `commits` map lookup with a full scan of the
   * lines parsed so far (`lines.filter(...)`) reports **63.6x** and fails
   * this, almost exactly the ~64x a quadratic implementation predicts.
   *
   * **It does not catch a `lines.find(...)` scan, and that is worth knowing
   * before assuming otherwise.** `find` short-circuits, and the corpus
   * cycles 20 commits, so every hash is located within the first 20 entries
   * however long the file: linear with a constant of 20. Making the corpus
   * catch that would mean one commit per line, which is not a repository
   * anyone has. The map is still the right implementation; this test simply
   * does not defend that particular route to the wrong one.
   */
  it('parses blame output in proportion to its length', () => {
    const g = growth(
      (lines) => blamePorcelain(lines),
      (raw) => void parseGitBlame(raw),
      2_000,
      16_000,
    );

    expect(g.ratio, describeGrowth('parseGitBlame', g, 24)).toBeLessThan(24);
  });

  /**
   * The palette and quick-open run this on every keystroke, over the whole
   * project index. It is the closest thing to a typing path that can be
   * measured without a view — `fuzzyFilter` is O(items) around a matcher that
   * is itself O(pattern x text), so the risk is a change that makes the
   * per-item cost depend on the list length.
   *
   * Measured over 15 local runs at 8x the input: **8.4x-12.4x** — the widest
   * spread of the six, because the sort at the end is comparison-heavy and
   * its cost depends on how many items matched.
   */
  it('ranks a project index in proportion to its size', () => {
    const g = growth(
      (count) => projectPaths(count),
      (paths) => void fuzzyFilter('wspc', paths, (p) => p),
      2_000,
      16_000,
    );

    expect(g.ratio, describeGrowth('fuzzyFilter', g, 24)).toBeLessThan(24);
  });

  /**
   * Search over one large file. `findMatches` splits into lines and runs the
   * matcher per line, so it is linear; `previewFor` bounds each preview to
   * `PREVIEW_BUDGET`. A regression that built the preview from the whole line
   * before trimming would show here and nowhere else.
   *
   * Measured over 15 local runs at 8x the input: **7.4x-10.8x**.
   */
  it('finds matches in proportion to the text', () => {
    const matcher = buildSearchRegex('return', {
      caseSensitive: false,
      wholeWord: false,
      regexp: false,
    });

    const g = growth(
      (lines) => sourceFile(lines),
      (text) => void findMatches(text, matcher),
      2_000,
      16_000,
    );

    expect(g.ratio, describeGrowth('findMatches', g, 24)).toBeLessThan(24);
  });

  /**
   * Replace builds every edit and then splices them in one pass. `applyEdits`
   * accumulates with `+=`, which V8 makes amortised-linear through cons
   * strings; rewriting it as `out.slice(0, from) + insert + out.slice(to)` per
   * edit reads more obviously correct and is quadratic.
   *
   * Measured over 15 local runs at 8x the input: **8.8x-10.3x**.
   */
  it('replaces in proportion to the text', () => {
    const matcher = buildSearchRegex('return', {
      caseSensitive: false,
      wholeWord: false,
      regexp: false,
    });

    const g = growth(
      (lines) => sourceFile(lines),
      (text) => void computeReplacements(text, matcher, 'yield'),
      2_000,
      16_000,
    );

    expect(g.ratio, describeGrowth('computeReplacements', g, 24)).toBeLessThan(24);
  });

  /**
   * `objectSpans`' own comment: rescanning from each `{` "is quadratic, and a
   * reply that is a long run of `{` is exactly what a looping or truncated 7B
   * model emits: 256K braces measured at 75s". The two-parity single pass that
   * replaced it is linear. This is the test that says so.
   *
   * Measured over 15 local runs at 8x the input: **9.2x-11.2x**.
   */
  it('scans a brace-heavy model reply in one pass', () => {
    const g = growth(
      (braces) => modelReply(braces),
      (reply) => void objectSpans(reply),
      2_000,
      16_000,
    );

    expect(g.ratio, describeGrowth('objectSpans', g, 24)).toBeLessThan(24);
  });

  /**
   * `unfence`'s own comment: the previous regex went cubic on "an opening
   * fence followed by a long run of whitespace and no closing fence — a reply
   * truncated mid-emission, or a model stuck repeating blank lines". 8 KB of
   * it took over three minutes. The replacement is a bounded single pass, so
   * this input is now the *cheapest* one, not the most expensive.
   *
   * Measured over 15 local runs at 8x the input: **8.3x-9.4x**, the tightest
   * of the six. Note what a failure would mean here: the old implementation
   * would not have grown to 24x at 8x the input, it would have timed the
   * suite out. This one is a canary rather than a stopwatch.
   */
  /**
   * A4-001: sticky scroll used to derive its pinned rows from `fileSymbols`,
   * a walk over the *whole* parsed tree, on every keystroke. What the panel
   * actually needs is the chain of declarations enclosing one position, which
   * `enclosingSymbols` gets by walking `.parent` from that position instead —
   * a cost bounded by nesting depth, not document length. `sourceFile` nests
   * two deep (a class, then a method) at any size, so this input's nesting
   * does not grow with `lines` the way the six guards above's inputs do; the
   * claim here is closer to flat than to linear, which is why this test uses
   * its own tighter budget rather than the file's shared 24x.
   *
   * Measured locally: `enclosingSymbols` **0.8x-1.0x** at 16x the input (it
   * does not grow at all, within noise); the walk it replaced, `stickyRows(
   * fileSymbols(...))` over the same fixture and position, measured
   * **17.4x-19.4x** — tracking the document, as A4-001 found by reading the
   * code. A budget of 4 sits well above the flat implementation's noise and
   * well below the old one's near-linear growth, so this fails on the
   * regression this exists to catch and would not have failed on the
   * complexity claim `stickyRows` alone still makes (that one is still
   * guarded structurally: it only ever seees rows that fit in `max`).
   */
  it('pins sticky rows in proportion to nesting depth, not document length', () => {
    const ts = jsParser.configure({ dialect: 'ts' });

    const g = growth(
      (lines) => {
        const source = sourceFile(lines);
        const doc = Text.of(source.split('\n'));
        const tree = ts.parse(source);
        // Three quarters of the way in, so both sizes measure a position deep
        // inside the generated classes rather than the empty tail `sourceFile`
        // pads with once it has enough lines.
        const pos = Math.floor(doc.length * 0.75);
        const topLine = doc.lineAt(pos).number;
        return { doc, tree, pos, topLine } as const;
      },
      ({ doc, tree, pos, topLine }) => void enclosingSymbols(tree, doc, pos, topLine, 5),
      2_000,
      32_000,
    );

    expect(g.ratio, describeGrowth('enclosingSymbols', g, 4)).toBeLessThan(4);
  });

  it('survives an unclosed fence with a long whitespace tail', () => {
    const g = growth(
      (size) => '```json\n' + ' '.repeat(size),
      (text) => void unfence(text),
      64_000,
      512_000,
    );

    expect(g.ratio, describeGrowth('unfence', g, 24)).toBeLessThan(24);
  });
});
