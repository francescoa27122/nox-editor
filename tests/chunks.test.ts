import { describe, expect, it } from 'vitest';
// @ts-expect-error — a build script, deliberately outside the tsconfig graph,
// like `scripts/release-notes.mjs` and its suite.
import { chunkFor } from '../scripts/chunks.mjs';

/**
 * What this guards.
 *
 * The rule used to return a single `grammars` name for every parser, which
 * collapsed all of `editor/languages.ts`'s dynamic imports onto one file:
 * opening a .json buffer downloaded every grammar Nox ships. It said the
 * opposite in a comment — *"so startup only pays for what it uses"* — and
 * nothing checked, so it stayed wrong from v0.1 until eleven more languages
 * took the chunk to 640 kB and made it obvious.
 *
 * The build is where that is visible and the build is not a test, so the rule
 * lives in a module of its own and the invariant is asserted here: **two
 * languages never share a chunk.**
 */

const id = (specifier: string) => `/project/node_modules/${specifier}/dist/index.js`;

describe('a language grammar', () => {
  it('gets a chunk of its own', () => {
    expect(chunkFor(id('@codemirror/lang-go'))).toBe('grammar-go');
    expect(chunkFor(id('@codemirror/lang-java'))).toBe('grammar-java');
  });

  it('takes its Lezer parser with it rather than into a shared pile', () => {
    expect(chunkFor(id('@lezer/go'))).toBe('grammar-go');
    expect(chunkFor(id('@lezer/java'))).toBe('grammar-java');
  });

  it('covers the stream parsers, which are modules inside one package', () => {
    expect(chunkFor('/project/node_modules/@codemirror/legacy-modes/mode/shell.js')).toBe(
      'grammar-shell',
    );
    expect(chunkFor('/project/node_modules/@codemirror/legacy-modes/mode/toml.js')).toBe(
      'grammar-toml',
    );
  });
});

describe('the editor engine', () => {
  it('keeps the parser runtime every grammar shares', () => {
    for (const shared of ['common', 'highlight', 'lr']) {
      expect(chunkFor(id(`@lezer/${shared}`))).toBe('editor-engine');
    }
  });

  it('keeps the rest of CodeMirror', () => {
    expect(chunkFor(id('@codemirror/view'))).toBe('editor-engine');
    expect(chunkFor(id('@codemirror/autocomplete'))).toBe('editor-engine');
  });

  it('claims nothing that is ours', () => {
    expect(chunkFor('/project/src/app.ts')).toBeUndefined();
    expect(chunkFor('/project/node_modules/svelte/src/index.js')).toBeUndefined();
  });
});

describe('the invariant the old rule broke', () => {
  it('never puts two languages in one chunk', () => {
    const languages = [
      'go', 'java', 'cpp', 'php', 'sql', 'xml', 'yaml',
      'javascript', 'json', 'html', 'css', 'markdown', 'python', 'rust',
    ];

    const chunks = languages.map((language) => chunkFor(id(`@codemirror/lang-${language}`)));

    // A single `grammars` name for all of them is exactly what this file
    // exists to stop, and it is the shape the rule had for nine months.
    expect(new Set(chunks).size).toBe(languages.length);
    expect(chunks).not.toContain('grammars');
  });
});
