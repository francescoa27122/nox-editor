import { describe, expect, it, vi } from 'vitest';
import { parseManifest, type PluginManifest } from '../src/core/plugin-manifest';
import { CommandRegistry } from '../src/services/commands';
import { CAPABILITIES } from '../src/services/permissions';
import { PLUGIN_PROTOCOL_VERSION, type Inbound } from '../src/services/plugin/protocol';
import { PluginHost, type PluginConnection } from '../src/services/plugin/host';

/**
 * The plugin host: discovery to invocation, with nothing real behind it.
 *
 * No worker and no child process anywhere in this file. The host takes a
 * `connect` function, exactly as `services/agent/stdio.ts` takes an
 * `AgentProcess` rather than a command line — which is what lets the cases
 * worth testing be *written* instead of staged: a plugin that never answers,
 * one that speaks the wrong protocol version, one that dies mid-command, one
 * that asks for something it did not declare.
 */

function manifestFor(over: Record<string, unknown> = {}): PluginManifest {
  const parsed = parseManifest(
    {
      id: 'demo',
      label: 'Demo',
      worker: 'main.js',
      commands: [{ name: 'run', title: 'Run Demo' }],
      ...over,
    },
    new Set<string>(CAPABILITIES),
  );
  if (!parsed.ok) throw new Error(`fixture manifest is invalid: ${parsed.reason}`);
  return parsed.manifest;
}

/** A plugin that is a function from request to reply, and a record of both. */
function fakePlugin(
  reply: (message: Record<string, unknown>, send: (m: Inbound) => void) => void,
) {
  const written: Record<string, unknown>[] = [];
  let onLine: ((line: string) => void) | null = null;
  let onExit: ((code: number | null) => void) | null = null;
  let killed = false;

  /**
   * Lines written before anyone is listening.
   *
   * `AgentProcess.onLine` requires this of every real implementation, in those
   * words: *"Anything produced before a handler is attached must be buffered
   * and delivered when one is."* A plugin writes its greeting in the same tick
   * it starts, well before the host has the connection back to subscribe to —
   * so a fake that drops those lines is not a fake of the contract, and every
   * handshake in this file failed until it buffered.
   */
  const pending: string[] = [];
  const emit = (line: string) => {
    if (onLine) onLine(line);
    else pending.push(line);
  };

  const connection: PluginConnection = {
    send: async (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      written.push(message);
      reply(message, (m) => emit(JSON.stringify(m)));
    },
    onLine: (handler) => {
      onLine = handler;
      for (const line of pending.splice(0)) handler(line);
    },
    onStderr: () => {},
    onExit: (handler) => {
      onExit = handler;
    },
    kill: async () => {
      killed = true;
    },
  };

  return {
    connection,
    written,
    get killed() {
      return killed;
    },
    /** Make the plugin die, as a crash or a clean exit would. */
    die: (code: number | null = 1) => onExit?.(code),
    push: (m: Inbound) => emit(JSON.stringify(m)),
  };
}

/** The ordinary plugin: greets correctly, answers every invoke. */
function wellBehaved() {
  return fakePlugin((message, send) => {
    const id = message.id as number;
    if (message.method === 'command.invoke') send({ id, ok: true, result: 'done' });
  });
}

interface HarnessOptions {
  manifest?: PluginManifest;
  plugin?: ReturnType<typeof fakePlugin>;
  greeting?: number | 'silent';
  deny?: boolean;
}

function setup(options: HarnessOptions = {}) {
  const commands = new CommandRegistry();
  const plugin = options.plugin ?? wellBehaved();
  const notifications: { title: string; detail?: string }[] = [];

  if (options.deny) {
    commands.setGuard(async (_command, principal) => {
      if (principal.kind !== 'user') throw new Error('Denied by policy');
    });
  }

  const host = new PluginHost({
    commands,
    context: {
      reader: () => ({
        openBuffers: () => [],
        bufferText: () => 'text',
        selection: () => null,
      }),
    },
    stage: () => true,
    notify: (title, detail) => notifications.push({ title, detail }),
    connect: async () => {
      // The greeting arrives unprompted, the way a real plugin's does: it is
      // the first thing written, before anything is asked of it.
      const version = options.greeting ?? PLUGIN_PROTOCOL_VERSION;
      if (version !== 'silent') {
        queueMicrotask(() => plugin.push({ id: 0, method: 'hello', params: { version } }));
      }
      return plugin.connection;
    },
    handshakeTimeoutMs: 50,
    invokeTimeoutMs: 50,
  });

  host.load([{ manifest: options.manifest ?? manifestFor(), directory: '/w/.nox/plugins/demo' }]);
  return { host, commands, plugin, notifications };
}

describe('contributed commands', () => {
  it('are registered from the manifest, before anything is started', () => {
    const { commands, plugin } = setup();

    expect(commands.get('plugin.demo.run')?.title).toBe('Run Demo');
    // Nothing has run. A plugin that has to start to say what it offers is a
    // plugin every launch pays for, on an editor whose thesis is starting
    // fast.
    expect(plugin.written).toHaveLength(0);
  });

  it('carry the capabilities the manifest declared, and no others', () => {
    const { commands } = setup({ manifest: manifestFor({ capabilities: ['fs.read'] }) });

    expect(commands.get('plugin.demo.run')?.capabilities).toEqual(['fs.read']);
  });

  it('declare nothing when the manifest declares nothing', () => {
    // Absent, not empty: `Command.capabilities` documents absence as "nothing
    // with a side effect", and an empty array would be a different claim
    // written in the same place.
    expect(setup().commands.get('plugin.demo.run')?.capabilities).toBeUndefined();
  });

  it('start the plugin the first time one is invoked, and not again after', async () => {
    const { commands, plugin } = setup();

    await commands.execute('plugin.demo.run');
    await commands.execute('plugin.demo.run');

    const invokes = plugin.written.filter((m) => m.method === 'command.invoke');
    expect(invokes).toHaveLength(2);
    expect(invokes[0]?.params).toEqual({ name: 'run' });
  });
});

describe('the handshake', () => {
  it('refuses a plugin speaking a protocol Nox does not', async () => {
    const { commands, host, notifications } = setup({ greeting: PLUGIN_PROTOCOL_VERSION + 1 });

    await commands.execute('plugin.demo.run');

    expect(host.stateOf('demo')).toBe('failed');
    expect(notifications.map((n) => n.detail).join(' ')).toContain('protocol');
  });

  it('gives up on one that never introduces itself', async () => {
    const { commands, host } = setup({ greeting: 'silent' });

    await commands.execute('plugin.demo.run');

    // The failure this prevents is `stdio.ts`'s: with no deadline, a plugin
    // that starts and says nothing leaves the command hanging for the life of
    // the app.
    expect(host.stateOf('demo')).toBe('failed');
  });
});

describe('what a plugin may ask for', () => {
  it('reaches a command through the dispatcher, under its own principal', async () => {
    const seen: string[] = [];
    const plugin = fakePlugin((message, send) => {
      const id = message.id as number;
      if (message.method === 'command.invoke') {
        send({ id: 99, method: 'command.execute', params: { commandId: 'demo.target' } });
        send({ id, ok: true });
      }
    });
    const { commands } = setup({ plugin });
    commands.register({
      id: 'demo.target',
      title: 'Target',
      run: () => {
        seen.push('ran');
      },
    });

    await commands.execute('plugin.demo.run');
    await vi.waitFor(() => expect(seen).toEqual(['ran']));
  });

  it('is refused when the policy denies it, and told so', async () => {
    const plugin = fakePlugin((message, send) => {
      const id = message.id as number;
      if (message.method === 'command.invoke') {
        send({ id: 99, method: 'command.execute', params: { commandId: 'demo.target' } });
        send({ id, ok: true });
      }
    });
    const { commands, plugin: fake } = setup({ plugin, deny: true });
    // Declaring a capability is what puts a command behind the guard at all
    // (`commands.ts`: the check runs only `if (command.capabilities?.length)`).
    // A command that declares nothing has no side effect to gate, so a
    // target without one would be allowed through and prove nothing.
    commands.register({
      id: 'demo.target',
      title: 'Target',
      capabilities: ['fs.write'],
      run: () => {},
    });

    await commands.execute('plugin.demo.run');

    await vi.waitFor(() => {
      const refusal = fake.written.find((r) => r.id === 99);
      expect(refusal).toMatchObject({ ok: false });
    });
  });

  it('gets `unknown-method` for something the protocol does not have', async () => {
    const plugin = fakePlugin((message, send) => {
      const id = message.id as number;
      if (message.method === 'command.invoke') {
        send({ id: 7, method: 'fs.writeWhateverIWant' } as never);
        send({ id, ok: true });
      }
    });
    const { commands, plugin: fake } = setup({ plugin });

    await commands.execute('plugin.demo.run');

    await vi.waitFor(() => {
      expect(fake.written.find((r) => r.id === 7)).toMatchObject({
        ok: false,
        error: { code: 'unknown-method' },
      });
    });
  });
});

describe('when a plugin fails', () => {
  it('survives a crash mid-command and stays invokable', async () => {
    const plugin = fakePlugin((message) => {
      if (message.method === 'command.invoke') plugin.die(1);
    });
    const { commands, host } = setup({ plugin });

    await commands.execute('plugin.demo.run');

    expect(host.stateOf('demo')).toBe('failed');
    // Still there. One crash is an accident, and a command that vanishes on
    // the first one cannot be retried after the author fixes it.
    expect(commands.get('plugin.demo.run')).toBeDefined();
  });

  it('is disabled after repeated failure, and its commands go with it', async () => {
    const { commands, host, notifications } = setup({ greeting: 'silent' });

    await commands.execute('plugin.demo.run');
    await commands.execute('plugin.demo.run');
    await commands.execute('plugin.demo.run');

    expect(host.stateOf('demo')).toBe('disabled');
    // A command that is certain to fail is worse than an absent one: it is a
    // row in the palette that lies about what the editor can do.
    expect(commands.get('plugin.demo.run')).toBeUndefined();
    expect(notifications.some((n) => n.title.includes('disabled'))).toBe(true);
  });
});

describe('stopping', () => {
  it('kills what is running and takes every command back', async () => {
    const { commands, host, plugin } = setup();
    await commands.execute('plugin.demo.run');

    await host.stopAll();

    expect(plugin.killed).toBe(true);
    expect(commands.get('plugin.demo.run')).toBeUndefined();
  });

  it('can be reloaded onto a clean registry afterwards', async () => {
    const { commands, host } = setup();
    await host.stopAll();

    // The duplicate-id throw in `CommandRegistry.register` makes this the case
    // that matters: a reload that did not release the first registration
    // would take the whole app down rather than replace a plugin.
    host.load([{ manifest: manifestFor(), directory: '/w/.nox/plugins/demo' }]);
    expect(commands.get('plugin.demo.run')).toBeDefined();
  });
});
