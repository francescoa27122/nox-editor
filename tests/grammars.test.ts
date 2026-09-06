// @vitest-environment jsdom
import { StreamLanguage, ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { highlightTree } from '@lezer/highlight';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '../src/core/languages';
import { hasGrammar, hasSymbolStructure, loadLanguage } from '../src/editor/languages';
import { noxHighlightStyle } from '../src/editor/theme';

/**
 * Every language Nox names, highlighted.
 *
 * The claim these guard is the one a user makes by opening a file: it renders
 * in colour. That is two steps past "a loader exists" — a loader can resolve
 * to an extension that parses nothing, and a grammar can parse perfectly into
 * tags Nox's own `HighlightStyle` has no rule for, which paints plain text.
 * So each case runs the real parser over real source and then runs
 * `noxHighlightStyle` over the tree, and asserts on the styled ranges that
 * come out.
 *
 * Eleven of these languages were named by `core/languages.ts`, opened, and
 * rendered flat grey from v0.1 until 2026-08-26, because naming a language
 * and parsing it are different tables and nothing held them together. The
 * last case in this file is what holds them together now.
 */

/** Snippets are short and idiomatic: enough tokens to colour, no more. */
const SOURCE: Record<string, string> = {
  shell: '#!/bin/sh\nfor f in *.txt; do\n  echo "$f"\ndone\n',
  yaml: 'name: build\non:\n  push:\n    branches: [main]\n',
  toml: '[package]\nname = "nox"\nversion = "0.10.0"\n',
  xml: '<?xml version="1.0"?>\n<root attr="value">\n  <child>text</child>\n</root>\n',
  sql: 'SELECT id, name FROM users WHERE active = 1 ORDER BY name;\n',
  go: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n',
  c: '#include <stdio.h>\n\nint main(void) {\n  printf("hi");\n  return 0;\n}\n',
  cpp: '#include <string>\n\nnamespace nox {\nclass Editor {\npublic:\n  std::string name() const;\n};\n}\n',
  java: 'package nox;\n\npublic class Editor {\n  public static void main(String[] args) {\n    System.out.println("hi");\n  }\n}\n',
  ruby: 'class Editor\n  def name\n    @name ||= "nox"\n  end\nend\n',
  php: '<?php\nfunction greet(string $name): string {\n  return "hi $name";\n}\n',
};

/**
 * The seven added for A1-005 (2026-09-02): every one a legacy mode the
 * package already shipped while Nox opened the file as plain text.
 */
const SOURCE_2026_09: Record<string, string> = {
  csharp: 'using System;\n\nnamespace Nox {\n  public class Editor {\n    public string Name => "nox";\n  }\n}\n',
  kotlin: 'package nox\n\nfun main() {\n  val name = "nox"\n  println(name)\n}\n',
  swift: 'import Foundation\n\nstruct Editor {\n  let name = "nox"\n  func greet() -> String { return "hi \\(name)" }\n}\n',
  lua: '-- greet\nlocal function greet(name)\n  return "hi " .. name\nend\nprint(greet("nox"))\n',
  powershell: '# greet\nfunction Greet($name) {\n  Write-Output "hi $name"\n}\nGreet "nox"\n',
  ini: '; settings\n[editor]\nname = nox\ntabs = 2\n',
  dockerfile: 'FROM node:24\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["node", "index.js"]\n',
};

/** The classes `noxHighlightStyle` assigns across a parse of `doc`. */
async function highlightedClasses(languageId: string, doc: string): Promise<string[]> {
  const grammar = await loadLanguage(languageId);
  if (grammar === null) throw new Error(`no grammar for "${languageId}"`);

  const created = EditorState.create({ doc, extensions: [grammar] });
  // The initial parse runs on a wall-clock budget and stops at the first few
  // thousand characters, and `syntaxTree` keeps returning that stale snapshot
  // until a transaction re-snapshots it. Both steps are needed — see
  // `tests/folding.test.ts`, which failed under CPU contention with only the
  // first.
  const parsed = ensureSyntaxTree(created, created.doc.length, 10_000);
  if (parsed === null) throw new Error(`"${languageId}" did not finish parsing within 10s`);
  const state = created.update({}).state;

  const classes: string[] = [];
  highlightTree(syntaxTree(state), noxHighlightStyle, (_from, _to, className) => {
    classes.push(className);
  });
  return classes;
}

function describeGrammars(sources: Record<string, string>): void {
  for (const [languageId, doc] of Object.entries(sources)) {
    describe(languageId, () => {
      it('reports a grammar', () => {
        expect(hasGrammar(languageId)).toBe(true);
      });

      it('paints the source in more than one colour', async () => {
        const classes = await highlightedClasses(languageId, doc);

        // Several ranges, and more than one rule matched: a grammar that
        // parsed into tags the theme does not style would come back empty,
        // and one that only ever matched a comment would come back uniform.
        expect(classes.length).toBeGreaterThan(3);
        expect(new Set(classes).size).toBeGreaterThan(1);
      });
    });
  }
}

describe('the grammars added on 2026-08-26', () => {
  describeGrammars(SOURCE);
});

describe('the grammars added on 2026-09-02', () => {
  describeGrammars(SOURCE_2026_09);
});

describe('the language table and the grammar table', () => {
  it('leaves nothing named but unhighlighted except plain text', () => {
    const unhighlighted = LANGUAGES.filter((language) => !hasGrammar(language.id)).map(
      (language) => language.id,
    );

    // Plain text has no grammar because there is nothing to parse. Anything
    // else appearing here is a language Nox offers in the status bar and the
    // language picker and then renders flat, which is the state this file
    // exists to end. Adding a language with no parser available is a real
    // choice — make it here, out loud.
    expect(unhighlighted).toEqual(['plaintext']);
  });
});

describe('grammars that build no tree', () => {
  /**
   * The drift this closes.
   *
   * `hasSymbolStructure` answers before a grammar is loaded — the palette
   * needs it to choose a sentence, not to read a tree — so it cannot ask the
   * extension what it is and has to carry a list. A list beside the loaders
   * is a list that goes stale the next time one is added. This asserts the
   * list against the thing it is a list *of*: a loaded `StreamLanguage`.
   */
  it('are exactly the ones the palette is told cannot list symbols', async () => {
    for (const language of LANGUAGES) {
      if (!hasGrammar(language.id)) continue;

      const grammar = await loadLanguage(language.id);
      const isStream = grammar instanceof StreamLanguage;

      expect(hasSymbolStructure(language.id), `${language.id} is a stream parser: ${isStream}`).toBe(
        !isStream,
      );
    }
  });

  it('is false for a language with no grammar at all', () => {
    expect(hasSymbolStructure('plaintext')).toBe(false);
  });
});
