import { Signal } from '@core/signal';
import type { Platform } from '@platform/types';
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
 *
 * There are two layers. `bind()` builds the **defaults** — `app.ts`'s
 * `#registerKeybindings` is the whole of them — and a `KeybindingRule` read
 * from `keybindings.json` is a **user rule applied over** that table, never a
 * mutation of it. That is what makes "reset" a deletion rather than a
 * remembered original. See
 * `docs/superpowers/specs/2026-08-20-keybinding-editor-design.md`.
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

/**
 * One line of `keybindings.json`.
 *
 * A binding's identity is its `(chord, command)` pair — unique across the
 * default table, where two chords may share a command and nine bindings share
 * `nav.goToTab` with different `arg`s. `remove: true` deletes the default with
 * that identity; anything else adds a binding.
 */
export interface KeybindingRule {
  chord: string;
  command: string;
  arg?: unknown;
  remove?: boolean;
}

/** Where the user layer lives, beside `settings.json`. */
const USER_BINDINGS_FILE = 'keybindings.json';

/**
 * Key tokens that are only ever a modifier being held. Recording ignores
 * them, so reaching for ⇧ before the real key does not record `⇧` alone.
 */
const MODIFIER_KEYS = new Set([
  'shift',
  'control',
  'ctrl',
  'alt',
  'altgraph',
  'meta',
  'os',
  'capslock',
]);

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

/** Shape check for one entry of a hand-editable `keybindings.json`. */
function isRule(value: unknown): value is KeybindingRule {
  if (typeof value !== 'object' || value === null) return false;
  const rule = value as Record<string, unknown>;
  return typeof rule.chord === 'string' && typeof rule.command === 'string';
}

/**
 * Canonical form of one rule.
 *
 * Optional keys are omitted rather than set to `undefined`, so a rule read
 * back off disk is `toEqual` the rule that was written.
 */
function normalizeRule(rule: KeybindingRule): KeybindingRule {
  const out: KeybindingRule = { chord: normalizeChord(rule.chord), command: rule.command };
  if ('arg' in rule && rule.arg !== undefined) out.arg = rule.arg;
  if (rule.remove) out.remove = true;
  return out;
}

export class KeymapService {
  #bindings = new Map<Chord, Keybinding[]>();
  #commandToChord = new Map<string, Chord>();
  #commands: CommandRegistry;
  #platform: Platform | null;
  #detach: (() => void) | null = null;

  /** The table `bind()` builds. Never edited by a user rule — only shadowed. */
  #defaults: Keybinding[] = [];
  #userRules: KeybindingRule[] = [];
  #capture: ((chord: Chord) => void) | null = null;
  #saving: Promise<void> = Promise.resolve();

  readonly version = new Signal(0);

  constructor(commands: CommandRegistry, platform?: Platform) {
    this.#commands = commands;
    this.#platform = platform ?? null;
  }

  bind(chord: string, commandId: string, options: { arg?: unknown; when?: () => boolean } = {}): void {
    this.#defaults.push({ chord: normalizeChord(chord), commandId, ...options });
    // Rebuild rather than push onto the live map: a `remove` rule already
    // loaded has to apply to a default registered after it, or a late
    // `bind()` would quietly resurrect a key the user unassigned.
    this.#rebuild();
  }

  bindAll(table: Record<string, string>): void {
    for (const [chord, commandId] of Object.entries(table)) this.bind(chord, commandId);
  }

  /** Drop every default on this chord. Not a user rule — this edits the table. */
  unbind(chord: string): void {
    const normalized = normalizeChord(chord);
    this.#defaults = this.#defaults.filter((b) => b.chord !== normalized);
    this.#rebuild();
  }

  // --- The user layer ------------------------------------------------------

  /** The rules as they would be written to disk. */
  userRules(): readonly KeybindingRule[] {
    return this.#userRules;
  }

  /** Replace the rules, rebuild the map, and persist. One version bump. */
  setUserRules(rules: readonly KeybindingRule[]): void {
    this.#userRules = rules.map(normalizeRule);
    this.#rebuild();
    this.#save();
  }

  /** True when any rule names this command — what the reset affordance reads. */
  isCustomized(commandId: string): boolean {
    return this.#userRules.some((rule) => rule.command === commandId);
  }

  /** Any rule at all: what "Reset all" reads. */
  get customizedCount(): number {
    return new Set(this.#userRules.map((rule) => rule.command)).size;
  }

  /**
   * Give `commandId` the chord `chord`.
   *
   * `from` names the binding being replaced — omit it and this adds a second
   * chord rather than moving the first. `arg` is inherited from the default
   * being replaced (or the command's first default) unless one is passed.
   */
  assign(commandId: string, chord: string, options: { from?: string; arg?: unknown } = {}): void {
    const target = normalizeChord(chord);
    const from = options.from === undefined ? null : normalizeChord(options.from);

    let rules = this.#userRules.filter(
      (rule) =>
        rule.remove ||
        rule.command !== commandId ||
        (rule.chord !== target && rule.chord !== from),
    );

    if (from !== null && from !== target && this.#isDefaultBinding(from, commandId)) {
      rules = [...rules, { chord: from, command: commandId, remove: true }];
    }
    // Re-taking a chord this command used to own: its removal rule is stale.
    rules = rules.filter(
      (rule) => !(rule.remove && rule.chord === target && rule.command === commandId),
    );

    const arg = options.arg !== undefined ? options.arg : this.#defaultArgFor(commandId, from);
    const rule: KeybindingRule = { chord: target, command: commandId };
    if (arg !== undefined) rule.arg = arg;

    this.setUserRules([...rules, rule]);
  }

  /** Take a chord away from a command, leaving its other bindings alone. */
  unassign(commandId: string, chord: string): void {
    const target = normalizeChord(chord);
    let rules = this.#userRules.filter(
      (rule) => rule.remove || rule.command !== commandId || rule.chord !== target,
    );
    if (
      this.#isDefaultBinding(target, commandId) &&
      !rules.some((rule) => rule.remove && rule.chord === target && rule.command === commandId)
    ) {
      rules = [...rules, { chord: target, command: commandId, remove: true }];
    }
    this.setUserRules(rules);
  }

  /** Forget every customisation of one command. */
  resetCommand(commandId: string): void {
    this.setUserRules(this.#userRules.filter((rule) => rule.command !== commandId));
  }

  resetAll(): void {
    this.setUserRules([]);
  }

  /** The bindings this chord would displace — the same command is not one. */
  conflictsFor(chord: string, commandId: string): Keybinding[] {
    return this.lookup(chord).filter((binding) => binding.commandId !== commandId);
  }

  /** Everything bound to one chord, most-recently-bound first. */
  lookup(chord: string): Keybinding[] {
    return [...(this.#bindings.get(normalizeChord(chord)) ?? [])];
  }

  /** The default table, for "is this row still what shipped?". */
  defaults(): readonly Keybinding[] {
    return this.#defaults;
  }

  serializeUserRules(): string {
    return `${JSON.stringify(this.#userRules, null, 2)}\n`;
  }

  /** Read the rules. A missing, unreadable or corrupt file leaves defaults. */
  async loadUserRules(): Promise<void> {
    if (!this.#platform) return;
    let raw: string | null = null;
    try {
      raw = await this.#platform.readConfigFile(USER_BINDINGS_FILE);
    } catch {
      return;
    }
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // Corrupt: the defaults stand. Losing rebinds beats not booting.
    }
    if (!Array.isArray(parsed)) return;

    this.#userRules = parsed.filter(isRule).map(normalizeRule);
    this.#rebuild();
  }

  /** Await the write in flight. Writes are fire-and-forget otherwise. */
  async flush(): Promise<void> {
    await this.#saving;
  }

  #save(): void {
    const platform = this.#platform;
    if (!platform) return;
    // Empty rules write an empty file rather than `[]`: `Platform` has no
    // delete, and an empty file reads back as "no customisations" already.
    const contents = this.#userRules.length === 0 ? '' : this.serializeUserRules();
    this.#saving = this.#saving
      .then(() => platform.writeConfigFile(USER_BINDINGS_FILE, contents))
      .catch(() => {
        /* Keybindings that cannot be written must not break the session. */
      });
  }

  #isDefaultBinding(chord: Chord, commandId: string): boolean {
    return this.#defaults.some((b) => b.chord === chord && b.commandId === commandId);
  }

  /** `arg` for a new binding: the default it replaces, else the command's first. */
  #defaultArgFor(commandId: string, from: Chord | null): unknown {
    const exact =
      from === null
        ? undefined
        : this.#defaults.find((b) => b.chord === from && b.commandId === commandId);
    const inherited = exact ?? this.#defaults.find((b) => b.commandId === commandId);
    return inherited?.arg;
  }

  /**
   * The live map, from the defaults plus the rules. One version bump.
   *
   * Additions are applied *after* the defaults because `#add` unshifts — so a
   * user binding beats a default on the same chord without any precedence
   * machinery beyond the order of these two loops.
   */
  #rebuild(): void {
    this.#bindings.clear();
    this.#commandToChord.clear();

    // NUL joins the pair: neither a chord token nor a command id can contain
    // one, so the composite key cannot collide.
    const removed = new Set(
      this.#userRules
        .filter((rule) => rule.remove)
        .map((rule) => `${rule.chord}\u0000${rule.command}`),
    );

    for (const binding of this.#defaults) {
      if (removed.has(`${binding.chord}\u0000${binding.commandId}`)) continue;
      this.#add(binding);
    }

    for (const rule of this.#userRules) {
      if (rule.remove) continue;
      // `when` is a predicate and cannot be serialised, so it is inherited
      // from the command's own default — rebinding Escape keeps its guard.
      const inherited = this.#defaults.find((b) => b.commandId === rule.command);
      this.#add({
        chord: rule.chord,
        commandId: rule.command,
        arg: 'arg' in rule ? rule.arg : inherited?.arg,
        when: inherited?.when,
      });
    }

    this.version.update((n) => n + 1);
  }

  #add(binding: Keybinding): void {
    const existing = this.#bindings.get(binding.chord) ?? [];
    // Later bindings take precedence, so unshift.
    this.#bindings.set(binding.chord, [binding, ...existing]);
    if (!this.#commandToChord.has(binding.commandId)) {
      this.#commandToChord.set(binding.commandId, binding.chord);
    }
  }

  // --- Recording -----------------------------------------------------------

  /**
   * Route every key to `handler` instead of running commands.
   *
   * A recording input cannot listen for itself: `attach` is on the capture
   * phase at the window, so a claimed chord is already `preventDefault`ed and
   * executed before any descendant sees it. Recording is therefore a mode of
   * the service, not a listener beside it.
   */
  beginCapture(handler: (chord: Chord) => void): void {
    this.#capture = handler;
  }

  endCapture(): void {
    this.#capture = null;
  }

  get capturing(): boolean {
    return this.#capture !== null;
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
   * One keydown. Returns true when the key was claimed.
   *
   * Split out of `attach` so a test can drive it without a window, and so
   * capture mode has exactly one place to intercept.
   */
  handleKey(event: KeyboardEvent): boolean {
    if (event.isComposing || event.repeat === undefined) return false;

    if (this.#capture) {
      // Everything is swallowed while recording, including keys nothing is
      // bound to — otherwise the key under the cursor would type itself into
      // whatever has focus behind the panel.
      event.preventDefault();
      event.stopPropagation();
      if (MODIFIER_KEYS.has(keyTokenFromEvent(event))) return true;
      this.#capture(chordFromEvent(event));
      return true;
    }

    const commandId = this.resolve(event);
    if (!commandId) return false;

    const candidates = this.#bindings.get(chordFromEvent(event)) ?? [];
    const binding = candidates.find((b) => b.commandId === commandId);

    event.preventDefault();
    event.stopPropagation();
    void this.#commands.execute(commandId, binding?.arg);
    return true;
  }

  /**
   * Listen on the capture phase so bindings win over CodeMirror for the chords
   * we actually claim; everything else falls through untouched.
   */
  attach(target: Window | HTMLElement): () => void {
    const handler = (event: Event) => {
      this.handleKey(event as KeyboardEvent);
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
