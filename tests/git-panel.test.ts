// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import GitPanel from '../src/ui/GitPanel.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The Git panel over a real app and the MemoryPlatform repository model —
 * real sequences, not choreography. See the spec's §6.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/** A microtask settle + flush: refreshStatus is one await chain deep. */
async function settle() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  flush();
}

async function setup() {
  mounted = mountComponent(GitPanel);
  const { app, platform, container } = mounted;
  app.git.start();
  platform.seedGitRepo('/w');
  platform.seedGitBase('/w/clean.ts', 'same\n');
  platform.seedFile('/w/clean.ts', 'same\n');
  platform.seedGitBase('/w/edited.ts', 'one\n');
  platform.seedFile('/w/edited.ts', 'one\ntwo\n');
  platform.seedFile('/w/loose.ts', 'untracked\n');
  await app.workspace.openFolder('/w');
  await settle();
  return { app, platform, container };
}

describe('the git panel, read-only', () => {
  it('shows the branch on the branch line', async () => {
    const { container } = await setup();
    expect(container.querySelector('.branch-line')!.textContent).toContain('main');
  });

  it('lists worktree changes under Changes, untracked labelled U', async () => {
    const { container } = await setup();
    const rows = [...container.querySelectorAll('.section.changes .row')];
    const texts = rows.map((r) => r.textContent ?? '');
    expect(texts.some((t) => t.includes('edited.ts') && t.includes('M'))).toBe(true);
    expect(texts.some((t) => t.includes('loose.ts') && t.includes('U'))).toBe(true);
    expect(texts.some((t) => t.includes('clean.ts'))).toBe(false);
  });

  it('shows the staged section only when something is staged', async () => {
    const { container, platform, app } = await setup();
    expect(container.querySelector('.section.staged')).toBeNull();
    await platform.gitStage('/w', ['/w/edited.ts']);
    await app.git.refreshStatus();
    await settle();
    expect(container.querySelector('.section.staged .row')!.textContent).toContain('edited.ts');
  });

  it('opens the file on row click', async () => {
    const { container, app } = await setup();
    const row = [...container.querySelectorAll('.section.changes .row .open')].find((r) =>
      r.textContent!.includes('edited.ts'),
    ) as HTMLElement;
    row.click();
    await settle();
    expect(app.workspace.buffers.get().some((b) => b.path === '/w/edited.ts')).toBe(true);
  });

  it('the view affordance opens the file and the diff surface', async () => {
    const { container, app } = await setup();
    const view = [...container.querySelectorAll('.section.changes .row')]
      .find((r) => r.textContent!.includes('edited.ts'))!
      .querySelector('[title="Show Changes"]') as HTMLElement;
    view.click();
    await settle();
    expect(app.ui.diffOpen.get()).toBe(true);
  });

  it('says so over a folder that is not a repository', async () => {
    mounted = mountComponent(GitPanel);
    const { app, platform, container } = mounted;
    app.git.start();
    platform.seedFile('/plain/a.txt', 'x\n');
    await app.workspace.openFolder('/plain');
    await settle();
    expect(container.querySelector('.panel-empty')).not.toBeNull();
  });
});
