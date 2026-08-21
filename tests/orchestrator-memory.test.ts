import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The agent-side memory from `examples/`, exercised directly. The store is
// the part with logic in it; the adapter that drives it is covered over real
// pipes in `stdio.test.ts`.
// @ts-expect-error — an example, deliberately outside the typed source tree.
import { createMemory, formatRecall, remembering } from '../examples/orchestrators/memory.mjs';

describe('agent memory', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nox-memory-'));
    path = join(dir, 'nested', 'agent-memory.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the directory and appends one line per entry', () => {
    const memory = createMemory({ path, now: () => '2026-01-01T00:00:00.000Z' });

    memory.record({ workspace: '/w', instruction: 'rename the parser', summary: 'done' });
    memory.record({ workspace: '/w', instruction: 'add a test', summary: 'done' });

    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      workspace: '/w',
      instruction: 'rename the parser',
      summary: 'done',
    });
  });

  it('ranks by overlap and refuses to pad the result with unrelated entries', () => {
    const memory = createMemory({ path });
    memory.record({ workspace: '/w', instruction: 'rename the parser module', summary: 'renamed' });
    memory.record({ workspace: '/w', instruction: 'bump the icon sizes', summary: 'bumped' });

    const hits = memory.recall('rename the parser again');

    // Only the entry that actually shares words comes back. Returning the
    // icon one too — merely because it is recent — is the failure this
    // assertion exists to pin.
    expect(hits).toHaveLength(1);
    expect(hits[0].instruction).toBe('rename the parser module');
  });

  it('breaks ties towards the more recent entry', () => {
    const memory = createMemory({ path });
    memory.record({ workspace: '/w', instruction: 'fix the parser', summary: 'first' });
    memory.record({ workspace: '/w', instruction: 'fix the parser', summary: 'second' });

    expect(memory.recall('fix the parser')[0].summary).toBe('second');
  });

  it('scopes recall to one workspace', () => {
    const memory = createMemory({ path });
    memory.record({ workspace: '/a', instruction: 'rename the parser', summary: 'in a' });
    memory.record({ workspace: '/b', instruction: 'rename the parser', summary: 'in b' });

    expect(memory.recall('rename the parser', { workspace: '/b' })).toHaveLength(1);
    expect(memory.recall('rename the parser', { workspace: '/b' })[0].summary).toBe('in b');
    // With no workspace named, scoping is off rather than empty.
    expect(memory.recall('rename the parser')).toHaveLength(2);
  });

  it('drops a torn line instead of losing the history behind it', () => {
    const memory = createMemory({ path });
    memory.record({ workspace: '/w', instruction: 'rename the parser', summary: 'kept' });

    // What a process killed mid-write leaves behind.
    appendFileSync(path, '{"workspace":"/w","instruc', 'utf-8');

    expect(memory.read()).toHaveLength(1);
    expect(memory.recall('rename the parser')[0].summary).toBe('kept');
  });

  it('returns nothing for a query with no scoreable words', () => {
    const memory = createMemory({ path });
    memory.record({ workspace: '/w', instruction: 'rename the parser', summary: 'done' });

    expect(memory.recall('the and for')).toEqual([]);
    expect(memory.recall('')).toEqual([]);
  });

  it('formats recall as lines a model can read, and nothing at all when empty', () => {
    expect(formatRecall([])).toBe('');
    expect(
      formatRecall([{ at: '2026-01-01T00:00:00.000Z', instruction: 'rename it', summary: 'renamed' }]),
    ).toBe('\n\nEarlier in this workspace:\n- 2026-01-01T00:00:00.000Z: "rename it" → renamed');
  });

  it('records what happened rather than what was asked, and nothing when the inner throws', async () => {
    const memory = createMemory({ path });
    const read = async (method: string) =>
      method === 'context.workspaceTree' ? { root: '/w' } : null;

    const ok = remembering(
      async () => ({ edits: [], summary: 'looked, found nothing to change' }),
      memory,
    );
    await ok('have a look', '', [], read);

    const boom = remembering(async () => {
      throw new Error('the model fell over');
    }, memory);
    await expect(boom('have another look', '', [], read)).rejects.toThrow('the model fell over');

    const entries = memory.read();
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe('looked, found nothing to change');
    expect(entries[0].workspace).toBe('/w');
  });
});
