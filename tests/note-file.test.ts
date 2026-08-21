import { describe, expect, it } from 'vitest';
import { formatNoteFile, parseNoteFile, noteFileName } from '../src/core/note-file';

/**
 * The Markdown a note exports to, and what comes back in.
 *
 * The front matter is deliberately **not YAML** — no parser ships and none is
 * being added, and hand-rolling a subset of a whitespace-significant format is
 * how importers rot. It is one `key: value` per line where the value is JSON,
 * which round-trips exactly in both directions.
 */

const anchor = { path: '/w/src/lsp.rs', line: 320, snippet: 'for line in BufReader' };

describe('writing a note file', () => {
  it('puts the body after the front matter, verbatim', () => {
    const text = formatNoteFile({ title: 'Release checklist' }, 'line one\nline two\n');

    expect(text.endsWith('line one\nline two\n')).toBe(true);
  });

  it('writes values as JSON so a title with a colon survives', () => {
    const text = formatNoteFile({ title: 'lsp.rs:320 — why' }, '');

    expect(text).toContain('title: "lsp.rs:320 — why"');
  });

  it('omits keys it was not given rather than writing null', () => {
    const text = formatNoteFile({ title: 'plain' }, 'body');

    expect(text).not.toContain('anchor:');
    expect(text).not.toContain('pinned:');
  });
});

describe('round-tripping', () => {
  /**
   * The property the whole phase is judged on: what goes out comes back.
   */
  it('returns every field it was given', () => {
    const meta = {
      id: 'n7',
      title: 'Why the reader threads changed',
      createdAt: 1787348292534,
      updatedAt: 1787348292999,
      pinned: true,
      anchor,
    };
    const body = '```\nfor line in BufReader::new(stderr).lines()\n```\n\nand why.\n';

    const parsed = parseNoteFile(formatNoteFile(meta, body));

    expect(parsed.meta).toEqual(meta);
    expect(parsed.body).toBe(body);
  });

  it('survives a body that contains its own delimiter', () => {
    const body = 'before\n---\nafter\n';

    const parsed = parseNoteFile(formatNoteFile({ title: 'n' }, body));

    expect(parsed.body).toBe(body);
  });

  it('survives a body that is empty', () => {
    const parsed = parseNoteFile(formatNoteFile({ title: 'n' }, ''));

    expect(parsed.body).toBe('');
    expect(parsed.meta.title).toBe('n');
  });
});

describe('reading a file Nox did not write', () => {
  /**
   * Plain Markdown written elsewhere should import as a note rather than be
   * refused. The caller supplies the title from the filename.
   */
  it('treats a file with no front matter as all body', () => {
    const parsed = parseNoteFile('# Just some markdown\n\nwith no front matter.\n');

    expect(parsed.meta).toEqual({});
    expect(parsed.body).toBe('# Just some markdown\n\nwith no front matter.\n');
  });

  /**
   * The failure this prevents: a file written by another tool — with real
   * YAML in its front matter — being dropped on import. Its metadata is
   * visible in the body, which a person can fix by hand; a skipped file is
   * silently lost.
   */
  it('treats front matter it cannot parse as body, never as a reason to skip', () => {
    const text = '---\ntags: [a, b]\nnot json at all\n---\nthe real body\n';

    const parsed = parseNoteFile(text);

    expect(parsed.meta).toEqual({});
    expect(parsed.body).toBe(text);
  });

  it('ignores a key it does not know rather than failing the file', () => {
    const text = '---\ntitle: "kept"\nfuture: {"some":"key"}\n---\nbody\n';

    const parsed = parseNoteFile(text);

    expect(parsed.meta.title).toBe('kept');
    expect(parsed.body).toBe('body\n');
  });

  it('rejects a value of the wrong type rather than importing nonsense', () => {
    const text = '---\ntitle: 42\npinned: "yes"\n---\nbody\n';

    const parsed = parseNoteFile(text);

    expect(parsed.meta.title).toBeUndefined();
    expect(parsed.meta.pinned).toBeUndefined();
  });
});

describe('naming the file', () => {
  it('slugifies the title', () => {
    expect(noteFileName('Release Checklist', 3, new Set())).toBe('release-checklist.md');
  });

  it('strips punctuation a filesystem would rather not carry', () => {
    expect(noteFileName('lsp.rs:320 — why?', 3, new Set())).toBe('lsp-rs-320-why.md');
  });

  /**
   * The failure this prevents: two notes writing to one path, so exporting
   * four notes yields three files. Titles are user-edited and not unique.
   */
  it('appends the ordinal when the name is taken', () => {
    const taken = new Set(['notes.md']);

    expect(noteFileName('Notes', 7, taken)).toBe('notes-7.md');
  });

  it('falls back to the ordinal when a title slugifies to nothing', () => {
    expect(noteFileName('***', 4, new Set())).toBe('note-4.md');
  });
});
