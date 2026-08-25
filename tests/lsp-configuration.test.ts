import { describe, expect, it } from 'vitest';
import {
  configurationItems,
  configurationReply,
  sectionValue,
} from '../src/core/lsp-configuration';

const SETTINGS = {
  python: {
    analysis: { typeCheckingMode: 'strict', extraPaths: ['./src'] },
    pythonPath: '/usr/bin/python3',
  },
  gopls: { 'ui.completion.usePlaceholders': true },
  emptyString: '',
  zero: 0,
  no: false,
  nested: { nulled: null },
};

describe('sectionValue', () => {
  it('walks a dotted path', () => {
    expect(sectionValue(SETTINGS, 'python.analysis.typeCheckingMode')).toBe('strict');
  });

  it('returns a whole sub-object for a partial path', () => {
    expect(sectionValue(SETTINGS, 'python.analysis')).toEqual({
      typeCheckingMode: 'strict',
      extraPaths: ['./src'],
    });
  });

  /** gopls asks with no section at all, meaning "everything you have". */
  it('returns everything for an absent section', () => {
    expect(sectionValue(SETTINGS, undefined)).toBe(SETTINGS);
    expect(sectionValue(SETTINGS, '')).toBe(SETTINGS);
  });

  it('answers null for an unknown section', () => {
    expect(sectionValue(SETTINGS, 'rust-analyzer')).toBeNull();
    expect(sectionValue(SETTINGS, 'python.analysis.nope')).toBeNull();
  });

  /**
   * A key whose literal name contains dots, which is how gopls spells its
   * options. The walk splits on `.`, so this resolves to null rather than to
   * the value — worth pinning as the known shape of the thing rather than
   * discovering it against a real gopls.
   */
  it('does not find a key whose own name contains dots', () => {
    expect(sectionValue(SETTINGS, 'gopls.ui.completion.usePlaceholders')).toBeNull();
    // The enclosing object still resolves, which is how such a server should
    // ask for them: section `gopls`, and read the dotted keys itself.
    expect(sectionValue(SETTINGS, 'gopls')).toEqual({ 'ui.completion.usePlaceholders': true });
  });

  /**
   * The failure this prevents: treating "falsy" as "missing". A user who set
   * `typeCheckingMode` to `""`, a count to `0` or a flag to `false` means
   * exactly that, and answering null instead silently restores the server's
   * default — the bug this whole handler exists to remove.
   */
  it('preserves falsy values that were really configured', () => {
    expect(sectionValue(SETTINGS, 'emptyString')).toBe('');
    expect(sectionValue(SETTINGS, 'zero')).toBe(0);
    expect(sectionValue(SETTINGS, 'no')).toBe(false);
  });

  it('answers null for a section reaching into a scalar or an array', () => {
    expect(sectionValue(SETTINGS, 'python.pythonPath.length')).toBeNull();
    expect(sectionValue(SETTINGS, 'python.analysis.extraPaths.0')).toBeNull();
  });

  it('answers null when there are no settings at all', () => {
    expect(sectionValue(undefined, 'python')).toBeNull();
    expect(sectionValue(null, 'python')).toBeNull();
    expect(sectionValue('not an object', 'python')).toBeNull();
  });

  /** Inherited keys are not settings. `constructor` is on every object. */
  it('does not resolve inherited properties', () => {
    expect(sectionValue(SETTINGS, 'constructor')).toBeNull();
    expect(sectionValue(SETTINGS, 'python.toString')).toBeNull();
  });
});

describe('configurationItems', () => {
  it('reads sections and scopes', () => {
    expect(configurationItems({ items: [{ section: 'python' }, { scopeUri: 'file:///w' }] })).toEqual(
      [{ section: 'python' }, { scopeUri: 'file:///w' }],
    );
  });

  it('is empty for a request that is not shaped like one', () => {
    expect(configurationItems(undefined)).toEqual([]);
    expect(configurationItems({})).toEqual([]);
    expect(configurationItems({ items: 'nope' })).toEqual([]);
  });

  it('keeps a place for an item it cannot read', () => {
    expect(configurationItems({ items: [null, { section: 'python' }] })).toEqual([
      {},
      { section: 'python' },
    ]);
  });
});

describe('configurationReply', () => {
  /**
   * The failure this prevents, and the reason the reply is a `map` rather than
   * a `filter`: a server reads the result **positionally**. Drop the unknown
   * middle section and `python.pythonPath`'s value lands on the question about
   * `rust-analyzer`, which reads as the user having misconfigured a setting
   * they never touched.
   */
  it('answers one value per item, in order, including for unknown sections', () => {
    const reply = configurationReply(
      {
        items: [
          { section: 'python.analysis.typeCheckingMode' },
          { section: 'rust-analyzer' },
          { section: 'python.pythonPath' },
        ],
      },
      SETTINGS,
    );

    expect(reply).toEqual(['strict', null, '/usr/bin/python3']);
  });

  it('answers nulls when the server has no settings block', () => {
    expect(configurationReply({ items: [{ section: 'a' }, { section: 'b' }] }, undefined)).toEqual([
      null,
      null,
    ]);
  });

  it('answers an empty array for an empty request', () => {
    expect(configurationReply({ items: [] }, SETTINGS)).toEqual([]);
  });
});
