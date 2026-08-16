import { htmlLanguage } from '@codemirror/lang-html';
import { parser as cssParser } from '@lezer/css';
import { parser as jsParser } from '@lezer/javascript';
import { parser as pythonParser } from '@lezer/python';
import { parser as rustParser } from '@lezer/rust';
import { Text } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import { describe, expect, it } from 'vitest';
import { fileSymbols } from '../src/core/symbols';

const ts = jsParser.configure({ dialect: 'ts' });

/** Parse with `parser` and return the symbols as "qualified:kind" strings. */
function scan(parser: { parse(input: string): Tree }, source: string): string[] {
  const doc = Text.of(source.split('\n'));
  return fileSymbols(parser.parse(source), doc).map((s) => `${s.qualified}:${s.kind}`);
}

describe('the symbols in a file', () => {
  /**
   * The failure this prevents: a method listed as `bar`, so a file with four
   * classes each having a `render` gives four identical rows and no way to
   * tell them apart. Fuzzy matching runs over the title, so the enclosing
   * name has to be in it.
   */
  it('qualifies a method with its class', () => {
    expect(scan(ts, 'class Foo {\n  bar() {}\n}\n')).toEqual(['Foo:class', 'Foo.bar:function']);
  });

  /**
   * The failure this prevents: collecting every named node, which turns the
   * list into an outline of the parse tree rather than of the code.
   */
  it('ignores variables, imports and call sites', () => {
    const source = "import { x } from 'y';\nconst a = 1;\nfunction real() {}\nreal();\n";
    expect(scan(ts, source)).toEqual(['real:function']);
  });

  it('reads TypeScript interfaces, type aliases and enums', () => {
    const source = 'interface I {}\ntype T = string;\nenum E { A }\n';
    expect(scan(ts, source)).toEqual(['I:interface', 'T:type', 'E:enum']);
  });

  it('reads Python classes and defs', () => {
    const source = 'class Foo:\n    def bar(self):\n        pass\n';
    expect(scan(pythonParser, source)).toEqual(['Foo:class', 'Foo.bar:function']);
  });

  /**
   * Rust names items with two different node types — `BoundIdentifier` for
   * functions and modules, `TypeIdentifier` for structs, enums, traits, impls
   * and type aliases. Reading only one of them silently loses half of Rust.
   */
  it('reads Rust items named by either identifier node', () => {
    const source = 'struct S {}\ntrait T {}\nmod m {}\nimpl S {\n    fn f() {}\n}\n';
    expect(scan(rustParser, source)).toEqual([
      'S:class',
      'T:interface',
      'm:module',
      'S:class',
      'S.f:function',
    ]);
  });

  /**
   * A CSS rule set has no name child: the selector is the text from the node
   * to its `Block`. Taking the whole node's text would put the declarations
   * in the title.
   */
  it('names a CSS rule set by its selector', () => {
    expect(scan(cssParser, '.foo, .bar {\n  color: red;\n}\n')).toEqual(['.foo, .bar:rule']);
  });

  /**
   * The failure this prevents: an empty list where the file plainly has
   * structure, because the walk only ever looked at top-level nodes.
   */
  it('finds a nested function inside another function', () => {
    expect(scan(ts, 'function outer() {\n  function inner() {}\n}\n')).toEqual([
      'outer:function',
      'outer.inner:function',
    ]);
  });

  it('returns nothing for a file with no structure', () => {
    expect(scan(ts, 'const a = 1;\nconst b = 2;\n')).toEqual([]);
  });

  /**
   * The design's central argument, and the case that regresses silently under
   * a per-language table: `@codemirror/lang-html` nests the CSS and
   * JavaScript grammars, so one `.html` tree holds `RuleSet` *and*
   * `FunctionDeclaration`. Rules keyed by the file's language would look up
   * "html", find the rules for a grammar that deliberately collects nothing,
   * and return an empty list for a file plainly full of structure.
   *
   * Uses `htmlLanguage.parser`, not `@lezer/html` — the bare grammar does not
   * nest, and testing against it would prove nothing.
   */
  it('finds symbols from every grammar in a mixed-language file', () => {
    const source = '<style>.a { color: red }</style>\n<script>function f() {}</script>\n';
    expect(scan(htmlLanguage.parser, source)).toEqual(['.a:rule', 'f:function']);
  });

  /**
   * `from`/`to` are what the palette jumps to, so they must be the node's own
   * range rather than the name child's.
   */
  it('reports the range of the whole declaration', () => {
    const doc = Text.of(['function f() {}']);
    const [symbol] = fileSymbols(ts.parse('function f() {}'), doc);
    expect([symbol?.from, symbol?.to]).toEqual([0, 15]);
  });
});
