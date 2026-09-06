// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { ScriptedProvider, type ModelChunk } from '../src/services/agent/provider';
import { ProviderTransport, type AgentSession } from '../src/services/agent/runtime';

/**
 * Getting a session's trail out of the panel.
 *
 * Guards A7-008: the trail lived in a `Signal`, the panel had no copy, export
 * or save control, and nothing wrote it anywhere, so "you can check what
 * happened rather than trust it" held only while the window stayed open.
 * This proves the command puts the whole record, reads and decisions
 * included, on the clipboard as JSON a person can file.
 *
 * Not caught: survival across a restart. Persistence is a format decision
 * and is deliberately not part of this.
 */

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  if (original) Object.defineProperty(navigator, 'clipboard', original);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

/** jsdom ships no clipboard; this is the one the command writes to. */
function stubClipboard(): { text: string | null } {
  const copied: { text: string | null } = { text: null };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.text = text;
      },
    },
  });
  return copied;
}

async function settle(session: AgentSession, budgetMs = 10_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (session.status.get() !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`session stuck in "${session.status.get()}" after ${budgetMs}ms`);
}

async function appWithSession(script: (a: string) => ModelChunk[]) {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/a.txt', 'one\n');

  const app = new NoxApp(platform);
  // The app's own prompter opens a dialog and waits for a human; here the
  // human says no, which is the decision the export has to carry.
  app.permissions.setPrompter(async () => 'deny');
  await app.workspace.openFolder('/w');
  const a = (await app.workspace.open('/w/a.txt'))!;

  const session = app.agents.start(
    new ProviderTransport(new ScriptedProvider(() => script(a))),
    'Look around',
    { label: 'Test agent' },
  );
  await settle(session);
  return { app, session, a };
}

describe('agents.copyTrail', () => {
  it('puts the session trail on the clipboard as JSON, reads and decisions included', async () => {
    const { app, session, a } = await appWithSession((buffer) => [
      { type: 'text', text: 'Looking' },
      { type: 'action', request: { method: 'context.bufferText', params: { bufferId: buffer } } },
      // Denied by the default policy: the decision is the point.
      { type: 'action', request: { method: 'command.execute', params: { commandId: 'file.save' } } },
    ]);
    const copied = stubClipboard();

    expect(await app.commands.execute('agents.copyTrail')).toBe(true);

    const parsed = JSON.parse(copied.text!) as {
      session: { id: string; label: string; instruction: string; actions: { kind: string }[] };
      reads: { method: string; target?: string }[];
      decisions: { capability: string; granted: boolean }[];
    };
    expect(parsed.session.id).toBe(session.id);
    expect(parsed.session.label).toBe('Test agent');
    expect(parsed.session.instruction).toBe('Look around');
    expect(parsed.session.actions.map((action) => action.kind)).toEqual([
      'instruction',
      'note',
      'read',
      'command',
    ]);
    // The opening brief reads through the same logged reader, so the read
    // the agent asked for is one of several; all of them are this session's.
    // The log names the reader's method, not the wire method.
    expect(parsed.reads).toContainEqual(expect.objectContaining({ method: 'bufferText', target: a }));
    for (const read of parsed.reads) {
      expect(read).toMatchObject({ principal: { kind: 'agent', sessionId: session.id } });
    }
    expect(parsed.decisions).toEqual([expect.objectContaining({ capability: 'fs.write', granted: false })]);
  });

  it('copies the session named by its argument', async () => {
    const { app, session } = await appWithSession(() => [{ type: 'text', text: 'first' }]);
    const second = app.agents.start(
      new ProviderTransport(new ScriptedProvider(() => [{ type: 'text', text: 'second' }])),
      'Again',
    );
    await settle(second);
    const copied = stubClipboard();

    await app.commands.execute('agents.copyTrail', session.id);
    expect((JSON.parse(copied.text!) as { session: { id: string } }).session.id).toBe(session.id);

    // With no argument the newest session is the one copied.
    await app.commands.execute('agents.copyTrail');
    expect((JSON.parse(copied.text!) as { session: { id: string } }).session.id).toBe(second.id);
  });

  it('is disabled until something has run', () => {
    const app = new NoxApp(new MemoryPlatform());
    expect(app.commands.get('agents.copyTrail')?.enabled?.()).toBe(false);
    expect(app.agents.exportTrail('agent-99')).toBeNull();
  });
});
