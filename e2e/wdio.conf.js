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

/**
 * Where the binary is.
 *
 * Normally unset: the service detects it. Tauri names the built binary from
 * `productName` while Cargo names it from `package.name`, and those disagree
 * here — `Nox` against `nox` — so a hardcoded path is a guess that cannot be
 * checked without a Rust toolchain. The override exists for the case where
 * detection is the thing that turns out to be wrong.
 */
const application = process.env.NOX_E2E_BINARY;

export const config = {
  runner: 'local',
  specs: ['./specs/**/*.e2e.js'],

  // One at a time. Each instance is a real window belonging to a real
  // process, and Nox persists window geometry and session state to the same
  // config directory — two at once would be two editors writing one session.
  maxInstances: 1,

  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': application ? { application } : {},
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
