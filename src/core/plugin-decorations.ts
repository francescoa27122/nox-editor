/**
 * What a plugin asked to have drawn in the editor, made safe to draw.
 *
 * Pure, and the strictest normaliser in the codebase after the manifest
 * parser — for the same reason and one more. The reason it shares: these
 * numbers come from code someone else wrote. The one it does not: **CodeMirror
 * throws on a range outside the document**, and it throws from inside the view
 * update, which does not degrade into a missing decoration. It takes the
 * editor down.
 *
 * `editor/lsp.ts` learned this from language servers and clamps their
 * diagnostic ranges for the same reason. A plugin is a third party with less
 * excuse and no specification, so this clamps harder: out of order, out of
 * bounds, empty, unsorted, too many — all handled here, where they can be
 * tested against nothing but numbers.
 */

/**
 * What a decoration looks like.
 *
 * A closed vocabulary, not a CSS class. A plugin choosing its own styling
 * would be a plugin choosing how Nox looks, and the whole arrangement is that
 * **the plugin names what it means and Nox decides how that is drawn** — the
 * same split that makes panels rows rather than markup.
 */
export type DecorationKind = 'error' | 'warning' | 'info' | 'highlight';

const KINDS = new Set<string>(['error', 'warning', 'info', 'highlight']);

export interface PluginDecoration {
  from: number;
  to: number;
  kind: DecorationKind;
  /** Shown on hover. Optional, and capped. */
  message?: string;
}

/**
 * How many decorations one plugin may have in one buffer.
 *
 * Generous — a linter on a large file legitimately has hundreds — and finite,
 * because the set is mapped forward through every edit. That mapping is the
 * one cost these put on the typing path, and it is proportional to how many
 * there are.
 */
export const MAX_DECORATIONS = 2_000;

/** How long a hover message may be. */
export const MAX_MESSAGE_LENGTH = 200;

export interface NormalisedDecorations {
  decorations: PluginDecoration[];
  /** How many were unusable or past the cap, for the caller to report. */
  dropped: number;
}

/**
 * Clamp, drop and sort a plugin's ranges against a document length.
 *
 * Sorted because `RangeSet.of` requires it and throws otherwise — a plugin
 * that reports findings by rule rather than by position emits them out of
 * order as a matter of course, and that is not an error on its part.
 */
export function normaliseDecorations(
  value: unknown,
  documentLength: number,
): NormalisedDecorations {
  if (!Array.isArray(value)) return { decorations: [], dropped: 0 };

  const decorations: PluginDecoration[] = [];
  let dropped = 0;

  for (const entry of value) {
    if (decorations.length >= MAX_DECORATIONS) {
      dropped += 1;
      continue;
    }

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      dropped += 1;
      continue;
    }

    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    if (typeof kind !== 'string' || !KINDS.has(kind)) {
      dropped += 1;
      continue;
    }

    if (typeof record.from !== 'number' || typeof record.to !== 'number') {
      dropped += 1;
      continue;
    }
    if (!Number.isFinite(record.from) || !Number.isFinite(record.to)) {
      dropped += 1;
      continue;
    }

    // Clamped rather than refused. A plugin computing against a buffer that
    // has since shrunk is the ordinary case, not a malformed one — and the
    // alternative to clamping is an exception inside a view update.
    const from = Math.max(0, Math.min(Math.floor(record.from), documentLength));
    const to = Math.max(0, Math.min(Math.floor(record.to), documentLength));

    // A zero-width mark draws nothing and still costs a mapping on every
    // edit, so an empty or inverted range is dropped rather than kept.
    if (to <= from) {
      dropped += 1;
      continue;
    }

    decorations.push({
      from,
      to,
      kind: kind as DecorationKind,
      ...(typeof record.message === 'string' && record.message.length > 0
        ? { message: record.message.slice(0, MAX_MESSAGE_LENGTH) }
        : {}),
    });
  }

  // `RangeSet.of` requires `from` order and throws otherwise. Sorted here
  // rather than asked of the plugin: a linter reporting by rule emits out of
  // order as a matter of course, and that is not a mistake on its part.
  decorations.sort((a, b) => a.from - b.from || a.to - b.to);

  return { decorations, dropped };
}
