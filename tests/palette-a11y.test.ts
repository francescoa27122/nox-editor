// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import CommandPalette from '../src/ui/CommandPalette.svelte';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import type { OverlayKind } from '../src/services/ui';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * What a screen reader is told the palette is.
 *
 * What this guards: the dialog was `aria-label="Command palette"` in every
 * one of its modes, so quick open, go to line, the branch picker and the
 * language picker all announced themselves as the command palette, and the
 * result count was a bare number in a span with no label, so a screen reader
 * heard "158" and nothing about what 158 was. The input's own label already
 * follows the mode; the dialog and the count now do too.
 *
 * What this does not catch: the wording being useful. It holds that the
 * label changes with the mode and names the count, not that the words are
 * the right ones.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function open(mode: OverlayKind, app = new NoxApp(new MemoryPlatform())) {
  mounted = mountComponent(CommandPalette, { props: { mode }, app });
  flush();
  return mounted;
}

const dialogLabel = (container: HTMLElement) =>
  container.querySelector('[role="dialog"]')?.getAttribute('aria-label');

function setQuery(container: HTMLElement, value: string): void {
  const input = container.querySelector('input')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flush();
}

describe('the dialog name', () => {
  it('is the command palette only when it is one', () => {
    expect(dialogLabel(open('palette').container)).toBe('Command palette');
  });

  it('follows the mode it opened in', () => {
    expect(dialogLabel(open('quick-open').container)).not.toBe('Command palette');
    mounted!.unmount();
    expect(dialogLabel(open('go-to-line').container)).not.toBe('Command palette');
    mounted!.unmount();
    expect(dialogLabel(open('language').container)).not.toBe('Command palette');
  });

  /**
   * The prefixes switch modes without reopening, so the name has to be
   * derived from the effective mode rather than the one it opened in.
   */
  it('follows a prefix typed mid-way', () => {
    const { container } = open('quick-open');
    const files = dialogLabel(container);

    setQuery(container, ':');
    const line = dialogLabel(container);
    expect(line).not.toBe(files);

    setQuery(container, '>');
    expect(dialogLabel(container)).toBe('Command palette');
  });
});

describe('the result count', () => {
  it('is a labelled live region that says what it counts', () => {
    const app = new NoxApp(new MemoryPlatform());
    app.commands.register({ id: 'test.one', title: 'One', category: 'Test', run: () => {} });
    const { container } = open('palette', app);

    const count = container.querySelector<HTMLElement>('.result-count');
    expect(count).not.toBeNull();
    expect(count!.getAttribute('role')).toBe('status');
    // The visible text stays the bare number the sighted user scans; the
    // label carries the noun.
    expect(count!.getAttribute('aria-label')).toMatch(/^\d+ results?$/);
    expect(count!.textContent?.trim()).toMatch(/^\d+$/);
  });
});
