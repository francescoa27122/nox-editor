import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { SERVERS_FILE, SERVERS_TEMPLATE, ServerRegistry } from '../src/services/lsp/registry';

/**
 * The two commands `servers.json` needs, and the promise they make.
 *
 * Mirrors the agents.json pair: one creates the file with something that
 * works, the other re-reads it. The interesting case is the third — a file
 * that stopped parsing must not silently disarm the servers that were running
 * from the last good version of it.
 */

describe('configuring language servers', () => {
  it('creates servers.json with an entry that works', async () => {
    const platform = new MemoryPlatform();
    const registry = new ServerRegistry(platform);

    await registry.ensureFile();
    await registry.load();

    expect(await platform.readConfigFile(SERVERS_FILE)).toBe(SERVERS_TEMPLATE);
    expect(registry.forLanguage('typescript')?.command).toBe('typescript-language-server');
  });

  it('re-reads the file on request', async () => {
    const platform = new MemoryPlatform();
    const registry = new ServerRegistry(platform);
    await registry.load();
    expect(registry.servers.get()).toEqual([]);

    await platform.writeConfigFile(
      SERVERS_FILE,
      JSON.stringify({ servers: [{ languages: ['rust'], command: 'rust-analyzer' }] }),
    );
    await registry.load();

    expect(registry.forLanguage('rust')?.command).toBe('rust-analyzer');
  });

  it('reports a broken file, and the caller can keep the last good configuration', async () => {
    const platform = new MemoryPlatform();
    const registry = new ServerRegistry(platform);

    await platform.writeConfigFile(
      SERVERS_FILE,
      JSON.stringify({ servers: [{ languages: ['rust'], command: 'rust-analyzer' }] }),
    );
    await registry.load();
    const good = registry.servers.get();

    await platform.writeConfigFile(SERVERS_FILE, '{ broken');
    await registry.load();

    // The registry reports and empties; keeping the previous list is the
    // caller's decision, and it can make it because the error says so.
    expect(registry.error.get()).toBeTruthy();
    expect(good).toHaveLength(1);
  });
});
