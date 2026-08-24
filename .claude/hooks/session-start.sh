#!/bin/bash
#
# Makes a Claude Code on the web container able to run what CI runs.
#
# A fresh remote container arrives with the repo cloned and nothing else: no
# node_modules, no Chromium that matches the pinned Playwright, and none of the
# GTK/WebKit stack `cargo` needs to link a Tauri binary on Linux. Without this
# hook the first thing any session does is discover that `npm test` cannot
# start, and the second is spend a few minutes fixing it by hand — every
# session, identically.
#
# The container image is snapshotted after this hook completes, so everything
# below is paid once per environment build rather than once per session.
set -euo pipefail

# Local machines already have all of this, and a developer's box is not
# somewhere to be running `apt-get install` from a session hook.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

echo "nox: preparing the remote container"

# `install` rather than `ci`, which is what CI uses: `ci` deletes node_modules
# and starts over, which throws away exactly the snapshotted state this hook
# exists to build up. `install` is a no-op when the lockfile is already
# satisfied, so re-running the hook costs nothing.
echo "nox: npm dependencies"
npm install --no-audit --no-fund

# `npm run test:stories` drives every story through a real browser, and the
# browser it wants is the revision pinned by the repo's Playwright — not
# whatever the base image happened to bake in. When they disagree the run does
# not fall back or download on demand: it aborts with "Please run the following
# command to download new browsers" before a single story renders.
#
# Chromium only. The other engines are several hundred MB that nothing in this
# repo ever launches.
echo "nox: Chromium for the story tests"
npx --yes playwright install chromium

# The GTK/WebKit stack `cargo test` links against in src-tauri. Guarded on
# pkg-config rather than run unconditionally, so a warm container skips the apt
# work entirely instead of re-resolving ~130 packages to conclude it has them.
#
# CI carries an elaborate retry-and-cache action for this same install, because
# the apt mirror behind GitHub's runners degrades into 10-26 minute fetches that
# never error. That machinery is deliberately not copied here: this container
# talks to a mirror that serves the whole set in about half a minute, and the
# cost of being wrong is one slow environment build rather than a red required
# check. If it ever does start stalling, .github/actions/linux-build-deps is the
# worked example to copy.
if ! pkg-config --exists webkit2gtk-4.1; then
  echo "nox: GTK/WebKit build dependencies for src-tauri"
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=3 update
  apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=3 install -y \
    libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    libxdo-dev \
    libssl-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev
else
  echo "nox: GTK/WebKit build dependencies already present"
fi

# Download the crate sources without compiling them. This is the cheap half of
# warming Rust up, and it is the half that removes a network dependency from the
# first `cargo test` rather than just moving compile time around.
#
# `--locked` is what keeps this hook from editing tracked files. Without it,
# `cargo fetch` quietly rewrites Cargo.lock whenever the committed lockfile no
# longer matches what the resolver picks today — which it currently does not, by
# several hundred lines. A session that opens with an unexplained modification
# to Cargo.lock invites an agent to commit a dependency bump nobody asked for,
# so a stale lockfile is reported and left alone rather than silently repaired.
#
# The failure is non-fatal for the same reason: fetching crates is an
# optimisation, and a container that skipped it still runs `cargo test` fine —
# it just pays the download then, visibly, where the resulting lockfile change
# is attributable to a command someone ran.
#
# The expensive half — `cargo test --no-run`, which takes a little over two
# minutes cold and leaves a 4 GB target directory — is deliberately not here.
# It would be snapshotted and would genuinely make the first `cargo test`
# instant, but it triples how long a cold environment build blocks on this hook,
# and most sessions never touch the Rust side. Uncomment it if the work you do
# in these sessions is mostly in src-tauri.
if command -v cargo >/dev/null 2>&1; then
  echo "nox: fetching crate sources"
  if ! cargo fetch --locked --manifest-path src-tauri/Cargo.toml; then
    echo "nox: crate sources not pre-fetched — src-tauri/Cargo.lock is out of"
    echo "nox: date, so fetching it would have rewritten a tracked file."
    echo "nox: \`cargo test\` still works; it will update the lockfile itself."
  fi
  # cargo test --locked --manifest-path src-tauri/Cargo.toml --no-run
fi

echo "nox: ready — npm test, npm run check, npm run build, npm run test:stories and cargo test all run here"
