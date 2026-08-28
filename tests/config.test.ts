import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { ConfigService } from '../src/services/config';
import { coerce, coerceAll, defaultSettings, SETTINGS_SCHEMA } from '../src/services/config/schema';

describe('schema coercion', () => {
  it('clamps numbers into range', () => {
    expect(coerce('editor.fontSize', 999)).toBe(SETTINGS_SCHEMA['editor.fontSize'].max);
    expect(coerce('editor.fontSize', 1)).toBe(SETTINGS_SCHEMA['editor.fontSize'].min);
  });

  it('falls back to the default on a type mismatch', () => {
    expect(coerce('editor.fontSize', 'big')).toBe(SETTINGS_SCHEMA['editor.fontSize'].default);
    expect(coerce('editor.wordWrap', 'yes')).toBe(false);
  });

  it('rejects values outside an enum', () => {
    // Moved off `workbench.theme` on 2026-08-28, when themes became user
    // files and that key became a string: an enum is exactly what it can no
    // longer be. `files.autoSave` is a real enum and keeps this covered.
    expect(coerce('files.autoSave', 'sometimes')).toBe('off');
    expect(coerce('files.autoSave', 'onFocusChange')).toBe('onFocusChange');
  });

  /**
   * The other half of that change, and the reason it had to happen. A theme id
   * naming a file Nox has not read yet — or one on a machine where the file is
   * absent — must survive a load. An enum would rewrite it to the default and
   * the user's choice would be gone rather than merely unavailable.
   */
  it('keeps a theme id it does not recognise, because themes are user files', () => {
    expect(coerce('workbench.theme', 'solar')).toBe('solar');
    expect(coerce('workbench.theme', 'umbra')).toBe('umbra');
    expect(coerce('workbench.theme', 42)).toBe('eclipse');
  });

  it('drops unknown keys', () => {
    expect(coerceAll({ 'editor.fontSize': 16, 'not.a.setting': true })).toEqual({
      'editor.fontSize': 16,
    });
  });

  it('tolerates non-objects', () => {
    expect(coerceAll(null)).toEqual({});
    expect(coerceAll('nope')).toEqual({});
  });
});

describe('ConfigService', () => {
  it('starts at the defaults', () => {
    const config = new ConfigService(new MemoryPlatform());
    expect(config.settings.get()).toEqual(defaultSettings());
  });

  it('notifies subscribers with the changed keys', () => {
    const config = new ConfigService(new MemoryPlatform());
    const seen: string[][] = [];
    config.changed.subscribe((keys) => seen.push([...keys]));

    config.set('editor.fontSize', 15);
    expect(seen.at(-1)).toEqual(['editor.fontSize']);
  });

  it('does not notify when the value is unchanged', () => {
    const config = new ConfigService(new MemoryPlatform());
    let notifications = 0;
    config.changed.subscribe(() => notifications++);
    const baseline = notifications;

    config.set('editor.fontSize', config.get('editor.fontSize'));
    expect(notifications).toBe(baseline);
  });

  it('coerces on the way in', () => {
    const config = new ConfigService(new MemoryPlatform());
    config.set('editor.fontSize', 1000);
    expect(config.get('editor.fontSize')).toBe(SETTINGS_SCHEMA['editor.fontSize'].max);
  });

  it('patches several settings as one change', () => {
    const config = new ConfigService(new MemoryPlatform());
    const batches: number[] = [];
    config.changed.subscribe((keys) => batches.push(keys.size));

    config.patch({ 'editor.fontSize': 15, 'editor.wordWrap': true });
    expect(batches.at(-1)).toBe(2);
    expect(config.get('editor.wordWrap')).toBe(true);
  });

  it('serialises only non-default values', () => {
    const config = new ConfigService(new MemoryPlatform());
    expect(JSON.parse(config.serialize())).toEqual({});

    config.set('editor.fontSize', 15);
    expect(JSON.parse(config.serialize())).toEqual({ 'editor.fontSize': 15 });
  });

  it('round-trips through the platform', async () => {
    const platform = new MemoryPlatform();
    const first = new ConfigService(platform);
    first.set('editor.tabSize', 4);
    first.set('workbench.theme', 'umbra');
    await first.flush();

    const second = new ConfigService(platform);
    await second.load();
    expect(second.get('editor.tabSize')).toBe(4);
    expect(second.get('workbench.theme')).toBe('umbra');
  });

  it('survives a corrupt settings file', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('settings.json', '{ not json');

    const config = new ConfigService(platform);
    await config.load();
    expect(config.settings.get()).toEqual(defaultSettings());
  });

  it('picks up new defaults for keys it never stored', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('settings.json', JSON.stringify({ 'editor.tabSize': 4 }));

    const config = new ConfigService(platform);
    await config.load();
    expect(config.get('editor.tabSize')).toBe(4);
    expect(config.get('editor.fontSize')).toBe(SETTINGS_SCHEMA['editor.fontSize'].default);
  });

  it('resets a single key and reports default state', () => {
    const config = new ConfigService(new MemoryPlatform());
    config.set('editor.fontSize', 20);
    expect(config.isDefault('editor.fontSize')).toBe(false);

    config.reset('editor.fontSize');
    expect(config.isDefault('editor.fontSize')).toBe(true);
  });

  it('resets everything', () => {
    const config = new ConfigService(new MemoryPlatform());
    config.patch({ 'editor.fontSize': 20, 'editor.wordWrap': true });
    config.resetAll();
    expect(config.settings.get()).toEqual(defaultSettings());
  });
});
