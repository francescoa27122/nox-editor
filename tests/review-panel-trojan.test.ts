// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import ReviewPanel from '../src/ui/ReviewPanel.svelte';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The review panel showing what a proposal actually holds.
 *
 * Guards A7-007's wiring: the detector in `core/trojan.ts` has its own tests,
 * and this one proves the panel uses it. Before it, a hunk line was a bare
 * text node, so a bidi override reordered the diff on screen and a
 * zero-width character inside a name was drawn as nothing at all.
 *
 * Not caught here: what the user sees, since jsdom does no layout and no
 * bidi shaping. The assertion is on the DOM text, which is what the browser
 * would shape; once the control is a visible `<U+202E>` there is nothing left
 * for the shaper to reorder.
 */

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function panelWithProposal(insert: string) {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/a.js', 'let x = 1;\n');

  const app = new NoxApp(platform);
  await app.workspace.openFolder('/w');
  const a = (await app.workspace.open('/w/a.js'))!;
  app.review.stage({
    description: 'Tweak',
    author: { kind: 'agent', sessionId: 'agent-1', label: 'Test agent' },
    edits: [{ bufferId: a, changes: { from: 0, to: 10, insert } }],
  });

  mounted = mountComponent(ReviewPanel, { app });
  flush();
  return mounted.container;
}

describe('the review panel', () => {
  it('draws a bidi override where it sits and flags the hunk', async () => {
    const container = await panelWithProposal('/*\u202E } if (isAdmin) { */');

    const added = container.querySelector('.line.added')!;
    expect(added.textContent).toContain('/*<U+202E> } if (isAdmin) { */');
    expect(added.textContent).not.toContain('\u202E');

    const note = container.querySelector('.trojan-note')!;
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('bidi controls');
  });

  it('shows a zero-width character inside a name and says so', async () => {
    const container = await panelWithProposal('let is\u200BAdmin = 1;');

    expect(container.querySelector('.line.added')!.textContent).toContain('is<U+200B>Admin');
    expect(container.querySelector('.trojan-note')!.textContent).toContain('zero-width characters');
  });

  it('leaves an ordinary hunk unflagged and untouched', async () => {
    const container = await panelWithProposal('let y = 2;');

    expect(container.querySelector('.line.added')!.textContent).toContain('let y = 2;');
    expect(container.querySelector('.trojan-note')).toBeNull();
  });

  it('stages exactly what was proposed: revealing is rendering, not rewriting', async () => {
    await panelWithProposal('let is\u200BAdmin = 1;');
    const staged = mounted!.app.review.staged.get()!;
    expect(staged.files[0]!.hunks[0]!.added[0]).toContain('\u200B');
  });
});
