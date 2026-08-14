import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { AgentConfigService, AGENTS_FILE, AGENTS_TEMPLATE } from '../src/services/agent/config';

async function withFile(contents: string | null) {
  const platform = new MemoryPlatform();
  if (contents !== null) await platform.writeConfigFile(AGENTS_FILE, contents);
  const config = new AgentConfigService(platform);
  await config.load();
  return { platform, config };
}

describe('reading agents.json', () => {
  it('reads a well-formed entry', async () => {
    const { config } = await withFile(
      JSON.stringify({
        agents: [{ id: 'mine', label: 'My Agent', command: 'node', args: ['agent.js'], cwd: '/w' }],
      }),
    );

    expect(config.agents.get()).toEqual([
      { id: 'mine', label: 'My Agent', command: 'node', args: ['agent.js'], cwd: '/w' },
    ]);
    expect(config.error.get()).toBeNull();
  });

  it('falls back to the id when no label is given', async () => {
    const { config } = await withFile(JSON.stringify({ agents: [{ id: 'mine', command: 'node' }] }));
    expect(config.agents.get()[0]?.label).toBe('mine');
  });

  it('treats a missing file as no agents, not an error', async () => {
    const { config } = await withFile(null);
    expect(config.agents.get()).toEqual([]);
    expect(config.error.get()).toBeNull();
  });

  it('reports a syntax error instead of looking empty', async () => {
    const { config } = await withFile('{ "agents": [ }');

    // A typo here would otherwise be indistinguishable from having configured
    // nothing, which is the one reading that sends someone hunting.
    expect(config.error.get()).not.toBeNull();
    expect(config.agents.get()).toEqual([]);
  });

  it('skips entries missing the two fields that cannot be defaulted', async () => {
    const { config } = await withFile(
      JSON.stringify({
        agents: [
          { label: 'No id', command: 'node' },
          { id: 'no-command', label: 'No command' },
          { id: 'good', command: 'node' },
        ],
      }),
    );

    expect(config.agents.get().map((agent) => agent.id)).toEqual(['good']);
  });

  it('says so when every entry was rejected', async () => {
    const { config } = await withFile(JSON.stringify({ agents: [{ label: 'incomplete' }] }));
    expect(config.error.get()).toMatch(/id and a command/);
  });

  it('keeps the first of two entries sharing an id', async () => {
    const { config } = await withFile(
      JSON.stringify({
        agents: [
          { id: 'dup', label: 'First', command: 'a' },
          { id: 'dup', label: 'Second', command: 'b' },
        ],
      }),
    );

    // Two agents on one id would share policy decisions and session labels.
    expect(config.agents.get()).toHaveLength(1);
    expect(config.agents.get()[0]?.label).toBe('First');
  });

  it('ignores a non-array agents field', async () => {
    const { config } = await withFile(JSON.stringify({ agents: 'node agent.js' }));
    expect(config.agents.get()).toEqual([]);
  });

  it('drops non-string args rather than passing them to a process', async () => {
    const { config } = await withFile(
      JSON.stringify({ agents: [{ id: 'a', command: 'node', args: ['ok', 7, null] }] }),
    );
    expect(config.agents.get()[0]?.args).toEqual(['ok']);
  });
});

describe('creating agents.json', () => {
  it('writes an example when there is no file', async () => {
    const { platform, config } = await withFile(null);
    await config.ensureFile();

    expect(await platform.readConfigFile(AGENTS_FILE)).toBe(AGENTS_TEMPLATE);
  });

  it('never overwrites a file that already has content', async () => {
    const mine = JSON.stringify({ agents: [{ id: 'mine', command: 'node' }] });
    const { platform, config } = await withFile(mine);

    await config.ensureFile();
    expect(await platform.readConfigFile(AGENTS_FILE)).toBe(mine);
  });

  it('replaces an empty file', async () => {
    const { platform, config } = await withFile('   ');
    await config.ensureFile();
    expect(await platform.readConfigFile(AGENTS_FILE)).toBe(AGENTS_TEMPLATE);
  });

  it('produces a template that parses back into one agent', async () => {
    const { platform, config } = await withFile(null);
    await config.ensureFile();
    await config.load();

    // The example has to be valid, or the first thing a new user sees is an
    // error about the file Nox just wrote for them.
    expect(config.error.get()).toBeNull();
    expect(config.agents.get()).toHaveLength(1);
    expect(platform).toBeDefined();
  });
});
