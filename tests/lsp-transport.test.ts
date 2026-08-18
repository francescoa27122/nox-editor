import { describe, expect, it, vi } from 'vitest';
import { JsonRpcTransport } from '../src/services/lsp/transport';

/**
 * JSON-RPC correlation, with no process anywhere.
 *
 * The transport takes a `send` function rather than anything that could spawn
 * something, which is what lets the interleaving and timeout cases below be
 * written down at all — provoking an out-of-order reply against a real server
 * is not something you can ask for.
 */

function setup(options?: { timeoutMs?: number }) {
  const sent: Record<string, unknown>[] = [];
  const transport = new JsonRpcTransport(async (message) => {
    sent.push(JSON.parse(message) as Record<string, unknown>);
  }, options);
  return { transport, sent };
}

describe('requests', () => {
  it('sends a well-formed request and resolves with its result', async () => {
    const { transport, sent } = setup();

    const pending = transport.request<{ ok: boolean }>('initialize', { rootUri: 'file:///w' });
    expect(sent[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { rootUri: 'file:///w' },
    });

    transport.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('matches replies to their own request when they arrive out of order', async () => {
    // A single pending slot would pass every other test in this file and fail
    // here, which is the whole reason correlation is by id.
    const { transport } = setup();

    const first = transport.request<string>('a');
    const second = transport.request<string>('b');

    transport.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'second' }));
    transport.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'first' }));

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('rejects with the error the server sent', async () => {
    const { transport } = setup();
    const pending = transport.request('rename');

    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'no can do' } }),
    );

    await expect(pending).rejects.toThrow('no can do');
  });

  it('rejects rather than pending forever when no reply comes', async () => {
    vi.useFakeTimers();
    try {
      const { transport } = setup({ timeoutMs: 10 });
      const pending = transport.request('hover');
      const assertion = expect(pending).rejects.toThrow(/timed out/i);

      await vi.advanceTimersByTimeAsync(11);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets a request once it has been answered', async () => {
    // A pending map that grew forever would be a leak nothing ever surfaced.
    const { transport } = setup();
    const pending = transport.request('a');
    transport.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1 }));
    await pending;

    expect(transport.pendingCount()).toBe(0);
  });
});

describe('notifications', () => {
  it('sends one with no id, so nothing waits for a reply', async () => {
    const { transport, sent } = setup();
    await transport.notify('initialized', {});

    expect(sent[0]).toEqual({ jsonrpc: '2.0', method: 'initialized', params: {} });
    expect(sent[0]).not.toHaveProperty('id');
  });

  it('delivers an incoming notification to the handler for its method', () => {
    const { transport } = setup();
    const seen: unknown[] = [];
    transport.onNotification('textDocument/publishDiagnostics', (params) => seen.push(params));

    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri: 'file:///w/a.ts', diagnostics: [] },
      }),
    );

    expect(seen).toEqual([{ uri: 'file:///w/a.ts', diagnostics: [] }]);
  });

  it('ignores a notification nothing is listening for', () => {
    const { transport } = setup();
    expect(() =>
      transport.receive(JSON.stringify({ jsonrpc: '2.0', method: 'window/logMessage' })),
    ).not.toThrow();
  });
});

describe('requests from the server', () => {
  it('answers a method it implements', async () => {
    const { transport, sent } = setup();
    transport.onRequest('workspace/configuration', async () => [{ setting: 1 }]);

    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration' }),
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 7, result: [{ setting: 1 }] });
  });

  it('answers one it does not with an error, never with silence', async () => {
    // A server waiting on a reply that never comes stalls, and the stall looks
    // like a slow server rather than a missing method.
    const { transport, sent } = setup();

    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'client/registerCapability' }),
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601 },
    });
  });
});

describe('dispose', () => {
  it('rejects everything still pending, with the reason', async () => {
    const { transport } = setup();
    const first = transport.request('a');
    const second = transport.request('b');

    transport.dispose('the server exited');

    await expect(first).rejects.toThrow('the server exited');
    await expect(second).rejects.toThrow('the server exited');
    expect(transport.pendingCount()).toBe(0);
  });

  it('ignores a reply that arrives after disposal', async () => {
    const { transport } = setup();
    const pending = transport.request('a');
    transport.dispose('gone');
    await expect(pending).rejects.toThrow('gone');

    expect(() =>
      transport.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1 })),
    ).not.toThrow();
  });
});

describe('malformed input', () => {
  it('reports unparseable text rather than throwing into the reader', () => {
    // This arrives from a thread in Rust; an exception here would take down
    // whatever was pumping messages, not the message.
    const { transport } = setup();
    const errors: string[] = [];
    transport.onError((message) => errors.push(message));

    transport.receive('not json at all');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/parse/i);
  });
});
