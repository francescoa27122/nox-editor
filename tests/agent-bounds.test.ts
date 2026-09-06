import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { ScriptedProvider, type ModelChunk } from '../src/services/agent/provider';
import {
  AgentRuntime,
  capTrail,
  ProviderTransport,
  REQUEST_BUDGET,
  TRAIL_LIMIT,
  type AgentAction,
  type AgentSession,
} from '../src/services/agent/runtime';
import { CommandRegistry } from '../src/services/commands';
import { ContextService } from '../src/services/context';
import { FileTreeService } from '../src/services/filetree';
import { JobRunner } from '../src/services/jobs';
import { PermissionService } from '../src/services/permissions';
import { ReviewService } from '../src/services/review';
import { WorkspaceService } from '../src/services/workspace';

/**
 * What bounds a runaway agent.
 *
 * These guard A7-005: before them the trail grew without a cap, every append
 * copied and republished the whole of it, and the only deadline was the stdio
 * transport's idle timeout, which a chatty agent resets with every line. An
 * agent printing a note every few milliseconds kept a session alive for as
 * long as the app was open and made the panel slower with each one.
 *
 * What they do not catch: the wall-clock cost of a single request, and an
 * agent that is slow rather than chatty. The idle timeout still owns that.
 */

async function setup() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/a.txt', 'one\n');

  const workspace = new WorkspaceService(platform, () => history());
  const files = new FileTreeService(platform);
  const context = new ContextService(workspace, files);
  const commands = new CommandRegistry();
  const permissions = new PermissionService(() => workspace.rootPath.get());
  const review = new ReviewService(workspace);
  const jobs = new JobRunner();
  const runtime = new AgentRuntime({ workspace, context, commands, permissions, review, jobs });

  await workspace.openFolder('/w');
  return { runtime };
}

async function settle(session: AgentSession, budgetMs = 20_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (session.status.get() !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`session stuck in "${session.status.get()}" after ${budgetMs}ms`);
}

const notes = (count: number): ModelChunk[] =>
  Array.from({ length: count }, (_, index) => ({ type: 'text', text: `note ${index}` }));

const scripted = (chunks: ModelChunk[]) => new ProviderTransport(new ScriptedProvider(() => chunks));

describe('capTrail', () => {
  const note = (index: number): AgentAction => ({ kind: 'note', at: index, text: `n${index}` });

  it('leaves a trail under the limit alone', () => {
    const trail = [note(1), note(2)];
    expect(capTrail(trail, 3)).toBe(trail);
  });

  it('keeps the newest entries behind a marker that counts what was dropped', () => {
    const capped = capTrail([note(1), note(2), note(3), note(4)], 2);
    // The marker's timestamp is the newest action it stands in for.
    expect(capped).toEqual([{ kind: 'elided', at: 2, count: 2 }, note(3), note(4)]);
  });

  it('accumulates the count across successive caps rather than resetting it', () => {
    let trail = capTrail([note(1), note(2), note(3)], 2);
    trail = capTrail([...trail, note(4)], 2);
    trail = capTrail([...trail, note(5)], 2);
    // Five recorded, two kept: the marker says three, not one.
    expect(trail[0]).toEqual({ kind: 'elided', at: 3, count: 3 });
    expect(trail.slice(1)).toEqual([note(4), note(5)]);
  });
});

describe('a session that never stops talking', () => {
  it('keeps the trail at the limit and says how much it dropped', async () => {
    const { runtime } = await setup();
    const extra = 500;
    const session = runtime.start(scripted(notes(TRAIL_LIMIT + extra)), 'Chatter');
    await settle(session);

    const trail = session.actions.get();
    expect(trail).toHaveLength(TRAIL_LIMIT + 1);
    // The instruction and the first `extra` notes are what went: one marker
    // stands in for all of them, and it counts every one.
    expect(trail[0]).toMatchObject({ kind: 'elided', count: extra + 1 });
    expect(trail.at(-1)).toEqual(expect.objectContaining({ kind: 'note', text: `note ${TRAIL_LIMIT + extra - 1}` }));
    expect(runtime.sessions.get()[0]?.actions).toHaveLength(TRAIL_LIMIT + 1);
  });

  it('is stopped past the request budget, with the reason on the trail', async () => {
    const { runtime } = await setup();
    const session = runtime.start(scripted(notes(REQUEST_BUDGET + 10)), 'Loop');
    await settle(session);

    expect(session.status.get()).toBe('failed');
    const last = session.actions.get().at(-1);
    expect(last).toMatchObject({ kind: 'error' });
    expect((last as { message: string }).message).toContain(String(REQUEST_BUDGET));
    // The request past the budget was refused, not answered: nothing after it
    // reached the trail.
    const noted = session.actions.get().filter((action) => action.kind === 'note');
    expect(noted.at(-1)).toEqual(expect.objectContaining({ text: `note ${REQUEST_BUDGET - 1}` }));
  });

  it('lets a session exactly at the budget finish normally', async () => {
    const { runtime } = await setup();
    const session = runtime.start(scripted(notes(REQUEST_BUDGET)), 'Just enough');
    await settle(session);
    expect(session.status.get()).toBe('done');
  });
});
