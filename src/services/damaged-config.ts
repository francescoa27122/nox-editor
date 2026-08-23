import { damagedCopyName, type DamagedFile } from '@core/damaged-config';
import type { Platform } from '@platform/types';

/**
 * Keep a copy of a config file that would not parse, and say where it went.
 *
 * The **original is left in place**, not deleted. Nox does not delete a
 * user's file to fix its own problem; the copy is the preservation, and the
 * original being overwritten by the next legitimate write is acceptable
 * precisely because this copy exists and the user was told about it.
 *
 * The copy is rewritten on each damaged load rather than kept as a series, so
 * it always mirrors the file that is *currently* damaged — the one worth
 * repairing.
 *
 * Never throws. A copy that cannot be written comes back as `copy: null`, and
 * the caller still reports the damage: knowing the file was unreadable
 * matters more than knowing where the spare went.
 */
export async function preserveDamaged(
  platform: Platform,
  file: string,
  raw: string,
): Promise<DamagedFile> {
  const copy = damagedCopyName(file);
  try {
    await platform.writeConfigFile(copy, raw);
    return { file, copy };
  } catch {
    return { file, copy: null };
  }
}
