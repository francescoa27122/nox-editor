/**
 * Path helpers that work for both POSIX and Windows paths without depending
 * on Node's `path`. The renderer never knows which OS it is on — it only ever
 * handles path strings the platform layer hands it — so these normalise both.
 */

const SEP_RE = /[\\/]/;

/** True for `/foo`, `C:\foo`, `\\server\share`. */
export function isAbsolute(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p);
}

/** The separator this path appears to use. Windows paths keep backslashes. */
export function separatorOf(p: string): string {
  return /^[a-zA-Z]:\\/.test(p) || (p.includes('\\') && !p.includes('/')) ? '\\' : '/';
}

/** Final segment: `/a/b/c.txt` -> `c.txt`. Trailing separators are ignored. */
export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const parts = trimmed.split(SEP_RE);
  return parts[parts.length - 1] ?? '';
}

/** Everything before the final segment. Returns '' when there is no parent. */
export function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return '';
  if (idx === 0) return trimmed[0] ?? '/';
  return trimmed.slice(0, idx);
}

/** Lowercased extension without the dot. Dotfiles have no extension. */
export function extname(p: string): string {
  const base = basename(p);
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return '';
  return base.slice(idx + 1).toLowerCase();
}

/** Join segments using the separator implied by the first one. */
export function join(...parts: string[]): string {
  const present = parts.filter((p) => p.length > 0);
  if (present.length === 0) return '';
  const sep = separatorOf(present[0]!);
  return present
    .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .filter((p) => p.length > 0)
    .join(sep);
}

/** Path of `child` relative to `root`, or the original when not contained. */
export function relative(root: string, child: string): string {
  const r = root.replace(/[\\/]+$/, '');
  if (!child.startsWith(r)) return child;
  return child.slice(r.length).replace(/^[\\/]+/, '');
}

/**
 * True when `child` is `parent` or lives beneath it. Guards against `/aa` ⊄ `/a`.
 *
 * **A string comparison, and never a trust boundary.** It does not resolve
 * `..`, so `contains('/proj', '/proj/../../etc/shadow')` is `true`. That is
 * fine for what most callers want, which is "does this path *read* as being
 * under that folder" about paths the OS already handed them. It is not fine
 * for deciding whether something is allowed to be touched. Use
 * `containsResolved` there.
 */
export function contains(parent: string, child: string): boolean {
  const p = parent.replace(/[\\/]+$/, '');
  if (child === p) return true;
  return child.startsWith(p) && SEP_RE.test(child.charAt(p.length));
}

/**
 * `contains`, after resolving `.` and `..` on both sides.
 *
 * The one to use when the answer decides whether an action is permitted.
 * `PermissionService` asks exactly this question to know whether a path is
 * outside the open folder, and until 2026-08-30 it asked `contains`, so
 * `['/proj/../../etc/shadow']` was judged *inside* the workspace and `fs.read`
 * was granted by policy with no prompt. The traversal is resolved by the OS
 * later, which is what makes the string form so easy to miss.
 *
 * Separate from `contains` rather than folded into it because the twenty-odd
 * other callers pass paths that came from the filesystem already resolved, and
 * a normalise on each is work in a hot path for a question they are not
 * asking. The cost of the split is that someone can still reach for the wrong
 * one, which is what the warning on `contains` is for.
 */
export function containsResolved(parent: string, child: string): boolean {
  return contains(normalize(parent), normalize(child));
}

/** Collapse `.` and `..` segments. Does not touch the leading separator. */
export function normalize(p: string): string {
  const sep = separatorOf(p);
  const absolute = isAbsolute(p);
  const drive = /^[a-zA-Z]:/.exec(p)?.[0] ?? '';
  const body = drive ? p.slice(drive.length) : p;

  const out: string[] = [];
  for (const seg of body.split(SEP_RE)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(seg);
  }

  const joined = out.join(sep);
  if (drive) return `${drive}${sep}${joined}`;
  return absolute ? `${sep}${joined}` : joined;
}

/**
 * Drop any path that lives inside another path in the same list.
 *
 * Needed the moment the explorer allows multi-select: if you pick a folder and
 * a file inside it and hit delete, removing the folder first makes the file's
 * delete fail with "not found". Reducing to top-level entries first makes the
 * operation mean what the user intended. Order is preserved.
 */
export function topLevelPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter((path) => !unique.some((other) => other !== path && contains(other, path)));
}

/**
 * Whether `source` can be moved into `targetDir`.
 *
 * Three ways a drag is meaningless or destructive, and the third is the one
 * that eats data: dropping a folder inside itself would move a directory into
 * its own subtree. Refusing here is much cheaper than discovering it after the
 * rename has already half-happened.
 */
export function canMoveInto(source: string, targetDir: string): boolean {
  if (source === targetDir) return false;
  // Already there: a no-op that would otherwise fail on a name collision.
  if (dirname(source) === targetDir) return false;
  // Into its own descendant.
  if (contains(source, targetDir)) return false;
  return true;
}

/** Display form for the title bar / status bar: `~/code/app/main.ts`. */
export function tildify(p: string, home: string | null): string {
  if (!home) return p;
  const h = home.replace(/[\\/]+$/, '');
  if (contains(h, p)) return `~${p.slice(h.length)}`;
  return p;
}
