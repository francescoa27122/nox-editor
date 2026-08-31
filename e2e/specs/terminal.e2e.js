import { browser, $, $$, expect } from '@wdio/globals';

/**
 * The terminal, in the packaged app, against a real shell.
 *
 * **This is a 1.0 bar row, not a nice-to-have.** "Nothing in the release notes
 * says unverified" names four things as genuinely outside what the browser
 * target can reach: the menu bar, native dialogs, the terminal, and the git
 * panel against a real repository. The menu bar got `menu-bar.e2e.js`. This is
 * the terminal, and until it existed the terminal had **no packaged-app
 * coverage of any kind** on any platform: `MemoryPlatform.openTerminal` throws
 * `unsupported`, so every suite under `tests/` is structurally incapable of
 * running a shell, and the one hand walk on file never reached it.
 *
 * What only this can answer is the whole chain at once: `nox_pty_open` spawns
 * a real process on a real pty, `nox://pty-data` carries its bytes across the
 * IPC boundary, `platform/tauri.ts` routes them by session id, and xterm.js
 * puts them on screen. Every one of those links is invisible to `tests/`.
 *
 * **Text, not geometry**, per `e2e/README.md`. Nothing here measures a cell, a
 * column count or where the panel sits. It asks whether a command that was
 * typed produced the output it should have, which is the one question a pty
 * exists to answer.
 *
 * xterm.js is read through the DOM rather than a canvas because this build
 * imports no renderer addon, so the default DOM renderer is what draws, and
 * `.xterm-rows` holds the text. If a canvas addon is ever added, this suite
 * goes blind rather than red, which is worth knowing before making that swap.
 *
 * ## Why typing goes through the helper textarea
 *
 * `browser.keys` and the Actions API both deliver **every character twice** to
 * xterm and only to xterm: typing `echo` produces `eecchhoo`, and bash then
 * reports `eecchhoo: command not found`. Measured 2026-08-30 on WebKitGTK
 * 605.1.15 under xvfb, four ways (a string, a character array, one chained
 * action, one `perform` per character); all four double.
 *
 * The evidence says this is the **driver**, not Nox:
 *
 * - The command palette's `<input>` does *not* double under the same driver
 *   in the same session: `browser.keys('abc')` leaves exactly `>abc`.
 * - Probing xterm's helper textarea during a keystroke logs **one `input`
 *   event carrying the character**. In a real browser xterm calls
 *   `preventDefault()` on keydown for a printable key precisely so the
 *   textarea never receives it, and emits the data itself. Text arriving there
 *   anyway means the insertion ignored `preventDefault`, which gives two data
 *   paths for one key, and only in a widget that reads its textarea as input.
 *
 * So this suite types with `addValue`, which drives the textarea path alone
 * and leaves the round trip below intact: textarea input, `onData`,
 * `nox_pty_write`, the pty, the shell, `nox://pty-data`, xterm.
 *
 * **What that cannot prove is what a human sees.** A synthetic-input harness
 * is the wrong instrument for a question about real key delivery, which is the
 * whole reason the 1.0 bar keeps a real-keyboard pass. "Type in the terminal
 * and check each character appears once" is now a specific line on that
 * checklist rather than a hunch.
 */

const MAC = process.platform === 'darwin';
const WINDOWS = process.platform === 'win32';

async function waitForBoot() {
  await $('.nox-shell').waitForExist({ timeout: 60_000 });
  await $('.nox-statusbar').waitForExist({ timeout: 60_000 });
}

/**
 * Type into the terminal.
 *
 * `addValue` on xterm's helper textarea rather than `browser.keys`, for the
 * reason set out at the top of this file: the key-event path doubles every
 * character under this driver and the textarea path does not.
 */
async function type(text) {
  await $('.nox-terminal textarea').addValue(text);
}

/**
 * Submit the line, with the Enter key.
 *
 * **`browser.keys(['Enter'])`, not a carriage return in the text**, and this
 * is the one place this file uses the key-event path on purpose.
 *
 * The text path cannot do it. `addValue('\r')` reaches the pty on WebKitGTK,
 * because that driver puts the character into the textarea and xterm forwards
 * what it finds there. On Chromium (Windows and macOS) Element Send Keys
 * dispatches real key events, and a bare carriage return is not one, so the
 * command was typed correctly and then sat at the prompt forever. The CI
 * screen dump said so exactly: `C:\Users\runneradmin>echo NOXE^2E-OK`, no
 * output, no second prompt.
 *
 * Enter is safe on the path the rest of this file avoids. The doubling
 * documented at the top of this file duplicates *characters*; a duplicated
 * Enter is an extra empty prompt and changes no assertion here.
 */
async function submit() {
  await browser.keys(['Enter']);
}

/** Everything the terminal is currently showing, as one string. */
async function screenText() {
  const rows = await $('.nox-terminal .xterm-rows');
  if (!(await rows.isExisting())) return '';
  return (await rows.getText()) ?? '';
}

/**
 * Wait until the terminal has printed something matching `pattern`.
 *
 * Polls the rendered rows rather than waiting a fixed time: a shell's start-up
 * cost is the runner's, not ours, and the three platforms here disagree about
 * it by an order of magnitude.
 *
 * **On failure it prints what the terminal actually showed.** Without that,
 * a red run on a platform the author cannot reach says only "the marker never
 * came", which is consistent with the keystrokes not arriving, the line not
 * being submitted, the shell rejecting the syntax, and the shell never having
 * started. Two speculative fixes went in against that ambiguity before this
 * was added. The screen contents distinguish all four in one run.
 */
async function waitForOutput(pattern, what, timeout = 60_000) {
  try {
    await browser.waitUntil(async () => pattern.test(await screenText()), {
      timeout,
      interval: 250,
    });
  } catch {
    throw new Error(`${what}\n  looked for: ${pattern}\n  screen was: ${JSON.stringify(await screenText())}`);
  }
}

describe('the terminal', () => {
  before(async () => {
    await waitForBoot();
  });

  after(async () => {
    // Leave the panel closed for whatever runs next. Hiding does not kill the
    // shell, which is `UIService.hideTerminal`'s documented choice, so this is
    // tidiness rather than teardown.
    if (await $('.nox-terminal').isExisting()) {
      await browser.keys(['Control', '`']);
    }
  });

  /**
   * The chord is `Ctrl+\`` on every platform, including macOS: `app.ts`'s
   * binding table says so, because it is the convention everywhere and ⌘` is
   * already macOS's cycle-windows.
   */
  it('opens on its chord and attaches a real shell', async () => {
    await browser.keys(['Control', '`']);
    await $('.nox-terminal').waitForExist({ timeout: 30_000 });

    // The panel can exist before the pty has said anything, so existence is
    // not the assertion. A shell that started prints a prompt, and a prompt is
    // the first thing only a real process can produce.
    await waitForOutput(
      /\S/,
      'the terminal panel opened but the shell never printed anything, which is a pty that did not start',
    );

    await expect($('.nox-terminal')).toBeExisting();
  });

  /**
   * The round trip: a keystroke leaves the renderer, crosses into Rust, is
   * written to the pty master, is read by the shell, and its output comes back
   * the other way as a `nox://pty-data` event.
   *
   * The marker is split so that the *echo* of what was typed cannot satisfy
   * the assertion. A shell echoes the command line back before running it, so
   * asserting on a literal that appears in the command would pass against a
   * terminal that only ever showed keystrokes and never ran anything. Building
   * the word inside the shell means the only way it appears whole is if a
   * process actually executed.
   */
  it('runs what is typed and shows what came back', async () => {
    if (!(await $('.nox-terminal').isExisting())) {
      await browser.keys(['Control', '`']);
      await $('.nox-terminal').waitForExist({ timeout: 30_000 });
      await waitForOutput(/\S/, 'the shell never printed a prompt');
    }

    // `echo` is the one command every shell in this matrix has, but the way to
    // join two literals is not shared. Windows starts **cmd.exe**, not
    // PowerShell: `pty.rs`'s `default_shell` reads `ComSpec`. So the earlier
    // `echo ("NOXE" + "2E-OK")` here was PowerShell syntax that cmd printed
    // back verbatim, marker and all absent.
    //
    // In cmd, `^` is the escape character and is removed, so `NOXE^2E-OK` is
    // typed and `NOXE2E-OK` is printed. In a POSIX shell adjacent quoted
    // strings concatenate. Both keep the property the split is for: the
    // terminal's echo of what was *typed* cannot satisfy the assertion,
    // because the joined word only exists once a process has run.
    const command = WINDOWS ? 'echo NOXE^2E-OK' : 'echo "NOXE""2E-OK"';

    await type(command);

    // Two waits, not one, and the split is the point. A terminal echoes what
    // is typed before anything runs, so this first one fails only when the
    // keystrokes never reached xterm at all, and the second only when a line
    // that was typed did not run. One assertion could not tell those apart,
    // which is what made the Windows failure guesswork.
    await waitForOutput(/echo/, 'nothing typed reached the terminal', 15_000);

    await submit();

    await waitForOutput(
      /NOXE2E-OK/,
      'the line was typed but never produced the joined marker, so it was not submitted or the shell did not accept it',
    );
  });

  /**
   * Hiding is not killing, which `UIService.hideTerminal` states in prose and
   * nothing has ever checked: "closing the panel is not a reason to kill a
   * build half way through".
   *
   * The scrollback surviving a hide is the observable form of that claim. It
   * lives in the xterm instance, and `TerminalPanel` hides the panel with CSS
   * rather than unmounting precisely so it is not disposed. If the panel were
   * ever changed to unmount, the marker from the previous test would be gone
   * when it came back and this goes red.
   */
  it('keeps the session and its scrollback when the panel is hidden', async () => {
    await browser.keys(['Control', '`']);
    await browser.waitUntil(async () => !(await $('.nox-terminal').isDisplayed().catch(() => false)), {
      timeout: 15_000,
      timeoutMsg: 'the terminal panel never went away',
    });

    await browser.keys(['Control', '`']);
    await $('.nox-terminal').waitForDisplayed({ timeout: 15_000 });

    // The same marker the previous test produced. Present means the shell was
    // never restarted and its scrollback was never thrown away.
    await waitForOutput(
      /NOXE2E-OK/,
      'the scrollback did not survive hiding the panel, so the session was disposed rather than hidden',
    );
  });

  /**
   * macOS draws a native menu and the other two draw their own, so the item
   * that opens the terminal is only reachable in-window off macOS. Asserted
   * rather than skipped, because "the menu has a Terminal item" is exactly the
   * kind of wiring that rots silently: `menu.ts`'s LAYOUT puts `Terminal` in
   * the Tools group, and nothing outside this file checks that the group
   * reaches the packaged window.
   */
  it('offers the terminal from the Tools menu, where the OS gives no native one', async function () {
    if (MAC) return this.skip();

    // `.menu-title` and `.menu`, the selectors `menu-bar.e2e.js` established.
    // Found by name rather than by index: the group's position in LAYOUT is
    // not what this is about, and an index would make an unrelated reorder
    // look like a missing menu.
    const titles = await $$('.menu-title');
    let tools = null;
    for (const title of titles) {
      if ((await title.getText()).trim() === 'Tools') {
        tools = title;
        break;
      }
    }
    if (!tools) return this.skip();

    await tools.click();
    await $('.menu').waitForExist({ timeout: 10_000 });

    const text = await $('.menu').getText();
    expect(text).toContain('Terminal');

    await browser.keys(['Escape']);
  });
});
