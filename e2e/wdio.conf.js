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
 * everywhere else. `cargo` was not installed on the development machine when
 * this was written, so every iteration cost a CI round trip.
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

/**
 * Which WebDriver actually drives the webview.
 *
 * `embedded` is a WebDriver server *inside* the app, from
 * `tauri-plugin-wdio-webdriver`, which `src-tauri` compiles only under its
 * `wdio` feature and registers only in a debug build. No `tauri-driver`, no
 * WebKitWebDriver, no msedgedriver.
 *
 * It replaced `external` because **`external` is a dead end on Windows.**
 * Everything up to the session worked there — `nox.exe` built, WebView2
 * `151.0.4129.86` detected, the exactly matching msedgedriver downloaded,
 * `tauri-driver` ready on 4444 — and then `POST /session` waited sixty
 * seconds for a Chromium DevTools port that a Tauri WebView2 window never
 * opens. Version skew, the usual cause of that error, was ruled out by the
 * exact match. `Haprog/tauri-wdio-win-test` exists to do precisely this and
 * reports no way to make modern WebdriverIO work with `tauri-driver` there.
 *
 * The same change is also the only route to macOS, which has no external
 * driver available at all.
 */
const DRIVER = { driverProvider: 'embedded' };

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
      'wdio:tauriServiceOptions': DRIVER,
    },
  ],

  // Set at both levels on purpose. `onPrepare` is a *launcher* hook and reads
  // the options given here; the capability is what a worker reads. They carry
  // the same object, so there is nothing to disagree about, and setting only
  // one leaves which-of-the-two-wins as something to discover from a CI log.
  services: [['@wdio/tauri-service', DRIVER]],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: process.env.CI ? 'info' : 'debug',

  /**
   * Disarm the service's per-command window-focus check. This is worth ten
   * seconds on every single command.
   *
   * `TauriWorkerService.beforeCommand` calls `ensureActiveWindowFocus` for
   * `findElement`, `findElements`, `$`, `$$`, `getTitle` and `elementClick` —
   * which is everything a spec does. That asks the app for its window states
   * over `window.__TAURI__.core.invoke`, and **Nox does not expose
   * `window.__TAURI__` at all**: the renderer reaches Tauri through
   * `platform/tauri.ts`, which is the boundary the whole architecture rests
   * on, and `withGlobalTauri` would put an invoke bridge on the global object
   * of a webview that renders other people's code. So the lookup cannot
   * succeed, and it fails by *timing out* — 5s in the `before` hook and 5s
   * again per command. Measured: a `findElement` that takes 4 ms was costing
   * a flat ten seconds, and four specs took six minutes.
   *
   * The service turns the check off for a session in which the caller has
   * chosen a window explicitly — `afterCommand` on a successful
   * `switchToWindow` calls its `suppressActiveWindowFocus`. Switching to the
   * handle we are already on is exactly that statement and nothing else: it
   * moves nothing, and the service's own guard for its internal recovery
   * switches does not fire, because that reads an `AsyncLocalStorage` only
   * its own code sets.
   *
   * Suppressing it is also *correct*, not merely fast. Focus recovery exists
   * for apps with several windows; `tauri.conf.json` declares one and Nox has
   * no API to open another, so there is no window for it to recover to.
   */
  before: async (_capabilities, _specs, browser) => {
    await browser.switchToWindow(await browser.getWindowHandle());
  },

  // Generous, and not arbitrary: the first launch of a debug build on a cold
  // CI runner pays for the webview starting as well as the app.
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  mochaOpts: {
    ui: 'bdd',
    timeout: 120_000,
  },
};
