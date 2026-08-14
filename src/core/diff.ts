/**
 * Line diff.
 *
 * Myers' O(ND) algorithm, which is what every diff you have ever read was
 * produced by. A dependency would have been easier, but `core/` earns its
 * testability by importing nothing, and a diff is a pure function over two
 * arrays — precisely the thing that belongs here.
 *
 * Line granularity, because that is how hunks are reviewed. Word-level
 * refinement can layer on top later without changing any of this.
 */

/** A run of changed lines: what was there, and what replaces it. */
export interface Hunk {
  /** 0-based index into the *before* lines where the hunk starts. */
  fromLine: number;
  /** Lines removed. Empty for a pure insertion. */
  removed: string[];
  /** Lines inserted. Empty for a pure deletion. */
  added: string[];
}

/**
 * Split text into lines that still carry their terminators.
 *
 * `lines.join('')` reconstructs the text exactly, and the element count
 * matches CodeMirror's `doc.lines`, so a line index here is a document line
 * number minus one. Both of those matter: the first makes reassembling a
 * narrowed change set trivial, and the second means no offset arithmetic has
 * to reason about where newlines went.
 */
export function splitLines(text: string): string[] {
  const parts = text.split('\n');
  return parts.map((part, index) => (index < parts.length - 1 ? `${part}\n` : part));
}

/** Diff two texts by line. */
export function diffText(before: string, after: string): Hunk[] {
  return diffLines(splitLines(before), splitLines(after));
}

export function diffLines(before: readonly string[], after: readonly string[]): Hunk[] {
  // Trim what matches at both ends first. Most edits touch a small part of a
  // large file, and Myers costs O((N+M)·D) — shrinking D is the whole game.
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before[start] === after[start]) start++;

  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  if (a.length === 0 && b.length === 0) return [];

  // With nothing common in the middle, the answer is one replacement and
  // Myers would only rediscover that.
  if (a.length === 0 || b.length === 0) {
    return [{ fromLine: start, removed: [...a], added: [...b] }];
  }

  return toHunks(myers(a, b), a, b, start);
}

type Op = 'equal' | 'delete' | 'insert';

function myers(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    // The frontier as it stood *before* this round, which is what walking
    // back from the end needs to find each step's predecessor.
    trace.push(v.slice());

    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }

      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;

      if (x >= n && y >= m) return backtrack(trace, d, offset, n, m);
    }
  }

  /* Unreachable: d = n + m always reaches the end. */
  return [];
}

function backtrack(trace: Int32Array[], d: number, offset: number, n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;

  for (let depth = d; depth > 0; depth--) {
    const v = trace[depth]!;
    const k = x - y;

    const previousK =
      k === -depth || (k !== depth && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const previousX = v[offset + previousK]!;
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      ops.push('equal');
      x--;
      y--;
    }

    if (x === previousX) {
      ops.push('insert');
      y--;
    } else {
      ops.push('delete');
      x--;
    }
  }

  // Whatever ran along the diagonal before the first edit.
  while (x > 0 && y > 0) {
    ops.push('equal');
    x--;
    y--;
  }

  return ops.reverse();
}

function toHunks(ops: readonly Op[], a: readonly string[], b: readonly string[], offset: number): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let ai = 0;
  let bi = 0;

  for (const op of ops) {
    if (op === 'equal') {
      // An unchanged line ends the run; adjacent changes stay one hunk.
      current = null;
      ai++;
      bi++;
      continue;
    }

    current ??= (() => {
      const hunk: Hunk = { fromLine: offset + ai, removed: [], added: [] };
      hunks.push(hunk);
      return hunk;
    })();

    if (op === 'delete') current.removed.push(a[ai++]!);
    else current.added.push(b[bi++]!);
  }

  return hunks;
}
