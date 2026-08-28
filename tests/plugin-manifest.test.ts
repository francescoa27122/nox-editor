import { describe, expect, it } from 'vitest';
import { parseManifest, contributedCommandId } from '../src/core/plugin-manifest';
import { CAPABILITIES } from '../src/services/permissions';

/**
 * `plugin.json`, read.
 *
 * Pure on purpose, and validated harder than any other config Nox reads. The
 * difference is who wrote it: `settings.json` is the user's own mistake to
 * make, and a manifest arrives with **code someone else wrote**. Every field
 * here is a claim by a third party about what it may do, so the rule is
 * stricter than "drop a bad entry" — a manifest that is wrong about its own
 * *capabilities* is refused whole rather than trimmed, because a trimmed
 * capability list is a plugin running with permissions nobody agreed to.
 */

const MINIMAL = { id: 'formatter', label: 'Formatter', worker: 'main.js' };

/**
 * The capability vocabulary, passed in rather than imported.
 *
 * `core/` never imports from `services/`, and the list of capabilities is the
 * permission model's to own — so the parser is told what words exist instead
 * of knowing. `CAPABILITIES` is exhaustiveness-checked against the union it
 * comes from, so the two cannot drift.
 */
const KNOWN = new Set<string>(CAPABILITIES);
const parse = (value: unknown) => parseManifest(value, KNOWN);

describe('the shape of a manifest', () => {
  it('takes the minimum: an id, a label, and something to run', () => {
    const parsed = parse(MINIMAL);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.id).toBe('formatter');
    expect(parsed.manifest.entry).toEqual({ kind: 'worker', file: 'main.js' });
    expect(parsed.manifest.commands).toEqual([]);
    expect(parsed.manifest.capabilities).toEqual([]);
  });

  it('takes a child process instead of a worker', () => {
    const parsed = parse({
      id: 'ruff',
      label: 'Ruff',
      command: 'ruff-nox-plugin',
      args: ['--stdio'],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.entry).toEqual({
      kind: 'process',
      command: 'ruff-nox-plugin',
      args: ['--stdio'],
    });
  });

  it('refuses one that names neither', () => {
    const parsed = parse({ id: 'x', label: 'X' });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('worker');
  });

  it('refuses one that names both, rather than picking for the author', () => {
    // Guessing which they meant is how a plugin ends up running the thing its
    // author was in the middle of replacing.
    const parsed = parse({ ...MINIMAL, command: 'also-this' });

    expect(parsed.ok).toBe(false);
  });
});

describe('activation', () => {
  it('waits for a command by default', () => {
    const parsed = parse(MINIMAL);
    expect(parsed.ok && parsed.manifest.activation).toBe('command');
  });

  it('takes `startup` for a plugin that has to be running to be useful', () => {
    // A status item's content is only known to running code, so a plugin that
    // puts one on the bar cannot be started lazily by one.
    const parsed = parse({ ...MINIMAL, activation: 'startup' });
    expect(parsed.ok && parsed.manifest.activation).toBe('startup');
  });

  it('refuses a word it does not know rather than defaulting quietly', () => {
    // Defaulting would start a plugin lazily that asked to start eagerly, and
    // the symptom would be a status item that never appears.
    expect(parse({ ...MINIMAL, activation: 'eager' }).ok).toBe(false);
  });
});

describe('the id', () => {
  it('refuses anything that is not a plain lowercase name', () => {
    // The id becomes part of a command id and part of a policy key. A dot
    // would split the namespace; a slash or `..` would aim the entry file
    // outside the plugin's own folder.
    for (const id of ['Formatter', 'my.plugin', 'my/plugin', '../evil', 'my plugin', '']) {
      expect(parse({ ...MINIMAL, id }).ok, id).toBe(false);
    }
  });

  it('takes letters, digits and hyphens', () => {
    for (const id of ['ruff', 'ruff-format', 'x2']) {
      expect(parse({ ...MINIMAL, id }).ok, id).toBe(true);
    }
  });
});

describe('the entry file', () => {
  it('refuses one that climbs out of the plugin folder', () => {
    for (const worker of ['../../../etc/passwd', '/abs/main.js', 'a/../../b.js', 'C:\\x.js']) {
      expect(parse({ ...MINIMAL, worker }).ok, worker).toBe(false);
    }
  });

  it('takes a path inside it', () => {
    expect(parse({ ...MINIMAL, worker: 'dist/main.js' }).ok).toBe(true);
  });
});

describe('declared capabilities', () => {
  it('keeps the ones the permission model actually has', () => {
    const parsed = parse({ ...MINIMAL, capabilities: ['fs.read', 'buffer.edit'] });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.capabilities).toEqual(['fs.read', 'buffer.edit']);
  });

  it('refuses the whole manifest for one it does not recognise', () => {
    // Not trimmed. A trimmed list is a plugin whose declaration the user read
    // and whose behaviour does not match it — and the failure mode of
    // guessing wrong here is a permission nobody agreed to.
    const parsed = parse({ ...MINIMAL, capabilities: ['fs.read', 'gpu.mine'] });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('gpu.mine');
  });

  it('refuses a capability list that is not a list of strings', () => {
    expect(parse({ ...MINIMAL, capabilities: 'fs.read' }).ok).toBe(false);
    expect(parse({ ...MINIMAL, capabilities: [1] }).ok).toBe(false);
  });
});

describe('contributed commands', () => {
  it('reads a name and a title', () => {
    const parsed = parse({
      ...MINIMAL,
      commands: [{ name: 'run', title: 'Format Document' }],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.commands).toEqual([{ name: 'run', title: 'Format Document' }]);
  });

  it('drops one that is unusable and names it, rather than failing the plugin', () => {
    // Unlike a capability, a malformed command grants nothing. Losing one
    // command is a smaller harm than refusing a plugin whose other commands
    // are fine, so this side of the manifest is lenient on purpose.
    const parsed = parse({
      ...MINIMAL,
      commands: [{ name: 'ok', title: 'Fine' }, { title: 'No name' }, 'nope'],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.commands).toHaveLength(1);
    expect(parsed.problems).toHaveLength(2);
  });

  it('refuses a command name that would break the namespace', () => {
    const parsed = parse({
      ...MINIMAL,
      commands: [{ name: 'a.b', title: 'Dotted' }],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.commands).toEqual([]);
    expect(parsed.problems[0]).toContain('a.b');
  });
});

describe('contributed panels', () => {
  it('reads a name, a title and an optional icon', () => {
    const parsed = parse({
      ...MINIMAL,
      panels: [{ name: 'issues', title: 'Issues', icon: 'warning' }],
    });

    expect(parsed.ok && parsed.manifest.panels).toEqual([
      { name: 'issues', title: 'Issues', icon: 'warning' },
    ]);
  });

  it('drops one whose name a command already claimed', () => {
    /**
     * The one that would otherwise take the window down.
     *
     * A panel's focus command is registered under the same
     * `plugin.<id>.<name>` id a contributed command gets, and
     * `CommandRegistry.register` throws on a duplicate — so this is not a
     * cosmetic clash, it is a plugin that crashes the app at load.
     */
    const parsed = parse({
      ...MINIMAL,
      commands: [{ name: 'issues', title: 'Run' }],
      panels: [{ name: 'issues', title: 'Issues' }],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.commands).toHaveLength(1);
    expect(parsed.manifest.panels).toEqual([]);
    expect(parsed.problems[0]).toContain('collides');
  });

  it('drops a second panel of the same name too', () => {
    const parsed = parse({
      ...MINIMAL,
      panels: [{ name: 'a', title: 'One' }, { name: 'a', title: 'Two' }],
    });

    expect(parsed.ok && parsed.manifest.panels).toHaveLength(1);
  });

  it('keeps a panel whose icon is unknown, because an icon is decoration', () => {
    const parsed = parse({ ...MINIMAL, panels: [{ name: 'a', title: 'A', icon: 'nonsense' }] });

    expect(parsed.ok && parsed.manifest.panels).toHaveLength(1);
  });

  it('has none by default', () => {
    const parsed = parse(MINIMAL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.panels).toEqual([]);
  });
});

describe('the command id a contribution becomes', () => {
  it('is namespaced under the plugin, so core ids cannot be shadowed', () => {
    expect(contributedCommandId('ruff', 'run')).toBe('plugin.ruff.run');
  });

  it('cannot collide between two plugins', () => {
    expect(contributedCommandId('a', 'run')).not.toBe(contributedCommandId('b', 'run'));
  });

  it('cannot be made to equal a core command id', () => {
    // `file.save` has one dot; every contributed id has at least two and a
    // fixed first segment, and `parseManifest` refuses a dot in either half.
    expect(contributedCommandId('file', 'save')).toBe('plugin.file.save');
  });
});

/**
 * Settings a plugin declares.
 *
 * Lenient, like commands and panels and unlike capabilities: the worst a
 * malformed setting does is fail to appear, so losing one beats refusing a
 * plugin whose others are fine. See
 * `docs/superpowers/specs/2026-08-28-plugin-settings-design.md` §1.
 */
describe('declared settings', () => {
  it('takes the four kinds the settings panel can draw', () => {
    const parsed = parse({
      ...MINIMAL,
      settings: [
        { key: 'enabled', kind: 'boolean', default: true, label: 'Enabled' },
        { key: 'limit', kind: 'number', default: 10, min: 1, max: 99, label: 'Limit' },
        { key: 'markers', kind: 'string', default: 'TODO', label: 'Markers' },
        {
          key: 'level',
          kind: 'enum',
          default: 'warn',
          options: ['off', 'warn', 'error'],
          label: 'Level',
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.settings.map((setting) => setting.kind)).toEqual([
      'boolean',
      'number',
      'string',
      'enum',
    ]);
  });

  it('has none by default', () => {
    const parsed = parse(MINIMAL);
    expect(parsed.ok && parsed.manifest.settings).toEqual([]);
  });

  it('falls back to the key when no label is given', () => {
    const parsed = parse({
      ...MINIMAL,
      settings: [{ key: 'lineLength', kind: 'number', default: 88, min: 1, max: 200 }],
    });

    expect(parsed.ok && parsed.manifest.settings[0]?.label).toBe('lineLength');
  });

  it('drops one whose default does not match its own kind', () => {
    // The default is what a user who never touches the row gets, so a
    // mistyped one is a setting that is wrong for everybody.
    const parsed = parse({
      ...MINIMAL,
      settings: [{ key: 'limit', kind: 'number', default: 'ten', min: 1, max: 99 }],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.settings).toEqual([]);
    expect(parsed.problems.join(' ')).toMatch(/limit/);
  });

  it('drops an enum whose default is not one of its options', () => {
    const parsed = parse({
      ...MINIMAL,
      settings: [{ key: 'level', kind: 'enum', default: 'loud', options: ['off', 'warn'] }],
    });

    expect(parsed.ok && parsed.manifest.settings).toEqual([]);
  });

  it('drops an enum with no options, which could draw nothing', () => {
    const parsed = parse({ ...MINIMAL, settings: [{ key: 'level', kind: 'enum', default: 'a', options: [] }] });

    expect(parsed.ok && parsed.manifest.settings).toEqual([]);
  });

  it('drops a number whose bounds exclude its own default', () => {
    const parsed = parse({
      ...MINIMAL,
      settings: [{ key: 'limit', kind: 'number', default: 500, min: 1, max: 99 }],
    });

    expect(parsed.ok && parsed.manifest.settings).toEqual([]);
  });

  it('drops a kind the panel has no control for', () => {
    const parsed = parse({
      ...MINIMAL,
      settings: [{ key: 'colour', kind: 'color', default: '#fff' }],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.settings).toEqual([]);
    expect(parsed.problems.join(' ')).toMatch(/colour/);
  });

  it('drops a duplicate key rather than letting the second shadow the first', () => {
    const parsed = parse({
      ...MINIMAL,
      settings: [
        { key: 'limit', kind: 'number', default: 10, min: 1, max: 99 },
        { key: 'limit', kind: 'string', default: 'x' },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.settings).toHaveLength(1);
    expect(parsed.manifest.settings[0]?.kind).toBe('number');
  });

  it('refuses nothing: a settings list that is not a list costs the list, not the plugin', () => {
    const parsed = parse({ ...MINIMAL, settings: 'lots' });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.settings).toEqual([]);
    expect(parsed.problems.join(' ')).toMatch(/settings/);
  });

  it('allows a key a command already uses, because the namespaces are separate', () => {
    // A command becomes `plugin.<id>.<name>`; a setting is a key inside the
    // plugin's own object in `plugin-settings.json`. Nothing collides.
    const parsed = parse({
      ...MINIMAL,
      commands: [{ name: 'run', title: 'Run' }],
      settings: [{ key: 'run', kind: 'boolean', default: false }],
    });

    expect(parsed.ok && parsed.manifest.settings).toHaveLength(1);
    expect(parsed.ok && parsed.manifest.commands).toHaveLength(1);
  });
});
