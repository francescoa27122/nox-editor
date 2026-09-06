import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../src/core/languages';

/**
 * Which language a path resolves to.
 *
 * Guards A1-005: `filenames` was documented as being "for things like
 * `Dockerfile` or `Makefile`" while neither name was in the table, and a
 * `.cs`, `.kt`, `.swift`, `.lua`, `.ps1` or `.ini` file opened as plain
 * text. These pin the detections the 2026-09-02 entries added. Does not
 * catch: Makefile, which still has no grammar to detect into.
 */
describe('detectLanguage', () => {
  it.each([
    ['/w/Editor.cs', 'csharp'],
    ['/w/Main.kt', 'kotlin'],
    ['/w/build.gradle.kts', 'kotlin'],
    ['/w/App.swift', 'swift'],
    ['/w/init.lua', 'lua'],
    ['/w/deploy.ps1', 'powershell'],
    ['/w/Module.psm1', 'powershell'],
    ['/w/settings.ini', 'ini'],
    ['/w/app.properties', 'ini'],
    ['/w/.env', 'ini'],
    ['/w/.editorconfig', 'ini'],
    ['/w/Dockerfile', 'dockerfile'],
    ['/w/dockerfile', 'dockerfile'],
    ['/w/Containerfile', 'dockerfile'],
    ['/w/api.dockerfile', 'dockerfile'],
  ])('%s is %s', (path, id) => {
    expect(detectLanguage(path).id).toBe(id);
  });

  it('still falls back to plain text for a name it does not know', () => {
    expect(detectLanguage('/w/Makefile').id).toBe('plaintext');
    expect(detectLanguage('/w/notes.unknown').id).toBe('plaintext');
  });
});
