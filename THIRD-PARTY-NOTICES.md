# Third-party notices

Nox is MIT-licensed (see `LICENSE`). The application it builds into carries
the work of the projects below, each under its own licence, and each licence
asks for at least this: that the copyright and permission notice travel with
the code. This file is that notice for a Nox bundle. The full text of every
licence is in the package itself, under `node_modules/<package>/` for the
renderer and in the crate's registry source for the Rust side.

Direct dependencies only, on both sides. The transitive graphs were surveyed
when this file was written (2026-09-02): the 54 renderer packages are MIT,
Apache-2.0-or-MIT and one 0BSD; the 520 crates are permissive throughout
(MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0, Unlicense, CC0-1.0,
MPL-2.0 for five crates, CDLA-Permissive-2.0 for one), and the two crates
that offer LGPL-2.1-or-later offer MIT beside it. `npm ls --omit=dev --all`
and `cargo metadata` from `src-tauri/` list the whole graph with the
versions the lockfiles pin. Development tooling (Vite, Vitest, Storybook,
ESLint, TypeScript and the rest) is not shipped and is not listed.

Regenerate this file when a dependency is added or removed: the versions are
the ones `package.json` and `Cargo.lock` resolved to when it was last
written, and `tests/ship-readiness.test.ts` holds every direct dependency
to a row here.

## Renderer (npm, `package.json` `dependencies`)

| Package | Version | Licence | Upstream |
|---|---|---|---|
| @codemirror/autocomplete | 6.20.3 | MIT | <https://code.haverbeke.berlin/codemirror/autocomplete> |
| @codemirror/commands | 6.10.4 | MIT | <https://code.haverbeke.berlin/codemirror/commands> |
| @codemirror/lang-cpp | 6.0.3 | MIT | <https://github.com/codemirror/lang-cpp> |
| @codemirror/lang-css | 6.3.1 | MIT | <https://github.com/codemirror/lang-css> |
| @codemirror/lang-go | 6.0.1 | MIT | <https://github.com/codemirror/lang-go> |
| @codemirror/lang-html | 6.4.12 | MIT | <https://code.haverbeke.berlin/codemirror/lang-html> |
| @codemirror/lang-java | 6.0.2 | MIT | <https://github.com/codemirror/lang-java> |
| @codemirror/lang-javascript | 6.2.5 | MIT | <https://github.com/codemirror/lang-javascript> |
| @codemirror/lang-json | 6.0.2 | MIT | <https://github.com/codemirror/lang-json> |
| @codemirror/lang-markdown | 6.5.2 | MIT | <https://code.haverbeke.berlin/codemirror/lang-markdown> |
| @codemirror/lang-php | 6.0.2 | MIT | <https://github.com/codemirror/lang-php> |
| @codemirror/lang-python | 6.2.1 | MIT | <https://github.com/codemirror/lang-python> |
| @codemirror/lang-rust | 6.0.2 | MIT | <https://github.com/codemirror/lang-rust> |
| @codemirror/lang-sql | 6.10.0 | MIT | <https://github.com/codemirror/lang-sql> |
| @codemirror/lang-xml | 6.1.0 | MIT | <https://github.com/codemirror/lang-xml> |
| @codemirror/lang-yaml | 6.1.3 | MIT | <https://github.com/codemirror/lang-yaml> |
| @codemirror/language | 6.12.4 | MIT | <https://code.haverbeke.berlin/codemirror/language> |
| @codemirror/legacy-modes | 6.5.3 | MIT | <https://code.haverbeke.berlin/codemirror/legacy-modes> |
| @codemirror/lint | 6.9.7 | MIT | <https://code.haverbeke.berlin/codemirror/lint> |
| @codemirror/search | 6.7.1 | MIT | <https://code.haverbeke.berlin/codemirror/search> |
| @codemirror/state | 6.7.1 | MIT | <https://code.haverbeke.berlin/codemirror/state> |
| @codemirror/view | 6.43.8 | MIT | <https://code.haverbeke.berlin/codemirror/view> |
| @lezer/highlight | 1.2.3 | MIT | <https://github.com/lezer-parser/highlight> |
| @tauri-apps/api | 2.11.1 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| @tauri-apps/plugin-dialog | 2.7.2 | MIT OR Apache-2.0 | <https://github.com/tauri-apps/plugins-workspace> |
| @tauri-apps/plugin-process | 2.3.1 | MIT OR Apache-2.0 | <https://github.com/tauri-apps/plugins-workspace> |
| @tauri-apps/plugin-updater | 2.10.1 | MIT OR Apache-2.0 | <https://github.com/tauri-apps/plugins-workspace> |
| @xterm/addon-fit | 0.11.0 | MIT | <https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit> |
| @xterm/xterm | 6.0.0 | MIT | <https://github.com/xtermjs/xterm.js> |

## Host (Rust, `src-tauri/Cargo.toml` `[dependencies]` and `[build-dependencies]`)

The `wdio` feature's optional WebDriver crate is compiled only for the
end-to-end harness and never into a release, so it is not listed.

| Package | Version | Licence | Upstream |
|---|---|---|---|
| encoding_rs | 0.8.35 | (Apache-2.0 OR MIT) AND BSD-3-Clause | <https://github.com/hsivonen/encoding_rs> |
| futures-util | 0.3.34 | MIT OR Apache-2.0 | <https://github.com/rust-lang/futures-rs> |
| ignore | 0.4.33 | Unlicense OR MIT | <https://github.com/BurntSushi/ripgrep/tree/master/crates/ignore> |
| notify | 8.2.0 | CC0-1.0 | <https://github.com/notify-rs/notify> |
| portable-pty | 0.9.0 | MIT | <https://github.com/wezterm/wezterm> |
| regex | 1.13.1 | MIT OR Apache-2.0 | <https://github.com/rust-lang/regex> |
| reqwest | 0.12.28 | MIT OR Apache-2.0 | <https://github.com/seanmonstar/reqwest> |
| serde | 1.0.229 | MIT OR Apache-2.0 | <https://github.com/serde-rs/serde> |
| serde_json | 1.0.151 | MIT OR Apache-2.0 | <https://github.com/serde-rs/json> |
| tauri | 2.11.5 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| tauri-build | 2.6.3 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| tauri-plugin-dialog | 2.7.2 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| tauri-plugin-process | 2.3.1 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| tauri-plugin-single-instance | 2.4.4 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| tauri-plugin-updater | 2.10.1 | Apache-2.0 OR MIT | <https://github.com/tauri-apps/plugins-workspace> |
| tokio | 1.53.1 | MIT | <https://github.com/tokio-rs/tokio> |
| trash | 5.2.6 | MIT | <https://github.com/ArturKovacs/trash> |

## Licence texts

- **MIT**: <https://opensource.org/license/mit>
- **Apache-2.0**: <https://www.apache.org/licenses/LICENSE-2.0>
- **BSD-3-Clause**: <https://opensource.org/license/bsd-3-clause>
- **Unlicense**: <https://unlicense.org/>
- **CC0-1.0**: <https://creativecommons.org/publicdomain/zero/1.0/>

Where a package offers a choice (`MIT OR Apache-2.0`), Nox takes it under
MIT. `encoding_rs` is `(Apache-2.0 OR MIT) AND BSD-3-Clause`: the
BSD-3-Clause part covers the WHATWG-derived tables and applies alongside.
