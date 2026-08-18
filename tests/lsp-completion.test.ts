import { describe, expect, it } from 'vitest';
import {
  completionKind,
  documentationOf,
  stripSnippet,
  toCodeMirrorCompletions,
  type LspCompletionItem,
} from '../src/core/lsp-completion';

/**
 * LSP completion items to CodeMirror completions.
 *
 * A mis-mapped kind is a wrong icon. A mishandled `textEdit` silently
 * corrupts the line the user is typing on, which is why the insertion rules
 * get the most cases here.
 */

const DOC = 'console.\n';

function item(overrides: Partial<LspCompletionItem> = {}): LspCompletionItem {
  return { label: 'log', ...overrides };
}

describe('kinds', () => {
  it('maps the ones people actually see', () => {
    expect(completionKind(3)).toBe('function');
    expect(completionKind(2)).toBe('method');
    expect(completionKind(6)).toBe('variable');
    expect(completionKind(7)).toBe('class');
    expect(completionKind(8)).toBe('interface');
    expect(completionKind(14)).toBe('keyword');
    expect(completionKind(21)).toBe('constant');
  });

  it('falls back to variable for an unknown or missing kind', () => {
    // An unrecognised kind is a rendering question, not an error — an
    // untyped completion renders with no icon and looks broken.
    expect(completionKind(99)).toBe('variable');
    expect(completionKind(undefined)).toBe('variable');
  });

  it('has a mapping for every kind the protocol defines', () => {
    for (let kind = 1; kind <= 25; kind++) {
      expect(typeof completionKind(kind)).toBe('string');
    }
  });
});

describe('what gets inserted', () => {
  it('prefers a textEdit, which names the exact range to replace', () => {
    // Ignoring it is how `console.log` becomes `console.console.log`.
    const [converted] = toCodeMirrorCompletions(DOC, [
      item({
        textEdit: {
          range: { start: { line: 0, character: 8 }, end: { line: 0, character: 8 } },
          newText: 'log',
        },
      }),
    ]);

    expect(converted).toMatchObject({ apply: 'log', from: 8, to: 8 });
  });

  it('uses insertText when there is no textEdit', () => {
    expect(toCodeMirrorCompletions(DOC, [item({ insertText: 'logged' })])[0]?.apply).toBe('logged');
  });

  it('falls back to the label when there is neither', () => {
    const [converted] = toCodeMirrorCompletions(DOC, [item()]);

    expect(converted?.label).toBe('log');
    expect(converted?.apply).toBeUndefined();
  });
});

describe('snippets', () => {
  it('strips placeholders to their default text', () => {
    // `foo(${1:arg})` inserted verbatim is the failure a user notices and
    // has to undo.
    expect(stripSnippet('foo(${1:arg})')).toBe('foo(arg)');
    expect(stripSnippet('foo($1)')).toBe('foo()');
    expect(stripSnippet('done$0')).toBe('done');
  });

  it('leaves a plain string alone', () => {
    expect(stripSnippet('log')).toBe('log');
  });

  it('applies stripping only to snippet-format items', () => {
    const snippet = toCodeMirrorCompletions(DOC, [
      item({ insertText: 'foo(${1:arg})', insertTextFormat: 2 }),
    ]);
    const plain = toCodeMirrorCompletions(DOC, [
      item({ insertText: 'foo(${1:arg})', insertTextFormat: 1 }),
    ]);

    expect(snippet[0]?.apply).toBe('foo(arg)');
    expect(plain[0]?.apply).toBe('foo(${1:arg})');
  });
});

describe('the rest of the item', () => {
  it('passes detail and sort order through', () => {
    const [converted] = toCodeMirrorCompletions(DOC, [
      item({ detail: '(method) log', sortText: '00' }),
    ]);

    expect(converted?.detail).toBe('(method) log');
    expect(converted?.sortText).toBe('00');
  });

  it('matches on filterText while showing the decorated label', () => {
    const [converted] = toCodeMirrorCompletions(DOC, [item({ label: '● log', filterText: 'log' })]);

    expect(converted?.label).toBe('log');
    expect(converted?.displayLabel).toBe('● log');
  });

  it('shows documentation that came with the item', () => {
    const [converted] = toCodeMirrorCompletions(DOC, [item({ documentation: 'Logs a message' })]);

    expect(converted?.info).toBe('Logs a message');
  });

  it('unwraps markup-content documentation', () => {
    const [converted] = toCodeMirrorCompletions(DOC, [item({ documentation: { value: 'Logs it' } })]);

    expect(converted?.info).toBe('Logs it');
  });

  it('converts an empty list to an empty list', () => {
    expect(toCodeMirrorCompletions(DOC, [])).toEqual([]);
  });
});

describe('documentationOf', () => {
  it('reads a plain string', () => {
    expect(documentationOf({ label: 'log', documentation: 'Logs' })).toBe('Logs');
  });

  it('unwraps markup content', () => {
    expect(documentationOf({ label: 'log', documentation: { value: 'Logs' } })).toBe('Logs');
  });

  it('reports absence as null, which is what makes the item eligible for a lazy fetch', () => {
    expect(documentationOf({ label: 'log' })).toBeNull();
  });
});
