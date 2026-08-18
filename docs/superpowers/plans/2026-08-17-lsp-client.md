# LSP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A configured language server runs under Nox and its diagnostics appear as squiggles, gutter marks and a problems panel.

**Architecture:** Rust owns process supervision and `Content-Length` framing only, because that length is counted in bytes and the renderer only ever sees decoded strings. Everything above it — JSON-RPC, lifecycle, document sync, diagnostics — is TypeScript taking an injected process factory, so the whole protocol is testable with no child process and no cargo.

**Tech Stack:** TypeScript, Rust (Tauri 2), CodeMirror 6 (`@codemirror/lint`), Svelte 5, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-lsp-client-design.md`

## Global Constraints

- **Line endings are CRLF.** Multi-line `sed`/`perl`/`python` replacements against `\n` patterns silently no-op. Verify every edit landed.
- **`ui/` may never import `@tauri-apps/*`.** UI talks to services; services talk to `Platform`.
- **Baseline to beat:** `npm test` 858 tests / 37 files, `npm run check` 385 files 0 errors. Run both before every commit and report the real output.
- **Commit author** is already configured per-repo: `francescoa27122 <42079355+frncescoa27122@users.noreply.github.com>` (note the missing `a` — it matches the repo's 182-commit convention).
- **Do not push, open a PR, or merge.** Commit locally and stop.
- **No cargo on this machine.** Rust changes are compiled by CI only. Write Rust so its logic is unit-testable and its untestable part is thin.
- **Positions are UTF-16 code units**; `general.positionEncodings: ['utf-16']` is declared in `initialize`.
- **Numbers fixed by the spec:** `didChange` debounce 300ms; request timeout 10s; restart backoff 1s/2s/4s capped at 3 attempts in 60s.

---

### Task 1: `file://` URI conversion

**Files:**
- Create: `src/core/uri.ts`
- Test: `tests/uri.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `pathToUri(path: string): string`, `uriToPath(uri: string): string`.

- [x] **Step 1: Write the failing test**

`tests/uri.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pathToUri, uriToPath } from '../src/core/uri';

describe('pathToUri', () => {
  it('encodes a POSIX path', () => {
    expect(pathToUri('/home/a/main.ts')).toBe('file:///home/a/main.ts');
  });

  it('lower-cases and encodes a Windows drive letter', () => {
    // VS Code's form. Servers vary on whether they accept a bare colon, and
    // every server accepts the encoded one.
    expect(pathToUri('C:\\src\\main.ts')).toBe('file:///c%3A/src/main.ts');
  });

  it('encodes spaces and other reserved characters', () => {
    expect(pathToUri('/home/a b/c#d.ts')).toBe('file:///home/a%20b/c%23d.ts');
  });

  it('keeps a UNC host as the authority', () => {
    expect(pathToUri('\\\\server\\share\\a.ts')).toBe('file://server/share/a.ts');
  });
});

describe('uriToPath', () => {
  it('round-trips every form', () => {
    for (const path of ['/home/a/main.ts', 'C:\\src\\main.ts', '/home/a b/c#d.ts', '\\\\server\\share\\a.ts']) {
      expect(uriToPath(pathToUri(path))).toBe(path.replace(/\\/g, '/').replace(/^\/\//, '//'));
    }
  });

  it('rejects a non-file URI rather than guessing', () => {
    expect(() => uriToPath('http://example.com/a.ts')).toThrow();
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/uri.test.ts`
Expected: FAIL — cannot resolve `../src/core/uri`.

- [x] **Step 3: Implement `src/core/uri.ts`**

```ts
/**
 * Paths to `file://` URIs and back.
 *
 * Its own module, with its own tests, because this is a silent-corruption
 * source rather than a formatting detail: a server told the wrong URI reports
 * diagnostics against a document nobody is looking at, and says nothing about
 * the one they are. Windows is a first-class platform here, so a drive letter
 * and a UNC share are first-class cases, not afterthoughts.
 */

const DRIVE = /^([A-Za-z]):/;

/** Encode one path segment, leaving nothing a server has to guess about. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

export function pathToUri(path: string): string {
  const slashed = path.replace(/\\/g, '/');

  // UNC: `//server/share/a.ts` -> the host becomes the URI authority.
  if (slashed.startsWith('//')) {
    const [, , host = '', ...rest] = slashed.split('/');
    const tail = rest.map(encodeSegment).join('/');
    return `file://${host}${tail ? `/${tail}` : ''}`;
  }

  const drive = DRIVE.exec(slashed);
  if (drive) {
    // Lower-cased and percent-encoded, matching what VS Code sends. A bare
    // colon is legal in a path and ambiguous in a URI.
    const rest = slashed.slice(drive[0].length).replace(/^\//, '');
    const tail = rest.split('/').map(encodeSegment).join('/');
    return `file:///${drive[1]!.toLowerCase()}%3A${tail ? `/${tail}` : '/'}`;
  }

  const tail = slashed.replace(/^\//, '').split('/').map(encodeSegment).join('/');
  return `file:///${tail}`;
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) {
    throw new Error(`not a file URI: ${uri}`);
  }

  const rest = uri.slice('file://'.length);

  // An authority means UNC; `file:///...` has an empty one.
  if (!rest.startsWith('/')) {
    const slash = rest.indexOf('/');
    const host = slash === -1 ? rest : rest.slice(0, slash);
    const tail = slash === -1 ? '' : rest.slice(slash);
    return `//${host}${decodeURIComponent(tail)}`;
  }

  const decoded = decodeURIComponent(rest);
  const drive = /^\/([A-Za-z]):/.exec(decoded);
  if (drive) {
    return `${drive[1]!.toUpperCase()}:${decoded.slice(drive[0].length)}`;
  }
  return decoded;
}
```

- [x] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/uri.test.ts`
Expected: PASS. If the round-trip test fails on the Windows case, the expected value in the test is the authority — read what it produced and fix the implementation, not the assertion.

- [x] **Step 5: Type check and commit**

```bash
npm run check
git add src/core/uri.ts tests/uri.test.ts
git commit -m "Convert paths to file URIs, drive letters and UNC included"
```

---

### Task 2: LSP position ↔ offset conversion

**Files:**
- Create: `src/core/lsp-position.ts`
- Test: `tests/lsp-position.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface LspPosition { line: number; character: number }`, `offsetAt(text: string, position: LspPosition): number`, `positionAt(text: string, offset: number): LspPosition`.

- [x] **Step 1: Write the failing test**

`tests/lsp-position.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { offsetAt, positionAt } from '../src/core/lsp-position';

describe('offsetAt', () => {
  it('finds a position on the first line', () => {
    expect(offsetAt('const a = 1;\nconst b = 2;\n', { line: 0, character: 6 })).toBe(6);
  });

  it('finds a position on a later line', () => {
    expect(offsetAt('const a = 1;\nconst b = 2;\n', { line: 1, character: 6 })).toBe(19);
  });

  it('counts UTF-16 code units, so an emoji is two characters', () => {
    // '🙂' is one code point and two UTF-16 code units, which is what LSP
    // counts and what a JavaScript string index counts.
    expect(offsetAt('a🙂b', { line: 0, character: 3 })).toBe(3);
  });

  it('treats a CRLF line ending as a terminator, not content', () => {
    // Every file in this repository is CRLF. A '\r' counted as a character
    // shifts every column on the line by one.
    const text = 'const a = 1;\r\nconst b = 2;\r\n';
    expect(offsetAt(text, { line: 1, character: 0 })).toBe(14);
    // A column past the visible end clamps to before the '\r'.
    expect(offsetAt(text, { line: 0, character: 99 })).toBe(12);
  });

  it('clamps a line past the end of the document', () => {
    expect(offsetAt('a\nb', { line: 99, character: 0 })).toBe(3);
  });
});

describe('positionAt', () => {
  it('is the inverse of offsetAt', () => {
    const text = 'alpha\r\nbeta\r\ngamma';
    for (const offset of [0, 3, 7, 12, 17]) {
      expect(offsetAt(text, positionAt(text, offset))).toBe(offset);
    }
  });

  it('clamps an offset past the end', () => {
    expect(positionAt('a\nb', 99)).toEqual({ line: 1, character: 1 });
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/lsp-position.test.ts`
Expected: FAIL — cannot resolve `../src/core/lsp-position`.

- [x] **Step 3: Implement `src/core/lsp-position.ts`**

```ts
/**
 * LSP positions to string offsets and back.
 *
 * LSP counts a character in UTF-16 code units, and so does a JavaScript string
 * index, so the mapping is mechanical — which is exactly why it is worth
 * writing down once and testing, rather than being open-coded at each call
 * site where an off-by-one is invisible.
 *
 * Both directions clamp. A server computes against a copy of the document that
 * may be a revision behind, and a range past the end of the current text is a
 * crash in CodeMirror rather than a cosmetic error.
 */

export interface LspPosition {
  /** Zero-based. */
  line: number;
  /** Zero-based, in UTF-16 code units. */
  character: number;
}

/** Offset of the first character of each line. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** Length of the line at `start`, excluding its terminator. */
function lineLength(text: string, start: number): number {
  let end = text.indexOf('\n', start);
  if (end === -1) end = text.length;
  // A '\r' before the '\n' terminates the line; it is not a character on it.
  if (end > start && text[end - 1] === '\r') end--;
  return end - start;
}

export function offsetAt(text: string, position: LspPosition): number {
  const starts = lineStarts(text);
  if (position.line >= starts.length) return text.length;

  const start = starts[Math.max(0, position.line)]!;
  const length = lineLength(text, start);
  const character = Math.min(Math.max(0, position.character), length);
  return start + character;
}

export function positionAt(text: string, offset: number): LspPosition {
  const clamped = Math.min(Math.max(0, offset), text.length);
  const starts = lineStarts(text);

  // The last line whose start is at or before the offset.
  let line = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i]! <= clamped) line = i;
    else break;
  }

  return { line, character: clamped - starts[line]! };
}
```

- [x] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/lsp-position.test.ts`
Expected: PASS.

- [x] **Step 5: Type check and commit**

```bash
npm run check
git add src/core/lsp-position.ts tests/lsp-position.test.ts
git commit -m "Map LSP positions to offsets, clamping both directions"
```

---

### Task 3: The Platform boundary

**Files:**
- Modify: `src/platform/types.ts` (add to `PlatformCapabilities`, add two interfaces, add two `Platform` methods)
- Modify: `src/platform/memory.ts`, `src/platform/web.ts`, `src/platform/demo-workspace.ts` if it implements `Platform`
- Test: `tests/lsp-platform.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LanguageServerSpec`, `LanguageServerProcess`, `capabilities.languageServers`, `Platform.startLanguageServer(spec)`, `Platform.stopAllLanguageServers()`.

- [x] **Step 1: Write the failing test**

`tests/lsp-platform.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';

describe('language servers on a platform that has none', () => {
  it('says so in its capabilities', () => {
    expect(new MemoryPlatform().capabilities.languageServers).toBe(false);
  });

  it('refuses loudly rather than returning a server that never speaks', async () => {
    // The same argument as spawnAgent and openTerminal: a silent failure here
    // is indistinguishable from a slow server, and stays that way forever.
    await expect(new MemoryPlatform().startLanguageServer({ command: 'x' })).rejects.toThrow();
  });

  it('has nothing to stop', async () => {
    await expect(new MemoryPlatform().stopAllLanguageServers()).resolves.toBeUndefined();
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/lsp-platform.test.ts`
Expected: FAIL — `languageServers` does not exist on the capabilities type, `startLanguageServer` is not a function.

- [x] **Step 3: Add the boundary**

In `src/platform/types.ts`, add to `PlatformCapabilities` after `localModels`:

```ts
  /** True when `startLanguageServer` can start a language server. */
  languageServers: boolean;
```

Add the interfaces next to `AgentProcess`:

```ts
/** What to start, for `Platform.startLanguageServer`. */
export interface LanguageServerSpec {
  command: string;
  args?: string[];
  /** Defaults to the workspace root. */
  cwd?: string;
}

/**
 * A running language server, as complete JSON-RPC messages.
 *
 * Deliberately no knowledge of the protocol: this moves messages, and
 * `services/lsp/` decides what they mean — the same split as `AgentProcess`,
 * for the same reason.
 *
 * The framing is *not* the renderer's business, and cannot be: `Content-Length`
 * counts bytes, and everything on this side of the boundary is a decoded
 * string whose length is in UTF-16 code units. The two disagree on the first
 * non-ASCII character.
 */
export interface LanguageServerProcess {
  /** Write one message. The framing is added for you. */
  send(message: string): Promise<void>;
  /**
   * Each complete message the server writes.
   *
   * **Anything produced before a handler is attached must be buffered and
   * delivered when one is.** A server can emit `window/logMessage` and its
   * `initialize` response in the tick it starts, and dropping those loses the
   * handshake the whole session is predicated on.
   */
  onMessage(handler: (message: string) => void): void;
  /** Each stderr line — diagnostics about the server, never protocol. Buffered too. */
  onStderr(handler: (line: string) => void): void;
  /** Called once, when the process ends. Fires immediately if it already has. */
  onExit(handler: (code: number | null) => void): void;
  /** Stop it and release the listeners. Safe to call twice. */
  kill(): Promise<void>;
}
```

Add to `interface Platform`, after `killAllAgents`:

```ts
  /**
   * Start a language server.
   *
   * Throws `PlatformError('unsupported')` where there are no processes to
   * start. Check `capabilities.languageServers` first.
   */
  startLanguageServer(spec: LanguageServerSpec): Promise<LanguageServerProcess>;

  /** Stop every running language server. Called when the window is going away. */
  stopAllLanguageServers(): Promise<void>;
```

In `src/platform/memory.ts`, beside `spawnAgent`:

```ts
  /**
   * No processes in memory. Refusing loudly for the same reason as
   * `spawnAgent`: a server that silently produced nothing is indistinguishable
   * from one that is merely slow to start.
   */
  async startLanguageServer(): Promise<never> {
    throw new PlatformError('this build cannot start language servers', 'unsupported');
  }

  async stopAllLanguageServers(): Promise<void> {
    /* No servers in memory; nothing to stop. */
  }
```

Set `languageServers: false` in every capabilities literal in `memory.ts`, `web.ts` and `demo-workspace.ts`, and add the same two refusing methods to `web.ts`.

- [x] **Step 4: Run the test and the type check**

Run: `npx vitest run tests/lsp-platform.test.ts && npm run check`
Expected: test PASS; `npm run check` reports 0 errors. `svelte-check` will name every capabilities literal that still lacks `languageServers` — fix each rather than widening the type.

- [x] **Step 5: Commit**

```bash
npm test
git add src/platform tests/lsp-platform.test.ts
git commit -m "Put language servers on the platform boundary, refusing where there are none"
```

---

### Task 4: `MessageStream` — LSP framing in Rust

**Files:**
- Create: `src-tauri/src/lsp.rs` (this task adds only `MessageStream` and its tests)
- Modify: `src-tauri/src/lib.rs` (add `mod lsp;`)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub struct MessageStream` with `pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String>`.

- [x] **Step 1: Write the module with its tests, tests first in the file**

Create `src-tauri/src/lsp.rs`:

```rust
//! Language server supervision.
//!
//! `agent.rs` moves lines; this moves length-prefixed messages. The difference
//! is not cosmetic. An LSP body carries no trailing newline, so a line-buffered
//! reader holds every message until the *next* one arrives — the handshake
//! appears to hang and all traffic runs one message late.
//!
//! The framing lives here rather than in the renderer because `Content-Length`
//! counts **bytes**, and everything across the IPC boundary is a decoded string
//! whose length is in UTF-16 code units. A JSON body of `{"label":"café"}` is
//! longer in bytes than in characters, so framing computed on the far side
//! desynchronises on the first accented hover string and never recovers.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub type Result<T> = std::result::Result<T, String>;

/// Reassembles `Content-Length`-framed messages across read boundaries.
///
/// Separate from the reading so it can be tested without a server, exactly as
/// `pty.rs` separates `Utf8Stream`: a read boundary inside a header is near
/// impossible to provoke on purpose against a real server, and trivial to
/// write down here.
#[derive(Default)]
pub struct MessageStream {
    buffer: Vec<u8>,
}

impl MessageStream {
    /// Take some bytes, return every complete message they finished.
    ///
    /// Decoding happens only once a whole body is in hand, which is the point:
    /// the length is a byte count, so it cannot be applied to text.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        self.buffer.extend_from_slice(bytes);
        let mut out = Vec::new();

        loop {
            let Some(header_end) = find(&self.buffer, b"\r\n\r\n") else {
                return Ok(out);
            };

            let header = std::str::from_utf8(&self.buffer[..header_end])
                .map_err(|_| "lsp: header was not utf-8".to_string())?;

            let mut length: Option<usize> = None;
            for line in header.split("\r\n") {
                let Some((name, value)) = line.split_once(':') else {
                    continue;
                };
                if name.eq_ignore_ascii_case("content-length") {
                    length = Some(
                        value
                            .trim()
                            .parse()
                            .map_err(|_| format!("lsp: bad Content-Length {value:?}"))?,
                    );
                }
            }

            // A stream that has lost framing cannot be recovered by guessing,
            // so this is an error rather than a resync.
            let length = length.ok_or_else(|| "lsp: message with no Content-Length".to_string())?;

            let body_start = header_end + 4;
            if self.buffer.len() < body_start + length {
                return Ok(out); // Body still arriving.
            }

            let body = &self.buffer[body_start..body_start + length];
            let message = String::from_utf8(body.to_vec())
                .map_err(|_| "lsp: body was not utf-8".to_string())?;
            out.push(message);

            self.buffer.drain(..body_start + length);
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Frame one message for writing.
pub fn frame(message: &str) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", message.len()).into_bytes();
    out.extend_from_slice(message.as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn framed(body: &str) -> Vec<u8> {
        frame(body)
    }

    #[test]
    fn reads_one_message_in_one_push() {
        let mut stream = MessageStream::default();
        assert_eq!(stream.push(&framed("{\"a\":1}")).unwrap(), vec!["{\"a\":1}"]);
    }

    #[test]
    fn holds_a_message_split_inside_its_header() {
        let mut stream = MessageStream::default();
        let bytes = framed("{\"a\":1}");
        assert!(stream.push(&bytes[..8]).unwrap().is_empty());
        assert_eq!(stream.push(&bytes[8..]).unwrap(), vec!["{\"a\":1}"]);
    }

    #[test]
    fn holds_a_message_split_inside_its_body() {
        let mut stream = MessageStream::default();
        let bytes = framed("{\"a\":1}");
        let cut = bytes.len() - 3;
        assert!(stream.push(&bytes[..cut]).unwrap().is_empty());
        assert_eq!(stream.push(&bytes[cut..]).unwrap(), vec!["{\"a\":1}"]);
    }

    #[test]
    fn reads_two_messages_from_one_push() {
        let mut stream = MessageStream::default();
        let mut bytes = framed("{\"a\":1}");
        bytes.extend_from_slice(&framed("{\"b\":2}"));
        assert_eq!(stream.push(&bytes).unwrap(), vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn a_blank_line_inside_a_string_is_body_not_a_header_break() {
        // The length is authoritative; scanning for the separator alone would
        // cut this message in half.
        let body = "{\"a\":\"x\\r\\n\\r\\ny\"}";
        let mut stream = MessageStream::default();
        assert_eq!(stream.push(&framed(body)).unwrap(), vec![body]);
    }

    #[test]
    fn counts_bytes_rather_than_characters() {
        // The case the whole design turns on: this body is longer in bytes
        // than in characters, so a length applied to text would truncate it.
        let body = "{\"label\":\"café — naïve\"}";
        assert!(frame(body).len() > body.chars().count());

        let mut stream = MessageStream::default();
        assert_eq!(stream.push(&framed(body)).unwrap(), vec![body]);
    }

    #[test]
    fn errors_on_a_header_with_no_length_rather_than_hanging() {
        let mut stream = MessageStream::default();
        assert!(stream.push(b"Content-Type: x\r\n\r\n{}").is_err());
    }
}
```

Add `mod lsp;` to `src-tauri/src/lib.rs` beside the other module declarations.

- [x] **Step 2: Verify what can be verified here**

There is no cargo on this machine, so `cargo test` cannot run. Verify by inspection and by CI:

```bash
grep -c "fn " src-tauri/src/lsp.rs
git add src-tauri/src/lsp.rs src-tauri/src/lib.rs
git commit -m "Frame LSP messages by byte length, and test the boundaries"
```

State plainly in the commit and in any report that these tests are **unrun locally** and that CI is the first thing to execute them.

- [x] **Step 3: Note the follow-up**

The unused-import warnings for `HashMap`, `Command`, etc. are expected until Task 5 adds the supervision that uses them. If CI's `cargo build` treats warnings as errors, move those imports into Task 5's edit instead.

---

### Task 5: Supervision, the Tauri commands, and the real client

**Files:**
- Modify: `src-tauri/src/lsp.rs` (add `LspState`, the four commands, the reader thread)
- Modify: `src-tauri/src/lib.rs` (`.manage(lsp::LspState::default())` and four `generate_handler!` entries)
- Modify: `src/platform/tauri.ts` (implement `startLanguageServer` / `stopAllLanguageServers`)

**Interfaces:**
- Consumes: `MessageStream`, `frame` from Task 4; the `LanguageServerProcess` interface from Task 3.
- Produces: commands `nox_lsp_start`, `nox_lsp_send`, `nox_lsp_stop`, `nox_lsp_stop_all`; events `nox://lsp-message`, `nox://lsp-stderr`, `nox://lsp-exit`.

- [x] **Step 1: Add supervision to `lsp.rs`**

Model it directly on `agent.rs`: a `LspState(Mutex<HashMap<String, Running>>)`, a `Running { child, stdin }`, a reader thread per server, and a stderr thread. The reader thread differs from `agent.rs` in exactly one way — it reads into a `[u8; 8192]` and feeds `MessageStream` rather than iterating lines:

```rust
#[derive(Default)]
pub struct LspState(Mutex<HashMap<String, Running>>);

struct Running {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
}

#[derive(Clone, Serialize)]
struct MessagePayload {
    id: String,
    message: String,
}

#[derive(Clone, Serialize)]
struct LinePayload {
    id: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: String,
    code: Option<i32>,
}
```

In the reader thread:

```rust
let mut stream = MessageStream::default();
let mut chunk = [0u8; 8192];
loop {
    match stdout.read(&mut chunk) {
        Ok(0) => break,
        Ok(n) => match stream.push(&chunk[..n]) {
            Ok(messages) => {
                for message in messages {
                    let _ = app.emit(
                        "nox://lsp-message",
                        MessagePayload { id: id.clone(), message },
                    );
                }
            }
            Err(error) => {
                // Framing is lost; say so on the channel built for saying so,
                // and stop rather than emit garbage.
                let _ = app.emit("nox://lsp-stderr", LinePayload { id: id.clone(), line: error });
                break;
            }
        },
        Err(_) => break,
    }
}
```

`nox_lsp_send` writes `frame(&message)` to the stored stdin and flushes. `nox_lsp_stop` removes the entry and kills. `nox_lsp_stop_all` drains the map.

- [x] **Step 2: Register in `lib.rs`**

Add `.manage(lsp::LspState::default())` beside the other `.manage` calls and these four lines to `generate_handler!`, after the `pty::` block:

```rust
            lsp::nox_lsp_start,
            lsp::nox_lsp_send,
            lsp::nox_lsp_stop,
            lsp::nox_lsp_stop_all,
```

- [x] **Step 3: Implement the renderer half in `src/platform/tauri.ts`**

Copy the shape of `spawnAgent` exactly — it already solves the buffering requirement. Three `listen` calls (`nox://lsp-message`, `nox://lsp-stderr`, `nox://lsp-exit`) filtered by id, buffers for anything arriving before a handler attaches, `invoke('nox_lsp_start', ...)`, and an `unlisten` on exit and on `kill`. Set `languageServers: true` in the Tauri capabilities literal.

- [x] **Step 4: Verify**

```bash
npm run check
npm test
```

Expected: 0 errors, all tests pass. The Rust cannot be compiled here; say so.

- [x] **Step 5: Commit**

```bash
git add src-tauri/src src/platform/tauri.ts
git commit -m "Supervise a language server, and stream its messages to the renderer"
```

---

### Task 6: JSON-RPC

**Files:**
- Create: `src/services/lsp/transport.ts`
- Test: `tests/lsp-transport.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class JsonRpcTransport` with `constructor(send: (message: string) => Promise<void>, options?: { timeoutMs?: number })`, `receive(raw: string): void`, `request<T>(method: string, params?: unknown): Promise<T>`, `notify(method: string, params?: unknown): Promise<void>`, `onNotification(method: string, handler: (params: unknown) => void): void`, `onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void`, `dispose(reason: string): void`.

- [x] **Step 1: Write the failing test**

`tests/lsp-transport.test.ts` — cover, one `it` each:

1. `request` sends `{jsonrpc:'2.0',id:1,method,params}` and resolves with `result` when the matching id comes back.
2. Two requests answered out of order resolve to their own results (id correlation, the bug a single pending slot would hide).
3. An `error` reply rejects with its message.
4. A request with no reply rejects after `timeoutMs` (construct with `timeoutMs: 5` and `await expect(...).rejects.toThrow(/timed out/)`).
5. A notification carries no id and never resolves a pending entry.
6. An incoming notification reaches the handler registered for its method.
7. An incoming **request** for an unregistered method is answered with a JSON-RPC error `-32601`, not silence.
8. `dispose('server exited')` rejects every pending request with that reason.

The fake is a `const sent: string[] = []` and `async (m) => { sent.push(m) }` — no process needed at all.

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/lsp-transport.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `transport.ts`**

Monotonic `#nextId`, `#pending = new Map<number, {resolve, reject, timer}>()`, `#notifications = new Map<string, handler[]>()`, `#requests = new Map<string, handler>()`. `receive` parses JSON once, then dispatches on shape: has `id` and `method` → incoming request; has `method` only → notification; has `id` only → reply. Unknown incoming request replies `{ error: { code: -32601, message: `unknown method: ${method}` } }`. Every `request` sets a timeout that deletes its own entry and rejects. `dispose` clears timers and rejects everything.

- [x] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/lsp-transport.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
npm run check && npm test
git add src/services/lsp/transport.ts tests/lsp-transport.test.ts
git commit -m "Correlate JSON-RPC replies, and answer what Nox cannot do"
```

---

### Task 7: Session lifecycle

**Files:**
- Create: `src/services/lsp/session.ts`
- Test: `tests/lsp-session.test.ts` (defines `FakeServer implements LanguageServerProcess`, modelled on `tests/stdio.test.ts`'s `FakeProcess`)

**Interfaces:**
- Consumes: `JsonRpcTransport` (Task 6), `LanguageServerProcess` (Task 3).
- Produces: `class LspSession` with `constructor(open: () => Promise<LanguageServerProcess>, options: { name: string; rootUri: string })`, `static spawnedBy(platform, spec, options)`, `readonly status: Signal<'starting'|'initializing'|'running'|'failed'|'stopped'>`, `readonly capabilities: Signal<ServerCapabilities|null>`, `start(): Promise<void>`, `request/notify` delegating to the transport with pre-initialize queueing, `stop(): Promise<void>`, `readonly stderr: string[]`.

- [x] **Step 1: Write `FakeServer` and the failing tests**

`FakeServer` must honour the buffering contract — a fake that does not honour the contract tests the wrong thing. Copy `tests/stdio.test.ts:25-60` and change `onLine` to `onMessage` and the parse to `JSON.parse` of a whole message.

Cases, one `it` each:

1. `start()` sends `initialize` with `general.positionEncodings: ['utf-16']` and the given `rootUri`.
2. Status is `initializing` until the reply arrives, then `running`.
3. A `notify` issued before the `initialize` reply is **queued**, and is written only after `initialized` — assert order on `server.written`.
4. The server's advertised `textDocumentSync` is stored on `capabilities`.
5. `stop()` sends `shutdown`, then `exit`, then kills — assert that order.
6. A server that exits during `initialize` leaves status `failed` and keeps its stderr tail.
7. A crash while running sets status `failed` and the last 20 stderr lines are retained.
8. A factory that rejects — which is what a missing command looks like from
   here — leaves status `failed` with the error's message, and does **not**
   enter a retry loop. Spec §9's first row.

- [x] **Step 2: Run and watch fail**

Run: `npx vitest run tests/lsp-session.test.ts` → FAIL, module not found.

- [x] **Step 3: Implement `session.ts`**

State machine `starting → initializing → running → stopped`, with `failed` reachable from any of them. Hold a `#queue: (() => void)[]` flushed after `initialized`. Keep `#stderr` as the last 20 lines, exactly as `StdioTransport` does — "when a server dies during a handshake, its last words on stderr are the only explanation anyone will get".

- [x] **Step 4: Run and watch pass**, then `npm run check && npm test`.

- [x] **Step 5: Commit**

```bash
git add src/services/lsp/session.ts tests/lsp-session.test.ts
git commit -m "Run one server's lifecycle, queueing what it cannot yet hear"
```

---

### Task 8: A real child process, speaking real framing

**Files:**
- Create: `tests/support/fake-lsp-server.mjs`
- Test: append a `describe('a real child process')` block to `tests/lsp-session.test.ts`

**Interfaces:**
- Consumes: `LspSession` (Task 7).
- Produces: nothing production.

- [x] **Step 1: Write the fake server script**

`tests/support/fake-lsp-server.mjs` reads `Content-Length`-framed messages from stdin and replies. It must include a non-ASCII string in one reply, so the byte-vs-character contract is exercised over real pipes:

```js
// A minimal LSP server, for tests. Speaks real Content-Length framing.
let buffer = Buffer.alloc(0);

function write(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const split = buffer.indexOf('\r\n\r\n');
    if (split === -1) return;
    const header = buffer.subarray(0, split).toString('ascii');
    const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
    if (buffer.length < split + 4 + length) return;
    const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString('utf8'));
    buffer = buffer.subarray(split + 4 + length);

    if (message.method === 'initialize') {
      // The accented label is the point: its byte length exceeds its
      // character count, so a client framing over decoded text truncates it.
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: { capabilities: { textDocumentSync: 1 }, serverInfo: { name: 'café — naïve' } },
      });
    }
    if (message.method === 'exit') process.exit(0);
  }
});
```

- [x] **Step 2: Write the failing test**

Adapt a Node child to `LanguageServerProcess` the way `tests/stdio.test.ts:389` adapts one to `AgentProcess` — but with a `Buffer`-based reader instead of `readline`, since messages are not lines. Assert that `session.start()` reaches `running` and that `capabilities` carries `serverInfo.name === 'café — naïve'` intact.

- [x] **Step 3: Run it**

Run: `npx vitest run tests/lsp-session.test.ts`
Expected: PASS. A mangled `serverInfo.name` means the adapter is framing over characters — fix the adapter, and note that the same bug in `lsp.rs` is what Task 4's `counts_bytes_rather_than_characters` test guards.

- [x] **Step 4: Commit**

```bash
npm test
git add tests/support/fake-lsp-server.mjs tests/lsp-session.test.ts
git commit -m "Prove the framing over real pipes, accents included"
```

---

### Task 9: Document synchronisation

**Files:**
- Create: `src/services/lsp/documents.ts`
- Test: `tests/lsp-documents.test.ts`

**Interfaces:**
- Consumes: `LspSession` (Task 7), `pathToUri` (Task 1), `WorkspaceService.buffers` / `textOf` / `revisionOf`.
- Produces: `class DocumentSync` with `constructor(workspace: WorkspaceService, options?: { debounceMs?: number })`, `attach(session: LspSession, languages: readonly string[]): void`, `openUris(): string[]`, `dispose(): void`.

- [x] **Step 1: Write the failing test**

Cases:

1. Opening a buffer whose `languageId` is in the session's list sends `textDocument/didOpen` with `uri`, `languageId`, `version` equal to `workspace.revisionOf(id)`, and the full text.
2. A buffer whose language is *not* in the list sends nothing.
3. An edit sends one `textDocument/didChange` after the debounce, not one per keystroke — advance with `vi.useFakeTimers()`.
4. The `didChange` version equals the buffer's new revision.
5. Closing sends `textDocument/didClose`.
6. `didChange` carries the whole text (`contentChanges: [{ text }]`), because sync is full.

- [x] **Step 2–4: Fail, implement, pass.**

Subscribe to `workspace.buffers`; diff the previous snapshot list against the new one by `id` to derive opened / changed (revision moved) / closed. Send `didOpen` immediately, debounce `didChange` by 300ms per URI, send `didClose` immediately.

- [x] **Step 5: Commit**

```bash
npm run check && npm test
git add src/services/lsp/documents.ts tests/lsp-documents.test.ts
git commit -m "Sync whole documents, versioned by the buffer revision"
```

---

### Task 10: The server registry

**Files:**
- Create: `src/services/lsp/registry.ts`
- Test: `tests/lsp-registry.test.ts`

**Interfaces:**
- Consumes: `Platform.readConfigFile` / `writeConfigFile`.
- Produces: `interface ServerConfig { languages: string[]; command: string; args?: string[]; initializationOptions?: unknown }`, `parseServers(text: string): { servers: ServerConfig[]; error: string | null }`, `EXAMPLE_SERVERS_JSON: string`, `class ServerRegistry` with `load(): Promise<void>`, `readonly servers: Signal<ServerConfig[]>`, `forLanguage(languageId: string): ServerConfig | null`, `ensureFile(): Promise<string>`.

- [x] **Step 1: Write the failing test**

Cases:

1. A valid file parses to its entries.
2. Malformed JSON returns `error` and an **empty** server list, so a caller can keep the previous good configuration.
3. An entry missing `command` is rejected with a message naming it, rather than spawning something undefined.
4. `forLanguage('typescript')` finds the entry that lists it and returns `null` for one nothing claims.
5. `EXAMPLE_SERVERS_JSON` itself parses, and yields a `typescript-language-server` entry — the file Nox writes for the user must be one that works.

- [x] **Step 2–4: Fail, implement, pass.**

`EXAMPLE_SERVERS_JSON` is the block from the spec's §8. Since `JSON.parse` rejects comments, ship it as valid JSON with a leading `"//"`-style note key or none at all — test 5 is what decides it; keep the file parseable.

- [x] **Step 5: Commit**

```bash
npm run check && npm test
git add src/services/lsp/registry.ts tests/lsp-registry.test.ts
git commit -m "Read servers.json, and refuse to spawn what it does not describe"
```

---

### Task 11: `LspService`

**Files:**
- Create: `src/services/lsp/index.ts`
- Test: `tests/lsp-service.test.ts`

**Interfaces:**
- Consumes: Tasks 6, 7, 9, 10, plus `positionAt`/`offsetAt` (Task 2) and `uriToPath` (Task 1).
- Produces: `interface LspDiagnostic { uri: string; range: { start: LspPosition; end: LspPosition }; severity: 1|2|3|4; message: string; source?: string }`, `class LspService` with `readonly diagnostics: Signal<ReadonlyMap<string, LspDiagnostic[]>>`, `readonly sessions: Signal<SessionStatus[]>`, `start(): Promise<void>`, `stop(): Promise<void>`, `diagnosticsFor(uri: string): LspDiagnostic[]`.

- [x] **Step 1: Write the failing test**

Cases:

1. `textDocument/publishDiagnostics` populates the map under its URI.
2. A batch whose `version` is **older** than the buffer's current revision is dropped.
3. A batch with **no** `version` is applied (the field is optional; §7 of the spec).
4. Diagnostics arrive for a URI that is not open, and are still stored — the panel shows project-wide errors.
5. Closing a document clears its entry.
6. A session that fails clears every URI it published, so no squiggle outlives its server.
7. A crash restarts with backoff and stops after 3 attempts inside 60s, leaving status `failed` (`vi.useFakeTimers()`).

- [x] **Step 2–4: Fail, implement, pass.**

- [x] **Step 5: Commit**

```bash
npm run check && npm test
git add src/services/lsp/index.ts tests/lsp-service.test.ts
git commit -m "Hold diagnostics by URI, and drop the ones the buffer outran"
```

---

### Task 12: The CodeMirror bridge

**Files:**
- Modify: `package.json` (`@codemirror/lint` becomes a direct dependency)
- Create: `src/editor/lsp.ts`
- Modify: `src/editor/extensions.ts`
- Test: `tests/lsp-editor.test.ts`

**Interfaces:**
- Consumes: `LspDiagnostic` (Task 11), `offsetAt` (Task 2).
- Produces: `toCodeMirrorDiagnostics(text: string, diagnostics: readonly LspDiagnostic[]): Diagnostic[]`, `lspDiagnosticsExtension(): Extension`, `applyDiagnostics(view: EditorView, diagnostics: readonly LspDiagnostic[]): void`.

- [x] **Step 1: Add the dependency**

```bash
npm install --save-exact @codemirror/lint@^6
```

Then confirm `package-lock.json` changed, and remember the five-version rule does **not** apply here — that is for releases, and this is a dependency.

- [x] **Step 2: Write the failing test**

Cases for `toCodeMirrorDiagnostics`, which is the pure half and where the risk is:

1. Severity 1–4 map to `error | warning | info | hint`.
2. A range is converted to `from`/`to` offsets against the given text.
3. A range **past the end of the document** is clamped rather than passed through — the reason this function exists, since CodeMirror throws on out-of-range positions and a server's copy can be a revision behind.
4. A range whose `end` precedes its `start` is normalised rather than emitted inverted.
5. An empty list yields an empty list, and does not throw.

- [x] **Step 3–4: Fail, implement, pass.**

`lspDiagnosticsExtension()` returns `[lintGutter()]`; `applyDiagnostics` dispatches `setDiagnostics(view.state, converted)`. Add the extension into `buildExtensions` in its own `Compartment`, beside the others.

- [x] **Step 5: Commit**

```bash
npm run check && npm test
git add package.json package-lock.json src/editor tests/lsp-editor.test.ts
git commit -m "Paint diagnostics through lint, clamped to the document"
```

---

### Task 13: The problems panel

**Files:**
- Create: `src/ui/ProblemsPanel.svelte`
- Modify: `src/ui/Sidebar.svelte`, `src/services/ui.ts` (panel registration — follow whatever `SearchPanel` does)
- Test: `tests/problems-panel.test.ts`

**Interfaces:**
- Consumes: `LspService.diagnostics` (Task 11).
- Produces: a `problems` panel id.

- [x] **Step 1: Write the failing test**

Follow `tests/answers-panel.test.ts` for the component-test harness. Cases: rows group by file; the count in the header matches the total; arrow keys move `focused`; Enter opens the file at the diagnostic's line; an empty state renders instead of a bare list.

- [x] **Step 2–4: Fail, implement, pass.**

Copy `SearchPanel`'s `rows()` / `focused` shape rather than inventing a second navigation model.

- [x] **Step 5: Commit**

```bash
npm run check && npm test
git add src/ui tests/problems-panel.test.ts
git commit -m "List every problem, arrow keys included"
```

---

### Task 14: The status item

**Files:**
- Modify: `src/ui/StatusBar.svelte`
- Test: `tests/lsp-status.test.ts`

- [x] **Step 1: Write the failing test**

Cases: a running server shows its name; a failed one says so and exposes the stderr tail; nothing renders when `capabilities.languageServers` is false.

- [x] **Step 2–4: Fail, implement, pass.**

- [x] **Step 5: Commit**

```bash
npm run check && npm test
git add src/ui/StatusBar.svelte tests/lsp-status.test.ts
git commit -m "Say which server is running, and why one is not"
```

---

### Task 15: Wiring and commands

**Files:**
- Modify: `src/app.ts`
- Test: `tests/lsp-commands.test.ts`

- [x] **Step 1: Write the failing test**

Cases: **Configure Language Servers** creates `servers.json` from `EXAMPLE_SERVERS_JSON` when absent and opens it; **Reload Language Server Configuration** re-reads it; a malformed file raises a notification and leaves the previous configuration live; `stopAllLanguageServers` runs on close, beside `killAllAgents`.

- [x] **Step 2–4: Fail, implement, pass.**

Copy the `agents.json` handling in `app.ts:740-765` — it already solves create-with-example, reload, and error reporting.

- [x] **Step 5: Commit**

```bash
npm run check && npm test
git add src/app.ts tests/lsp-commands.test.ts
git commit -m "Wire the LSP service in, and give servers.json its two commands"
```

---

### Task 16: Documentation

**Files:**
- Modify: `ROADMAP.md`, `ARCHITECTURE.md`, `CHANGELOG.md`
- Create: `WORKLOG.md`

- [x] **Step 1: Update each**

`ROADMAP.md`: mark **LSP client** and **Diagnostics** shipped in the v0.4 table, in whatever form `#24` established for "which release a milestone shipped in".
`ARCHITECTURE.md`: add `services/lsp/` and `src-tauri/src/lsp.rs` to the module map, and state the framing rule once — it is the non-obvious constraint a future reader will otherwise undo.
`CHANGELOG.md`: an Unreleased entry.
`WORKLOG.md`: create it at the repo root in the operating manual's format (Shipped / Verified / Next / Blocked / Confidence), newest entry on top.

- [x] **Step 2: Verify and commit**

```bash
npm run check && npm test
git add ROADMAP.md ARCHITECTURE.md CHANGELOG.md WORKLOG.md
git commit -m "Write down the LSP client, and start a work log"
```

---

## Done when

- `npm test` passes with every new test included, and the count is stated.
- `npm run check` reports 0 errors.
- The Rust tests are committed and **declared unrun locally**; CI is the first thing to execute them.
- Nothing is pushed, no PR is opened.
