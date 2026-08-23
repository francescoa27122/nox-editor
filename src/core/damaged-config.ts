/**
 * A config file Nox cannot read is damaged, not absent.
 *
 * Absent is a state the editor already handles: start from defaults and write
 * your own file over the top. That is correct for a file that genuinely is
 * not there, and destructive for one that is — and every file this module
 * serves holds something the user cannot get back.
 *
 * Pure on purpose. The copying itself needs a `Platform` and lives with the
 * service that owns the file; what is here is the naming and the one piece of
 * salvage, both of which are total functions over strings and are where being
 * wrong is silent.
 *
 * See `docs/superpowers/specs/2026-08-22-damaged-config-recovery-design.md`.
 */

/** What a service publishes when it could not read its own file. */
export interface DamagedFile {
  /** The file that would not parse, as `readConfigFile` names it. */
  file: string;
  /** Where the copy was put, or null when the copy could not be written. */
  copy: string | null;
}

/**
 * The name the damaged copy is kept under.
 *
 * The marker goes *before* the extension so the copy sorts beside its
 * original in a directory listing and still opens as JSON in an editor —
 * `settings.damaged.json`, not `settings.json.damaged`. Split on the last dot
 * rather than the first, so a name that already contains one keeps it.
 *
 * Nox never reads or writes these names for any other purpose, which is what
 * makes the copy survive every later save.
 */
export function damagedCopyName(file: string): string {
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return `${file}.damaged`;
  return `${file.slice(0, dot)}.damaged${file.slice(dot)}`;
}

/**
 * The largest number `pattern` captures anywhere in `raw`, or 0.
 *
 * `session.json` and `notes.json` both hand out content-file names from a
 * counter that is "recomputed on load" — and both restart it at 1 when the
 * load fails, which is what turns a damaged index into a *destroyed* body
 * file. This is the way out: `JSON.parse` failing does not make the text
 * unreadable, it makes it unstructured, and the names are still in it. A
 * truncated file yields its high-water mark exactly as a valid one does.
 *
 * `pattern` must be global and must capture the number in group 1. Its
 * `lastIndex` is reset first, because a caller may reasonably hold one
 * regex and use it twice.
 */
export function highestNumbered(raw: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let highest = 0;
  let found: RegExpExecArray | null;

  while ((found = pattern.exec(raw)) !== null) {
    // A zero-width match would spin forever; no pattern here can produce one,
    // but this module must not depend on that staying true.
    if (found[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    const value = Number.parseInt(found[1] ?? '', 10);
    if (Number.isFinite(value) && value > highest) highest = value;
  }

  return highest;
}
