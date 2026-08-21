// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import GitPanel from '../src/ui/GitPanel.svelte';
import CommandPalette from '../src/ui/CommandPalette.svelte';
import { parseGitStatus } from '../src/core/git-status';
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

  it('spells the porcelain letter out for anyone who does not read git', async () => {
    // The letter was the row's only encoding besides its colour, so it had to
    // be already known to be read at all. Guards the accessible name, which
    // is the half a tooltip cannot give a screen reader.
    const { container } = await setup();
    const letters = [...container.querySelectorAll('.section.changes .row .letter')];
    const named = letters.map((el) => [el.textContent, el.getAttribute('aria-label')]);
    expect(named).toContainEqual(['M', 'Modified']);
    expect(named).toContainEqual(['U', 'Untracked']);
    for (const el of letters) expect(el.getAttribute('title')).toBe(el.getAttribute('aria-label'));
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

describe('branch switch and create', () => {
  it('a refused switch leaves the panel unchanged and shows git\'s words', async () => {
    const { app, platform, container } = await setup();
    // A conflicting branch: f.txt differs and the worktree is dirty.
    platform.seedGitBase('/w/f.txt', 'v1\n');
    platform.externalWrite('/w/f.txt', 'v1\n');
    await platform.gitSwitch('/w', 'other', true);
    platform.externalWrite('/w/f.txt', 'v2\n');
    await platform.gitStage('/w', ['/w/f.txt']);
    await platform.gitCommit('/w', 'v2');
    await platform.gitSwitch('/w', 'main', false);
    platform.externalWrite('/w/f.txt', 'dirty\n');
    await app.git.refreshStatus();
    await settle();

    await app.git.switch('other', false);
    await settle();

    expect(container.querySelector('.branch-line')!.textContent).toContain('main');
    expect(
      app.notifications.items.get().some(
        (n) => n.kind === 'error' && n.message.includes('Your local changes'),
      ),
    ).toBe(true);
  });

  it('branch create + switch updates the branch line', async () => {
    const { app, container } = await setup();
    await app.git.switch('feature/picker', true);
    await settle();
    expect(container.querySelector('.branch-line')!.textContent).toContain('feature/picker');
  });
});

describe('the branch picker mode', () => {
  it('lists local branches with Create branch… at the top, prefix-free', async () => {
    const { app, platform } = await setup();
    await platform.gitSwitch('/w', 'feature/x', true);
    await platform.gitSwitch('/w', 'main', false);
    await app.git.refreshStatus();
    await settle();

    const picker = mountComponent(CommandPalette, { app, props: { mode: 'git-branch' as const } });
    try {
      await settle();
      const rows = [...picker.container.querySelectorAll('[role="option"]')].map(
        (r) => r.textContent ?? '',
      );
      expect(rows[0]).toContain('Create branch…');
      expect(rows.some((r) => r.includes('feature/x'))).toBe(true);
      expect(rows.some((r) => r.includes('main'))).toBe(true);
    } finally {
      picker.unmount();
    }
  });

  it('typing keeps its first character — "main" matches whole, not "ain"', async () => {
    // The trap this task guards against: every other palette mode is
    // prefixed, so `term` drops `text[0]`. The branch mode is prefix-free,
    // so `text[0]` is content the user typed and must survive.
    //
    // Because the matcher is subsequence-based, a query and its own
    // one-character-shorter suffix can both match the same branch name (the
    // suffix is trivially still a subsequence) — so "the row is still
    // there" cannot tell a full match from a first-character-eaten one.
    // What *does* differ, deterministically: "main" has four distinct
    // letters, so matching the full word "main" against the branch "main"
    // is forced to align position 0 ('m') to position 0, highlighting the
    // whole word as one run. Matching the truncated "ain" cannot touch
    // position 0 at all — 'm' isn't in the pattern. So whether the first
    // character of the label renders with the `hit` class is exactly the
    // signal that would catch `text.slice(1)` sneaking back into this mode.
    const { app } = await setup();

    const picker = mountComponent(CommandPalette, { app, props: { mode: 'git-branch' as const } });
    try {
      await settle();
      const input = picker.container.querySelector('input')!;
      input.value = 'main';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      flush();
      await settle();

      const rows = [...picker.container.querySelectorAll('[role="option"]')];
      const mainRow = rows.find((r) => r.querySelector('.label')?.textContent?.trim() === 'main');
      expect(mainRow, 'the "main" branch row should still be listed').toBeDefined();

      const firstSpan = mainRow!.querySelector('.label span');
      expect(firstSpan?.textContent).toBe('main');
      expect(firstSpan?.classList.contains('hit')).toBe(true);
    } finally {
      picker.unmount();
    }
  });

  it('does not let a prefix character hijack the branch mode into another one', async () => {
    // '>' means commands and '@' means symbols in every other mode, and both
    // are legal characters to type while filtering branches — neither may
    // switch `effectiveMode` away from 'branches'. Note that neither
    // character appears in any seeded branch name, so the fuzzy filter
    // itself legitimately drops every branch row; the signal here is not
    // "a branch still matches" but that this is still recognizably the
    // branch picker at all — the placeholder (driven by `effectiveMode`)
    // and the always-pinned "Create branch…" row, which only `branchRows`
    // produces, both say so. Hijacked into 'commands' or 'symbols', the
    // placeholder would read "Search commands…" / "Go to a symbol…" and
    // "Create branch…" would not appear (nothing in either of those modes
    // produces that row).
    const { app } = await setup();

    const picker = mountComponent(CommandPalette, { app, props: { mode: 'git-branch' as const } });
    try {
      await settle();
      const input = picker.container.querySelector('input')!;

      for (const prefix of ['>', '@']) {
        input.value = prefix;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        flush();
        await settle();

        expect(input.getAttribute('aria-label'), prefix).toBe('Switch to a branch, or create one…');
        const rows = [...picker.container.querySelectorAll('[role="option"]')].map(
          (r) => r.textContent ?? '',
        );
        expect(rows[0], prefix).toContain('Create branch…');
      }
    } finally {
      picker.unmount();
    }
  });
});

describe('a conflicted file', () => {
  /**
   * Mid-merge, with markers in the file. Before this, the `u` record parsed
   * to M and the row sat under Changes wearing the same amber letter as a
   * file the user had edited themselves — and offering the same enabled
   * Stage button, which would `git add` the markers.
   */
  async function setupConflicted() {
    mounted = mountComponent(GitPanel);
    const { app, platform, container } = mounted;
    app.git.start();
    platform.seedGitRepo('/w');
    platform.seedGitBase('/w/edited.ts', 'one\n');
    platform.seedFile('/w/edited.ts', 'one\ntwo\n');
    platform.seedGitConflict(
      '/w/merged.ts',
      '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n',
    );
    await app.workspace.openFolder('/w');
    await settle();
    return { app, platform, container };
  }

  it('gets its own section, above Staged and out of Changes', async () => {
    const { app, platform, container } = await setupConflicted();
    await platform.gitStage('/w', ['/w/edited.ts']);
    await app.git.refreshStatus();
    await settle();

    const conflicts = container.querySelector('.section.conflicts');
    expect(conflicts, 'expected a Conflicts section').not.toBeNull();
    expect(conflicts!.textContent).toContain('merged.ts');
    // Not also listed as an ordinary change — one file, one honest place.
    expect(container.querySelector('.section.changes')!.textContent).not.toContain('merged.ts');

    // Above Staged: the one thing that blocks the commit reads first.
    const staged = container.querySelector('.section.staged')!;
    expect(
      conflicts!.compareDocumentPosition(staged) & Node.DOCUMENT_POSITION_FOLLOWING,
      'Conflicts must render above Staged',
    ).toBeTruthy();
  });

  it('spells the letter out, so colour is not the only signal', async () => {
    // Same rule as every other row: the letter is a term of art and red is
    // not readable by everyone, so the accessible name carries the word.
    const { container } = await setupConflicted();
    const letter = container.querySelector('.section.conflicts .row .letter')!;
    expect(letter.textContent).toBe('C');
    expect(letter.getAttribute('aria-label')).toBe('Conflicted');
    expect(letter.getAttribute('title')).toBe(letter.getAttribute('aria-label'));
  });

  it('refuses to stage it, and says why', async () => {
    // The whole point: `git add` on a file full of markers is the one stage
    // that is actively harmful, and it used to be one hover away.
    const { container, platform } = await setupConflicted();
    const row = container.querySelector('.section.conflicts .row')!;
    const stage = row.querySelector('.actions button:last-of-type') as HTMLButtonElement;
    expect(stage.disabled).toBe(true);
    expect(stage.getAttribute('title') ?? '').toMatch(/resolve the conflict/i);

    stage.click();
    await settle();
    await settle();
    // Nothing reached the index — the refusal is real, not just a grey tint.
    const after = parseGitStatus(await platform.gitStatus('/w'));
    expect(after.staged.some((e) => e.path === 'merged.ts')).toBe(false);
  });

  it('still opens the file, which is where a conflict is actually resolved', async () => {
    const { container, app } = await setupConflicted();
    const open = container.querySelector('.section.conflicts .row .open') as HTMLElement;
    expect(open.tagName).toBe('BUTTON');
    open.click();
    await settle();
    expect(app.workspace.buffers.get().some((b) => b.path === '/w/merged.ts')).toBe(true);
  });
});

describe('row actions stay in the tab order', () => {
  // jsdom does not apply CSS layout — a stylesheet rule of `display: none`
  // does not stop `.focus()` from landing there in this harness (verified:
  // jsdom's focus algorithm does not consult cascaded `display`), so the
  // regression this guards (buttons pulled out of the tab order by
  // `display: none`, restored to reachability via `.section.staged` etc.)
  // cannot be pinned by driving real focus here. Asserting the rule shape
  // in the source is the honest substitute: reveal by opacity, on both
  // `:hover` and `:focus-within`, never by `display`.
  it('reveals the actions via opacity and :focus-within, never display:none', () => {
    const source = readFileSync('src/ui/GitPanel.svelte', 'utf8');
    const baseRule = /\.row \.actions \{([^}]*)\}/.exec(source)?.[1];
    expect(baseRule, 'expected a .row .actions rule in GitPanel.svelte').toBeDefined();
    expect(baseRule).not.toMatch(/display:\s*none/);

    // What this replaced: `expect(baseRule).toMatch(/opacity:\s*0/)`, which
    // matches `opacity: 0.7` exactly as happily as `opacity: 0` — the rule
    // was changed from one to the other and the assertion passed on both
    // sides, so it pinned nothing. Read the number out and assert the range
    // instead. `> 0` is the actual regression: at 0 the actions are in the
    // tab order but paint nothing, so a keyboard user activates a control
    // they never saw and a mouse user cannot learn a row is stageable
    // without hovering it. `< 1` is the other half of the intent — resting
    // state is secondary to the row's filename, not competing with it.
    const resting = Number(/opacity:\s*([\d.]+)/.exec(baseRule!)?.[1]);
    expect(resting, 'expected a resting opacity on .row .actions').not.toBeNaN();
    expect(resting).toBeGreaterThan(0);
    expect(resting).toBeLessThan(1);

    // The reveal must fire on focus, not only on pointer hover — otherwise
    // a keyboard user tabbing to a not-fully-opaque button can activate it
    // (opacity does not block focus) but never sees it happen. Both
    // selectors must land on opacity 1: naming `:focus-within` somewhere in
    // the file is not the same as it actually revealing anything.
    const revealRule = /\.row:hover \.actions,\s*\.row \.actions:focus-within \{([^}]*)\}/.exec(
      source,
    )?.[1];
    expect(revealRule, 'expected hover and focus-within to share one reveal rule').toBeDefined();
    expect(revealRule).toMatch(/opacity:\s*1\s*;/);
  });
});

describe('joining status paths onto the repository', () => {
  it('joins on the repo toplevel, not the workspace root, when the workspace opens below it', async () => {
    // The bug this pins: the panel used to join a toplevel-relative status
    // path onto the *workspace* root. When the workspace is opened below
    // the repo root, that silently targets whatever same-named file lives
    // at that wrong depth — here, a decoy nested under the workspace root
    // while the real modified file sits at the repo root above it.
    mounted = mountComponent(GitPanel);
    const { app, platform, container } = mounted;
    app.git.start();
    platform.seedGitRepo('/w');
    platform.seedGitBase('/w/a.txt', 'one\n');
    platform.seedFile('/w/a.txt', 'one\ntwo\n');
    platform.seedFile('/w/sub/a.txt', 'decoy\n');
    await app.workspace.openFolder('/w/sub');
    await settle();

    const row = [...container.querySelectorAll('.section.changes .row')].find(
      (r) => (r.querySelector('.open') as HTMLElement | null)?.textContent?.trim() === 'a.txt',
    )!;
    (row.querySelector('[title="Stage"]') as HTMLElement).click();
    await settle();
    await settle();

    const after = parseGitStatus(await platform.gitStatus('/w'));
    expect(after.staged).toContainEqual({ path: 'a.txt', status: 'M' });
    expect(after.staged.some((e) => e.path === 'sub/a.txt')).toBe(false);
    // The decoy is exactly as it was: untracked, never touched.
    expect(after.unstaged).toContainEqual({ path: 'sub/a.txt', status: 'U' });
  });

  it('refuses the join and disables a row\'s actions, with a title saying why, when the toplevel is unknown', async () => {
    const { app, container } = await setup();
    const current = app.git.status.get()!;
    app.git.status.set({ ...current, toplevel: null });
    flush();

    const row = [...container.querySelectorAll('.section.changes .row')].find((r) =>
      r.textContent!.includes('edited.ts'),
    )!;
    const openEl = row.querySelector('.open') as HTMLElement;
    // Rows still render — this is a refusal, not a crash.
    expect(openEl.textContent).toContain('edited.ts');
    expect(openEl.tagName).toBe('SPAN');
    expect(openEl.getAttribute('title') ?? '').toMatch(/repository root/i);

    const actionButtons = [...row.querySelectorAll('.actions button')];
    expect(actionButtons.length).toBeGreaterThan(0);
    for (const button of actionButtons) {
      expect((button as HTMLButtonElement).disabled, button.outerHTML).toBe(true);
      expect(button.getAttribute('title') ?? '').toMatch(/repository root/i);
    }
  });
});

describe('unstaging a rename', () => {
  it('resets both the new path and the original path, so the old path\'s deletion does not stay staged', async () => {
    // MemoryPlatform's status fake, unlike real porcelain, does not fuse a
    // delete+add pair into one `R` record with `origPath` — so the raw
    // staged shape it produces here (old.txt D, new.txt A) is fed to the
    // panel reshaped into the porcelain-collapsed form a real rename would
    // carry, which is the shape the fix (GitPanel's `unstageTargets`) has
    // to act correctly over.
    const { app, container, platform } = await setup();
    platform.seedGitBase('/w/old.txt', 'body\n');
    platform.seedFile('/w/old.txt', 'body\n');
    platform.externalRename('/w/old.txt', '/w/new.txt');
    await platform.gitStage('/w', ['/w/old.txt', '/w/new.txt']);

    const raw = parseGitStatus(await platform.gitStatus('/w'));
    expect(raw.staged).toContainEqual({ path: 'old.txt', status: 'D' });
    expect(raw.staged).toContainEqual({ path: 'new.txt', status: 'A' });

    app.git.status.set({
      ...raw,
      staged: [{ path: 'new.txt', status: 'R', origPath: 'old.txt' }],
    });
    flush();

    (container.querySelector('.section.staged .row [title="Unstage"]') as HTMLElement).click();
    await settle();
    await settle();

    const after = parseGitStatus(await platform.gitStatus('/w'));
    expect(after.staged.some((e) => e.path === 'old.txt')).toBe(false);
    expect(after.staged.some((e) => e.path === 'new.txt')).toBe(false);
  });
});

describe('a deleted row', () => {
  it('disables open on a deletion but keeps the row\'s stage/unstage action', async () => {
    const { app, container, platform } = await setup();
    platform.seedGitBase('/w/gone.ts', 'bye\n');
    platform.seedFile('/w/gone.ts', 'bye\n');
    platform.externalRemove('/w/gone.ts');
    await app.git.refreshStatus();
    await settle();

    const row = [...container.querySelectorAll('.section.changes .row')].find((r) =>
      r.textContent!.includes('gone.ts'),
    )!;
    const openEl = row.querySelector('.open') as HTMLElement;
    expect(openEl.tagName).toBe('SPAN');
    expect(openEl.getAttribute('title') ?? '').toMatch(/deleted/i);

    // The row's other actions are unaffected — a deletion can still be
    // (un)staged, only "open a file that is gone" is what is switched off.
    const stage = row.querySelector('[title="Stage"]') as HTMLButtonElement;
    expect(stage.disabled).toBe(false);
  });
});
