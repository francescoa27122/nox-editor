import type { Hunk } from './diff';

/**
 * Git gutter marks: hunks answered in before-space, marks drawn in
 * current-space.
 *
 * `diffText(base, current)` speaks in the *before* text — `Hunk.fromLine` is a
 * 0-based index into the base — but the gutter draws beside the *current*
 * document. The translation is one running number: every hunk shifts the text
 * after it by `added − removed` lines, so a hunk's current-space start is its
 * `fromLine` plus the cumulative offset of the hunks before it. Lines here are
 * 1-based because they land directly on editor lines, and that is how the
 * editor speaks.
 *
 * Pure; the service computes hunks and the extension paints. See
 * `docs/superpowers/specs/2026-08-19-git-gutter-design.md` §5.
 */

export type GutterLineKind = 'added' | 'modified' | 'removed';

/** One mark: a 1-based line in the *current* text, and what happened to it. */
export interface GutterLine {
  line: number;
  kind: GutterLineKind;
}

/**
 * The marks for a hunk list, sorted by line, at most one mark per line.
 *
 * A hunk with both sides is `modified`, insert-only is `added` — either way
 * the mark covers the hunk's `added.length` current lines. A pure deletion has
 * no current lines to cover, so it gets one `removed` mark on the line now
 * sitting where the deleted lines were: the first context line after the
 * deletion. That line always exists in coalesced `diffText` output — a
 * deletion at EOF either keeps the trailing empty line as context (the mark
 * lands on the last document line) or takes the final newline with it and
 * becomes a modified hunk — so no upper clamp is possible or needed; the
 * lower clamp to line 1 only guards hunks that did not come from `diffText`.
 *
 * When a `removed` mark and another kind claim the same line, the other kind
 * wins regardless of which arrived first: the changed line is the more
 * specific fact, and the removal still reads because its mark is drawn as a
 * point, not a bar. Two non-removed claims on one line cannot happen — hunks
 * are coalesced, so changed current-line ranges never overlap — which is why
 * no rule for that case exists in code.
 */
export function gutterLines(hunks: readonly Hunk[]): GutterLine[] {
  const byLine = new Map<number, GutterLineKind>();
  let offset = 0;

  for (const hunk of hunks) {
    const start = hunk.fromLine + offset;

    if (hunk.added.length > 0) {
      const kind: GutterLineKind = hunk.removed.length > 0 ? 'modified' : 'added';
      for (let i = 0; i < hunk.added.length; i++) byLine.set(start + 1 + i, kind);
    } else if (hunk.removed.length > 0) {
      const line = Math.max(1, start + 1);
      if (!byLine.has(line)) byLine.set(line, 'removed');
    }

    offset += hunk.added.length - hunk.removed.length;
  }

  return [...byLine]
    .map(([line, kind]) => ({ line, kind }))
    .sort((a, b) => a.line - b.line);
}

/**
 * Make a git blob comparable to the editor's document.
 *
 * Mirrors what `decode` in `src/services/workspace.ts` does to a file on the
 * way in: one leading BOM off, every CRLF to LF. The document is always
 * canonical LF with no BOM, and diffing an unnormalized CRLF base against it
 * would mark every line modified — the one failure mode that makes the gutter
 * worse than absent. A lone CR is content, not a terminator, and passes
 * through untouched.
 */
export function normalizeGitBase(text: string): string {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  return body.replace(/\r\n/g, '\n');
}
