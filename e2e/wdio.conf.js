/**
 * WebDriver against the packaged Nox binary.
 *
 * Why this exists: until now the only record of the desktop app working was a
 * manual walk, and the one on file (`.desktop-pass-report.md`) got 12 of its
 * 17 items marked UNSEEN and reported two defects that turned out to be the
 * walk harness rather than the app. That harness swallowed clicks in a screen
 * region it also hid from its own screenshots, and ate **Escape** at the OS
 * level before any app could see it. An instrument that silently drops inputs
 * cannot answer the question "does the packaged app work", in either
 * direction. This can, and it can do it unattended on every pull request.
 *
 * **Plain JavaScript, deliberately**, in a repository that is TypeScript
 * everywhere else. `cargo` is not installed on the development machine, so
 * nothing here can be run locally — every iteration costs a CI round trip.
 * A TypeScript loader is one more thing that can fail in that loop for a
 * reason unrelated to what is being tested, bought for type coverage of a
 * hundred lines of test glue. Worth revisiting once the harness has earned
 * its keep; not worth it while the harness is the thing being proved.
 *
 * Its own `package.json` for the same kind of reason: `@wdio/*` is a large
 * dependency tree, and the seven existing CI checks all run `npm ci` at the
 * root. Nothing about building or unit-testing Nox needs WebdriverIO.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the binary is.
 *
 * Set explicitly rather than detected. The service has automatic path
 * detection but does not apply it to an empty `tauri:options` — the first CI
 * run failed with "Tauri application path not specified", and because the
 * service bails before rewriting the capability, the symptom is the confusing
 * `No "browserName" defined in capabilities` from WebdriverIO itself rather
 * than anything naming Tauri.
 *
 * The name is `nox`, from Cargo's `package.name` — **not** `Nox` from Tauri's
 * `productName`, which is what the bundled application is called. Those
 * disagree here, and `--no-bundle` stops before the rename, so this is the
 * Cargo one. Read off the build log rather than reasoned about:
 * `Built application at: …/src-tauri/target/debug/nox`.
 *
 * Absolute, from this file's own location, so it does not depend on where
 * the runner happened to be standing.
 */
const application =
  process.env.NOX_E2E_BINARY ??
  path.resolve(
    here,
    '..',
    'src-tauri',
    'target',
    'debug',
    process.platform === 'win32' ? 'nox.exe' : 'nox',
  );

export const config = {
  runner: 'local',
  specs: [path.join(here, 'specs', '**', '*.e2e.js')],

  // One at a time. Each instance is a real window belonging to a real
  // process, and Nox persists window geometry and session state to the same
  // config directory — two at once would be two editors writing one session.
  maxInstances: 1,

  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': { application },
    },
  ],

  services: ['@wdio/tauri-service'],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: process.env.CI ? 'info' : 'debug',

  // Generous, and not arbitrary: the first launch of a debug build on a cold
  // CI runner pays for the webview starting as well as the app.
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  mochaOpts: {
    ui: 'bdd',
    timeout: 120_000,
  },
};
