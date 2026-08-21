import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every source file under `src/` is text.
 *
 * The failure this prevents, and it shipped: `services/permissions.ts` built
 * its grant keys with a *raw* NUL byte rather than a `\0` escape. The value was
 * right and the compiler was happy, but a NUL makes the entire file binary to
 * `grep`, `git diff`, and every other text tool — so `grep -rn "forgetSession"
 * src/` reported the call site in `runtime.ts` and silently omitted the
 * definition. Nothing here is subtle once you know; the cost is that the way
 * you find out is by concluding a method does not exist.
 *
 * A separator is the natural place for this to happen again, since NUL is
 * genuinely the right character to join fields that may contain spaces. The
 * escape is what has to be reviewed, not the choice.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/*
  `tests/` is walked as well as `src/`, because the first thing found after the
  guard was written was a raw NUL in `tests/workspace.test.ts` — seeding a
  deliberately binary fixture, which is a legitimate thing for that test to
  want and still turns the whole file binary to every text tool. The escape is
  what has to be reviewed, not the intent.
*/
const ROOTS = ['src', 'tests'].map((dir) => join(ROOT, dir));

/** Every source file under a root, by extension. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.(ts|svelte|css|json|js)$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

describe('the source tree', () => {
  const files = ROOTS.flatMap(sourceFiles);

  it('found files to check, so a broken walk cannot pass vacuously', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('holds no raw control bytes that would make a file binary to grep', () => {
    const offenders = files
      .filter((path) => readFileSync(path).includes(0))
      .map((path) => path.slice(ROOT.length));

    expect(offenders).toEqual([]);
  });
});
