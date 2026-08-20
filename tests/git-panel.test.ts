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

describe('stage and unstage', () => {
  it('stage moves the row between sections and the gutter base follows', async () => {
    const { app, container } = await setup();
    const id = (await app.workspace.open('/w/edited.ts'))!;
    await settle();
    // Before: the buffer differs from the index base ('one\n').
    expect(app.git.hunks.get().has(id)).toBe(true);

    const stage = [...container.querySelectorAll('.section.changes .row')]
      .find((r) => r.textContent!.includes('edited.ts'))!
      .querySelector('[title="Stage"]') as HTMLElement;
    stage.click();
    await settle();
    await settle();

    expect(container.querySelector('.section.staged')!.textContent).toContain('edited.ts');
    // Envelope §6: the mutation refreshed the gutter base — the index now
    // holds the buffer's text, so the hunks are gone.
    expect(app.git.hunks.get().has(id)).toBe(false);
  });

  it('unstage returns the row', async () => {
    const { app, container, platform } = await setup();
    await platform.gitStage('/w', ['/w/edited.ts']);
    await app.git.refreshStatus();
    await settle();

    const unstage = container
      .querySelector('.section.staged .row [title="Unstage"]') as HTMLElement;
    unstage.click();
    await settle();
    await settle();

    expect(container.querySelector('.section.staged')).toBeNull();
    expect(container.querySelector('.section.changes')!.textContent).toContain('edited.ts');
  });

  it('a refused stage becomes a notification with git\'s words, and the panel keeps the truth', async () => {
    const { app, container, platform } = await setup();
    platform.gitStage = async () => {
      throw new Error("fatal: pathspec 'edited.ts' did not match any files");
    };
    const stage = [...container.querySelectorAll('.section.changes .row')]
      .find((r) => r.textContent!.includes('edited.ts'))!
      .querySelector('[title="Stage"]') as HTMLElement;
    stage.click();
    await settle();
    await settle();

    const items = app.notifications.items.get();
    expect(items.some((n) => n.kind === 'error' && n.message.includes('did not match'))).toBe(true);
    expect(container.querySelector('.section.staged')).toBeNull();
  });
});

describe('commit', () => {
  it('is disabled with nothing staged, and with a blank message', async () => {
    const { container, platform, app } = await setup();
    const button = () => container.querySelector('.commit button') as HTMLButtonElement;
    const box = () => container.querySelector('.commit textarea') as HTMLTextAreaElement;

    // Nothing staged: disabled even with a message.
    box().value = 'a message';
    box().dispatchEvent(new Event('input'));
    flush();
    expect(button().disabled).toBe(true);

    await platform.gitStage('/w', ['/w/edited.ts']);
    await app.git.refreshStatus();
    await settle();

    // Staged but blank message: still disabled.
    box().value = '   ';
    box().dispatchEvent(new Event('input'));
    flush();
    expect(button().disabled).toBe(true);

    box().value = 'a message';
    box().dispatchEvent(new Event('input'));
    flush();
    expect(button().disabled).toBe(false);
  });

  it('clears the staged list and the box, bumps the log, and names the commit', async () => {
    const { container, platform, app } = await setup();
    await platform.gitStage('/w', ['/w/edited.ts']);
    await app.git.refreshStatus();
    await settle();

    const box = container.querySelector('.commit textarea') as HTMLTextAreaElement;
    box.value = 'Widen the edit\n\nWith a body.';
    box.dispatchEvent(new Event('input'));
    flush();
    (container.querySelector('.commit button') as HTMLElement).click();
    await settle();
    await settle();

    expect(container.querySelector('.section.staged')).toBeNull();
    expect((container.querySelector('.commit textarea') as HTMLTextAreaElement).value).toBe('');
    const state = platform.gitRepoState('/w')!;
    expect(state.commits.at(-1)!.subject).toBe('Widen the edit');
    const toast = app.notifications.items.get().find((n) => n.kind === 'success')!;
    expect(toast.message).toMatch(/[0-9a-f]{7} Widen the edit/);
  });

  it('surfaces a refusal verbatim and keeps the staged list', async () => {
    const { container, platform, app } = await setup();
    await platform.gitStage('/w', ['/w/edited.ts']);
    await app.git.refreshStatus();
    await settle();
    platform.gitCommit = async () => {
      throw new Error('Aborting commit due to empty commit message.');
    };

    const box = container.querySelector('.commit textarea') as HTMLTextAreaElement;
    box.value = 'doomed';
    box.dispatchEvent(new Event('input'));
    flush();
    (container.querySelector('.commit button') as HTMLElement).click();
    await settle();
    await settle();

    expect(
      app.notifications.items.get().some((n) => n.kind === 'error' && n.message.includes('empty commit message')),
    ).toBe(true);
    // The box keeps the message — a failed commit must not eat the words.
    expect((container.querySelector('.commit textarea') as HTMLTextAreaElement).value).toBe('doomed');
    expect(container.querySelector('.section.staged')!.textContent).toContain('edited.ts');
  });
});
