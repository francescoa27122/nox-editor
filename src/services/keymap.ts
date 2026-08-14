import { Signal } from '@core/signal';
import type { CommandRegistry } from './commands';

/**
 * Keybindings.
 *
 * A binding is a normalised chord string like `mod+shift+p` mapped to a
 * command id. `mod` is ⌘ on macOS and Ctrl elsewhere, so one binding table
 * serves every platform.
 *
 * Only *application* keys live here. Editing keys (undo, multi-cursor, comment
 * toggling) belong to CodeMirror's own keymap — binding them twice would mean
 * two sources of truth and a race over `preventDefault`.
 */

export type Chord = string;

export interface Keybinding {
  chord: Chord;
  commandId: string;
  /** Optional argument passed to the command. */
  arg?: unknown;
  /** When false the binding is skipped and the key falls through. */
  when?: () => boolean;
}

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);

/** Normalise names users type in config into our canonical key tokens. */
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  spacebar: 'space',
  ' ': 'space',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  pageup: 'pgup',
  pagedown: 'pgdown',
  cmd: 'meta',
  command: 'meta',
  option: 'alt',
  control: 'ctrl',
};

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;

/** Parse a human-written chord into canonical form: `Cmd+Shift+P` → `meta+shift+p`. */
export function normalizeChord(input: string): Chord {
  const parts = input
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  const modifiers = new Set<string>();
  let key = '';

  for (const raw of parts) {
    const part = KEY_ALIASES[raw] ?? raw;
    if (part === 'mod') {
      modifiers.add(isMac ? 'meta' : 'ctrl');
    } else if (part === 'ctrl' || part === 'alt' || part === 'shift' || part === 'meta') {
      modifiers.add(part);
    } else {
      key = part;
    }
  }

  const ordered = MODIFIER_ORDER.filter((m) => modifiers.has(m));
  return [...ordered, key].filter(Boolean).join('+');
}

/** Canonical chord for a live keyboard event. */
export function chordFromEvent(event: KeyboardEvent): Chord {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey) parts.push('meta');
  parts.push(keyTokenFromEvent(event));
  return parts.join('+');
}

/**
 * The physical key, independent of modifiers and layout where possible.
 * `event.key` is unreliable under Alt on several layouts (⌥3 is `£` on a UK
 * Mac), so letters and digits come from `event.code`.
 */
function keyTokenFromEvent(event: KeyboardEvent): string {
  const code = event.code;
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad') && code.length > 6) return `numpad${code.slice(6).toLowerCase()}`;

  const named: Record<string, string> = {
    Escape: 'escape',
    Enter: 'enter',
    NumpadEnter: 'enter',
    Tab: 'tab',
    Space: 'space',
    Backspace: 'backspace',
    Delete: 'delete',
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Home: 'home',
    End: 'end',
    PageUp: 'pgup',
    PageDown: 'pgdown',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
  };
  if (named[code]) return named[code]!;
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();

  return (event.key || '').toLowerCase();
}

const SYMBOLS: Record<string, string> = {
  meta: '⌘',
  shift: '⇧',
  alt: '⌥',
  ctrl: '⌃',
};

const KEY_LABELS: Record<string, string> = {
  escape: 'Esc',
  enter: '↵',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  space: 'Space',
  backspace: '⌫',
  delete: '⌦',
  tab: '⇥',
  pgup: 'PgUp',
  pgdown: 'PgDn',
};

/** Human display form. `meta+shift+p` → `⇧⌘P` on macOS, `Ctrl+Shift+P` elsewhere. */
export function formatChord(chord: Chord): string {
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  const modifiers = new Set(parts);

  const label = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : titleCase(key));

  if (isMac) {
    // macOS convention orders modifiers ⌃⌥⇧⌘ regardless of how they were written.
    const ordered = (['ctrl', 'alt', 'shift', 'meta'] as const)
      .filter((m) => modifiers.has(m))
      .map((m) => SYMBOLS[m]);
    return `${ordered.join('')}${label}`;
  }

  const ordered = (['ctrl', 'alt', 'shift', 'meta'] as const)
    .filter((m) => modifiers.has(m))
    .map((m) => (m === 'meta' ? 'Win' : titleCase(m)));
  return [...ordered, label].join('+');
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class KeymapService {
  #bindings = new Map<Chord, Keybinding[]>();
  #commandToChord = new Map<string, Chord>();
  #commands: CommandRegistry;
  #detach: (() => void) | null = null;

  readonly version = new Signal(0);

  constructor(commands: CommandRegistry) {
    this.#commands = commands;
  }

  bind(chord: string, commandId: string, options: { arg?: unknown; when?: () => boolean } = {}): void {
    const normalized = normalizeChord(chord);
    const binding: Keybinding = { chord: normalized, commandId, ...options };
    const existing = this.#bindings.get(normalized) ?? [];
    // Later bindings take precedence, so unshift.
    this.#bindings.set(normalized, [binding, ...existing]);
    if (!this.#commandToChord.has(commandId)) this.#commandToChord.set(commandId, normalized);
    this.version.update((n) => n + 1);
  }

  bindAll(table: Record<string, string>): void {
    for (const [chord, commandId] of Object.entries(table)) this.bind(chord, commandId);
  }

  unbind(chord: string): void {
    const normalized = normalizeChord(chord);
    const removed = this.#bindings.get(normalized) ?? [];
    this.#bindings.delete(normalized);
    for (const binding of removed) {
      if (this.#commandToChord.get(binding.commandId) === normalized) {
        this.#commandToChord.delete(binding.commandId);
      }
    }
    this.version.update((n) => n + 1);
  }

  /** Display string for the command's primary binding, for palette + menus. */
  displayFor(commandId: string): string | undefined {
    const chord = this.#commandToChord.get(commandId);
    return chord ? formatChord(chord) : undefined;
  }

  bindings(): Keybinding[] {
    return [...this.#bindings.values()].flat();
  }

  /** Returns the command id that handled the event, or null to let it through. */
  resolve(event: KeyboardEvent): string | null {
    const candidates = this.#bindings.get(chordFromEvent(event));
    if (!candidates) return null;
    for (const binding of candidates) {
      if (binding.when && !binding.when()) continue;
      if (!this.#commands.isEnabled(binding.commandId)) continue;
      return binding.commandId;
    }
    return null;
  }

  /**
   * Listen on the capture phase so bindings win over CodeMirror for the chords
   * we actually claim; everything else falls through untouched.
   */
  attach(target: Window | HTMLElement): () => void {
    const handler = (event: Event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.isComposing || keyEvent.repeat === undefined) return;
      const commandId = this.resolve(keyEvent);
      if (!commandId) return;

      const candidates = this.#bindings.get(chordFromEvent(keyEvent)) ?? [];
      const binding = candidates.find((b) => b.commandId === commandId);

      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      void this.#commands.execute(commandId, binding?.arg);
    };

    target.addEventListener('keydown', handler, true);
    this.#detach = () => target.removeEventListener('keydown', handler, true);
    return this.#detach;
  }

  detach(): void {
    this.#detach?.();
    this.#detach = null;
  }
}

export const platformIsMac = isMac;
