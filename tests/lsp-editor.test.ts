import { describe, expect, it } from 'vitest';
import type { LspDiagnostic } from '../src/services/lsp';
import { toCodeMirrorDiagnostics } from '../src/editor/lsp';

/**
 * LSP diagnostics to CodeMirror ones.
 *
 * The clamping is the reason this function exists rather than being three
 * lines at the call site. CodeMirror throws on an out-of-range position, so a
 * batch computed against a copy of the document one revision behind is a
 * crash in the editor, not a cosmetic error — and `publishDiagnostics`
 * carries no version at all from some servers, so it cannot be caught earlier.
 */

const TEXT = 'const a = 1;\nconst b = 2;\n';

function at(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
  extra: Partial<LspDiagnostic> = {},
): LspDiagnostic {
  return {
    range: {
      start: { line: startLine, character: startCharacter },
      end: { line: endLine, character: endCharacter },
    },
    message: 'something',
    ...extra,
  };
}

describe('severity', () => {
  it('maps all four levels', () => {
    const converted = toCodeMirrorDiagnostics(TEXT, [
      at(0, 0, 0, 1, { severity: 1 }),
      at(0, 0, 0, 1, { severity: 2 }),
      at(0, 0, 0, 1, { severity: 3 }),
      at(0, 0, 0, 1, { severity: 4 }),
    ]);

    expect(converted.map((d) => d.severity)).toEqual(['error', 'warning', 'info', 'hint']);
  });

  it('treats a missing severity as an error, which is what the spec says', () => {
    expect(toCodeMirrorDiagnostics(TEXT, [at(0, 0, 0, 1)])[0]?.severity).toBe('error');
  });
});

describe('ranges', () => {
  it('converts a range to offsets', () => {
    const [converted] = toCodeMirrorDiagnostics(TEXT, [at(1, 6, 1, 7)]);

    expect(converted).toMatchObject({ from: 19, to: 20 });
  });

  it('clamps a range past the end of the document', () => {
    // A server one revision behind reports against text that no longer
    // exists. Unclamped, this is a thrown exception inside the editor.
    const [converted] = toCodeMirrorDiagnostics(TEXT, [at(99, 0, 99, 10)]);

    expect(converted?.from).toBeLessThanOrEqual(TEXT.length);
    expect(converted?.to).toBeLessThanOrEqual(TEXT.length);
  });

  it('normalises a range whose end precedes its start', () => {
    const [converted] = toCodeMirrorDiagnostics(TEXT, [at(1, 8, 0, 2)]);

    expect(converted!.from).toBeLessThanOrEqual(converted!.to);
  });

  it('gives a zero-width range one character, so it can be seen', () => {
    // A squiggle of no width is a squiggle nobody can click on.
    const [converted] = toCodeMirrorDiagnostics(TEXT, [at(0, 3, 0, 3)]);

    expect(converted!.to).toBeGreaterThan(converted!.from);
  });

  it('keeps a zero-width range at the very end inside the document', () => {
    const [converted] = toCodeMirrorDiagnostics(TEXT, [at(2, 0, 2, 0)]);

    expect(converted!.to).toBeLessThanOrEqual(TEXT.length);
    expect(converted!.from).toBeLessThanOrEqual(converted!.to);
  });
});

describe('the rest', () => {
  it('carries the message, and names the source when there is one', () => {
    const [converted] = toCodeMirrorDiagnostics(TEXT, [
      at(0, 0, 0, 1, { message: 'unused', source: 'ts' }),
    ]);

    expect(converted?.message).toBe('unused');
    expect(converted?.source).toBe('ts');
  });

  it('converts an empty list to an empty list, without throwing', () => {
    expect(toCodeMirrorDiagnostics(TEXT, [])).toEqual([]);
  });

  it('converts against an empty document, without throwing', () => {
    const [converted] = toCodeMirrorDiagnostics('', [at(0, 0, 5, 5)]);

    expect(converted).toMatchObject({ from: 0, to: 0 });
  });
});
