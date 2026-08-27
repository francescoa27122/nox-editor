import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import type { AgentProcess, PluginWorkerSpec } from '../src/platform/types';
import { PLUGIN_PROTOCOL_VERSION } from '../src/services/plugin/protocol';

/**
 * A plugin, from a folder on disk to a row in the palette.
 *
 * `tests/plugin-host.test.ts` drives the protocol against a fake connection;
 * this drives the *seam* — discovery reading a real (in-memory) directory, a
 * real `NoxApp` wiring the host to the real `CommandRegistry`, and the
 * contributed command reaching the same dispatcher the palette uses.
 *
 * The one thing faked is the worker, because Node has no `Worker` and a plugin
 * is only ever an object that moves lines anyway. Everything between the
 * `plugin.json` on disk and `commands.execute` is the shipping code.
 */

const CONFIG = '/cfg';

/** A worker that greets correctly and answers every invoke. */
function scriptedWorker() {
  const written: Record<string, unknown>[] = [];
  const buffered: string[] = [];
  let onLine: ((line: string) => void) | null = null;

  const emit = (message: unknown) => {
    const line = JSON.stringify(message);
    if (onLine) onLine(line);
    else buffered.push(line);
  };

  // Written in the tick it starts, before anyone is listening — which is what
  // the buffering above exists for, and what `AgentProcess.onLine` requires.
  emit({ id: 0, method: 'hello', params: { version: PLUGIN_PROTOCOL_VERSION } });

  const process: AgentProcess = {
    send: async (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      written.push(message);
      if (message.method === 'command.invoke') {
        emit({
          id: 500,
          method: 'command.execute',
          params: { commandId: 'view.toggleWordWrap' },
        });
        emit({ id: message.id, ok: true });
      }
    },
    onLine: (handler) => {
      onLine = handler;
      for (const line of buffered.splice(0)) handler(line);
    },
    onStderr: () => {},
    onExit: () => {},
    kill: async () => {},
  };

  return { process, written };
}

class PluginPlatform extends MemoryPlatform {
  worker = scriptedWorker();
  readonly startedWith: PluginWorkerSpec[] = [];

  override async configDir(): Promise<string | null> {
    return CONFIG;
  }

  override async startPluginWorker(spec: PluginWorkerSpec): Promise<AgentProcess> {
    this.startedWith.push(spec);
    return this.worker.process;
  }
}

let app: NoxApp | null = null;

afterEach(async () => {
  await app?.plugins.stopAll();
  app = null;
});

async function setup(manifest: unknown, source = '// a plugin\n') {
  const platform = new PluginPlatform();
  platform.mkdirp(`${CONFIG}/plugins/demo`);
  await platform.writeTextFile(`${CONFIG}/plugins/demo/plugin.json`, JSON.stringify(manifest));
  await platform.writeTextFile(`${CONFIG}/plugins/demo/main.js`, source);

  app = new NoxApp(platform);
  await app.loadPlugins();
  return { app, platform };
}

const MANIFEST = {
  id: 'demo',
  label: 'Demo Plugin',
  worker: 'main.js',
  commands: [{ name: 'greet', title: 'Say Hello' }],
};

describe('a plugin folder', () => {
  it('puts its command in the registry, under its own namespace', async () => {
    const { app: instance } = await setup(MANIFEST);

    const command = instance.commands.get('plugin.demo.greet');
    expect(command?.title).toBe('Say Hello');
    // The plugin's label groups it in the palette, so a row reads
    // "Demo Plugin: Say Hello" rather than sitting under a core category.
    expect(command?.category).toBe('Demo Plugin');
  });

  it('has not started anything yet', async () => {
    const { platform } = await setup(MANIFEST);

    expect(platform.startedWith).toHaveLength(0);
  });

  it('starts on the first invoke, and is handed its own source', async () => {
    const { app: instance, platform } = await setup(MANIFEST, '// hello from the plugin\n');

    await instance.commands.execute('plugin.demo.greet');

    expect(platform.startedWith).toHaveLength(1);
    expect(platform.startedWith[0]?.source).toContain('hello from the plugin');
  });

  it('reaches a real command through the real dispatcher', async () => {
    const { app: instance } = await setup(MANIFEST);
    const before = instance.config.get('editor.wordWrap');

    await instance.commands.execute('plugin.demo.greet');

    // `view.toggleWordWrap` is a genuine Nox command with a visible effect,
    // executed by the plugin over the wire. Nothing about this path is a
    // plugin-shaped copy of the real one — it *is* the real one.
    await vi.waitFor(() => expect(instance.config.get('editor.wordWrap')).toBe(!before));
  });
});

describe('a folder that is not a usable plugin', () => {
  it('is skipped, and does not stop the ones that are', async () => {
    const platform = new PluginPlatform();
    platform.mkdirp(`${CONFIG}/plugins/broken`);
    await platform.writeTextFile(`${CONFIG}/plugins/broken/plugin.json`, '{ not json');
    platform.mkdirp(`${CONFIG}/plugins/demo`);
    await platform.writeTextFile(`${CONFIG}/plugins/demo/plugin.json`, JSON.stringify(MANIFEST));
    await platform.writeTextFile(`${CONFIG}/plugins/demo/main.js`, '');

    app = new NoxApp(platform);
    await app.loadPlugins();

    expect(app.commands.get('plugin.demo.greet')).toBeDefined();
    // Said out loud rather than swallowed: a plugin that silently does not
    // appear is indistinguishable from one that appeared and does nothing.
    expect(app.notifications.items.get().some((n) => /could not be loaded/i.test(n.message))).toBe(
      true,
    );
  });

  it('cannot claim a command id outside its own namespace', async () => {
    const { app: instance } = await setup({
      ...MANIFEST,
      commands: [{ name: 'save', title: 'Not File Save' }],
    });

    // The core command is untouched, and the plugin's lives beside it.
    expect(instance.commands.get('file.save')?.title).not.toBe('Not File Save');
    expect(instance.commands.get('plugin.demo.save')?.title).toBe('Not File Save');
  });
});
