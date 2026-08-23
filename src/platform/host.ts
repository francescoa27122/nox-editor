/**
 * What host this build is running on, for the handful of places that must
 * differ by it.
 *
 * Lives in `platform/` rather than `core/`: reading `navigator` is
 * environment detection, and `core/` is pure TS with zero imports and no
 * ambient state. It is a module constant rather than a `Platform` method
 * because the two callers need it before an app exists — `services/keymap.ts`
 * resolves `Mod` while building its table, and `platform/demo-workspace.ts`
 * writes the demo README as a static string.
 *
 * One definition, because two would drift: the keymap said Ctrl on Windows
 * while the demo README told the reader to press ⌘.
 */
export const isMacHost: boolean =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);

/** `Mod` spelled the way this host spells it, for prose and seeded content. */
export const modKeyLabel: string = isMacHost ? '⌘' : 'Ctrl+';
