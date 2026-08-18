import { describe, expect, it } from 'vitest';
import { pathToUri, uriToPath } from '../src/core/uri';

/**
 * Path to `file://` and back.
 *
 * Its own file because this is a silent-corruption source rather than a
 * formatting detail: a server told the wrong URI reports diagnostics against a
 * document nobody is looking at, and says nothing about the one they are.
 */

describe('pathToUri', () => {
  it('encodes a POSIX path', () => {
    expect(pathToUri('/home/a/main.ts')).toBe('file:///home/a/main.ts');
  });

  it('lower-cases and encodes a Windows drive letter', () => {
    // VS Code's form. A bare colon is legal in a path and ambiguous in a URI,
    // and every server accepts the encoded one.
    expect(pathToUri('C:\\src\\main.ts')).toBe('file:///c%3A/src/main.ts');
  });

  it('encodes spaces and other reserved characters', () => {
    expect(pathToUri('/home/a b/c#d.ts')).toBe('file:///home/a%20b/c%23d.ts');
  });

  it('keeps a UNC host as the authority', () => {
    expect(pathToUri('\\\\server\\share\\a.ts')).toBe('file://server/share/a.ts');
  });
});

describe('uriToPath', () => {
  it('round-trips a POSIX path', () => {
    expect(uriToPath(pathToUri('/home/a/main.ts'))).toBe('/home/a/main.ts');
  });

  it('round-trips a path with reserved characters', () => {
    expect(uriToPath(pathToUri('/home/a b/c#d.ts'))).toBe('/home/a b/c#d.ts');
  });

  it('round-trips a Windows path back to backslashes', () => {
    expect(uriToPath(pathToUri('C:\\src\\main.ts'))).toBe('C:\\src\\main.ts');
  });

  it('round-trips a UNC path', () => {
    expect(uriToPath(pathToUri('\\\\server\\share\\a.ts'))).toBe('\\\\server\\share\\a.ts');
  });

  it('rejects a non-file URI rather than guessing', () => {
    expect(() => uriToPath('http://example.com/a.ts')).toThrow();
  });
});
