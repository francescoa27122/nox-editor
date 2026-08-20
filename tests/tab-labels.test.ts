import { describe, expect, it } from 'vitest';
import { tabLabels } from '../src/core/tab-labels';

/**
 * `tabLabels` — duplicate-name disambiguation for the tab strip.
 *
 * Mutation-checked on 2026-08-19: with the walk-up loop pinned to the
 * immediate parent (`level = 0` unconditionally), "same immediate parents,
 * differing higher up" fails — both tabs would read `index.ts — src`.
 * With the suffix fallback removed, the suffix-path case fails.
 */

function buffer(id: string, path: string | null, name?: string) {
  const base = path ? path.split(/[\\/]/).filter(Boolean).at(-1)! : (name ?? id);
  return { id, name: name ?? base, path };
}

describe('tabLabels', () => {
  it('leaves unique names untouched', () => {
    const labels = tabLabels([
      buffer('a', '/w/src/main.ts'),
      buffer('b', '/w/src/util.ts'),
    ]);
    expect(labels.get('a')).toBe('main.ts');
    expect(labels.get('b')).toBe('util.ts');
  });

  it('disambiguates same name, different parents, with the immediate parent', () => {
    const labels = tabLabels([
      buffer('a', '/w/ui/index.ts'),
      buffer('b', '/w/core/index.ts'),
    ]);
    expect(labels.get('a')).toBe('index.ts — ui');
    expect(labels.get('b')).toBe('index.ts — core');
  });

  it('walks up past identical parents to the first level that differs', () => {
    const labels = tabLabels([
      buffer('a', '/repo/app1/src/index.ts'),
      buffer('b', '/repo/app2/src/index.ts'),
    ]);
    expect(labels.get('a')).toBe('index.ts — app1');
    expect(labels.get('b')).toBe('index.ts — app2');
  });

  it('requires ONE level that separates a three-way collision', () => {
    const labels = tabLabels([
      buffer('a', '/w/alpha/x/f.ts'),
      buffer('b', '/w/beta/x/f.ts'),
      buffer('c', '/w/gamma/y/f.ts'),
    ]);
    // Level 0 (x, x, y) is ambiguous for a/b, so all three take level 1.
    expect(labels.get('a')).toBe('f.ts — alpha');
    expect(labels.get('b')).toBe('f.ts — beta');
    expect(labels.get('c')).toBe('f.ts — gamma');
  });

  it('keeps pathless buffers on their bare name', () => {
    const labels = tabLabels([
      buffer('u1', null, 'Untitled-1'),
      buffer('u2', null, 'Untitled-2'),
      buffer('a', '/w/notes.md'),
    ]);
    expect(labels.get('u1')).toBe('Untitled-1');
    expect(labels.get('u2')).toBe('Untitled-2');
    expect(labels.get('a')).toBe('notes.md');
  });

  it('does not decorate a lone pathed buffer colliding only with a pathless one', () => {
    const labels = tabLabels([
      buffer('p', '/w/notes.md'),
      buffer('u', null, 'notes.md'),
    ]);
    expect(labels.get('p')).toBe('notes.md');
    expect(labels.get('u')).toBe('notes.md');
  });

  it('falls back to the full parent when one path is a suffix of the other', () => {
    const labels = tabLabels([
      buffer('a', '/a/f.ts'),
      buffer('b', '/x/a/f.ts'),
    ]);
    // Nearest parents are both `a` and the short chain is exhausted, so the
    // whole directory path is the only honest tiebreak.
    expect(labels.get('a')).toBe('f.ts — /a');
    expect(labels.get('b')).toBe('f.ts — /x/a');
  });

  it('handles Windows separators', () => {
    const labels = tabLabels([
      buffer('a', 'C:\\w\\ui\\index.ts'),
      buffer('b', 'C:\\w\\core\\index.ts'),
    ]);
    expect(labels.get('a')).toBe('index.ts — ui');
    expect(labels.get('b')).toBe('index.ts — core');
  });

  it('returns an empty map for no buffers', () => {
    expect(tabLabels([]).size).toBe(0);
  });
});
