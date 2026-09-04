import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LANGUAGES } from '../src/core/languages';

/**
 * What this guards.
 *
 * The things a stranger meets before they meet the editor: where to report a
 * hole, what a bug report should carry, whose code is in the bundle. None of
 * it is behaviour, so none of it had a test, and the ship-readiness audit
 * (AUDIT/A8-ship-readiness.md) found each of them missing or stale. A file
 * that exists today can be deleted in a tidy-up tomorrow; these hold the
 * ones that must not be.
 *
 * What this does not catch: prose going stale inside a file that still
 * exists. It checks the load-bearing string in each, not the paragraph
 * around it.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

/** Normalised to LF: a Windows checkout with autocrlf on hands back CRLF. */
function read(...parts: string[]): string {
  return readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

describe('A8-004: a disclosure route and issue templates', () => {
  it('SECURITY.md points at private vulnerability reporting, not an inbox', () => {
    const security = read('SECURITY.md');
    expect(security).toContain(
      'https://github.com/francescoa27122/nox-editor/security/advisories/new',
    );
    // No personal address: the route is the repository's, so it survives a
    // change of maintainer and cannot be scraped off the tree.
    expect(security).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(security).toMatch(/latest release/i);
  });

  it('both issue templates exist and the bug report asks for Copy Diagnostics first', () => {
    const templates = join(root, '.github', 'ISSUE_TEMPLATE');
    expect(existsSync(join(templates, 'bug_report.md'))).toBe(true);
    expect(existsSync(join(templates, 'feature_request.md'))).toBe(true);

    const bug = read('.github', 'ISSUE_TEMPLATE', 'bug_report.md');
    // The first section, because the README already asks for it and reports
    // arrived without it: a field nobody sees until after the prose is one
    // nobody fills.
    const firstHeading = bug.split('\n').find((line) => line.startsWith('## '));
    expect(firstHeading).toBe('## Copy Diagnostics');
    expect(bug).toMatch(/^name: /m);
    expect(read('.github', 'ISSUE_TEMPLATE', 'feature_request.md')).toMatch(/^name: /m);
  });
});

describe('A8-005: third-party notices', () => {
  const notices = read('THIRD-PARTY-NOTICES.md');
  const listed = (name: string) => notices.includes(`| ${name} |`);

  it('lists every production npm dependency', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    const missing = Object.keys(pkg.dependencies).filter((name) => !listed(name));
    expect(missing).toEqual([]);
  });

  /**
   * A section-aware scan rather than a TOML parser: the manifest keeps one
   * dependency per line, and the only shape that matters here is the key
   * before `=`. An optional dependency is skipped because it is never in a
   * release (the `wdio` feature says why).
   */
  it('lists every direct crate in Cargo.toml', () => {
    const manifest = read('src-tauri', 'Cargo.toml');
    let section = '';
    const direct: string[] = [];
    for (const line of manifest.split('\n')) {
      const header = /^\[(.+)\]$/.exec(line.trim());
      if (header) {
        section = header[1] ?? '';
        continue;
      }
      if (section !== 'dependencies' && section !== 'build-dependencies') continue;
      const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (key?.[1] && !line.includes('optional = true')) direct.push(key[1]);
    }
    expect(direct.length).toBeGreaterThan(10);
    expect(direct.filter((name) => !listed(name))).toEqual([]);
  });

  it('the bundle carries the licence file and the README points at the notices', () => {
    const config = JSON.parse(read('src-tauri', 'tauri.conf.json')) as {
      bundle: { licenseFile?: string };
    };
    expect(config.bundle.licenseFile).toBeDefined();
    // Relative to tauri.conf.json, which is how the bundler resolves it.
    const licence = join(dirname(join(root, 'src-tauri', 'tauri.conf.json')), config.bundle.licenseFile ?? '');
    expect(existsSync(licence)).toBe(true);
    expect(read('README.md')).toContain('](THIRD-PARTY-NOTICES.md)');
  });
});

describe('A8-006: the macOS floor matches the CSS the app is drawn with', () => {
  /** Every file under `src/`, because a stylesheet can live in a component. */
  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) yield* walk(path);
      else yield path;
    }
  }

  /**
   * `color-mix()` is the whole value of twenty background, border and
   * text-decoration declarations, and an engine that cannot parse it drops
   * each one: the diff view loses its add and remove tints, the review panel
   * its hunk colouring. WebKit gained it in Safari 16.2, which ships with
   * macOS 13. A floor below that is a packaging claim the CSS cannot keep.
   *
   * What this does not catch: a newer CSS feature with a higher floor. It
   * holds the one the audit found; add the next one here when it arrives.
   */
  it('declares at least macOS 13 while any stylesheet uses color-mix()', () => {
    let usesColorMix = false;
    for (const file of walk(join(root, 'src'))) {
      if (!/\.(css|svelte)$/.test(file)) continue;
      if (readFileSync(file, 'utf8').includes('color-mix(')) {
        usesColorMix = true;
        break;
      }
    }
    expect(usesColorMix).toBe(true);

    const config = JSON.parse(read('src-tauri', 'tauri.conf.json')) as {
      bundle: { macOS: { minimumSystemVersion: string } };
    };
    const major = Number(config.bundle.macOS.minimumSystemVersion.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(13);
    // And the README says so, in the section a downloader reads.
    expect(read('README.md')).toMatch(/macOS 13 or newer/);
  });
});

describe('A8-007: the README names the one outbound call and the setting that stops it', () => {
  /**
   * The README used to say Nox "will only talk to your own machine" while
   * the updater fetched GitHub's release feed ten seconds after launch. The
   * sentence that replaced it names the setting by its label, so this reads
   * the label out of the schema rather than repeating it: rename the
   * setting and the README goes stale here rather than in a bug report.
   */
  it('quotes the current label of workbench.checkForUpdates', () => {
    const schema = read('src', 'services', 'config', 'schema.ts');
    const block = /'workbench\.checkForUpdates': bool\(true, \{\s*label: '([^']+)'/.exec(schema);
    expect(block?.[1]).toBeDefined();
    const readme = read('README.md');
    expect(readme).toContain(`**${block?.[1]}**`);
    expect(readme).not.toContain('Nox will only talk to your own machine');
  });
});

describe('A8-010: e2e/README.md counts what e2e/specs/ holds', () => {
  /**
   * The README said "four specs" for weeks after there were eight. The
   * count is read from the spec files, so the sentence and the suite cannot
   * drift apart again without this going red. The download size in the
   * root README is not held here: it is a property of a release artifact,
   * and CONTRIBUTING's Cutting a release checklist is where it is re-read.
   */
  it('gives every spec file a row in its table', () => {
    const specs = join(root, 'e2e', 'specs');
    const files = readdirSync(specs)
      .filter((name) => name.endsWith('.e2e.js'))
      .sort();
    const readme = read('e2e', 'README.md');

    // The table is the part that rots: a spec added without a row is a spec
    // nobody reading this file knows exists. Checking the rows rather than a
    // written-out count also survives the count changing, which a sentence
    // saying "four specs" did not: it was wrong by one when this was written.
    const missing = files.filter((name) => !readme.includes(`\`${name}\` |`));
    expect(missing).toEqual([]);
  });
});

describe('A8-006: nothing in the stylesheets needs a floor above the one we set', () => {
  /**
   * Raising `minimumSystemVersion` to 13.0 was argued from `color-mix()`,
   * which Safari shipped in 16.2. That argument is only worth anything if
   * nothing else in the stylesheets needs a *higher* floor, and one thing did:
   * Safari shipped unprefixed `backdrop-filter` in 18, so every macOS between
   * the new floor and 18 lost the scrim's blur with no error and no fallback.
   *
   * Held as a rule rather than a count, because the next unprefixed use will
   * be written by someone who never read this comment.
   */
  it('pairs every backdrop-filter with its -webkit- spelling', () => {
    const offenders: string[] = [];

    for (const name of readdirSync(join(root, 'src', 'ui')).filter((n) => n.endsWith('.svelte'))) {
      const source = readFileSync(join(root, 'src', 'ui', name), 'utf8');
      const plain = (source.match(/^\s*backdrop-filter:/gm) ?? []).length;
      const prefixed = (source.match(/^\s*-webkit-backdrop-filter:/gm) ?? []).length;
      if (plain !== prefixed) offenders.push(`${name}: ${plain} plain, ${prefixed} prefixed`);
    }

    expect(offenders).toEqual([]);
  });
});

describe('A8-012: the bundle copyright is the LICENSE line', () => {
  /**
   * bundle.copyright was an empty string, so Get Info on the .app and
   * Properties on nox.exe showed nothing where a user looks when an
   * unsigned binary asks to be trusted. Held equal to LICENSE rather than
   * to a literal, so the year and the name have one source.
   */
  it('matches the Copyright line in LICENSE exactly', () => {
    const line = read('LICENSE').split('\n').find((l) => l.startsWith('Copyright (c) '));
    expect(line).toBeDefined();
    const config = JSON.parse(read('src-tauri', 'tauri.conf.json')) as { bundle: { copyright: string } };
    expect(config.bundle.copyright).toBe(line);
  });
});

describe('A1-001: the file types the installers claim', () => {
  /**
   * What this guards.
   *
   * `bundle.fileAssociations` is what makes Nox appear in Open With, and it
   * is invisible until an installer runs: a misspelled key is dropped in
   * silence, and a claimed extension the editor cannot name is a promise the
   * status bar breaks. Neither shows up in any other suite, because nothing
   * else in the repository reads this block at all.
   *
   * What it does not catch: what the platform installers do with a block
   * that is well formed. Whether NSIS writes the registry entries, and
   * whether Launch Services believes the Info.plist, can only be seen on a
   * machine with the bundle installed.
   */
  const associations = (
    JSON.parse(read('src-tauri', 'tauri.conf.json')) as {
      bundle: { fileAssociations?: Record<string, unknown>[] };
    }
  ).bundle.fileAssociations;

  /**
   * The schema the Tauri CLI validates against, read out of the CLI that is
   * actually installed rather than a copy. `tauri.conf.json` names it in
   * `$schema` by URL, and nothing in this repository fetches that.
   */
  const schema = JSON.parse(read('node_modules', '@tauri-apps', 'cli', 'config.schema.json')) as {
    definitions: Record<
      string,
      {
        properties?: Record<string, unknown>;
        required?: string[];
        oneOf?: { enum?: string[] }[];
      }
    >;
  };

  /** The string values of a schema enum, which is written as a `oneOf` of one-value enums. */
  const enumValues = (name: string): string[] =>
    (schema.definitions[name]?.oneOf ?? []).flatMap((variant) => variant.enum ?? []);

  it('is a block the Tauri schema recognises, key by key', () => {
    expect(schema.definitions.BundleConfig?.properties).toHaveProperty('fileAssociations');
    expect(associations?.length).toBeGreaterThan(0);

    const association = schema.definitions.FileAssociation;
    // `additionalProperties: false` is the silent failure this exists for: a
    // key Tauri does not know is not an error, it is a claim that never
    // reaches the installer.
    const allowed = Object.keys(association?.properties ?? {});
    expect(allowed).toContain('ext');
    const roles = enumValues('BundleTypeRole');
    const ranks = enumValues('HandlerRank');
    expect(roles).toContain('Editor');
    expect(ranks).toContain('Alternate');

    for (const entry of associations ?? []) {
      for (const required of association?.required ?? []) expect(entry).toHaveProperty(required);
      expect(Object.keys(entry).filter((key) => !allowed.includes(key))).toEqual([]);
      expect(Array.isArray(entry.ext)).toBe(true);
      expect(roles).toContain(entry.role);
      expect(ranks).toContain(entry.rank);
    }
  });

  it('claims only extensions core/languages.ts can name, and claims each once', () => {
    const known = new Set(LANGUAGES.flatMap((language) => language.extensions));
    const claimed = (associations ?? []).flatMap((entry) => entry.ext as string[]);

    expect(claimed.filter((ext) => !known.has(ext))).toEqual([]);
    // Two associations claiming one extension is two ProgIDs for one file
    // type on Windows, and the installer writes whichever it reaches last.
    expect(new Set(claimed).size).toBe(claimed.length);
    // The floor: an editor that cannot be offered a .txt is not an editor.
    for (const ext of ['txt', 'md', 'json', 'rs', 'ts']) expect(claimed).toContain(ext);
  });

  /**
   * The decision this pins, from AUDIT/GATED-DECISIONS.md §3: be an option,
   * not a default. `role` is `Editor` everywhere, because Nox edits every
   * file it opens and a `Viewer` would be a lie. `rank` is what varies, and
   * the formats another application makes are `Alternate` so macOS offers
   * Nox without preferring it.
   */
  it('offers itself as an editor, and never outranks the tool that owns a format', () => {
    const rankOf = new Map<string, string>();
    for (const entry of associations ?? []) {
      expect(entry.role).toBe('Editor');
      expect(entry.rank).not.toBe('Owner');
      for (const ext of entry.ext as string[]) rankOf.set(ext, entry.rank as string);
    }
    for (const ext of ['json', 'md', 'markdown', 'xml']) {
      expect(rankOf.get(ext)).toBe('Alternate');
    }

    // Deliberately unclaimed, though `languages.ts` knows every one of them.
    // `.html`, `.htm` and `.xhtml` belong to the browser: on Windows the
    // installer has no "offer only" setting (see below), so claiming them
    // would take a double-click away from the thing the user meant. `.svg`
    // is an image everywhere but here, `.plist` is a macOS system file that
    // is often not text at all, and `.webmanifest` is a `.json` by another
    // name that nobody goes looking for an editor for.
    const claimed = new Set((associations ?? []).flatMap((entry) => entry.ext as string[]));
    for (const ext of ['html', 'htm', 'xhtml', 'svg', 'plist', 'webmanifest']) {
      expect(claimed.has(ext)).toBe(false);
    }
  });

  /**
   * `name` is doing two jobs, and the second one is not obvious from the
   * schema: on macOS it is `CFBundleTypeName`, and on Windows it is the
   * **ProgID**, written straight into `Software\Classes\<name>` by the
   * `APP_ASSOCIATE` macro in the generated `installer.nsi`. Tauri defaults it
   * to `ext[0]`, so an unnamed association would claim the registry key
   * `txt`. A ProgID has to be namespaced or it collides with whatever else
   * chose the same words.
   *
   * Read off the generated script rather than assumed: the same macro also
   * writes `Software\Classes\.<ext>` itself, so on Windows an install
   * makes Nox the *default* opener and backs the old value up for the
   * uninstaller. `rank` cannot soften that; it is `LSHandlerRank`, and macOS
   * is the only platform that reads it.
   */
  it('names each association as a namespaced Windows ProgID', () => {
    for (const entry of associations ?? []) {
      expect(entry.name).toMatch(/^Nox\.[A-Za-z]+$/);
    }
  });
});
