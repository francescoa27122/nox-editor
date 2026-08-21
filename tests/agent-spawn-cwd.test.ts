import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import type { AgentProcess, AgentProcessSpec, PlatformCapabilities } from '../src/platform/types';
import { AGENTS_FILE } from '../src/services/agent/config';

/**
 * Where a process agent is started from.
 *
 * `AgentProcessSpec.cwd` is documented as defaulting to the workspace root,
 * and until 2026-08-21 nothing implemented that default: with no `cwd` in
 * `agents.json` the child inherited whatever directory Nox itself was
 * launched from — `/` from Finder — which makes the relative `./my-agent.js`
 * in `AGENTS_TEMPLATE` resolve somewhere different every launch. Nothing in
 * the suite observed `spawnAgent` at all, which is why it stayed invisible;
 * this file is the observation.
 *
 * Mutation-checked on 2026-08-21: the root test fails without the default at
 * all (the bug as found); the no-folder test fails when the field is written
 * unconditionally (`cwd: cwd ?? ''`); the explicit-cwd test fails when the
 * root is preferred over the record.
 */

/** An agent process that is already over, so the handshake fails at once. */
class DeadProcess implements AgentProcess {
  async send(): Promise<void> {}
  onLine(): void {}
  onStderr(): void {}
  onExit(handler: (code: number | null) => void): void {
    handler(0);
  }
  async kill(): Promise<void> {}
}

/** A platform that can spawn, and remembers what it was asked to spawn. */
class SpawningPlatform extends MemoryPlatform {
  override readonly capabilities: PlatformCapabilities = {
    ...new MemoryPlatform().capabilities,
    agentProcesses: true,
  };

  readonly spawned: AgentProcessSpec[] = [];

  override async spawnAgent(spec: AgentProcessSpec): Promise<AgentProcess> {
    this.spawned.push(spec);
    return new DeadProcess();
  }
}

let app: NoxApp | null = null;

afterEach(() => {
  app = null;
});

async function setup(record: Record<string, unknown>, root: string | null) {
  const platform = new SpawningPlatform();
  await platform.writeConfigFile(AGENTS_FILE, JSON.stringify({ agents: [record] }));
  app = new NoxApp(platform);
  await app.agentConfig.load();
  if (root) {
    platform.mkdirp(root);
    await app.workspace.openFolder(root);
  }
  return { app, platform };
}

/** Run the agent and answer the instruction prompt the way the dialog would. */
async function ask(instance: NoxApp): Promise<void> {
  const done = instance.runAgent('mine');
  for (let i = 0; i < 20 && !instance.ui.prompt.get(); i++) await Promise.resolve();
  instance.ui.prompt.get()!.resolve('rename Task to Job');
  await done;
}

describe('starting a process agent', () => {
  it('runs it in the workspace root when agents.json names no cwd', async () => {
    const { app: instance, platform } = await setup({ id: 'mine', command: 'node' }, '/w');
    await ask(instance);

    expect(platform.spawned).toHaveLength(1);
    expect(platform.spawned[0]!.cwd).toBe('/w');
  });

  it('leaves cwd out when no folder is open', async () => {
    const { app: instance, platform } = await setup({ id: 'mine', command: 'node' }, null);
    await ask(instance);

    expect(platform.spawned).toHaveLength(1);
    // Absent rather than null or '': the spec's field is optional, and the
    // platform reads "not given" as "inherit", which is all that is left to
    // do when there is no project to run in.
    expect(platform.spawned[0]).not.toHaveProperty('cwd');
  });

  it('keeps a cwd the record asked for', async () => {
    const { app: instance, platform } = await setup(
      { id: 'mine', command: 'node', cwd: '/elsewhere' },
      '/w',
    );
    await ask(instance);

    expect(platform.spawned[0]!.cwd).toBe('/elsewhere');
  });
});
