import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
