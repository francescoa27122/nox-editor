/**
 * Fuzzy subsequence matching for the command palette and quick-open.
 *
 * Optimal O(pattern × text) dynamic program rather than a greedy scan, because
 * greedy matching produces visibly wrong rankings on paths (`src/core/path.ts`
 * typed as "path" should not match the `p`, `a`, `t`, `h` scattered across the
 * directory names). Inputs here are short — a few hundred characters at most —
 * so the DP is comfortably below a frame even across thousands of candidates.
 */

const SCORE_MATCH = 16;
const BONUS_BOUNDARY = 8; // first char after a separator: / \ _ - . space
const BONUS_CAMEL = 7; // lower→upper transition
const BONUS_FIRST = 12; // very first character of the candidate
const BONUS_CONSECUTIVE = 8; // adjacent to the previous matched character
const BONUS_CASE = 2; // exact-case match, breaks ties toward intent
const PENALTY_GAP_START = -3;
const PENALTY_GAP_EXTEND = -1;
const PENALTY_LEADING = -0.5; // per char skipped before the first match
const MAX_LEADING_PENALTY = -12;

const NEG = Number.NEGATIVE_INFINITY;

/**
 * Separator lookup by character code rather than `Set<string>`.
 *
 * Every separator is ASCII, so a 128-entry table covers all of them and any
 * code at or above 128 is not one. The `Set` this replaced was correct and
 * cost a one-character string allocation per character of every candidate, on
 * a path that runs over the whole project index between two frames.
 */
const SEPARATOR_CODES = (() => {
  const table = new Uint8Array(128);
  for (const ch of ['/', '\\', '_', '-', '.', ' ', ':', '@']) table[ch.charCodeAt(0)] = 1;
  return table;
})();

const isSeparatorCode = (code: number) => code < 128 && SEPARATOR_CODES[code] === 1;
const isUpperCode = (code: number) => code >= 65 && code <= 90;
const isLowerCode = (code: number) => code >= 97 && code <= 122;

export interface FuzzyMatch {
  score: number;
  /** Indices into the candidate string that should be highlighted. */
  positions: number[];
}

/**
 * Scratch buffers, reused across calls rather than allocated per candidate.
 *
 * These three were `new Float64Array(n)` inside `fuzzyMatch`, which is fine
 * for one call and is three allocations per *candidate* when quick-open scores
 * several thousand of them between one keystroke and the next frame.
 *
 * Safe because `fuzzyMatch` is synchronous, non-recursive and single-threaded:
 * nothing can be part-way through a scan when another begins, and nothing
 * escapes — the returned `positions` is a fresh array. They only ever grow, so
 * one long candidate does not make the next one reallocate.
 */
let scratchBonuses = new Float64Array(0);
let scratchPrev = new Float64Array(0);
let scratchCur = new Float64Array(0);

function ensureScratch(n: number): void {
  if (scratchBonuses.length >= n) return;
  scratchBonuses = new Float64Array(n);
  scratchPrev = new Float64Array(n);
  scratchCur = new Float64Array(n);
}

/**
 * Per-character positional bonus, independent of the pattern.
 *
 * Writes into `scratchBonuses` and returns it. Reads through `charCodeAt`
 * rather than `text[i]`, which allocates a one-character string every time.
 */
function characterBonuses(text: string, from: number, n: number): Float64Array {
  const bonuses = scratchBonuses;
  let previous = 0;
  for (let i = from; i < n; i++) {
    const code = text.charCodeAt(i);
    if (i === from) {
      // The candidate's own first character, which for a name-half match is
      // the one after the last separator rather than index 0.
      bonuses[i] = BONUS_FIRST;
    } else if (isSeparatorCode(previous)) {
      bonuses[i] = BONUS_BOUNDARY;
    } else if (isLowerCode(previous) && isUpperCode(code)) {
      bonuses[i] = BONUS_CAMEL;
    } else {
      bonuses[i] = 0;
    }
    previous = code;
  }
  return bonuses;
}

/**
 * A pattern prepared once for use against many candidates.
 *
 * `fuzzyMatch` lowercased the pattern and sliced a one-character string out of
 * it on every call — the same work, once per item in the index. `fuzzyFilter`
 * and `fuzzyMatchPath` build this once and pass it down.
 */
interface Prepared {
  raw: string;
  lower: string;
  /** `lower` split into single characters, for the `indexOf` rejection scan. */
  chars: string[];
  lowerCodes: Uint16Array;
  /** Original case, for the exact-case tiebreak bonus. */
  rawCodes: Uint16Array;
}

/**
 * The last prepared pattern, memoised.
 *
 * One entry is the right size because of how these are actually called: a
 * filter pass runs one pattern against every candidate, so the very next call
 * is nearly always the same string. It is what lets `fuzzyMatchPath` and the
 * eight `fuzzyMatch` call sites in `CommandPalette.svelte` share the work
 * without a prepared-pattern parameter threaded through all of them.
 *
 * Keyed on the raw pattern, so case is part of the key — `rawCodes` carries
 * the original case for the exact-case bonus, and two patterns differing only
 * in case do not score the same.
 */
let lastPrepared: Prepared | null = null;

function prepare(pattern: string): Prepared {
  if (lastPrepared !== null && lastPrepared.raw === pattern) return lastPrepared;
  const built = build(pattern);
  lastPrepared = built;
  return built;
}

function build(pattern: string): Prepared {
  const lower = pattern.toLowerCase();
  const chars: string[] = [];
  const lowerCodes = new Uint16Array(lower.length);
  const rawCodes = new Uint16Array(pattern.length);
  for (let i = 0; i < lower.length; i++) {
    chars.push(lower[i]!);
    lowerCodes[i] = lower.charCodeAt(i);
    rawCodes[i] = pattern.charCodeAt(i);
  }
  return { raw: pattern, lower, chars, lowerCodes, rawCodes };
}

/**
 * Score `pattern` against `text`. Returns null when `pattern` is not a
 * subsequence of `text`. An empty pattern matches everything with score 0.
 */
export function fuzzyMatch(pattern: string, text: string): FuzzyMatch | null {
  if (pattern.length === 0) return { score: 0, positions: [] };
  return matchPrepared(prepare(pattern), text);
}

/**
 * `fuzzyMatch` with the pattern already prepared.
 *
 * Identical scoring to the version this replaced, and `tests/fuzzy.test.ts`
 * plus `tests/palette-ranking.test.ts` are what say so — every number, bonus
 * and penalty below is unchanged. What differs is mechanical: character codes
 * instead of one-character strings, and the scratch buffers instead of three
 * allocations per candidate.
 */
function matchPrepared(pattern: Prepared, text: string, from = 0): FuzzyMatch | null {
  const m = pattern.lower.length;
  const n = text.length;
  if (m === 0) return { score: 0, positions: [] };
  if (m > n - from) return null;

  const lowerText = text.toLowerCase();

  // Cheap rejection pass before touching a buffer. This is the common case on
  // a large index and the reason the scan is affordable at all.
  let cursor = from;
  for (let i = 0; i < m; i++) {
    cursor = lowerText.indexOf(pattern.chars[i]!, cursor);
    if (cursor === -1) return null;
    cursor++;
  }

  ensureScratch(n);
  const bonuses = characterBonuses(text, from, n);

  let prev = scratchPrev;
  let cur = scratchCur;
  prev.fill(NEG, from, n);

  for (let i = 0; i < m; i++) {
    const pc = pattern.lowerCodes[i]!;
    const rawPc = pattern.rawCodes[i]!;
    // Best score reachable from row i-1 with a gap of >= 1 before column j.
    let gapped = NEG;
    cur.fill(NEG, from, n);

    for (let j = from; j < n; j++) {
      if (i > 0 && j >= from + 2) {
        const entering = prev[j - 2]!;
        gapped = Math.max(
          gapped === NEG ? NEG : gapped + PENALTY_GAP_EXTEND,
          entering === NEG ? NEG : entering + PENALTY_GAP_START,
        );
      }

      if (lowerText.charCodeAt(j) !== pc) continue;

      const exactCase = text.charCodeAt(j) === rawPc;
      const base = SCORE_MATCH + bonuses[j]! + (exactCase ? BONUS_CASE : 0);

      if (i === 0) {
        cur[j] = base + Math.max(MAX_LEADING_PENALTY, (j - from) * PENALTY_LEADING);
      } else {
        const consecutive =
          j > from && prev[j - 1] !== NEG ? prev[j - 1]! + BONUS_CONSECUTIVE : NEG;
        const best = Math.max(consecutive, gapped);
        if (best !== NEG) cur[j] = base + best;
      }
    }

    const swap = prev;
    prev = cur;
    cur = swap;
  }

  let score = NEG;
  let end = -1;
  for (let j = from; j < n; j++) {
    if (prev[j]! > score) {
      score = prev[j]!;
      end = j;
    }
  }
  if (end === -1 || score === NEG) return null;

  return { score, positions: backtrack(pattern.lowerCodes, lowerText, end, from) };
}

/**
 * Recover highlight positions by matching the pattern backwards from the
 * winning end index, taking the latest valid index for each character. This
 * right-aligns the run, which is what the DP optimises for anyway, and avoids
 * keeping the full O(m×n) choice matrix around.
 */
function backtrack(
  lowerCodes: Uint16Array,
  lowerText: string,
  end: number,
  from: number,
): number[] {
  const positions: number[] = [];
  let j = end;
  for (let i = lowerCodes.length - 1; i >= 0; i--) {
    const code = lowerCodes[i]!;
    while (j >= from && lowerText.charCodeAt(j) !== code) j--;
    if (j < from) break;
    positions.push(j);
    j--;
  }
  return positions.reverse();
}

export interface Scored<T> {
  item: T;
  score: number;
  positions: number[];
}

/** Filter + rank a list. `key` extracts the string to match against. */
export function fuzzyFilter<T>(
  pattern: string,
  items: readonly T[],
  key: (item: T) => string,
  limit = Infinity,
): Scored<T>[] {
  const compiled = prepare(pattern);
  const out: Scored<T>[] = [];
  for (const item of items) {
    const match = matchPrepared(compiled, key(item));
    if (match) out.push({ item, score: match.score, positions: match.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return limit === Infinity ? out : out.slice(0, limit);
}

/**
 * Path-aware match: a hit in the filename is worth far more than one in a
 * directory, which is what makes quick-open feel like it reads your mind.
 */
export function fuzzyMatchPath(pattern: string, path: string, nameStart: number): FuzzyMatch | null {
  if (pattern.length === 0) return { score: 0, positions: [] };
  const compiled = prepare(pattern);
  const full = matchPrepared(compiled, path);
  // Matched from an offset rather than against `path.slice(nameStart)`. The
  // slice was an allocation per candidate — measured at 3.0 ms per keystroke
  // across a 16,000-path index — and the positions come back absolute, so the
  // shift that used to follow is gone too.
  const name = matchPrepared(compiled, path, nameStart);
  if (!full && !name) return null;
  if (!name) return full;

  const promoted: FuzzyMatch = {
    score: name.score * 1.6,
    positions: name.positions,
  };
  if (!full) return promoted;
  return promoted.score >= full.score ? promoted : full;
}

/** Split a string into highlighted / plain runs for rendering. */
export function segmentMatch(
  text: string,
  positions: readonly number[],
): { text: string; hit: boolean }[] {
  if (positions.length === 0) return text ? [{ text, hit: false }] : [];
  const hits = new Set(positions);
  const segments: { text: string; hit: boolean }[] = [];
  let start = 0;
  let currentHit = hits.has(0);

  for (let i = 1; i <= text.length; i++) {
    const hit = i < text.length && hits.has(i);
    if (i === text.length || hit !== currentHit) {
      segments.push({ text: text.slice(start, i), hit: currentHit });
      start = i;
      currentHit = hit;
    }
  }
  return segments;
}
