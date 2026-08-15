import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import {
  AgentConfigService,
  AGENTS_FILE,
  AGENTS_TEMPLATE,
  isProcessAgent,
  runnableAgents,
  type AgentConfig,
  type OllamaAgentConfig,
  type ProcessAgentConfig,
} from '../src/services/agent/config';

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
    expect((config.agents.get()[0] as ProcessAgentConfig | undefined)?.args).toEqual(['ok']);
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

  it('produces a template that parses back into both example agents', async () => {
    const { platform, config } = await withFile(null);
    await config.ensureFile();
    await config.load();

    // The examples have to be valid, or the first thing a new user sees is an
    // error about the file Nox just wrote for them.
    expect(config.error.get()).toBeNull();
    expect(config.agents.get()).toHaveLength(2);
    expect(platform).toBeDefined();
  });
});

describe('ollama agents', () => {
  /**
   * The failure this prevents: requiring `kind` on every record, which would
   * make every existing agents.json in the wild stop loading on upgrade.
   */
  it('treats a record with no kind as a process agent', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile(
      'agents.json',
      JSON.stringify({ agents: [{ id: 'a', label: 'A', command: 'node' }] }),
    );

    const config = new AgentConfigService(platform);
    await config.load();

    expect(config.agents.get()).toHaveLength(1);
    expect(config.agents.get()[0]!.kind ?? 'process').toBe('process');
  });

  it('parses an ollama record', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile(
      'agents.json',
      JSON.stringify({
        agents: [
          { id: 'local', label: 'Qwen', kind: 'ollama',
            host: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b' },
        ],
      }),
    );

    const config = new AgentConfigService(platform);
    await config.load();

    const agent = config.agents.get()[0]!;
    expect(agent.kind).toBe('ollama');
    expect(agent).toMatchObject({ host: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b' });
  });

  /**
   * The failure this prevents: an ollama record missing its model loading as
   * a valid agent, so the failure surfaces as a confusing HTTP error at
   * session start rather than as a bad config file.
   */
  it('rejects an ollama record with no model', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile(
      'agents.json',
      JSON.stringify({ agents: [{ id: 'x', label: 'X', kind: 'ollama', host: 'http://127.0.0.1:11434' }] }),
    );

    const config = new AgentConfigService(platform);
    await config.load();

    expect(config.agents.get()).toEqual([]);
  });
});

describe('isProcessAgent', () => {
  // `runAgent` in app.ts uses this to filter the chooser down to agents it
  // can spawn as a subprocess. It is not unit-tested there — `runAgent` needs
  // a fully wired App (ui, platform, notifications, agent runtime) that is
  // out of scope for this file — so the predicate it depends on is pinned
  // directly here instead.

  /**
   * The failure this prevents: filtering on `kind === 'process'` instead of
   * `kind !== 'ollama'`, which would silently drop every agents.json written
   * before local models existed — none of them carry a `kind` at all.
   */
  it('still accepts a legacy record with no kind', () => {
    const legacy: ProcessAgentConfig = { id: 'a', label: 'A', command: 'node' };
    expect(isProcessAgent(legacy)).toBe(true);
  });

  it('rejects an ollama record', () => {
    const ollama: OllamaAgentConfig = {
      id: 'local',
      label: 'Qwen',
      kind: 'ollama',
      host: 'http://127.0.0.1:11434',
      model: 'qwen2.5-coder:7b',
    };
    expect(isProcessAgent(ollama)).toBe(false);
  });
});

describe('runnableAgents', () => {
  // `NoxApp.#runnableAgents()` and `AgentPanel.svelte` both call this instead
  // of re-deriving their own copy of the policy. Pinned here so the policy is
  // exercised without constructing a `NoxApp` — the thing the diff under
  // review left untested.

  const legacy: ProcessAgentConfig = { id: 'a', label: 'Legacy', command: 'node' };
  const ollamaWithProvider: OllamaAgentConfig = {
    id: 'local',
    label: 'Qwen',
    kind: 'ollama',
    host: 'http://127.0.0.1:11434',
    model: 'qwen2.5-coder:7b',
  };
  const ollamaWithoutProvider: OllamaAgentConfig = {
    id: 'unregistered',
    label: 'No provider',
    kind: 'ollama',
    host: 'http://127.0.0.1:11434',
    model: 'qwen2.5-coder:7b',
  };

  /**
   * The failure this prevents: re-deriving startability from `kind` instead
   * of reading `canSpawn`, which would silently offer every agents.json
   * written before local models existed even on a build that cannot spawn a
   * process — Task 3's compatibility guarantee, still load-bearing here.
   */
  it('runs a legacy record with no kind when canSpawn is true', () => {
    const result = runnableAgents([legacy], { canSpawn: true, providerIds: new Set() });
    expect(result).toEqual([legacy]);
  });

  /**
   * The failure this prevents: offering a process agent on a build that
   * cannot spawn one, which is exactly the bug this task exists to close —
   * a command offered and then refused.
   */
  it('excludes a legacy record with no kind when canSpawn is false', () => {
    const result = runnableAgents([legacy], { canSpawn: false, providerIds: new Set() });
    expect(result).toEqual([]);
  });

  /**
   * The failure this prevents: gating an ollama record on `canSpawn` (or on
   * `kind === 'ollama'` directly, naming the vendor at the boundary) instead
   * of on whether a provider was actually registered for its id.
   */
  it('runs an ollama record when a provider is registered for its id', () => {
    const result = runnableAgents([ollamaWithProvider], {
      canSpawn: false,
      providerIds: new Set(['local']),
    });
    expect(result).toEqual([ollamaWithProvider]);
  });

  /**
   * The failure this prevents: treating `canSpawn` as sufficient for an
   * ollama record too, which would offer a session against a model whose
   * provider was never registered (or was dropped by a reload) and fail at
   * start instead of never being offered.
   */
  it('excludes an ollama record with no registered provider, even when canSpawn is true', () => {
    const result = runnableAgents([ollamaWithoutProvider], {
      canSpawn: true,
      providerIds: new Set(),
    });
    expect(result).toEqual([]);
  });

  /**
   * The failure this prevents: building the result by iterating the provider
   * registry (or otherwise) instead of filtering the configured list in
   * place, which would reorder the chooser away from the order the user
   * wrote in agents.json.
   */
  it('preserves configured order', () => {
    const agents: AgentConfig[] = [ollamaWithProvider, legacy, ollamaWithoutProvider];
    const result = runnableAgents(agents, { canSpawn: true, providerIds: new Set(['local']) });
    expect(result).toEqual([ollamaWithProvider, legacy]);
  });
});
