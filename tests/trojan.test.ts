import { describe, expect, it } from 'vitest';
import { concernsIn, findHidden, hasMixedScript, revealHidden } from '../src/core/trojan';

/**
 * The review panel's defence against text that reads one way and is stored
 * another (the "Trojan Source" class, CVE-2021-42574).
 *
 * These guard A7-007: before the detector, a hunk line was rendered as a text
 * node with `white-space: pre`, so a bidi override put the characters on
 * screen in the order the override dictated, not the order the file would
 * hold, and a zero-width character inside an identifier was invisible. The
 * samples are the paper's own shapes, written out with escapes so that the
 * source of this test is not itself one of them.
 *
 * What they do not catch: a homoglyph in a script this does not pair with
 * Latin (Armenian, Cherokee), and anything the editor itself renders. The
 * defence is the panel's, because that is where a human is relying on the
 * rendering to decide.
 */

const RLO = '\u202E';
const LRI = '\u2066';
const PDI = '\u2069';

describe('findHidden', () => {
  it('finds nothing in ordinary code', () => {
    expect(findHidden('if (isAdmin) {\n  return true;\n}')).toEqual([]);
    expect(findHidden('const greeting = "héllo, wörld";')).toEqual([]);
  });

  it('finds every bidi control with its position and code point', () => {
    // Trojan Source "early return": the comment closes visually after the
    // return, but the file holds the return inside the comment.
    const line = `/*${RLO} } ${LRI}if (isAdmin)${PDI} ${LRI} begin admins only */`;
    const found = findHidden(line);
    expect(found.map((hit) => hit.kind)).toEqual(['bidi', 'bidi', 'bidi', 'bidi']);
    expect(found.map((hit) => hit.codePoint.toString(16))).toEqual(['202e', '2066', '2069', '2066']);
    expect(found[0]).toEqual({ index: 2, codePoint: 0x202e, kind: 'bidi' });
  });

  it('finds zero-width characters, including a BOM away from the start', () => {
    const found = findHidden('is\u200BAdmin = user\u200D.role\uFEFF;');
    expect(found).toEqual([
      { index: 2, codePoint: 0x200b, kind: 'zero-width' },
      { index: 15, codePoint: 0x200d, kind: 'zero-width' },
      { index: 21, codePoint: 0xfeff, kind: 'zero-width' },
    ]);
  });

  it('reports the whole range of controls the paper uses', () => {
    for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(findHidden(`a${String.fromCodePoint(code)}b`)).toHaveLength(1);
    }
    for (const code of [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]) {
      expect(findHidden(`a${String.fromCodePoint(code)}b`)).toHaveLength(1);
    }
  });
});

describe('hasMixedScript', () => {
  it('passes a plain Latin identifier and a plain Cyrillic one', () => {
    expect(hasMixedScript('sayHello')).toBe(false);
    expect(hasMixedScript('привет_мир')).toBe(false);
    expect(hasMixedScript('const π = 3.14;')).toBe(false);
  });

  it('flags a Latin word carrying a Cyrillic or Greek look-alike', () => {
    // Cyrillic small a (U+0430) in place of Latin a.
    expect(hasMixedScript('sаyHello')).toBe(true);
    // Greek omicron (U+03BF) in place of Latin o.
    expect(hasMixedScript('lοgin')).toBe(true);
  });

  it('does not flag two scripts in separate words', () => {
    // A Cyrillic word beside a Latin one is prose, not a disguise.
    expect(hasMixedScript('return "привет"; // greeting')).toBe(false);
  });

  it('leaves Han beside Latin alone, because that is how CJK code is written', () => {
    expect(hasMixedScript('const 変数name = 1;')).toBe(false);
  });
});

describe('concernsIn', () => {
  it('is empty for ordinary lines', () => {
    expect(concernsIn(['a\n', 'b\n'])).toEqual([]);
  });

  it('names each concern once, bidi first', () => {
    expect(concernsIn([`x\u200By\n`, `/*${RLO}*/\n`, 'sаy\n', `z${LRI}\n`])).toEqual([
      'bidi',
      'zero-width',
      'mixed-script',
    ]);
  });
});

describe('revealHidden', () => {
  it('leaves ordinary text exactly as it is', () => {
    const text = 'const greeting = "héllo";';
    expect(revealHidden(text)).toBe(text);
  });

  it('replaces each hidden character with its code point, in place', () => {
    expect(revealHidden(`a${RLO}b\u200Bc`)).toBe('a<U+202E>b<U+200B>c');
  });

  it('reveals the joiner in an emoji sequence too, which is the cost of seeing every one', () => {
    // A known false positive, kept: a review must show every invisible
    // character, and a family emoji in a proposed string is rare enough that
    // seeing `<U+200D>` there is a price worth paying.
    expect(revealHidden('👨\u200D👩')).toBe('👨<U+200D>👩');
  });
});
