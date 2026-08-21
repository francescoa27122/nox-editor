/**
 * Where a note's anchor lands once the file has moved on.
 *
 * A line number alone rots: inserting anything above an anchor makes it point
 * at the wrong code, and it does so silently, which is worse than pointing
 * nowhere because it still looks right. Storing the anchored text beside the
 * line lets a jump re-find it.
 *
 * Pure, and deliberately not in `services/`: it takes the file's text and a
 * line number, so the drift case is a string literal in a test rather than a
 * file someone has to edit to reproduce.
 */

/**
 * How far from the remembered line a match is still believed, in lines.
 *
 * An edit that moved code further than this is a restructure rather than a
 * drift, and a far-away identical line — `}` appears hundreds of times in a
 * real file — is more likely a coincidence than the anchor's subject. Past
 * the window the remembered line is the safer answer.
 */
const WINDOW = 500;

/**
 * The 1-based line to jump to for an anchor remembered at `line` holding
 * `snippet`, given the file's current `text`.
 *
 * Falls back to `line` (clamped into the file) whenever the snippet cannot be
 * found nearby, which puts the reader in the neighbourhood the note was about
 * — the best that can honestly be offered once the code itself is gone.
 */
export function resolveAnchorLine(text: string, line: number, snippet: string): number {
  const rows = text.split('\n');
  const clamped = Math.min(Math.max(line, 1), rows.length);

  const needle = snippet.trim();
  // An empty snippet matches every blank line, which is not help — it is a
  // jump to whichever blank line happens to be nearest.
  if (needle.length === 0) return clamped;

  const matches = (index: number) => rows[index]?.trim() === needle;

  const start = clamped - 1;
  if (matches(start)) return clamped;

  // Outward from the remembered line rather than a scan from the top, so the
  // *nearest* match wins. With a non-unique snippet, scanning from the top
  // lands on the first one in the document, which is rarely the right one.
  for (let distance = 1; distance <= WINDOW; distance++) {
    const before = start - distance;
    const after = start + distance;
    // Before ahead of after on a tie: an anchor that drifted is usually
    // pushed *down* by an insertion, so the copy above the remembered line is
    // the one the note was made against.
    if (before >= 0 && matches(before)) return before + 1;
    if (after < rows.length && matches(after)) return after + 1;
  }

  return clamped;
}
