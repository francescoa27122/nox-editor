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
const SEPARATORS = new Set(['/', '\\', '_', '-', '.', ' ', ':', '@']);

export interface FuzzyMatch {
  score: number;
  /** Indices into the candidate string that should be highlighted. */
  positions: number[];
}

const isUpper = (c: string) => c >= 'A' && c <= 'Z';
const isLower = (c: string) => c >= 'a' && c <= 'z';

/** Per-character positional bonus, independent of the pattern. */
function characterBonuses(text: string): Float64Array {
  const bonuses = new Float64Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (i === 0) {
      bonuses[i] = BONUS_FIRST;
      continue;
    }
    const prev = text[i - 1]!;
    if (SEPARATORS.has(prev)) bonuses[i] = BONUS_BOUNDARY;
    else if (isLower(prev) && isUpper(ch)) bonuses[i] = BONUS_CAMEL;
    else bonuses[i] = 0;
  }
  return bonuses;
}

/**
 * Score `pattern` against `text`. Returns null when `pattern` is not a
 * subsequence of `text`. An empty pattern matches everything with score 0.
 */
export function fuzzyMatch(pattern: string, text: string): FuzzyMatch | null {
  if (pattern.length === 0) return { score: 0, positions: [] };
  if (pattern.length > text.length) return null;

  const lowerPattern = pattern.toLowerCase();
  const lowerText = text.toLowerCase();

  // Cheap rejection pass before allocating anything.
  let cursor = 0;
  for (let i = 0; i < lowerPattern.length; i++) {
    cursor = lowerText.indexOf(lowerPattern[i]!, cursor);
    if (cursor === -1) return null;
    cursor++;
  }

  const n = text.length;
  const m = pattern.length;
  const bonuses = characterBonuses(text);

  let prev = new Float64Array(n).fill(NEG);
  let cur = new Float64Array(n).fill(NEG);

  for (let i = 0; i < m; i++) {
    const pc = lowerPattern[i]!;
    // Best score reachable from row i-1 with a gap of >= 1 before column j.
    let gapped = NEG;
    cur.fill(NEG);

    for (let j = 0; j < n; j++) {
      if (i > 0 && j >= 2) {
        const entering = prev[j - 2]!;
        gapped = Math.max(
          gapped === NEG ? NEG : gapped + PENALTY_GAP_EXTEND,
          entering === NEG ? NEG : entering + PENALTY_GAP_START,
        );
      }

      if (lowerText[j] !== pc) continue;

      const exactCase = text[j] === pattern[i];
      const base = SCORE_MATCH + bonuses[j]! + (exactCase ? BONUS_CASE : 0);

      if (i === 0) {
        cur[j] = base + Math.max(MAX_LEADING_PENALTY, j * PENALTY_LEADING);
      } else {
        const consecutive = j > 0 && prev[j - 1] !== NEG ? prev[j - 1]! + BONUS_CONSECUTIVE : NEG;
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
  for (let j = 0; j < n; j++) {
    if (prev[j]! > score) {
      score = prev[j]!;
      end = j;
    }
  }
  if (end === -1 || score === NEG) return null;

  return { score, positions: backtrack(lowerPattern, lowerText, end) };
}

/**
 * Recover highlight positions by matching the pattern backwards from the
 * winning end index, taking the latest valid index for each character. This
 * right-aligns the run, which is what the DP optimises for anyway, and avoids
 * keeping the full O(m×n) choice matrix around.
 */
function backtrack(lowerPattern: string, lowerText: string, end: number): number[] {
  const positions: number[] = [];
  let j = end;
  for (let i = lowerPattern.length - 1; i >= 0; i--) {
    while (j >= 0 && lowerText[j] !== lowerPattern[i]) j--;
    if (j < 0) break;
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
  const out: Scored<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(pattern, key(item));
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
  const full = fuzzyMatch(pattern, path);
  const name = fuzzyMatch(pattern, path.slice(nameStart));
  if (!full && !name) return null;
  if (!name) return full;

  const promoted: FuzzyMatch = {
    score: name.score * 1.6,
    positions: name.positions.map((p) => p + nameStart),
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
