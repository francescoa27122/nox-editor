import type { MenuNode, Platform, PredefinedMenuItemId } from '@platform/types';
import type { Command, CommandRegistry } from './commands';
import type { KeymapService } from './keymap';

/**
 * The application menu.
 *
 * Nox had none, so the command palette was the only index of what the app can
 * do — which made every command without a keybinding or a button invisible
 * unless you already knew its name. 51 of them were in exactly that position.
 *
 * The tree is *derived from the command table*, not written out by hand. A
 * hand-written menu would be a second list of ~140 titles with nothing to keep
 * it in step with the first, and the failure mode of drift here is the failure
 * mode we are fixing: a command nobody can find. {@link LAYOUT} says only
 * which categories share a menu; everything else falls out of the registry,
 * and `tests/menu.test.ts` asserts that nothing is left out.
 *
 * ## Accelerators, and why they cannot fire twice
 *
 * A macOS menu accelerator and Nox's in-page keymap are two routes to the same
 * command, and a keypress must not take both. It cannot, and the reason is
 * mechanical rather than lucky:
 *
 *   - `KeymapService.attach` listens on `window` in the **capture** phase and
 *     calls `preventDefault()` on every chord it claims, whatever has focus.
 *   - WKWebView's `performKeyEquivalent:` forwards a key equivalent to the
 *     page and only re-dispatches it to the main menu when the page did *not*
 *     consume it. Consumed by the page and delivered to the menu are the two
 *     halves of one branch.
 *
 * So an accelerator is only ever reached when the keymap declined the chord —
 * which happens when the command is disabled, and `CommandRegistry.execute`
 * refuses a disabled command anyway. The recorded desktop run in
 * `.desktop-pass-report.md:38` is the observation that matches: ⌘W is on both
 * `PredefinedMenuItem::close_window` and `file.close`, and it closed the file.
 *
 * That argument only holds for chords the *page* claims, which is why an
 * accelerator is attached only where {@link KeymapService.chordFor} reports an
 * application binding. A command whose chord belongs to CodeMirror instead
 * (`keyHint`, e.g. ⌘⇧K for Delete Line) gets a menu entry with no chord: the
 * editor only prevents default while it has focus, so an accelerator there
 * would fire against the editor from inside a search field. Undo, Redo and the
 * clipboard are handled the other way round — by predefined items that go
 * through the responder chain and do the right thing in any focused control.
 */

/** Which categories share a menu, and in what order the menus appear. */
interface MenuGroup {
  label: string;
  /** Command categories, in order. Each becomes a separated block. */
  categories: readonly string[];
  /** Handed to the OS, which attaches its own behaviour. See `MenuNode`. */
  role?: 'window' | 'help';
  /** System items placed before the commands. */
  leading?: readonly MenuNode[];
  /** System items placed after them. */
  trailing?: readonly MenuNode[];
}

const separator: MenuNode = { kind: 'separator' };
const predefined = (item: PredefinedMenuItemId, label?: string): MenuNode =>
  label === undefined ? { kind: 'predefined', item } : { kind: 'predefined', item, label };

/**
 * Commands the menu deliberately does not list, because a predefined item
 * covers them better. Each of these goes through the responder chain, so it
 * acts on whatever has focus rather than always on the editor.
 *
 * Kept as data because `tests/menu.test.ts` asserts the coverage claim against
 * it: every other non-hidden command must appear exactly once.
 */
export const COVERED_BY_SYSTEM_ITEMS: readonly string[] = [
  'edit.undo',
  'edit.redo',
  'edit.selectAll',
];

export const LAYOUT: readonly MenuGroup[] = [
  {
    label: 'Nox',
    categories: ['Application', 'Preferences'],
    leading: [predefined('about', 'About Nox'), separator],
    trailing: [
      separator,
      predefined('services'),
      separator,
      predefined('hide', 'Hide Nox'),
      predefined('hideOthers'),
      predefined('showAll'),
      separator,
      predefined('quit', 'Quit Nox'),
    ],
  },
  // Explorer sits under File, not View. Rename…, Delete…, Duplicate and Copy
  // Path are file operations, and View is not where anyone looks for them —
  // they arrived here because the explorer is a view, which is a fact about
  // the widget rather than about what the commands do. The three that really
  // are view operations (refresh, collapse all, select all in the tree) carry
  // `category: 'View'` instead and stay in the View menu.
  { label: 'File', categories: ['File', 'Explorer'] },
  {
    label: 'Edit',
    categories: ['Edit'],
    leading: [
      predefined('undo'),
      predefined('redo'),
      separator,
      predefined('cut'),
      predefined('copy'),
      predefined('paste'),
      predefined('selectAll'),
      separator,
    ],
  },
  { label: 'Find', categories: ['Search'] },
  { label: 'Go', categories: ['Go'] },
  {
    label: 'View',
    categories: ['View'],
    trailing: [separator, predefined('fullscreen')],
  },
  { label: 'Code', categories: ['Language', 'Change Marks', 'Review'] },
  { label: 'Tools', categories: ['Terminal', 'Git', 'Agents', 'Answers', 'Notes'] },
  {
    // The role is what makes macOS list the open windows in it and add its
    // own Bring All to Front; a submenu merely *labelled* Window is an
    // ordinary submenu with two items in it.
    label: 'Window',
    role: 'window',
    categories: [],
    leading: [predefined('minimize'), predefined('maximize')],
  },
];

/** Where a command whose category no category list claims ends up. */
const OVERFLOW_LABEL = 'More';

/**
 * Nox's canonical chord → a native accelerator, or undefined when there is no
 * faithful translation.
 *
 * Undefined rather than a guess: a menu that displays the wrong chord teaches
 * the user a key that does nothing, which is worse than showing none.
 */
export function toAccelerator(chord: string): string | undefined {
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  const modifiers = new Set(parts);

  const NAMES: Record<string, string> = {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    meta: 'Cmd',
  };
  const ordered: string[] = [];
  for (const modifier of ['ctrl', 'alt', 'shift', 'meta']) {
    if (!modifiers.has(modifier)) continue;
    ordered.push(NAMES[modifier]!);
  }
  // Every modifier must be one we know: an unrecognised one would silently
  // drop out and leave a *weaker* accelerator that fires on the wrong keypress.
  if (ordered.length !== modifiers.size) return undefined;

  const named: Record<string, string> = {
    escape: 'Escape',
    enter: 'Enter',
    tab: 'Tab',
    space: 'Space',
    backspace: 'Backspace',
    delete: 'Delete',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    home: 'Home',
    end: 'End',
    pgup: 'PageUp',
    pgdown: 'PageDown',
  };

  const isFunctionKey = /^f([1-9]|1\d|2[0-4])$/.test(key);

  let token: string | undefined;
  if (key.length === 1 && /[a-z0-9`\-=[\]\\;',./]/.test(key)) token = key.toUpperCase();
  else if (named[key]) token = named[key];
  else if (isFunctionKey) token = key.toUpperCase();

  if (!token) return undefined;
  // Unmodified accelerators are for function keys only. F12 cannot be typed
  // into a text field, so claiming it costs nothing; a bare letter, digit or
  // Escape would be claimed out of every input in the window the moment the
  // page declined it.
  if (ordered.length === 0 && !isFunctionKey) return undefined;

  return [...ordered, token].join('+');
}

/**
 * Build the menu description from the command table.
 *
 * Pure, and exported for the test that checks nothing is missing —
 * `MenuService` only adds the platform round trip.
 */
export interface BuildOptions {
  /**
   * Whether the platform supplies its own menu items — Undo, Cut, Quit and
   * the rest of the responder chain.
   *
   * True on macOS, where the system draws them and performing them through
   * the responder chain is what makes ⌘Z work in a text field rather than
   * only in the document.
   *
   * False wherever Nox draws the menu itself. There is no responder chain to
   * defer to, so `COVERED_BY_SYSTEM_ITEMS` stops meaning "leave these out" —
   * those commands exist and must be listed, or Undo and Select All appear
   * in no menu at all. Nothing `predefined` is emitted either: it names an
   * action only the OS can perform, so a hand-drawn menu could only render
   * it as a row that does nothing.
   */
  systemItems: boolean;
}

export function buildMenu(
  commands: readonly Command[],
  acceleratorFor: (commandId: string) => string | undefined,
  options: BuildOptions = { systemItems: true },
): MenuNode[] {
  const covered = new Set(options.systemItems ? COVERED_BY_SYSTEM_ITEMS : []);
  const byCategory = new Map<string, Command[]>();
  for (const command of commands) {
    if (command.hidden || covered.has(command.id)) continue;
    const category = command.category ?? OVERFLOW_LABEL;
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(command);
    else byCategory.set(category, [command]);
  }

  const item = (command: Command): MenuNode => {
    const accelerator = acceleratorFor(command.id);
    return accelerator === undefined
      ? { kind: 'command', commandId: command.id, label: command.title }
      : { kind: 'command', commandId: command.id, label: command.title, accelerator };
  };

  const menus: MenuNode[] = [];
  const placed = new Set<string>();

  // `leading`/`trailing` are where every `predefined` node enters the tree.
  // Dropping them here rather than filtering the finished menu keeps the
  // separator bookkeeping below honest: a group left with nothing but rules
  // must not become a menu.
  const fixed = (nodes: readonly MenuNode[] | undefined): MenuNode[] =>
    (nodes ?? []).filter((node) => options.systemItems || node.kind !== 'predefined');

  for (const group of LAYOUT) {
    const items: MenuNode[] = [...fixed(group.leading)];
    let blocks = 0;
    for (const category of group.categories) {
      const bucket = byCategory.get(category);
      if (!bucket || bucket.length === 0) continue;
      placed.add(category);
      // A rule between categories, so a menu that merges several still reads
      // as the groups it was built from rather than one long list.
      if (blocks > 0) items.push(separator);
      for (const command of bucket) items.push(item(command));
      blocks += 1;
    }
    items.push(...fixed(group.trailing));

    // A rule exists to separate two things. Dropping the system items can
    // leave one with nothing on a side — `leading: [about, separator]` and
    // `trailing: [separator, fullscreen]` both do — so rules are collapsed
    // after the fact rather than each site being special-cased.
    const tidy = items.filter((node, index) => {
      if (node.kind !== 'separator') return true;
      if (index === 0) return false;
      if (items[index - 1]?.kind === 'separator') return false;
      return items.slice(index + 1).some((later) => later.kind !== 'separator');
    });

    if (tidy.length === 0) continue;
    menus.push(
      group.role === undefined
        ? { kind: 'submenu', label: group.label, items: tidy }
        : { kind: 'submenu', label: group.label, role: group.role, items: tidy },
    );
  }

  // A category nobody claimed gets its own menu rather than disappearing. That
  // is the whole safety property: adding a command with a new category makes
  // the menu untidy, never incomplete.
  const strays = [...byCategory.entries()].filter(([category]) => !placed.has(category));
  for (const [category, bucket] of strays) {
    menus.push({ kind: 'submenu', label: category, items: bucket.map(item) });
  }

  return menus;
}

export class MenuService {
  #platform: Platform;
  #commands: CommandRegistry;
  #keymap: KeymapService;
  #disposeMenuListener: (() => void) | null = null;
  #disposeKeymapListener: (() => void) | null = null;

  constructor(platform: Platform, commands: CommandRegistry, keymap: KeymapService) {
    this.#platform = platform;
    this.#commands = commands;
    this.#keymap = keymap;
  }

  /** The tree as it would be installed. Exposed for tests and for `install`. */
  describe(): MenuNode[] {
    return buildMenu(
      this.#commands.all(),
      (commandId) => {
        const chord = this.#keymap.chordFor(commandId);
        return chord === undefined ? undefined : toAccelerator(chord);
      },
      // One tree, two consumers: the native menu on macOS and `MenuBar` where
      // Nox draws its own. Reading the same builder is what stops the two
      // drifting — there is no second layout table to keep in step.
      { systemItems: this.#platform.capabilities.applicationMenu },
    );
  }

  async install(): Promise<void> {
    await this.#platform.setApplicationMenu(this.describe());
  }

  /**
   * Install the menu and start routing it. Call once boot has loaded the
   * user's keybindings, so the accelerators shown are the ones that work.
   */
  async start(): Promise<void> {
    this.#disposeMenuListener = await this.#platform.onMenuCommand((commandId) => {
      // Through the registry like every other route in, so a disabled command
      // is refused here exactly as it is from the palette or a keypress.
      void this.#commands.execute(commandId);
    });

    await this.install();

    // Rebinding a key in the Keybindings panel changes what the accelerators
    // should say. `Signal.subscribe` calls back immediately, and that first
    // call is the state we have just installed.
    let first = true;
    this.#disposeKeymapListener = this.#keymap.version.subscribe(() => {
      if (first) {
        first = false;
        return;
      }
      void this.install();
    });
  }

  dispose(): void {
    this.#disposeMenuListener?.();
    this.#disposeMenuListener = null;
    this.#disposeKeymapListener?.();
    this.#disposeKeymapListener = null;
  }
}
