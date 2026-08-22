/**
 * The charsets Nox can read and write.
 *
 * In `core/` rather than `services/workspace.ts` where it started, because
 * `Platform` names it now and `platform/` must not import from `services/`.
 * `workspace.ts` re-exports it so existing importers are unaffected.
 *
 * The names are the strings that cross the IPC boundary, matching
 * `src-tauri/src/encoding.rs` exactly — one spelling in both places is what
 * stops the two drifting.
 */
export type Encoding =
  | 'utf-8'
  | 'utf-8-bom'
  | 'utf-16le'
  | 'utf-16be'
  | 'windows-1252'
  | 'shift_jis';

/**
 * What the user may choose from, with the wording they see.
 *
 * UTF-16 is *detected* from its byte-order mark and never needs choosing, but
 * a file whose mark was stripped can still be opened by picking it. **Saving
 * that file writes the mark back on**, which is the one case where Nox
 * changes a file's shape rather than preserving it: mark-less UTF-16 is
 * undetectable — little-endian ASCII is valid UTF-8, so it would be read back
 * as UTF-8 full of NULs and refused as binary — so the mark is what makes it
 * a file Nox can open again. See `encode_utf16` in `encoding.rs`.
 *
 * The two legacy charsets are choice-only: nothing detects them, because
 * nothing honestly can — see `encoding.rs`.
 */
export const ENCODING_CHOICES: readonly { id: Encoding; label: string }[] = [
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'utf-8-bom', label: 'UTF-8 with BOM' },
  { id: 'utf-16le', label: 'UTF-16 LE' },
  { id: 'utf-16be', label: 'UTF-16 BE' },
  { id: 'windows-1252', label: 'Western (Windows 1252)' },
  { id: 'shift_jis', label: 'Japanese (Shift JIS)' },
];

/** The label shown in the status bar. */
export function encodingLabel(encoding: Encoding): string {
  return ENCODING_CHOICES.find((choice) => choice.id === encoding)?.label ?? encoding;
}

/**
 * Whether a charset is one Nox will infer on its own.
 *
 * Only these can be. Everything else is reachable by explicit choice, which
 * is the whole design: a wrong guess produces mojibake and the next save
 * makes it permanent.
 */
export function isDetectable(encoding: Encoding): boolean {
  return encoding === 'utf-8' || encoding === 'utf-8-bom' || encoding === 'utf-16le' || encoding === 'utf-16be';
}
