import { describe, expect, it } from 'vitest';
import {
  parseSnippetFile,
  snippetsFor,
  toCodeMirrorTemplate,
  type SnippetFile,
} from '../src/core/snippets';

/**
 * The snippets file, read.
 *
 * Pure on purpose: the file is user-authored JSON, which means every shape in
 * here is a shape someone will actually write — including the wrong ones. The
 * rule throughout is that **a bad entry is dropped and counted, never fatal**.
 * A single typo that emptied the file would look exactly like having
 * configured nothing, which is the state the user was trying to leave.
 */

describe('parsing', () => {
  it('takes the short form, where the value is the template', () => {
    const parsed = parseSnippetFile({ typescript: { log: 'console.log(${1:value})$0' } });

    expect(parsed.problems).toEqual([]);
    expect(snippetsFor(parsed.snippets, 'typescript')).toEqual([
      { prefix: 'log', body: 'console.log(${1:value})$0' },
    ]);
  });

  it('takes the long form, with a description', () => {
    const parsed = parseSnippetFile({
      rust: { fnn: { body: 'fn ${1:name}() {\n    $0\n}', description: 'A function' } },
    });

    expect(snippetsFor(parsed.snippets, 'rust')).toEqual([
      { prefix: 'fnn', body: 'fn ${1:name}() {\n    $0\n}', description: 'A function' },
    ]);
  });

  it('joins an array body with newlines, so JSON need not carry escapes', () => {
    const parsed = parseSnippetFile({
      python: { main: { body: ['def main():', '    $0', '', 'main()'] } },
    });

    expect(snippetsFor(parsed.snippets, 'python')[0]?.body).toBe('def main():\n    $0\n\nmain()');
  });

  it('drops what it cannot use and says how much', () => {
    const parsed = parseSnippetFile({
      go: {
        good: 'fmt.Println($0)',
        empty: '',
        wrong: 42,
        noBody: { description: 'forgot the body' },
      },
    });

    expect(snippetsFor(parsed.snippets, 'go')).toEqual([{ prefix: 'good', body: 'fmt.Println($0)' }]);
    expect(parsed.problems).toHaveLength(3);
    // Named, not counted: "3 entries were wrong" cannot be acted on.
    expect(parsed.problems.join(' ')).toContain('empty');
    expect(parsed.problems.join(' ')).toContain('wrong');
    expect(parsed.problems.join(' ')).toContain('noBody');
  });

  it('reads a `//` key as a comment rather than a broken language', () => {
    const parsed = parseSnippetFile({
      '//': 'Your own snippets. $1 and $2 are stops; $0 is where the cursor lands.',
      go: { pl: 'fmt.Println($0)' },
    });

    // JSON has no comments, and the starter file has syntax to explain — so
    // the convention has to be understood rather than reported.
    expect(parsed.problems).toEqual([]);
    expect(snippetsFor(parsed.snippets, 'go')).toHaveLength(1);
  });

  it('survives a file that is not an object at all', () => {
    expect(parseSnippetFile(['nope']).snippets.size).toBe(0);
    expect(parseSnippetFile(null).snippets.size).toBe(0);
    expect(parseSnippetFile('a string').problems).toHaveLength(1);
  });

  it('ignores a language whose value is not an object, without losing the others', () => {
    const parsed = parseSnippetFile({ go: 'not an object', rust: { r: 'Ok($0)' } });

    expect(snippetsFor(parsed.snippets, 'rust')).toHaveLength(1);
    expect(parsed.problems).toHaveLength(1);
  });
});

describe('resolving for a language', () => {
  const file: SnippetFile = parseSnippetFile({
    '*': { todo: 'TODO(${1:who}): $0', note: 'NOTE: $0' },
    typescript: { log: 'console.log($0)', note: 'ts note $0' },
  }).snippets;

  it('offers the language its own and the wildcard together', () => {
    expect(snippetsFor(file, 'typescript').map((s) => s.prefix).sort()).toEqual([
      'log',
      'note',
      'todo',
    ]);
  });

  it('lets a language override a wildcard of the same prefix', () => {
    // Otherwise the picker shows two rows called `note` and the more specific
    // one is not reliably the one you get.
    expect(snippetsFor(file, 'typescript').find((s) => s.prefix === 'note')?.body).toBe(
      'ts note $0',
    );
  });

  it('gives a language with nothing of its own the wildcard set', () => {
    expect(snippetsFor(file, 'ruby').map((s) => s.prefix).sort()).toEqual(['note', 'todo']);
  });

  it('is empty when the file is', () => {
    expect(snippetsFor(parseSnippetFile({}).snippets, 'go')).toEqual([]);
  });
});


describe('the template dialects', () => {
  /**
   * What this guards.
   *
   * CodeMirror's parser matches braced fields only, so the bare `$0` every
   * language server emits is not a tab stop to it — it is text, and it landed
   * in the buffer. The snippet expanded, the placeholder worked, and `$0` sat
   * there at the end of the line.
   */
  it('braces a bare tab stop, which CodeMirror will not read without one', () => {
    expect(toCodeMirrorTemplate('console.log($1)$0')).toBe('console.log(${1})${0}');
  });

  it('leaves a braced field alone', () => {
    expect(toCodeMirrorTemplate('log(${1:value})')).toBe('log(${1:value})');
  });

  it('takes the first of a choice, which CodeMirror cannot offer', () => {
    expect(toCodeMirrorTemplate('${1|const,let,var|} x')).toBe('${1:const} x');
  });

  it('gives an empty choice a plain field rather than an empty default', () => {
    expect(toCodeMirrorTemplate('${1||}')).toBe('${1}');
  });

  it('unescapes a literal dollar rather than inserting the backslash', () => {
    // `\$1` is the protocol's way of writing a dollar followed by a one. An
    // unbraced `$` means nothing to CodeMirror, so dropping the backslash is
    // both safe and required — it would otherwise be typed into the buffer.
    expect(toCodeMirrorTemplate('cost: \\$1')).toBe('cost: $1');
  });

  it('leaves a variable exactly as written', () => {
    // Nox resolves none of them. Text the author can see and fix beats text
    // that silently vanished.
    expect(toCodeMirrorTemplate('// $TM_FILENAME')).toBe('// $TM_FILENAME');
  });
});
