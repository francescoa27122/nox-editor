// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import ExplorerPanel from '../src/ui/ExplorerPanel.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Who is allowed to move keyboard focus into the file tree.
 *
 * Guards the bug this suite was written for: the explorer's focus effect read
 * `$lead` and `$nodes` in its tracked body, while the effect beside it writes
 * the lead on *every* active-buffer change. So switching tabs — clicking one,
 * or accepting a quick-open — silently re-ran the focus effect and pulled the
 * caret out of the document and into the tree. From there `↓` scrolled the
 * file list instead of moving the cursor, and `Backspace` dispatched
 * `explorer.delete`, putting a Move-to-Trash dialog over a file the user
 * believed they were typing in.
 *
 * The two halves matter equally. Only `$focusRequest` may pull focus, and it
 * still must: a fix that simply stopped focusing the tree would pass the
 * first test and break ⌘⇧E.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  flush();
}

/** A folder with two files, opened, with the explorer mounted over it. */
async function setup() {
  mounted = mountComponent(ExplorerPanel);
  const { app, platform, container } = mounted;
  platform.seedFile('/w/a.ts', 'const a = 1;\n');
  platform.seedFile('/w/b.ts', 'const b = 2;\n');
  await app.workspace.openFolder('/w');
  await app.files.setRoot('/w');
  await settle();

  // Somewhere else entirely for focus to be — the editor, as far as this
  // component is concerned.
  const elsewhere = document.createElement('button');
  document.body.appendChild(elsewhere);
  elsewhere.focus();

  const tree = container.querySelector('.tree') as HTMLElement;
  return { app, tree, elsewhere, cleanup: () => elsewhere.remove() };
}

describe('explorer focus ownership', () => {
  it('opening a file from elsewhere does not steal focus into the tree', async () => {
    const { app, tree, elsewhere, cleanup } = await setup();
    try {
      // Not `/w/a.ts`: the mount seeds the lead with the first row, and a
      // write of the value already there would not re-run anything.
      await app.workspace.open('/w/b.ts');
      await settle();

      // The lead did follow the active buffer — that behaviour is wanted.
      expect(app.ui.explorer.lead.get()).toBe('/w/b.ts');
      // Focus did not.
      expect(document.activeElement).toBe(elsewhere);
      expect(document.activeElement).not.toBe(tree);
    } finally {
      cleanup();
    }
  });

  it('an explicit focus request still moves focus into the tree', async () => {
    const { app, tree, elsewhere, cleanup } = await setup();
    try {
      expect(document.activeElement).toBe(elsewhere);

      app.ui.focusExplorer();
      await settle();

      expect(document.activeElement).toBe(tree);
    } finally {
      cleanup();
    }
  });
});
