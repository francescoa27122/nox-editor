import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import {
  SERVERS_FILE,
  SERVERS_TEMPLATE,
  ServerRegistry,
} from '../src/services/lsp/registry';

/**
 * Which servers the user has told Nox about.
 *
 * Nothing here starts anything. The registry's whole job is to answer "did the
 * user ask for a server for this language", and to answer "no" for everything
 * until they say otherwise.
 */

function setup(contents?: string) {
  const platform = new MemoryPlatform();
  const registry = new ServerRegistry(platform);
  return { platform, registry, seed: () => platform.writeConfigFile(SERVERS_FILE, contents ?? '') };
}

describe('loading', () => {
  it('finds nothing when the file does not exist', async () => {
    const { registry } = setup();
    await registry.load();

    expect(registry.servers.get()).toEqual([]);
    expect(registry.error.get()).toBeNull();
  });

  it('reads the entries the user wrote', async () => {
    const { platform, registry } = setup();
    await platform.writeConfigFile(
      SERVERS_FILE,
      JSON.stringify({
        servers: [
          { languages: ['typescript'], command: 'typescript-language-server', args: ['--stdio'] },
        ],
      }),
    );
    await registry.load();

    expect(registry.servers.get()).toEqual([
      { languages: ['typescript'], command: 'typescript-language-server', args: ['--stdio'] },
    ]);
  });

  it('says so when the file is not valid JSON, and configures nothing', async () => {
    // A typo here would otherwise look exactly like having configured nothing,
    // which is the state the user was trying to leave.
    const { platform, registry } = setup();
    await platform.writeConfigFile(SERVERS_FILE, '{ not json');
    await registry.load();

    expect(registry.error.get()).toBeTruthy();
    expect(registry.servers.get()).toEqual([]);
  });

  it('refuses an entry with no command rather than spawning something undefined', async () => {
    const { platform, registry } = setup();
    await platform.writeConfigFile(
      SERVERS_FILE,
      JSON.stringify({ servers: [{ languages: ['typescript'] }] }),
    );
    await registry.load();

    expect(registry.servers.get()).toEqual([]);
    expect(registry.error.get()).toMatch(/command/i);
  });

  it('refuses an entry that claims no languages, which could never be chosen', async () => {
    const { platform, registry } = setup();
    await platform.writeConfigFile(
      SERVERS_FILE,
      JSON.stringify({ servers: [{ command: 'x', languages: [] }] }),
    );
    await registry.load();

    expect(registry.servers.get()).toEqual([]);
  });

  it('keeps the good entries beside a bad one', async () => {
    const { platform, registry } = setup();
    await platform.writeConfigFile(
      SERVERS_FILE,
      JSON.stringify({
        servers: [{ languages: ['typescript'], command: 'tsserver' }, { languages: ['rust'] }],
      }),
    );
    await registry.load();

    expect(registry.servers.get()).toHaveLength(1);
    expect(registry.servers.get()[0]?.command).toBe('tsserver');
  });
});

describe('lookup', () => {
  it('finds the server that claims a language', async () => {
    const { platform, registry } = setup();
    await platform.writeConfigFile(
      SERVERS_FILE,
      JSON.stringify({
        servers: [
          { languages: ['typescript', 'javascript'], command: 'tsserver' },
          { languages: ['rust'], command: 'rust-analyzer' },
        ],
      }),
    );
    await registry.load();

    expect(registry.forLanguage('javascript')?.command).toBe('tsserver');
    expect(registry.forLanguage('rust')?.command).toBe('rust-analyzer');
  });

  it('finds nothing for a language nothing claims', async () => {
    const { registry } = setup();
    await registry.load();

    expect(registry.forLanguage('markdown')).toBeNull();
  });
});

describe('the file Nox writes', () => {
  it('is valid JSON, since the user is meant to edit it rather than debug it', () => {
    expect(() => JSON.parse(SERVERS_TEMPLATE)).not.toThrow();
  });

  it('describes a working typescript-language-server, so enabling one is an edit not research', async () => {
    const { platform, registry } = setup();
    await platform.writeConfigFile(SERVERS_FILE, SERVERS_TEMPLATE);
    await registry.load();

    const server = registry.forLanguage('typescript');
    expect(server?.command).toBe('typescript-language-server');
    expect(server?.args).toEqual(['--stdio']);
    expect(registry.error.get()).toBeNull();
  });

  it('is created when it is missing', async () => {
    const { platform, registry } = setup();
    await registry.ensureFile();

    expect(await platform.readConfigFile(SERVERS_FILE)).toBe(SERVERS_TEMPLATE);
  });

  it('never overwrites what the user already wrote', async () => {
    const { platform, registry } = setup();
    await platform.writeConfigFile(SERVERS_FILE, '{"servers":[]}');
    await registry.ensureFile();

    expect(await platform.readConfigFile(SERVERS_FILE)).toBe('{"servers":[]}');
  });
});
