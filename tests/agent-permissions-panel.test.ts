// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import AgentPanel from '../src/ui/AgentPanel.svelte';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import type { AgentSessionSnapshot } from '../src/services/agent/runtime';
import type { Principal } from '../src/services/permissions';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The Agents panel as the place a standing permission is visible and
 * revocable.
 *
 * These are about copy and reachability rather than markup, because the defect
 * was neither a missing element nor a wrong style: `grep -rn "decisions"
 * src/ui/` matched nothing, `forgetSession`'s only caller was `undoSession`,
 * and a user who had clicked "Allow for this session" had no screen telling
 * them so and no button short of reverting the work.
 *
 * See AGENT-PLATFORM.md §2.6.
 */

const AGENT: Principal = { kind: 'agent', sessionId: 'agent-1', label: 'Scripted agent' };

const SESSION: AgentSessionSnapshot = {
  id: 'agent-1',
  label: 'Scripted agent',
  instruction: 'Tidy the imports',
  status: 'done',
  actions: [{ kind: 'note', at: 0, text: 'Read two files' }],
  summary: null,
  expects: undefined,
  answer: null,
  about: null,
  changes: 0,
};

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/**
 * An app with one finished session on the panel.
 *
 * The snapshot is pushed onto `agents.sessions` directly. That is the
 * component's actual input — it renders a snapshot list and nothing else — and
 * driving a scripted provider to completion under jsdom would test the runtime
 * a second time to reach the same three lines of markup.
 */
async function panelWithSession() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/a.txt', 'one\n');

  const app = new NoxApp(platform);
  await app.workspace.openFolder('/w');
  app.permissions.setPrompter(async () => 'allow-session');
  app.permissions.setDefaultPolicy({ fallback: 'prompt', rules: {} });
  app.agents.sessions.set([SESSION]);

  mounted = mountComponent(AgentPanel, { app });
  // `Mounted` already carries the app it mounted against — the same instance
  // passed in — so spreading one over the other would only shadow it.
  return mounted;
}

/** Expand the one session row, so the standing-permissions block renders. */
function expandRow(container: HTMLElement) {
  container.querySelector<HTMLButtonElement>('.head')?.click();
  flush();
}

/** The first button whose label reads `text`, ignoring surrounding whitespace. */
function buttonSaying(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

const rowsIn = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.grants li')].map((li) =>
    (li.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

describe('standing permissions on the Agents panel', () => {
  it('names the capability in words and the file it is confined to', async () => {
    const { app, container } = await panelWithSession();

    await app.permissions.check({
      principal: AGENT,
      capability: 'fs.write',
      resource: '/w/a.txt',
    });
    flush();
    expandRow(container);

    expect(rowsIn(container)).toEqual(['change files on disk a.txt']);
  });

  /**
   * A `buffer.edit` grant with no resource is the widest grant there is, not a
   * narrow one missing its label — `review.apply` names no file on purpose,
   * because naming the active one would understate what the user agreed to.
   * Rendering a blank there, beside a neighbour showing a path, would read as
   * the opposite of what it means.
   */
  it('says so when a file-scoped grant is confined to no file at all', async () => {
    const { app, container } = await panelWithSession();

    await app.permissions.check({ principal: AGENT, capability: 'buffer.edit' });
    await app.permissions.check({ principal: AGENT, capability: 'net.request' });
    flush();
    expandRow(container);

    expect(rowsIn(container)).toEqual([
      'edit what is open any file',
      'access the network anywhere',
    ]);
  });

  /**
   * The distinction §2.6 spends its length on. A policy `allow` is a rule the
   * user never granted; listing it as revocable would teach them something
   * false about what they authorised, and pressing revoke would not change it.
   */
  it('does not present a policy allow as something to take back', async () => {
    const { app, container } = await panelWithSession();
    app.permissions.setPolicy(AGENT, { fallback: 'deny', rules: { 'fs.read': 'allow' } });

    expect(
      await app.permissions.check({
        principal: AGENT,
        capability: 'fs.read',
        resource: '/w/a.txt',
      }),
    ).toBe(true);
    flush();
    expandRow(container);

    expect(container.querySelector('.grants ul')).toBeNull();
    expect(container.querySelector('.grants p')?.textContent).toMatch(
      /allowed once or allowed by\s+policy/,
    );
    expect(buttonSaying(container, 'Revoke access')).toBeNull();
  });

  it('offers no revoke button while nothing is standing', async () => {
    const { container } = await panelWithSession();

    expect(buttonSaying(container, 'Revoke access')).toBeNull();
    expect([...container.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain(
      'Revoke 1 permission',
    );
  });
});

describe('revoking from the Agents panel', () => {
  /**
   * The button exists so a user can keep an agent's work and still shut the
   * door. If pressing it emptied the trail, or the row, it would be undo
   * wearing revoke's label — which is the state this whole change is undoing.
   */
  it('clears the grant and leaves the session and its trail standing', async () => {
    const { app, container } = await panelWithSession();

    await app.permissions.check({
      principal: AGENT,
      capability: 'fs.write',
      resource: '/w/a.txt',
    });
    flush();
    expandRow(container);
    expect(rowsIn(container)).toHaveLength(1);

    buttonSaying(container, 'Revoke access')!.click();
    await Promise.resolve();
    flush();

    expect(app.permissions.grants.get()).toEqual([]);
    expect(rowsIn(container)).toEqual([]);
    expect(buttonSaying(container, 'Revoke access')).toBeNull();
    // Still one session, still showing what it did.
    expect(container.querySelectorAll('.sessions article')).toHaveLength(1);
    expect(container.querySelector('.trail')?.textContent).toContain('Read two files');
  });

  /**
   * The header count is the whole disclosure — there is no separate viewer, so
   * if it does not say how many are standing, nothing does. It is also the one
   * route to a grant whose session is not on the list.
   */
  it('counts what is standing in the header, and revokes all of it', async () => {
    const { app, container } = await panelWithSession();

    await app.permissions.check({ principal: AGENT, capability: 'fs.write', resource: '/w/a.txt' });
    await app.permissions.check({ principal: AGENT, capability: 'fs.write', resource: '/w/b.txt' });
    flush();

    const all = buttonSaying(container, 'Revoke 2 permissions');
    expect(all).not.toBeNull();

    all!.click();
    await Promise.resolve();
    flush();

    expect(app.permissions.grants.get()).toEqual([]);
    expect(buttonSaying(container, 'Revoke 2 permissions')).toBeNull();
  });

  /** Singular when there is one. A count that reads "1 permissions" is a tell. */
  it('agrees with itself about number', async () => {
    const { app, container } = await panelWithSession();

    await app.permissions.check({ principal: AGENT, capability: 'fs.write', resource: '/w/a.txt' });
    flush();

    expect(buttonSaying(container, 'Revoke 1 permission')).not.toBeNull();
  });
});
