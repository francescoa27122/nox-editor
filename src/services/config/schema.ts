/**
 * The settings schema.
 *
 * This object is the single definition of every user-facing preference: its
 * type, default, bounds, label and category. The Settings UI is *generated*
 * from it, the persisted JSON is validated against it, and the `Settings` type
 * is derived from it — so adding a preference is a one-line change here and
 * nowhere else. No component may hardcode a default.
 */

export type SettingCategory = 'Editor' | 'Text' | 'Files' | 'Workbench' | 'Terminal';

interface Common {
  label: string;
  description: string;
  category: SettingCategory;
  /** Hide from the settings UI (still settable via the config file). */
  advanced?: boolean;
}

export interface BooleanSetting extends Common {
  kind: 'boolean';
  default: boolean;
}
export interface NumberSetting extends Common {
  kind: 'number';
  default: number;
  min: number;
  max: number;
  step?: number;
}
export interface StringSetting extends Common {
  kind: 'string';
  default: string;
  placeholder?: string;
}
export interface EnumSetting<T extends string = string> extends Common {
  kind: 'enum';
  default: T;
  options: readonly T[];
  optionLabels?: Readonly<Record<string, string>>;
}

export type SettingDescriptor =
  | BooleanSetting
  | NumberSetting
  | StringSetting
  | EnumSetting<string>;

const bool = (def: boolean, meta: Common): BooleanSetting => ({ kind: 'boolean', default: def, ...meta });
const num = (
  def: number,
  bounds: { min: number; max: number; step?: number },
  meta: Common,
): NumberSetting => ({ kind: 'number', default: def, ...bounds, ...meta });
const str = (def: string, meta: Common & { placeholder?: string }): StringSetting => ({
  kind: 'string',
  default: def,
  ...meta,
});
const pick = <const T extends readonly string[]>(
  options: T,
  def: T[number],
  meta: Common & { optionLabels?: Readonly<Record<string, string>> },
): EnumSetting<T[number]> => ({ kind: 'enum', default: def, options, ...meta });

export const SETTINGS_SCHEMA = {
  // --- Workbench ---------------------------------------------------------
  'workbench.theme': pick(['eclipse', 'umbra'], 'eclipse', {
    label: 'Theme',
    description: 'Eclipse is the default blue-black night. Umbra is a deeper OLED variant.',
    category: 'Workbench',
    optionLabels: { eclipse: 'Eclipse', umbra: 'Umbra (OLED)' },
  }),
  'workbench.showExplorer': bool(true, {
    label: 'Show Explorer',
    description: 'Display the file explorer sidebar.',
    category: 'Workbench',
  }),
  'workbench.explorerWidth': num(248, { min: 150, max: 520 }, {
    label: 'Explorer Width',
    description: 'Width of the sidebar in pixels.',
    category: 'Workbench',
    advanced: true,
  }),
  'workbench.splitOrientation': pick(['vertical', 'horizontal'], 'vertical', {
    label: 'Split Direction',
    description: 'Whether split editor panes sit side by side or stacked.',
    category: 'Workbench',
    optionLabels: { vertical: 'Side by side', horizontal: 'Stacked' },
  }),
  'workbench.showStatusBar': bool(true, {
    label: 'Show Status Bar',
    description: 'Display the status bar along the bottom edge.',
    category: 'Workbench',
  }),
  'workbench.showChangeMarks': bool(true, {
    label: 'Show Change Marks',
    description: 'Mark lines changed by a replace, an agent or a plugin.',
    category: 'Workbench',
  }),
  'workbench.restoreSession': bool(true, {
    label: 'Restore Session',
    description: 'Reopen the last workspace and tabs on launch.',
    category: 'Workbench',
  }),

  // --- Terminal ----------------------------------------------------------
  'terminal.shell': str('', {
    label: 'Shell',
    description: 'Program to run. Empty uses your login shell.',
    category: 'Terminal',
    placeholder: '/bin/zsh',
  }),
  'terminal.fontSize': num(12, { min: 8, max: 32 }, {
    label: 'Terminal Font Size',
    description: 'Size of terminal text in pixels.',
    category: 'Terminal',
  }),
  'terminal.scrollback': num(1000, { min: 100, max: 100000 }, {
    label: 'Scrollback',
    description: 'Lines of output kept above the top of the terminal.',
    category: 'Terminal',
    advanced: true,
  }),
  'terminal.height': num(260, { min: 80, max: 900 }, {
    label: 'Terminal Height',
    description: 'Height of the terminal panel in pixels.',
    category: 'Terminal',
    advanced: true,
  }),

  // --- Editor appearance -------------------------------------------------
  'editor.fontFamily': str(
    "'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
    {
      label: 'Font Family',
      description: 'Monospace font stack used in the editor.',
      category: 'Editor',
      placeholder: 'JetBrains Mono, monospace',
    },
  ),
  'editor.fontSize': num(13, { min: 8, max: 32 }, {
    label: 'Font Size',
    description: 'Editor font size in pixels.',
    category: 'Editor',
  }),
  'editor.lineHeight': num(1.6, { min: 1, max: 2.6, step: 0.05 }, {
    label: 'Line Height',
    description: 'Line height as a multiple of the font size.',
    category: 'Editor',
  }),
  'editor.lineNumbers': bool(true, {
    label: 'Line Numbers',
    description: 'Show the line number gutter.',
    category: 'Editor',
  }),
  'editor.relativeLineNumbers': bool(false, {
    label: 'Relative Line Numbers',
    description: 'Number lines relative to the cursor, Vim style.',
    category: 'Editor',
  }),
  'editor.highlightActiveLine': bool(true, {
    label: 'Highlight Active Line',
    description: 'Tint the line containing the primary cursor.',
    category: 'Editor',
  }),
  'editor.cursorStyle': pick(['line', 'block', 'underline'], 'line', {
    label: 'Cursor Style',
    description: 'Shape of the text cursor.',
    category: 'Editor',
    optionLabels: { line: 'Line', block: 'Block', underline: 'Underline' },
  }),
  'editor.cursorBlink': bool(true, {
    label: 'Cursor Blink',
    description: 'Blink the cursor when the editor is focused.',
    category: 'Editor',
  }),
  'editor.renderWhitespace': pick(['none', 'trailing', 'all'], 'trailing', {
    label: 'Render Whitespace',
    description: 'Show markers for spaces and tabs.',
    category: 'Editor',
    optionLabels: { none: 'Never', trailing: 'Trailing only', all: 'Always' },
  }),
  'editor.scrollBeyondLastLine': bool(true, {
    label: 'Scroll Beyond Last Line',
    description: 'Allow scrolling past the end of the file.',
    category: 'Editor',
  }),

  // --- Text behaviour ----------------------------------------------------
  'editor.tabSize': num(2, { min: 1, max: 8 }, {
    label: 'Tab Size',
    description: 'Number of columns a tab occupies.',
    category: 'Text',
  }),
  'editor.insertSpaces': bool(true, {
    label: 'Insert Spaces',
    description: 'Indent with spaces instead of tab characters.',
    category: 'Text',
  }),
  'editor.wordWrap': bool(false, {
    label: 'Word Wrap',
    description: 'Wrap long lines at the viewport edge.',
    category: 'Text',
  }),
  'editor.autoIndent': bool(true, {
    label: 'Auto Indent',
    description: 'Keep indentation and add a level after an opening bracket.',
    category: 'Text',
  }),
  'editor.codeFolding': bool(true, {
    label: 'Code Folding',
    description: 'Show fold arrows in the gutter. Needs a grammar for the language.',
    category: 'Text',
  }),
  'editor.stickyScroll': bool(true, {
    label: 'Sticky Scroll',
    description: 'Keep the enclosing function or class pinned above the editor.',
    category: 'Editor',
  }),
  'editor.bracketMatching': bool(true, {
    label: 'Bracket Matching',
    description: 'Highlight the bracket matching the one at the cursor.',
    category: 'Text',
  }),
  'editor.autoCloseBrackets': bool(true, {
    label: 'Auto Close Brackets',
    description: 'Insert the closing bracket or quote automatically.',
    category: 'Text',
  }),

  // --- Files -------------------------------------------------------------
  'files.autoSave': pick(['off', 'afterDelay', 'onFocusChange'], 'off', {
    label: 'Auto Save',
    description: 'When to write modified buffers back to disk.',
    category: 'Files',
    optionLabels: { off: 'Off', afterDelay: 'After delay', onFocusChange: 'On focus change' },
  }),
  'files.autoSaveDelay': num(1000, { min: 200, max: 30000, step: 100 }, {
    label: 'Auto Save Delay',
    description: 'Idle milliseconds before an automatic save.',
    category: 'Files',
  }),
  'files.trimTrailingWhitespace': bool(false, {
    label: 'Trim Trailing Whitespace',
    description: 'Strip trailing spaces from every line on save.',
    category: 'Files',
  }),
  'files.insertFinalNewline': bool(true, {
    label: 'Insert Final Newline',
    description: 'Ensure the file ends with exactly one newline on save.',
    category: 'Files',
  }),
  'files.excludeFromExplorer': str('.git, node_modules, target, dist, .DS_Store', {
    label: 'Hide In Explorer',
    description: 'Comma-separated names the explorer will not show.',
    category: 'Files',
  }),
} as const satisfies Record<string, SettingDescriptor>;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;

type DefaultOf<D> = D extends { default: infer V } ? V : never;

/** The fully-typed settings object. Derived — never written by hand. */
export type Settings = {
  [K in SettingKey]: DefaultOf<(typeof SETTINGS_SCHEMA)[K]>;
};

export const SETTING_KEYS = Object.keys(SETTINGS_SCHEMA) as SettingKey[];

export function defaultSettings(): Settings {
  const out = {} as Record<string, unknown>;
  for (const key of SETTING_KEYS) out[key] = SETTINGS_SCHEMA[key].default;
  return out as Settings;
}

/**
 * Coerce one persisted value into a valid setting. Returns the default when
 * the stored value is the wrong type or out of range — a corrupt settings
 * file must never prevent the editor from starting.
 */
export function coerce(key: SettingKey, value: unknown): Settings[SettingKey] {
  const descriptor: SettingDescriptor = SETTINGS_SCHEMA[key];
  switch (descriptor.kind) {
    case 'boolean':
      return (typeof value === 'boolean' ? value : descriptor.default) as Settings[SettingKey];
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return descriptor.default as Settings[SettingKey];
      }
      const clamped = Math.min(descriptor.max, Math.max(descriptor.min, value));
      return clamped as Settings[SettingKey];
    }
    case 'string':
      return (typeof value === 'string' ? value : descriptor.default) as Settings[SettingKey];
    case 'enum':
      return (
        typeof value === 'string' && descriptor.options.includes(value)
          ? value
          : descriptor.default
      ) as Settings[SettingKey];
  }
}

/** Validate a whole persisted object, dropping unknown and invalid keys. */
export function coerceAll(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (!(key in source)) continue;
    out[key] = coerce(key, source[key]);
  }
  return out as Partial<Settings>;
}
