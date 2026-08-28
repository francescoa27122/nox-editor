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
  /** Effective plugin settings, by plugin id. */
  settings?: Record<string, Record<string, boolean | number | string>>;
}

function setup(options: HarnessOptions = {}) {
  const commands = new CommandRegistry();
  const plugin = options.plugin ?? wellBehaved();
  const notifications: { title: string; detail?: string }[] = [];
  const shown: string[] = [];

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
    settings: {
      // Keyed by plugin id, the way the real service is — so a test can prove
      // a plugin is told its own values and never another's.
      valuesFor: (pluginId: string) => options.settings?.[pluginId] ?? {},
    },
    notify: (title, detail) => notifications.push({ title, detail }),
    showPanel: (viewId) => shown.push(viewId),
    documentLength: () => 100,
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
    changeDebounceMs: 10,
  });

  host.load([{ manifest: options.manifest ?? manifestFor(), directory: '/w/.nox/plugins/demo' }]);
  return { host, commands, plugin, notifications, shown };
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

describe('status items', () => {
  /** A plugin that puts something on the bar as soon as it is running. */
  function announcer(text = 'ready') {
    return fakePlugin((message, send) => {
      const id = message.id as number;
      if (message.method === 'command.invoke') {
        send({ id: 42, method: 'status.set', params: { name: 'state', text } });
        send({ id, ok: true });
      }
    });
  }

  it('appear on the bar, namespaced to the plugin', async () => {
    const { commands, host } = setup({ plugin: announcer() });

    await commands.execute('plugin.demo.run');

    await vi.waitFor(() => {
      expect(host.status.items.get()).toHaveLength(1);
      expect(host.status.items.get()[0]?.id).toBe('plugin.demo.state');
    });
  });

  it('are taken back when the plugin dies', async () => {
    const plugin = announcer();
    const { commands, host } = setup({ plugin });

    await commands.execute('plugin.demo.run');
    await vi.waitFor(() => expect(host.status.items.get()).toHaveLength(1));

    plugin.die(1);

    // A readout stops being true the moment the thing reporting it stops, and
    // there is nothing left running to correct it.
    expect(host.status.items.get()).toEqual([]);
  });

  it('are taken back when the plugin is stopped', async () => {
    const { commands, host } = setup({ plugin: announcer() });
    await commands.execute('plugin.demo.run');
    await vi.waitFor(() => expect(host.status.items.get()).toHaveLength(1));

    await host.stopAll();

    expect(host.status.items.get()).toEqual([]);
  });
});

describe('activation', () => {
  it('leaves a `command` plugin alone until one is invoked', () => {
    const { plugin } = setup();

    expect(plugin.written).toHaveLength(0);
  });

  it('starts a `startup` plugin at load, because its items need it running', async () => {
    const plugin = fakePlugin(() => {});
    const { host } = setup({ manifest: manifestFor({ activation: 'startup' }), plugin });

    // A status item's content is only known to running code, so a plugin that
    // sets one can never be woken by a command the way a lazy one is.
    await vi.waitFor(() => expect(host.stateOf('demo')).toBe('running'));
  });
});

describe('panels', () => {
  const WITH_PANEL = { panels: [{ name: 'issues', title: 'Issues' }] };

  /** A plugin that fills its panel when told it is being looked at. */
  function filler() {
    return fakePlugin((message, send) => {
      const id = message.id as number;
      if (message.method === 'panel.show') {
        send({
          id: 77,
          method: 'panel.set',
          params: { name: 'issues', rows: [{ text: 'One problem' }] },
        });
        send({ id, ok: true });
      }
    });
  }

  it('registers a focus command from the manifest, before anything runs', () => {
    const { commands, plugin } = setup({ manifest: manifestFor(WITH_PANEL) });

    expect(commands.get('plugin.demo.issues')?.title).toBe('Show Issues');
    // The whole point of declaring panels: the rail button exists before the
    // plugin does, so a plugin with a panel stays as lazy as one without.
    expect(plugin.written).toHaveLength(0);
  });

  it('switches the sidebar and starts the plugin when that command runs', async () => {
    const { commands, shown, plugin } = setup({ manifest: manifestFor(WITH_PANEL), plugin: filler() });

    await commands.execute('plugin.demo.issues');

    expect(shown).toEqual(['plugin.demo.issues']);
    await vi.waitFor(() =>
      expect(plugin.written.some((m) => m.method === 'panel.show')).toBe(true),
    );
  });

  it('takes the rows the plugin answers with', async () => {
    const { host, commands } = setup({ manifest: manifestFor(WITH_PANEL), plugin: filler() });

    await commands.execute('plugin.demo.issues');

    await vi.waitFor(() =>
      expect(host.panels.contents.get().get('plugin.demo.issues')?.rows).toEqual([
        { text: 'One problem' },
      ]),
    );
  });

  it('empties them when the plugin dies', async () => {
    const plugin = filler();
    const { host, commands } = setup({ manifest: manifestFor(WITH_PANEL), plugin });
    await commands.execute('plugin.demo.issues');
    await vi.waitFor(() => expect(host.panels.contents.get().size).toBe(1));

    plugin.die(1);

    // The rail button stays — it came from the manifest and the panel can be
    // refilled. What goes is content that stopped being true.
    expect(host.panels.contents.get().size).toBe(0);
  });
});

describe('decorations', () => {
  /** A plugin that decorates on demand, and again whenever told to. */
  function decorator() {
    return fakePlugin((message, send) => {
      const id = message.id as number;
      if (message.method === 'command.invoke' || message.method === 'document.changed') {
        send({
          id: 900,
          method: 'editor.decorate',
          params: { bufferId: 'b1', ranges: [{ from: 0, to: 5, kind: 'warning' }] },
        });
        send({ id, ok: true });
      }
    });
  }

  it('stores what a plugin asked to have drawn', async () => {
    const { host, commands } = setup({ plugin: decorator() });

    await commands.execute('plugin.demo.run');

    await vi.waitFor(() => expect(host.decorations.forBuffer('b1')).toHaveLength(1));
  });

  it('tells a plugin when a buffer it decorated goes quiet', async () => {
    const plugin = decorator();
    const { host, commands } = setup({ plugin });
    await commands.execute('plugin.demo.run');
    await vi.waitFor(() => expect(host.decorations.forBuffer('b1')).toHaveLength(1));

    host.noteDocumentChanged('b1');

    // Debounced: the plugin hears once, after the typing stops.
    await vi.waitFor(() =>
      expect(plugin.written.some((m) => m.method === 'document.changed')).toBe(true),
    );
  });

  it('says nothing about a buffer the plugin never decorated', async () => {
    const plugin = decorator();
    const { host, commands } = setup({ plugin });
    await commands.execute('plugin.demo.run');
    await vi.waitFor(() => expect(host.decorations.forBuffer('b1')).toHaveLength(1));
    const before = plugin.written.filter((m) => m.method === 'document.changed').length;

    host.noteDocumentChanged('somewhere-else');

    // It decorated `b1` and nothing else, so typing in another buffer is not
    // its business. This is what keeps the channel from becoming an ambient
    // event feed — which is the thing being out of process exists to prevent.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(plugin.written.filter((m) => m.method === 'document.changed')).toHaveLength(before);
  });

  it('coalesces a burst of typing into one notification', async () => {
    const plugin = decorator();
    const { host, commands } = setup({ plugin });
    await commands.execute('plugin.demo.run');
    await vi.waitFor(() => expect(host.decorations.forBuffer('b1')).toHaveLength(1));

    for (let i = 0; i < 20; i++) host.noteDocumentChanged('b1');

    await new Promise((resolve) => setTimeout(resolve, 40));
    // Twenty keystrokes, one wake-up. The debounce is the whole reason a
    // plugin is not on the typing path.
    expect(plugin.written.filter((m) => m.method === 'document.changed')).toHaveLength(1);
  });

  it('takes its marks back when the plugin dies', async () => {
    const plugin = decorator();
    const { host, commands } = setup({ plugin });
    await commands.execute('plugin.demo.run');
    await vi.waitFor(() => expect(host.decorations.forBuffer('b1')).toHaveLength(1));

    plugin.die(1);

    expect(host.decorations.forBuffer('b1')).toEqual([]);
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

/**
 * A plugin's own options, over the wire.
 *
 * Two properties, and the second is the one worth writing down: a plugin reads
 * only its own namespace, and a settings change never *starts* a plugin. The
 * second is what keeps lazy activation intact — a user changing a setting in
 * the panel must not spawn every plugin that declares one. See
 * `docs/superpowers/specs/2026-08-28-plugin-settings-design.md` §4.
 */
describe('plugin settings', () => {
  it('answers `settings.get` with this plugin’s values', async () => {
    const plugin = fakePlugin((message, send) => {
      const id = message.id as number;
      if (message.method === 'command.invoke') {
        send({ id: 900, method: 'settings.get' });
        send({ id, ok: true });
      }
    });
    const { commands } = setup({
      plugin,
      settings: { demo: { markers: 'TODO' }, other: { secret: 'not yours' } },
    });

    await commands.execute('plugin.demo.run');
    await vi.waitFor(() => expect(plugin.written.some((m) => m.id === 900)).toBe(true));

    const reply = plugin.written.find((m) => m.id === 900);
    expect(reply?.ok).toBe(true);
    expect(reply?.result).toEqual({ markers: 'TODO' });
  });

  it('has no spelling that reads another plugin’s settings', async () => {
    // The request carries no plugin argument at all, so scoping is structural
    // rather than checked: one is sent and the caller's own id is the only
    // thing the host can look up. A param would be a thing to get wrong.
    const plugin = fakePlugin((message, send) => {
      const id = message.id as number;
      if (message.method === 'command.invoke') {
        send({ id: 901, method: 'settings.get', params: { pluginId: 'other' } } as never);
        send({ id, ok: true });
      }
    });
    const { commands } = setup({
      plugin,
      settings: { demo: { mine: true }, other: { secret: 'not yours' } },
    });

    await commands.execute('plugin.demo.run');
    await vi.waitFor(() => expect(plugin.written.some((m) => m.id === 901)).toBe(true));

    expect(plugin.written.find((m) => m.id === 901)?.result).toEqual({ mine: true });
  });

  it('pushes the new values to a running plugin', async () => {
    const { commands, host, plugin } = setup({ settings: { demo: { markers: 'TODO' } } });
    await commands.execute('plugin.demo.run');

    host.noteSettingsChanged('demo');

    await vi.waitFor(() =>
      expect(plugin.written.some((m) => m.method === 'settings.changed')).toBe(true),
    );
    // Carried with the notification rather than fetched. `document.changed` is
    // coarse because a document is large and the rule is that a plugin is
    // never woken per keystroke; a settings object is four scalars that move
    // at human speed, so a bare "they changed" would buy only a round trip.
    expect(plugin.written.find((m) => m.method === 'settings.changed')?.params).toEqual({
      values: { markers: 'TODO' },
    });
  });

  it('does not start a plugin that is only idle', () => {
    const { host, plugin } = setup({ settings: { demo: { markers: 'TODO' } } });

    host.noteSettingsChanged('demo');

    // Nothing was written, which means nothing was connected: changing a
    // setting in the panel must not spawn every plugin that declares one.
    expect(plugin.written).toHaveLength(0);
    expect(host.stateOf('demo')).toBe('idle');
  });

  it('tells only the plugin whose settings moved', async () => {
    const { commands, host, plugin } = setup({ settings: { demo: {} } });
    await commands.execute('plugin.demo.run');
    const before = plugin.written.length;

    host.noteSettingsChanged('someone-else');

    await Promise.resolve();
    expect(plugin.written).toHaveLength(before);
  });
});
