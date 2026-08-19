import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { FakeLanguageServer } from './support/fake-lsp-process';

/**
 * The language-server seam on a platform that has no processes.
 *
 * The interesting assertion is the refusal. A platform that returned a server
 * which never spoke would be indistinguishable from a server that is merely
 * slow to start, and would stay that way forever.
 */

describe('language servers on a platform that has none', () => {
  it('says so in its capabilities', () => {
    expect(new MemoryPlatform().capabilities.languageServers).toBe(false);
  });

  it('refuses loudly rather than returning a server that never speaks', async () => {
    await expect(new MemoryPlatform().startLanguageServer({ command: 'x' })).rejects.toThrow(
      /language server/i,
    );
  });

  it('has nothing to stop', async () => {
    await expect(new MemoryPlatform().stopAllLanguageServers()).resolves.toBeUndefined();
  });

  it('returns what the installed factory makes, and hands it the spec', async () => {
    const platform = new MemoryPlatform();
    const made: FakeLanguageServer[] = [];
    const specs: unknown[] = [];
    platform.languageServerFactory = (spec) => {
      specs.push(spec);
      const server = new FakeLanguageServer();
      made.push(server);
      return server;
    };

    const process = await platform.startLanguageServer({ command: 'tsserver', args: ['--stdio'] });

    expect(process).toBe(made[0]);
    expect(specs).toEqual([{ command: 'tsserver', args: ['--stdio'] }]);
  });
});
