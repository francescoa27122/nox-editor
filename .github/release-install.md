## Install

**macOS**: download the `.dmg` for your chip (`aarch64` is Apple
Silicon, `x64` is Intel), drag Nox to Applications and open it.
The app is signed with an Apple Developer ID and notarized, so
macOS lets it through the way it does any other download. No
terminal command. Nox needs macOS 13 or newer.

**Updates** install from inside Nox: *Check for Updates…*, or the
toast shortly after launch. They are verified against the app's
own signing key and replace the app in place.

**Linux**: take the `.deb` or the `.rpm`. Built on Ubuntu 22.04,
so it needs glibc 2.35 or newer. There is no AppImage.

**Windows**: take the `-setup.exe`. It is ad-hoc built rather
than signed with a code-signing certificate, so SmartScreen shows
*"Windows protected your PC"* on first run: choose **More info**,
then **Run anyway**. A Windows certificate is a separate decision
(`ROADMAP.md` says why), and building from source avoids the
dialog.
