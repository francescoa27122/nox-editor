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
