import { describe, expect, it } from 'vitest';
import {
  applyProgress,
  progressEvent,
  progressLabel,
  progressToken,
  type WorkDone,
} from '../src/core/lsp-progress';

const begin = (token: unknown, title: string, extra: Record<string, unknown> = {}) => ({
  token,
  value: { kind: 'begin', title, ...extra },
});

describe('progressToken', () => {
  /**
   * The failure this prevents: a server using `1` and `"1"` for two different
   * pieces of work, and one of them ending the other. The specification allows
   * both types, so keeping the type in the key is not paranoia.
   */
  it('keeps a numeric token distinct from the same digits as a string', () => {
    expect(progressToken(1)).not.toBe(progressToken('1'));
  });

  it('refuses anything that is not a token', () => {
    expect(progressToken(undefined)).toBeNull();
    expect(progressToken(null)).toBeNull();
    expect(progressToken({})).toBeNull();
    expect(progressToken(Number.NaN)).toBeNull();
  });
});

describe('progressEvent', () => {
  it('reads a begin with everything', () => {
    expect(
      progressEvent(begin('t', 'Indexing', { message: '1/840', percentage: 12 })),
    ).toMatchObject({ kind: 'begin', title: 'Indexing', message: '1/840', percentage: 12 });
  });

  it('reads a report and an end', () => {
    expect(progressEvent({ token: 't', value: { kind: 'report', percentage: 40 } })).toMatchObject({
      kind: 'report',
      percentage: 40,
    });
    expect(progressEvent({ token: 't', value: { kind: 'end', message: 'done' } })).toMatchObject({
      kind: 'end',
    });
  });

  it('refuses a begin with no title, because there would be nothing to show', () => {
    expect(progressEvent(begin('t', '   '))).toBeNull();
    expect(progressEvent({ token: 't', value: { kind: 'begin' } })).toBeNull();
  });

  /**
   * `$/progress` also carries *partial result* progress, which has no `kind`
   * at all. It is a different feature and guessing at it would put streamed
   * search results in the status bar.
   */
  it('ignores progress that is not work-done progress', () => {
    expect(progressEvent({ token: 't', value: [1, 2, 3] })).toBeNull();
    expect(progressEvent({ token: 't', value: { items: [] } })).toBeNull();
  });

  it('clamps a percentage rather than trusting it', () => {
    expect(progressEvent(begin('t', 'x', { percentage: 140 }))).toMatchObject({ percentage: 100 });
    expect(progressEvent(begin('t', 'x', { percentage: -3 }))).toMatchObject({ percentage: 0 });
    expect(progressEvent(begin('t', 'x', { percentage: 'nope' }))).not.toHaveProperty('percentage');
  });
});

describe('applyProgress', () => {
  const start = (token: unknown, title: string) =>
    applyProgress(new Map(), progressEvent(begin(token, title))!);

  it('adds, updates and removes', () => {
    let state = start('t', 'Indexing');
    expect([...state.values()]).toEqual([{ title: 'Indexing' }]);

    state = applyProgress(
      state,
      progressEvent({ token: 't', value: { kind: 'report', percentage: 50 } })!,
    );
    expect([...state.values()]).toEqual([{ title: 'Indexing', percentage: 50 }]);

    state = applyProgress(state, progressEvent({ token: 't', value: { kind: 'end' } })!);
    expect(state.size).toBe(0);
  });

  /**
   * The failure this prevents: a keep-alive `report` — one with neither a
   * message nor a percentage — blanking what the last one said, so the status
   * line flickers between "Indexing 3/840" and "Indexing".
   */
  it('does not let an empty report blank what is already known', () => {
    let state = applyProgress(
      start('t', 'Indexing'),
      progressEvent({ token: 't', value: { kind: 'report', message: '3/840', percentage: 20 } })!,
    );
    state = applyProgress(state, progressEvent({ token: 't', value: { kind: 'report' } })!);

    expect([...state.values()]).toEqual([{ title: 'Indexing', message: '3/840', percentage: 20 }]);
  });

  /**
   * A report for work that never began is dropped rather than invented. It
   * really happens: a restart can process the `end` while a `report` from the
   * old process is still in flight, and the alternative is a status line with
   * a percentage and no title.
   */
  it('drops a report for a token that never began', () => {
    const state = applyProgress(
      new Map(),
      progressEvent({ token: 'ghost', value: { kind: 'report', percentage: 40 } })!,
    );
    expect(state.size).toBe(0);
  });

  it('never mutates what it was given, because a Signal reads by identity', () => {
    const before = start('t', 'Indexing');
    const after = applyProgress(before, progressEvent(begin('u', 'Building'))!);
    expect(before.size).toBe(1);
    expect(after.size).toBe(2);
    expect(after).not.toBe(before);
  });

  it('keeps two tokens apart', () => {
    let state = applyProgress(start('t', 'Indexing'), progressEvent(begin('u', 'Building'))!);
    state = applyProgress(state, progressEvent({ token: 't', value: { kind: 'end' } })!);
    expect([...state.values()]).toEqual([{ title: 'Building' }]);
  });
});

describe('progressLabel', () => {
  const work = (over: Partial<WorkDone> = {}): WorkDone => ({ title: 'Indexing', ...over });

  it('is null when nothing is in flight', () => {
    expect(progressLabel([])).toBeNull();
  });

  it('is the title alone when that is all there is', () => {
    expect(progressLabel([work()])).toBe('Indexing');
  });

  it('appends the message and the percentage', () => {
    expect(progressLabel([work({ message: '3/840 (core)', percentage: 20 })])).toBe(
      'Indexing 3/840 (core) 20%',
    );
  });

  it('rounds a fractional percentage rather than rendering it', () => {
    expect(progressLabel([work({ percentage: 19.6 })])).toBe('Indexing 20%');
  });

  /** A server that repeats its title as the message would otherwise say it twice. */
  it('does not repeat the title as its own message', () => {
    expect(progressLabel([work({ message: 'Indexing' })])).toBe('Indexing');
    expect(progressLabel([work({ message: '   ' })])).toBe('Indexing');
  });

  /** The oldest is the one being waited on. */
  it('names the first of several', () => {
    expect(progressLabel([work({ title: 'Indexing' }), work({ title: 'Building' })])).toBe(
      'Indexing',
    );
  });
});
