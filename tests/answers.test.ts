import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { ProviderTransport, AgentRuntime, type AgentSession } from '../src/services/agent/runtime';
import { ScriptedProvider, type ModelRequest } from '../src/services/agent/provider';
import { CommandRegistry } from '../src/services/commands';
import { ContextService } from '../src/services/context';
import { FileTreeService } from '../src/services/filetree';
import { JobRunner } from '../src/services/jobs';
import { PermissionService } from '../src/services/permissions';
import { ReviewService } from '../src/services/review';
import { WorkspaceService } from '../src/services/workspace';

const A = 'one\ntwo\nthree\nfour\nfive\n';

async function setup() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/a.txt', A);

  const workspace = new WorkspaceService(platform, () => history());
  const files = new FileTreeService(platform);
  const context = new ContextService(workspace, files);
  const commands = new CommandRegistry();
  const permissions = new PermissionService(() => workspace.rootPath.get());
  const review = new ReviewService(workspace);
  const jobs = new JobRunner();
  const runtime = new AgentRuntime({ workspace, context, commands, permissions, review, jobs });

  await workspace.openFolder('/w');
  await files.setRoot('/w');
  await files.buildIndex();
  const a = (await workspace.open('/w/a.txt'))!;

  return { workspace, context, runtime, a };
}

async function settle(session: AgentSession, budgetMs = 10_000) {
  const deadline = Date.now() + budgetMs;
  while (session.status.get() === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A provider that records the request it was handed and says nothing. */
function watcher() {
  const seen: ModelRequest[] = [];
  const provider = new ScriptedProvider((request) => {
    seen.push(request);
    return [];
  });
  return { seen, transport: new ProviderTransport(provider) };
}

describe('what a session tells its provider to expect', () => {
  /**
   * The failure this prevents: the provider having no way to know prose was
   * wanted, which is the whole reason "explain this" ends in a failed
   * session today.
   */
  it('passes the expectation through to the provider', async () => {
    const { runtime } = await setup();
    const { seen, transport } = watcher();

    const session = runtime.start(transport, 'what does this do?', { expects: 'prose' });
    await settle(session);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.expects).toBe('prose');
  });

  /**
   * The failure this prevents: an ordinary session silently acquiring a new
   * field, which would change what every agent written before this is asked
   * for.
   */
  it('says nothing about expectations for an ordinary session', async () => {
    const { runtime } = await setup();
    const { seen, transport } = watcher();

    const session = runtime.start(transport, 'rename Task to Job');
    await settle(session);

    expect(seen[0]?.expects).toBeUndefined();
  });
});

describe('what a prose session is allowed to do', () => {
  /**
   * The failure this prevents: "explain this selection" staging an edit.
   * Enforced here rather than in the prompt, so an out-of-process agent that
   * ignores `expects` is refused too.
   */
  it('refuses a proposal', async () => {
    const { runtime, a } = await setup();
    const responses: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      const reply = yield {
        type: 'action',
        request: {
          method: 'proposal.stage',
          params: { description: 'nope', edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } }], baseRevisions: {} },
        },
      };
      responses.push(reply);
    });

    const session = runtime.start(new ProviderTransport(provider), 'explain this', {
      expects: 'prose',
    });
    await settle(session);

    expect(responses[0]).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });

  /**
   * The failure this prevents: a prose session reaching the command
   * dispatcher at all. `command.execute` is the only verb with a side
   * effect, so this is the whole of what "cannot edit anything" means.
   */
  it('refuses a command', async () => {
    const { runtime } = await setup();
    const responses: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      const reply = yield {
        type: 'action',
        request: { method: 'command.execute', params: { commandId: 'file.save' } },
      };
      responses.push(reply);
    });

    const session = runtime.start(new ProviderTransport(provider), 'explain this', {
      expects: 'prose',
    });
    await settle(session);

    expect(responses[0]).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });

  /**
   * The failure this prevents: the refusal being so broad that the session
   * cannot say anything either, which would refuse the answer itself.
   */
  it('still accepts a summary', async () => {
    const { runtime } = await setup();
    const responses: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      const reply = yield {
        type: 'action',
        request: { method: 'session.summary', params: { text: 'all done' } },
      };
      responses.push(reply);
    });

    const session = runtime.start(new ProviderTransport(provider), 'explain this', {
      expects: 'prose',
    });
    await settle(session);

    expect(responses[0]).toMatchObject({ ok: true });
  });

  /**
   * The failure this prevents: the refusal leaking into ordinary sessions
   * and breaking every agent already written.
   */
  it('leaves an ordinary session able to read', async () => {
    const { runtime } = await setup();
    const responses: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      const reply = yield { type: 'action', request: { method: 'context.openBuffers' } };
      responses.push(reply);
    });

    const session = runtime.start(new ProviderTransport(provider), 'look around');
    await settle(session);

    expect(responses[0]).toMatchObject({ ok: true });
  });
});
