import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { mirroredAnnotation } from '../src/services/transactions';
import { WorkspaceService, type BufferId } from '../src/services/workspace';

/**
 * One document in two panes, and the session that brings the pair back.
 *
 * These are driven through a **re-entrant** fake pane rather than a stub that
 * records what it was handed. That distinction is the whole point: the four
 * defects below all live in the loop between the workspace pushing a change
 * out and a pane routing it back in, and a dispatcher that never calls
 * `applyTransaction` cannot see any of them. The existing pane tests in
 * `groups.test.ts` use recording stubs, which is why they passed throughout.
 *
 * `FakePane` reproduces `EditorPane.svelte`'s two rules exactly: apply every
 * spec to its own state, and hand anything not already marked `mirrored` back
 * to the workspace with itself as the origin.
 */
class FakePane {
  state: EditorState;
  /** Stands in for the `EditorView` instance `EditorPane` passes as `owner`. */
  readonly self = {};
  /** Records what the workspace asked this pane about, when a test cares. */
  onAsked: ((id: BufferId | undefined) => void) | null = null;
  #workspace: WorkspaceService;
  #showing: BufferId;

  constructor(workspace: WorkspaceService, showing: BufferId, state: EditorState) {
    this.#workspace = workspace;
    this.#showing = showing;
    this.state = state;
  }

  get text(): string {
    return this.state.doc.toString();
  }

  register(groupId?: string): () => void {
    return this.#workspace.addViewDispatcher(
      (target, spec) => {
        if (target !== this.#showing) return false;
        const transaction = this.state.update(spec);
        this.state = transaction.state;
        // The pane's own guard: a change forwarded from the other pane has
        // already been recorded by the workspace.
        if (transaction.annotation(mirroredAnnotation)) return true;
        this.#workspace.applyTransaction(target, transaction, this.self);
        return true;
      },
      {
        owner: this.self,
        ...(groupId !== undefined ? { groupId } : {}),
        readSelection: (id: BufferId) => {
          this.onAsked?.(id);
          if (id !== this.#showing) return null;
          const selection = this.state.selection;
          return {
            ranges: selection.ranges.map((r) => [r.anchor, r.head] as [number, number]),
            main: selection.mainIndex,
          };
        },
      },
    );
  }
}

function setup() {
  const platform = new MemoryPlatform();
  platform.seedFile('/w/a.ts', 'one\n');
  platform.seedFile('/w/b.ts', 'two\n');
  platform.seedFile('/w/c.ts', 'three\n');
  const workspace = new WorkspaceService(platform, () => []);
  return { platform, workspace };
}

const layout = (workspace: WorkspaceService) =>
  workspace.groups.get().map((group) => group.tabs.map((tab) => tab.name));

describe('a change the workspace originates, with the file in two panes', () => {
  /**
   * The failure this prevents, and it is the worst one in the split-pane
   * feature: `#dispatchToView` handed the *same* spec to every pane in turn,
   * while each pane's route back through `applyTransaction` had already
   * mirrored it to the others. So the second pane applied a change that had
   * already landed — against a document that had already moved.
   *
   * With a reload, whose spec is `{from: 0, to: oldLength, insert: newDoc}`,
   * a file that grew came back as the new text with a slice of itself
   * appended. `reloadFromDisk` then set `savedDoc` from that state, so the
   * corrupted document was marked **clean** and the next save wrote it out.
   */
  it('applies exactly once to each pane', async () => {
    const { platform, workspace } = setup();
    const id = (await workspace.open('/w/a.ts'))!;
    workspace.splitEditor();
    workspace.mirrorInto(workspace.groups.get()[0]!.id, id);

    const state = workspace.stateOf(id)!;
    const one = new FakePane(workspace, id, state);
    const two = new FakePane(workspace, id, state);
    one.register();
    two.register();

    platform.seedFile('/w/a.ts', 'one\nand quite a lot more than there was\n');
    await workspace.reloadFromDisk(id);

    expect(one.text).toBe('one\nand quite a lot more than there was\n');
    expect(two.text).toBe('one\nand quite a lot more than there was\n');
    expect(workspace.textOf(id)).toBe('one\nand quite a lot more than there was\n');
  });

  /**
   * The other half of the same defect. A file that *shrank* gave the second
   * pane a range its document could no longer honour, and CodeMirror throws
   * on that — out of `reloadFromDisk`, mid-reload.
   */
  it('does not throw when the file shrank', async () => {
    const { platform, workspace } = setup();
    const id = (await workspace.open('/w/a.ts'))!;
    workspace.splitEditor();
    workspace.mirrorInto(workspace.groups.get()[0]!.id, id);

    const state = workspace.stateOf(id)!;
    const one = new FakePane(workspace, id, state);
    const two = new FakePane(workspace, id, state);
    one.register();
    two.register();

    platform.seedFile('/w/a.ts', 'x\n');
    await expect(workspace.reloadFromDisk(id)).resolves.toBe(true);

    expect(one.text).toBe('x\n');
    expect(two.text).toBe('x\n');
  });

  /** A single pane must keep behaving exactly as it did. */
  it('still reaches the only pane when the file is shown once', async () => {
    const { platform, workspace } = setup();
    const id = (await workspace.open('/w/a.ts'))!;
    const only = new FakePane(workspace, id, workspace.stateOf(id)!);
    only.register();

    platform.seedFile('/w/a.ts', 'replaced\n');
    await workspace.reloadFromDisk(id);

    expect(only.text).toBe('replaced\n');
    expect(workspace.textOf(id)).toBe('replaced\n');
  });

  /** And a buffer no pane is showing still takes the background path. */
  it('falls back to its own state when no pane is showing the file', async () => {
    const { platform, workspace } = setup();
    const id = (await workspace.open('/w/a.ts'))!;

    platform.seedFile('/w/a.ts', 'replaced\n');
    await workspace.reloadFromDisk(id);

    expect(workspace.textOf(id)).toBe('replaced\n');
  });
});

describe('the cursor a pane reports', () => {
  /**
   * The failure this prevents: `selectionOf` asked a pane in the right group
   * for its live selection without saying *which buffer* it was asking about,
   * and a pane's live selection is its **active** tab's. So every background
   * tab in every pane was persisted with the foreground tab's cursor — a.ts
   * read at line 400, b.ts edited at line 3, quit, and a.ts comes back at
   * line 3. The existing tests gave each group exactly one tab, where "the
   * pane's cursor" and "that tab's cursor" are the same thing.
   *
   * Asserted on the *question* as well as the answer: a pane that is not told
   * which buffer it is being asked about cannot possibly decline, so the id
   * reaching it is the fix, and the two range assertions are its effect.
   */
  it('belongs to the tab it was asked about, not to whatever the pane shows', async () => {
    const { workspace } = setup();
    const background = (await workspace.open('/w/a.ts'))!;
    const foreground = (await workspace.open('/w/b.ts'))!;
    const groupId = workspace.groups.get()[0]!.id;

    const asked: (BufferId | undefined)[] = [];
    // The pane is showing b.ts, with its caret somewhere b.ts has and a.ts
    // has no reason to.
    const pane = new FakePane(workspace, foreground, workspace.stateOf(foreground)!);
    pane.onAsked = (id) => asked.push(id);
    pane.state = pane.state.update({ selection: { anchor: 3 } }).state;
    pane.register(groupId);

    workspace.setSelection(background, { ranges: [[1, 1]], main: 0 });

    expect(workspace.selectionOf(background, groupId)?.ranges).toEqual([[1, 1]]);
    expect(workspace.selectionOf(foreground, groupId)?.ranges).toEqual([[3, 3]]);
    expect(asked).toEqual([background, foreground]);
  });
});

describe('splitting a pane', () => {
  /** The command's own behaviour is unchanged: the active tab moves across. */
  it('moves the active tab by default', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');

    workspace.splitEditor();

    expect(layout(workspace)).toEqual([['a.ts'], ['b.ts']]);
  });

  /**
   * The failure this prevents: session restore called `splitEditor()` for
   * every group after the first, and `splitEditor` *moves* the active tab
   * when its group has more than one. So a layout whose first pane held two
   * tabs came back with the second of them relocated — every launch.
   */
  it('can add an empty pane instead, for restore', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');

    workspace.splitEditor({ move: false });

    expect(layout(workspace)).toEqual([['a.ts', 'b.ts'], []]);
  });
});

describe('closing a tab', () => {
  /**
   * The failure this prevents: `close` has always taken the group to close
   * in, and the tests drove it directly — but no production caller passed
   * one. `#groupOf` then fell back to "the first group showing this buffer",
   * so ⌘W in the *second* pane of a mirrored file closed the tab in the
   * first, taking that pane with it.
   */
  it('closes the tab in the pane it was asked about', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/w/a.ts'))!;
    const first = workspace.groups.get()[0]!.id;
    const second = workspace.openCopyToSide()!;

    workspace.close(id, { force: true, group: second });

    expect(workspace.groups.get()).toHaveLength(1);
    expect(workspace.groups.get()[0]!.id).toBe(first);
    expect(layout(workspace)).toEqual([['a.ts']]);
  });
});

describe('closing through the app, with one file in two panes', () => {
  async function appWithMirror() {
    const platform = new MemoryPlatform();
    platform.mkdirp('/w');
    platform.seedFile('/w/a.ts', 'one\n');
    const app = new NoxApp(platform);
    await app.workspace.openFolder('/w');
    const id = (await app.workspace.open('/w/a.ts'))!;
    const first = app.workspace.groups.get()[0]!.id;
    const second = app.workspace.openCopyToSide()!;
    return { app, id, first, second };
  }

  /**
   * The failure this prevents, and it is the wiring rather than the model:
   * `closeBuffer` never passed a group, so `#groupOf` fell back to the first
   * pane showing the file. Focus the copy, press Cmd-W, and the *original*
   * pane closed instead — taking the pane with it, because it was then empty.
   */
  it('closes the tab in the focused pane', async () => {
    const { app, id, first, second } = await appWithMirror();
    expect(app.workspace.activeGroupId.get()).toBe(second);

    expect(await app.closeBuffer(id)).toBe(true);

    expect(app.workspace.groups.get().map((group) => group.id)).toEqual([first]);
    expect(app.workspace.buffers.get()).toHaveLength(1);
  });

  /**
   * Deliberately names the pane that is **neither** focused nor the one the
   * old fallback would have picked. Both of those are the first pane here, so
   * a version that ignored the argument would close the wrong one and this
   * would fail — which is what a middle-click or an X on an unfocused tab in
   * the second pane actually does.
   */
  it('closes the pane the caller names, when it names one', async () => {
    const { app, id, first, second } = await appWithMirror();
    app.workspace.focusGroup(first);

    expect(await app.closeBuffer(id, { group: second })).toBe(true);

    expect(app.workspace.groups.get().map((group) => group.id)).toEqual([first]);
  });

  /**
   * `buffers` is deduplicated — one entry however many panes show the file —
   * so iterating it closed a mirrored file once and left the second tab
   * behind, while the command reported success.
   */
  it('Close All Files leaves nothing open', async () => {
    const { app } = await appWithMirror();

    await app.commands.execute('file.closeAll');

    expect(app.workspace.buffers.get()).toHaveLength(0);
    expect(app.workspace.groups.get().flatMap((group) => group.tabs)).toEqual([]);
  });
});
