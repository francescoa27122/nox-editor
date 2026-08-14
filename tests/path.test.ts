import { describe, expect, it } from 'vitest';
import {
  basename,
  canMoveInto,
  contains,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  tildify,
  topLevelPaths,
} from '../src/core/path';

describe('basename', () => {
  it('returns the final segment', () => {
    expect(basename('/a/b/c.txt')).toBe('c.txt');
    expect(basename('c.txt')).toBe('c.txt');
  });

  it('ignores trailing separators', () => {
    expect(basename('/a/b/')).toBe('b');
    expect(basename('C:\\a\\b\\')).toBe('b');
  });
});

describe('dirname', () => {
  it('drops the final segment', () => {
    expect(dirname('/a/b/c.txt')).toBe('/a/b');
    expect(dirname('C:\\a\\b.txt')).toBe('C:\\a');
  });

  it('keeps the root separator', () => {
    expect(dirname('/a')).toBe('/');
  });

  it('returns empty for a bare name', () => {
    expect(dirname('c.txt')).toBe('');
  });
});

describe('extname', () => {
  it('lowercases and drops the dot', () => {
    expect(extname('/a/Main.TS')).toBe('ts');
  });

  it('treats dotfiles as extensionless', () => {
    expect(extname('/a/.gitignore')).toBe('');
  });

  it('uses only the last dot', () => {
    expect(extname('archive.tar.gz')).toBe('gz');
  });
});

describe('join', () => {
  it('uses the separator of the first segment', () => {
    expect(join('/a', 'b', 'c.txt')).toBe('/a/b/c.txt');
    expect(join('C:\\a', 'b')).toBe('C:\\a\\b');
  });

  it('collapses duplicate separators', () => {
    expect(join('/a/', '/b/', 'c')).toBe('/a/b/c');
  });

  it('skips empty segments', () => {
    expect(join('/a', '', 'b')).toBe('/a/b');
  });
});

describe('normalize', () => {
  it('resolves . and ..', () => {
    expect(normalize('/a/b/../c/./d')).toBe('/a/c/d');
  });

  it('does not escape an absolute root', () => {
    expect(normalize('/../..')).toBe('/');
  });

  it('keeps leading .. on relative paths', () => {
    expect(normalize('../a')).toBe('../a');
  });

  it('preserves a Windows drive', () => {
    expect(normalize('C:\\a\\..\\b')).toBe('C:\\b');
  });
});

describe('contains', () => {
  it('matches the directory itself and descendants', () => {
    expect(contains('/a', '/a')).toBe(true);
    expect(contains('/a', '/a/b')).toBe(true);
  });

  it('does not match a sibling with a shared prefix', () => {
    // The bug this guards: '/aa' must not be considered inside '/a'.
    expect(contains('/a', '/aa')).toBe(false);
  });
});

describe('topLevelPaths', () => {
  it('drops entries nested inside another entry', () => {
    // The multi-select delete case: removing /a first would make /a/b fail.
    expect(topLevelPaths(['/a', '/a/b', '/a/b/c.txt', '/d'])).toEqual(['/a', '/d']);
  });

  it('keeps siblings', () => {
    expect(topLevelPaths(['/a/one.ts', '/a/two.ts'])).toEqual(['/a/one.ts', '/a/two.ts']);
  });

  it('does not treat a shared prefix as nesting', () => {
    expect(topLevelPaths(['/a', '/ab'])).toEqual(['/a', '/ab']);
  });

  it('deduplicates', () => {
    expect(topLevelPaths(['/a', '/a'])).toEqual(['/a']);
  });

  it('preserves input order', () => {
    expect(topLevelPaths(['/z', '/a', '/a/b'])).toEqual(['/z', '/a']);
  });

  it('handles an empty list', () => {
    expect(topLevelPaths([])).toEqual([]);
  });
});

describe('canMoveInto', () => {
  it('allows a move to an unrelated folder', () => {
    expect(canMoveInto('/w/src/main.ts', '/w/lib')).toBe(true);
  });

  it('refuses a move into the folder it already lives in', () => {
    expect(canMoveInto('/w/src/main.ts', '/w/src')).toBe(false);
  });

  it('refuses a move onto itself', () => {
    expect(canMoveInto('/w/src', '/w/src')).toBe(false);
  });

  it('refuses moving a folder into its own descendant', () => {
    // The one that would actually eat data.
    expect(canMoveInto('/w/src', '/w/src/deep')).toBe(false);
    expect(canMoveInto('/w/src', '/w/src/deep/deeper')).toBe(false);
  });

  it('allows moving a folder into a sibling with a shared prefix', () => {
    expect(canMoveInto('/w/src', '/w/srcs')).toBe(true);
  });

  it('allows moving up to the parent of the parent', () => {
    expect(canMoveInto('/w/src/deep/nested.ts', '/w')).toBe(true);
  });
});

describe('relative', () => {
  it('strips the root', () => {
    expect(relative('/a/b', '/a/b/c/d.txt')).toBe('c/d.txt');
  });

  it('returns the input when not contained', () => {
    expect(relative('/x', '/a/b')).toBe('/a/b');
  });
});

describe('tildify', () => {
  it('replaces the home prefix', () => {
    expect(tildify('/home/nox/code/a.ts', '/home/nox')).toBe('~/code/a.ts');
  });

  it('leaves unrelated paths alone', () => {
    expect(tildify('/etc/hosts', '/home/nox')).toBe('/etc/hosts');
  });

  it('is a no-op without a home directory', () => {
    expect(tildify('/etc/hosts', null)).toBe('/etc/hosts');
  });
});

describe('isAbsolute', () => {
  it('recognises posix and windows roots', () => {
    expect(isAbsolute('/a')).toBe(true);
    expect(isAbsolute('C:\\a')).toBe(true);
    expect(isAbsolute('a/b')).toBe(false);
  });
});
