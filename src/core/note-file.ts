/**
 * The Markdown a note exports to, and what comes back in.
 *
 * Notes live as `note-7.txt` behind a JSON index in a config directory, which
 * is a quiet reason not to trust them with anything that matters. This is the
 * way out and back.
 *
 * **The front matter is not YAML.** Nox ships no YAML parser and none is being
 * added for this, and hand-rolling a subset of a whitespace-significant format
 * is how importers rot. The format is one `key: value` per line where the
 * value is JSON: `JSON.stringify` on the way out, `JSON.parse` on the way in,
 * unambiguous in both directions, and still readable as front matter by a
 * person. Gaining compatibility with other note tools is a decision worth
 * making on its own evidence, not one to smuggle in through an export format.
 */

import type { NoteAnchor } from '@core/anchor';

const FENCE = '---';

/** Everything about a note except its text. Every field optional: a file Nox
 * did not write has none of them. */
export interface NoteFileMeta {
  id?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  pinned?: boolean;
  anchor?: NoteAnchor;
}

export interface NoteFile {
  meta: NoteFileMeta;
  body: string;
}

/** A note as a Markdown file: front matter, then the body verbatim. */
export function formatNoteFile(meta: NoteFileMeta, body: string): string {
  const lines: string[] = [FENCE];
  for (const [key, value] of Object.entries(meta)) {
    // Skipped rather than written as null: a key that is absent reads as "not
    // set", and a reader should not have to tell those apart.
    if (value === undefined) continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push(FENCE);
  return `${lines.join('\n')}\n${body}`;
}

/**
 * Split a note file back into metadata and body.
 *
 * Anything that is not front matter Nox recognises becomes **body**, never an
 * error and never a reason to skip the file. A file written by another tool —
 * with real YAML in it — imports with its metadata visible in the text, which
 * a person can fix by hand. A file that is silently dropped is just gone.
 */
export function parseNoteFile(text: string): NoteFile {
  const all = text.split('\n');
  if (all[0] !== FENCE) return { meta: {}, body: text };

  const end = all.indexOf(FENCE, 1);
  if (end === -1) return { meta: {}, body: text };

  const meta: NoteFileMeta = {};
  for (let i = 1; i < end; i++) {
    const line = all[i]!;
    const split = line.indexOf(':');
    if (split === -1) return { meta: {}, body: text };

    const key = line.slice(0, split).trim();
    let value: unknown;
    try {
      value = JSON.parse(line.slice(split + 1).trim());
    } catch {
      // One unparseable line disqualifies the whole block. Keeping the rest
      // would import half a header and hide the other half in nothing.
      return { meta: {}, body: text };
    }
    assign(meta, key, value);
  }

  return { meta, body: all.slice(end + 1).join('\n') };
}

/**
 * Put `value` on `meta` when it is a key we know, at the type we expect.
 *
 * An unknown key is ignored so a file from a later version still imports; a
 * known key at the wrong type is dropped rather than trusted, because a
 * `title` of `42` downstream is worse than no title at all.
 */
function assign(meta: NoteFileMeta, key: string, value: unknown): void {
  switch (key) {
    case 'id':
    case 'title':
      if (typeof value === 'string') meta[key] = value;
      return;
    case 'createdAt':
    case 'updatedAt':
      if (typeof value === 'number') meta[key] = value;
      return;
    case 'pinned':
      if (typeof value === 'boolean') meta.pinned = value;
      return;
    case 'anchor':
      if (isAnchor(value)) meta.anchor = value;
      return;
    default:
      return;
  }
}

function isAnchor(value: unknown): value is NoteAnchor {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === 'string' &&
    typeof candidate.line === 'number' &&
    typeof candidate.snippet === 'string'
  );
}

/**
 * A filename for a note, unique among `taken`.
 *
 * Titles are user-edited and not unique, and two notes writing to one path
 * means exporting four notes and finding three files. The ordinal breaks the
 * tie because it is already the thing that makes a note's id unique.
 */
export function noteFileName(title: string, ordinal: number, taken: ReadonlySet<string>): string {
  const slug = slugify(title) || `note-${ordinal}`;
  const first = `${slug}.md`;
  return taken.has(first) ? `${slug}-${ordinal}.md` : first;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    // Anything that is not a letter, digit or space becomes a break. Keeps
    // the name portable across filesystems without guessing at each one's
    // rules — and `:` alone would make the file unwritable on Windows.
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}
