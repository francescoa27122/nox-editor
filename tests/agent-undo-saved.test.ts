// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import AgentPanel from '../src/ui/AgentPanel.svelte';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { ScriptedProvider } from '../src/services/agent/provider';
import { ProviderTransport, stillOnDisk, type AgentSession } from '../src/services/agent/runtime';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * "Undo session" after the user has saved.
 *
 * Guards A7-011: a save adds no history event, so after Save the agent's set
 * is still on top of the buffer's history and the undo succeeds in the
 * buffer while the file on disk keeps the agent's text. The panel then said
 * "Took back everything", and a user who closed Nox on that shipped the
 * edit. The runtime now reports which undone buffers were clean going in,
 * and both the panel and the palette command say so.
 *
 * Not caught: a buffer saved, edited, and saved again, which `undoChangeSet`
 * already refuses as "edited since" and which is a different message.
 */

const ORIGINAL = 'one\ntwo\n';

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function settle(session: AgentSession, budgetMs = 10_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (session.status.get() !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`session stuck in "${session.status.get()}" after ${budgetMs}ms`);
}

/** An app where an agent has proposed one edit and the user has applied it. */
async function applied() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/a.txt', ORIGINAL);

  const app = new NoxApp(platform);
  await app.workspace.openFolder('/w');
  const a = (await app.workspace.open('/w/a.txt'))!;

  const session = app.agents.start(
    new ProviderTransport(
      new ScriptedProvider(() => [
        {
          type: 'action',
          request: {
            method: 'proposal.stage',
            params: {
              description: 'Shout',
              edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }],
            },
          },
        },
      ]),
    ),
    'Shout',
    { label: 'Test agent' },
  );
  await settle(session);
  expect(app.applyReview()).toBe(true);
  expect(app.workspace.textOf(a)).toBe('ONE\ntwo\n');

  return { app, platform, session, a };
}

describe('undoSession after a save', () => {
  it('reports the buffer whose file still holds the agent text', async () => {
    const { app, platform, session, a } = await applied();
    expect(await app.workspace.save(a)).toBe(true);

    const outcome = app.agents.undoSession(session.id);

    expect(outcome.undone).toEqual([a]);
    expect(outcome.onDisk).toEqual([a]);
    // Reverted in the editor and dirty, with the agent's text still on disk.
    expect(app.workspace.textOf(a)).toBe(ORIGINAL);
    expect(app.workspace.get(a)?.isDirty).toBe(true);
    expect(await platform.readTextFile('/w/a.txt')).toBe('ONE\ntwo\n');
  });

  it('reports nothing on disk when the buffer was never saved', async () => {
    const { app, session, a } = await applied();

    const outcome = app.agents.undoSession(session.id);

    expect(outcome.undone).toEqual([a]);
    expect(outcome.onDisk).toEqual([]);
  });
});

describe('the sentence about the disk', () => {
  it('is silent when nothing was saved', () => {
    expect(stillOnDisk(0)).toBeNull();
  });

  it('names the disk and the way out', () => {
    expect(stillOnDisk(1)).toContain('on disk');
    expect(stillOnDisk(1)).toContain('until you save it again');
    expect(stillOnDisk(3)).toContain('3 of them');
    expect(stillOnDisk(3)).toContain('until you save them again');
  });
});

describe('the Undo session button', () => {
  it('warns that the disk still holds the agent text after a save', async () => {
    const { app, a } = await applied();
    expect(await app.workspace.save(a)).toBe(true);
    mounted = mountComponent(AgentPanel, { app });
    flush();

    const button = [...mounted.container.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === 'Undo session',
    )!;
    expect(button).toBeDefined();
    button.click();
    flush();

    const toast = app.notifications.items.get().at(-1)!;
    expect(toast.kind).toBe('warning');
    expect(toast.message).toContain('in the editor');
    expect(toast.detail).toContain('on disk');
  });

  it('still reports plain success when nothing was saved', async () => {
    const { app } = await applied();
    mounted = mountComponent(AgentPanel, { app });
    flush();

    [...mounted.container.querySelectorAll('button')]
      .find((element) => element.textContent?.trim() === 'Undo session')!
      .click();
    flush();

    const toast = app.notifications.items.get().at(-1)!;
    expect(toast.kind).toBe('success');
    expect(toast.detail ?? '').not.toContain('on disk');
  });
});

describe('the palette command', () => {
  it('says the same thing as the button', async () => {
    const { app, a } = await applied();
    expect(await app.workspace.save(a)).toBe(true);

    expect(await app.commands.execute('agents.undoLastSession')).toBe(true);

    const toast = app.notifications.items.get().at(-1)!;
    expect(toast.kind).toBe('warning');
    expect(toast.detail).toContain('on disk');
  });
});
