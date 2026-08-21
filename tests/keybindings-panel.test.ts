// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import KeybindingsPanel from '../src/ui/KeybindingsPanel.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The keybinding editor over a real app, real commands and the real default
 * keymap — see `docs/superpowers/specs/2026-08-20-keybinding-editor-design.md`
 * §4. Keys are delivered through `keymap.handleKey`, which is the same door
 * `attach`'s window listener uses, so recording is exercised rather than
 * simulated.
 *
 * The subject is `view.toggleExplorer` rather than something like
 * `file.save`: `resolve()` skips a binding whose command is disabled, and a
 * freshly constructed app has no buffer, so a save binding would read as
 * unbound no matter what this panel wrote.
 *
 * Mutation checks (each made the named test red, then reverted):
 * - `accept()` skipping the `unassign` loop over conflicts →
 *   "accepting a conflicting chord unassigns the command that held it".
 * - the rows derivation not reading `$keymapVersion` →
 *   "recording a chord and accepting rebinds the live keymap" (the list
 *   kept the old chord).
 * - `stopRecording()` not calling `endCapture` →
 *   "cancelling gives the keys back".
 * - the unbound-command rows dropped from the derivation →
 *   "a command with no key gets a row that says so".
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/** Minimal stand-in for a KeyboardEvent; only the fields the keymap reads. */
function keyEvent(init: {
  code: string;
  key?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}): KeyboardEvent {
  return {
    code: init.code,
    key: init.key ?? '',
    ctrlKey: init.ctrl ?? false,
    altKey: init.alt ?? false,
    shiftKey: init.shift ?? false,
    metaKey: init.meta ?? false,
    repeat: false,
    isComposing: false,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as KeyboardEvent;
}

function setup() {
  mounted = mountComponent(KeybindingsPanel);
  flush();
  return mounted;
}

function rowFor(container: HTMLElement, commandId: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`.row[data-command="${commandId}"]`);
  if (!row) throw new Error(`no row for ${commandId}`);
  return row;
}

function click(element: Element | null): void {
  (element as HTMLElement).click();
  flush();
}

/** Type a chord at the panel through the keymap's own door. */
function press(app: Mounted['app'], init: Parameters<typeof keyEvent>[0]): void {
  app.keymap.handleKey(keyEvent(init));
  flush();
}

describe('the keybinding editor', () => {
  it('lists a bound command with its chord', () => {
    const { container } = setup();
    expect(rowFor(container, 'view.toggleExplorer').querySelector('.chord')!.textContent).toContain('B');
  });

  it('a command with no key gets a row that says so', () => {
    const { container, app } = setup();
    const unbound = app.commands.all().find((c) => !app.keymap.displayFor(c.id));
    expect(unbound).toBeDefined();

    const row = rowFor(container, unbound!.id);
    expect(row.querySelector('.chord')!.textContent).toContain('Unassigned');
  });

  it('recording a chord and accepting rebinds the live keymap', () => {
    const { container, app } = setup();
    click(rowFor(container, 'view.toggleExplorer').querySelector('.edit'));

    press(app, { code: 'F9' });
    click(container.querySelector('.recording .accept'));

    expect(app.keymap.resolve(keyEvent({ code: 'F9' }))).toBe('view.toggleExplorer');
    expect(app.keymap.resolve(keyEvent({ code: 'KeyB', ctrl: true }))).toBeNull();
    expect(rowFor(container, 'view.toggleExplorer').querySelector('.chord')!.textContent).toContain('F9');
  });

  it('Enter accepts once a chord is recorded, and Escape cancels', () => {
    const { container, app } = setup();
    click(rowFor(container, 'view.toggleExplorer').querySelector('.edit'));

    press(app, { code: 'F9' });
    press(app, { code: 'Enter' });

    expect(app.keymap.resolve(keyEvent({ code: 'F9' }))).toBe('view.toggleExplorer');
    expect(container.querySelector('.recording')).toBeNull();
  });

  it('cancelling gives the keys back and changes nothing', () => {
    const { container, app } = setup();
    click(rowFor(container, 'view.toggleExplorer').querySelector('.edit'));
    press(app, { code: 'F9' });
    press(app, { code: 'Escape' });

    expect(app.keymap.capturing).toBe(false);
    expect(container.querySelector('.recording')).toBeNull();
    expect(app.keymap.resolve(keyEvent({ code: 'KeyB', ctrl: true }))).toBe('view.toggleExplorer');
    expect(app.keymap.userRules()).toEqual([]);
  });

  it('a recorded chord already in use names the command it would displace', () => {
    const { container, app } = setup();
    click(rowFor(container, 'view.toggleExplorer').querySelector('.edit'));
    press(app, { code: 'KeyP', ctrl: true });

    const conflict = container.querySelector('.recording .conflict')!.textContent ?? '';
    expect(conflict).toContain(app.commands.get('nav.quickOpen')!.title);
  });

  it('accepting a conflicting chord unassigns the command that held it', () => {
    const { container, app } = setup();
    click(rowFor(container, 'view.toggleExplorer').querySelector('.edit'));
    press(app, { code: 'KeyP', ctrl: true });
    click(container.querySelector('.recording .accept'));

    expect(app.keymap.resolve(keyEvent({ code: 'KeyP', ctrl: true }))).toBe('view.toggleExplorer');
    expect(rowFor(container, 'nav.quickOpen').querySelector('.chord')!.textContent).toContain(
      'Unassigned',
    );
  });

  it('the same chord on the same command is a no-op, not a conflict', () => {
    const { container, app } = setup();
    click(rowFor(container, 'view.toggleExplorer').querySelector('.edit'));
    press(app, { code: 'KeyB', ctrl: true });

    expect(container.querySelector('.recording .conflict')).toBeNull();
    click(container.querySelector('.recording .accept'));
    expect(app.keymap.resolve(keyEvent({ code: 'KeyB', ctrl: true }))).toBe('view.toggleExplorer');
  });

  it('clearing a row unassigns it, and the key falls through', () => {
    const { container, app } = setup();
    click(rowFor(container, 'view.toggleExplorer').querySelector('.clear'));

    expect(app.keymap.resolve(keyEvent({ code: 'KeyB', ctrl: true }))).toBeNull();
    expect(rowFor(container, 'view.toggleExplorer').querySelector('.chord')!.textContent).toContain(
      'Unassigned',
    );
  });

  it('reset appears only on a customised row, and restores the default', () => {
    const { container, app } = setup();
    expect(rowFor(container, 'view.toggleExplorer').querySelector('.reset')).toBeNull();

    click(rowFor(container, 'view.toggleExplorer').querySelector('.clear'));
    click(rowFor(container, 'view.toggleExplorer').querySelector('.reset'));

    expect(app.keymap.resolve(keyEvent({ code: 'KeyB', ctrl: true }))).toBe('view.toggleExplorer');
    expect(rowFor(container, 'view.toggleExplorer').querySelector('.reset')).toBeNull();
  });

  it('Reset all appears only once something is customised, and clears the lot', () => {
    const { container, app } = setup();
    expect(container.querySelector('.reset-all')).toBeNull();

    click(rowFor(container, 'view.toggleExplorer').querySelector('.clear'));
    expect(container.querySelector('.reset-all')).not.toBeNull();

    click(container.querySelector('.reset-all'));
    expect(app.keymap.userRules()).toEqual([]);
    expect(container.querySelector('.reset-all')).toBeNull();
  });

  it("the Editor section is read-only — CodeMirror owns those keys", () => {
    const { container } = setup();
    const editorRows = [...container.querySelectorAll('.row.readonly')];

    expect(editorRows.length).toBeGreaterThan(0);
    expect(editorRows.some((row) => row.querySelector('.edit'))).toBe(false);
  });

  it('unmounting ends capture, so a half-finished recording cannot eat the keyboard', () => {
    const { container, app } = setup();
    click(rowFor(container, 'view.toggleExplorer').querySelector('.edit'));
    expect(app.keymap.capturing).toBe(true);

    mounted!.unmount();
    mounted = null;

    expect(app.keymap.capturing).toBe(false);
  });
});
