# Ollama Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nox's first `ModelProvider` — a local Ollama model that can read the workspace and offer a change set for review.

**Architecture:** Streaming HTTP lives in Rust behind a vendor-neutral `Platform.streamJsonLines`, loopback-only. The provider in `services/agent/ollama.ts` owns everything Ollama-shaped: the prompt, a parser that tolerates what a 7B model actually emits, and the conversation loop — which lives inside the provider because `ModelStream` hands the `CoreResponse` back at each yield. Edits arrive as quoted search/replace and are converted to real offsets before `proposal.stage` ever sees them.

**Tech Stack:** Rust (`reqwest`, no TLS — loopback HTTP only), TypeScript, Tauri 2 events, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-ollama-provider-design.md` — read it before Task 1, especially §3, which records seven probes against a real Ollama and the three decisions they overturned.

## Global Constraints

- Branch: `ollama-provider`. It exists and holds the spec commit.
- **Nothing at the platform boundary names a vendor.** `streamJsonLines` knows nothing about Ollama; the path, request shape and frame shape live in `services/agent/ollama.ts`.
- **Loopback only, enforced in Rust.** The host must resolve to `127.0.0.1`, `::1` or `localhost`. A TypeScript-side check is not the enforcement.
- **`command.execute` is NOT in the agent's vocabulary this cycle.** The agent has no route to a side effect. Adding it is a finding, not initiative.
- **Nothing may be added to `src/services/config/schema.ts`.** Configuration lives in `agents.json`, because it is a list of records.
- **Logic in services; components only render.**
- Comments explain **why**, not what. Tests carry a comment naming the failure they prevent.
- Files are UTF-8.
- Verify commands: `npm run check`, `npm test` (595 passing today), `cargo test --manifest-path src-tauri/Cargo.toml` (35 today).
- Commit after every task. Do not push.

## What the probes established, and what it means for you

These are facts measured against Ollama 0.32.13 with `qwen2.5-coder:7b`, not guesses. Build to them:

- **There is no `tool_calls` field.** The model advertises `tools` in `ollama show` and never produces one. Actions arrive as JSON in `message.content`.
- **Content streams a few characters at a time.** No single frame holds a parseable object.
- **Code fencing is inconsistent** — fenced in one turn of a conversation and unfenced in the next, having been told not to fence at all. The fence arrives as its own frames: `` ``` ``, then `json`, then `\n`.
- **The model cannot compute character offsets.** Given an offset interface it produced a zero-width insertion of a whole function body. Given quoted search/replace it produced a correct minimal edit first time.

## File structure

| File | Responsibility |
|---|---|
| `src-tauri/Cargo.toml` | *modify* — `reqwest`, TLS-free |
| `src-tauri/src/http.rs` | *create* — loopback check, streaming POST, cancellation |
| `src-tauri/src/lib.rs` | *modify* — register the two commands |
| `src/platform/types.ts` | *modify* — `streamJsonLines`, its types, `capabilities.localModels` |
| `src/platform/tauri.ts` | *modify* — the adapter over the Rust command and its events |
| `src/platform/memory.ts` | *modify* — unsupported, `localModels: false` |
| `src/services/agent/config.ts` | *modify* — the `kind` union |
| `src/services/agent/ollama.ts` | *create* — prompt, parser, edit resolution, the loop |
| `src/app.ts` | *modify* — register a provider per configured Ollama agent |
| `tests/ollama.test.ts` | *create* |
| `tests/agent-config.test.ts` | *modify* |

---

### Task 1: Streaming HTTP in Rust, loopback only

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/http.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: Tauri commands `nox_http_stream { id, url, body }` and `nox_http_cancel { id }`; events `nox://http-line` (`{ id, line }`) and `nox://http-end` (`{ id, error: string | null }`)

- [ ] **Step 1: Write the failing test**

The unit worth testing is the loopback check — a pure function. The streaming path needs a live server and is covered by the in-app walk in Task 8.

Add to `src-tauri/src/http.rs` (which you create in step 3, so this test is written alongside it):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// The failure this prevents: the loopback restriction living only in a
    /// comment, so a typo'd or malicious host in `agents.json` silently
    /// reaches the open internet from inside the editor.
    #[test]
    fn only_loopback_hosts_are_allowed() {
        assert!(is_loopback("http://127.0.0.1:11434/api/chat"));
        assert!(is_loopback("http://localhost:11434/api/chat"));
        assert!(is_loopback("http://[::1]:11434/api/chat"));

        assert!(!is_loopback("http://example.com/api/chat"));
        assert!(!is_loopback("https://api.openai.com/v1/chat"));
        // The interesting one: a host that merely *starts* with something
        // loopback-looking. A naive `starts_with` check passes this.
        assert!(!is_loopback("http://localhost.evil.com/api/chat"));
        assert!(!is_loopback("http://127.0.0.1.evil.com/api/chat"));
    }

    /// The failure this prevents: accepting a scheme that is not HTTP at all,
    /// so a `file://` or `data:` URL reaches the request path.
    #[test]
    fn only_http_schemes_are_allowed() {
        assert!(!is_loopback("file:///etc/passwd"));
        assert!(!is_loopback("ftp://127.0.0.1/x"));
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cargo test --manifest-path src-tauri/Cargo.toml only_loopback
```

Expected: compile error — `http.rs` does not exist and is not declared as a module.

- [ ] **Step 3: Add the dependency**

In `src-tauri/Cargo.toml`, under `[dependencies]`:

```toml
# Streaming HTTP for local model servers. No TLS features: this client only
# ever talks to loopback over plain HTTP, and pulling in native-tls or rustls
# for a connection to 127.0.0.1 would be a large dependency bought for nothing.
reqwest = { version = "0.12", default-features = false, features = ["json", "stream"] }
futures-util = "0.3"
# Used by name for the oneshot cancel channel and `select!`. Tauri depends on
# tokio, but a transitive dependency is not in scope for `tokio::` paths.
tokio = { version = "1", features = ["sync", "macros"] }
```

- [ ] **Step 4: Write the module**

Create `src-tauri/src/http.rs`:

```rust
//! Streaming HTTP to a local model server.
//!
//! Deliberately not an Ollama client: it POSTs JSON to a loopback URL and
//! streams newline-delimited JSON back. What those lines mean is the
//! renderer's business — nothing here knows what a model is.
//!
//! Loopback is enforced here rather than in TypeScript because this is where
//! the request is actually made. A check on the other side of the IPC boundary
//! is a suggestion.

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Serialize)]
struct LinePayload {
    id: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct EndPayload {
    id: String,
    error: Option<String>,
}

/// Cancellation handles for in-flight requests, keyed by the renderer's id.
#[derive(Default)]
pub struct HttpState {
    cancels: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
}

/// True when `url` is plain HTTP to a loopback host.
///
/// Parses the host rather than matching a prefix: `localhost.evil.com` starts
/// with `localhost` and is not loopback.
pub fn is_loopback(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "http" {
        return false;
    }
    match parsed.host_str() {
        Some("localhost") | Some("127.0.0.1") | Some("::1") | Some("[::1]") => true,
        _ => false,
    }
}

/// Start the request and return at once.
///
/// **Returning immediately is the whole point.** If this awaited the stream,
/// the renderer's `await` would not resolve until the model finished — so the
/// handle it needs in order to *cancel* would only arrive once there was
/// nothing left to cancel. Validation happens here so a bad URL is still a
/// rejected promise on the caller's side; everything after it is spawned.
#[tauri::command]
pub fn nox_http_stream(
    app: AppHandle,
    state: State<'_, HttpState>,
    id: String,
    url: String,
    body: serde_json::Value,
) -> Result<(), String> {
    if !is_loopback(&url) {
        return Err(format!("refused: {url} is not a loopback http address"));
    }

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    state
        .cancels
        .lock()
        .map_err(|_| "internal: lock poisoned".to_string())?
        .insert(id.clone(), cancel_tx);

    tauri::async_runtime::spawn(stream_into_events(app, id, url, body, cancel_rx));
    Ok(())
}

async fn stream_into_events(
    app: AppHandle,
    id: String,
    url: String,
    body: serde_json::Value,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let finish = |app: &AppHandle, id: &str, error: Option<String>| {
        let _ = app.emit(
            "nox://http-end",
            EndPayload { id: id.to_string(), error },
        );
    };

    let response = match reqwest::Client::new().post(&url).json(&body).send().await {
        Ok(response) => response,
        Err(error) => {
            finish(&app, &id, Some(error.to_string()));
            return;
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        // The body carries the useful part — Ollama says `model "x" not found,
        // try pulling it first` — so surface it rather than a bare status.
        let detail = response.text().await.unwrap_or_default();
        finish(&app, &id, Some(format!("{status}: {detail}")));
        return;
    }

    let mut stream = response.bytes_stream();
    // Frames do not align to line boundaries; hold the tail until a newline.
    let mut pending = String::new();

    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                finish(&app, &id, None);
                break;
            }
            chunk = stream.next() => {
                let Some(chunk) = chunk else {
                    // A trailing line with no newline is still a line.
                    if !pending.trim().is_empty() {
                        let _ = app.emit("nox://http-line", LinePayload { id: id.clone(), line: pending.clone() });
                    }
                    finish(&app, &id, None);
                    break;
                };
                match chunk {
                    Ok(bytes) => {
                        pending.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(index) = pending.find('\n') {
                            let line: String = pending.drain(..=index).collect();
                            let line = line.trim_end().to_string();
                            if line.is_empty() { continue; }
                            let _ = app.emit("nox://http-line", LinePayload { id: id.clone(), line });
                        }
                    }
                    Err(error) => {
                        finish(&app, &id, Some(error.to_string()));
                        break;
                    }
                }
            }
        }
    }

    // The handle is dropped by `nox_http_cancel` on the cancel path; on the
    // normal path nothing removes it, so the map would grow one entry per
    // request. Clear it here via the app's managed state.
    if let Ok(mut cancels) = app.state::<HttpState>().cancels.lock() {
        cancels.remove(&id);
    }
}

#[tauri::command]
pub fn nox_http_cancel(state: State<'_, HttpState>, id: String) -> Result<(), String> {
    let Ok(mut cancels) = state.cancels.lock() else {
        return Ok(());
    };
    // Dropping the sender is what the select! arm is waiting for; sending is
    // just the tidier way to say so. Either way a second cancel is a no-op.
    if let Some(sender) = cancels.remove(&id) {
        let _ = sender.send(());
    }
    Ok(())
}
```

Then in `src-tauri/src/lib.rs`, declare the module beside the others (`mod http;`), register the state with `.manage(http::HttpState::default())` where the builder is configured, and add both commands to the `generate_handler!` list beside `fs::nox_write_config`.

- [ ] **Step 5: Run the Rust suite**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: PASS, 37 tests (35 today plus your two). Report the number you see.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/
git commit -m "Stream JSON lines from a loopback HTTP endpoint

Loopback is checked by parsing the host, not by matching a prefix:
localhost.evil.com starts with localhost. TLS features are off because
this client only ever talks to 127.0.0.1."
```

---

### Task 2: The Platform seam

**Files:**
- Modify: `src/platform/types.ts`
- Modify: `src/platform/tauri.ts`
- Modify: `src/platform/memory.ts`
- Modify: `src/platform/web.ts` — it overrides `capabilities` wholesale rather than inheriting, so the new key must be added there too or the typecheck fails
- Create: `tests/ollama.test.ts`

**Interfaces:**
- Consumes: Task 1's commands and events
- Produces:
  - `export interface JsonLinesSpec { url: string; body: unknown }`
  - `export interface JsonLinesStream { close(): Promise<void> }`
  - `Platform.streamJsonLines(spec, onLine, onEnd): Promise<JsonLinesStream>`
  - `capabilities.localModels: boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/ollama.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * The Ollama provider and the platform seam beneath it.
 *
 * Everything here drives a fake `streamJsonLines`, replaying frames recorded
 * from a real Ollama 0.32.13 running qwen2.5-coder:7b. Invented fixtures are
 * how an integration passes its tests and fails on contact — these are what
 * the server actually sent.
 */

describe('the platform seam', () => {
  /**
   * The failure this prevents: the browser target silently pretending it can
   * reach a model server, so the agent panel offers a session that can never
   * start.
   */
  it('reports no local models on the memory platform', () => {
    expect(new MemoryPlatform().capabilities.localModels).toBe(false);
  });

  /**
   * The failure this prevents: an unsupported platform returning a dead
   * stream rather than saying so, which would surface as a session that
   * hangs instead of an error naming the cause.
   */
  it('refuses to stream on a platform with no local models', async () => {
    const platform = new MemoryPlatform();
    await expect(
      platform.streamJsonLines({ url: 'http://127.0.0.1:11434/api/chat', body: {} }, () => {}, () => {}),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/ollama.test.ts
```

Expected: FAIL — `localModels` is not a property of `PlatformCapabilities`.

- [ ] **Step 3: Extend the Platform interface**

In `src/platform/types.ts`, add to `PlatformCapabilities` beside `terminals`:

```ts
  /** True when `streamJsonLines` can reach a local model server. */
  localModels: boolean;
```

And beside `openTerminal`, the types and the method:

```ts
export interface JsonLinesSpec {
  /**
   * Loopback only. Enforced in Rust, where the request is actually made — a
   * check on this side of the IPC boundary is a suggestion.
   */
  url: string;
  body: unknown;
}

export interface JsonLinesStream {
  /** Stop the request and drop the connection. Safe to call twice. */
  close(): Promise<void>;
}
```

```ts
  /**
   * POST JSON to a loopback endpoint and stream newline-delimited JSON back.
   *
   * Deliberately not named for a vendor: nothing at this boundary knows what
   * a model is, let alone whose. The path, the request shape and the frame
   * shape all live in `services/agent/ollama.ts`.
   *
   * Rejects where `capabilities.localModels` is false.
   */
  streamJsonLines(
    spec: JsonLinesSpec,
    onLine: (line: string) => void,
    onEnd: (error: string | null) => void,
  ): Promise<JsonLinesStream>;
```

- [ ] **Step 4: Implement it on both platforms**

In `src/platform/memory.ts`, add `localModels: false` to the capabilities object, and the method beside `openTerminal`:

```ts
  /**
   * No network in memory. Rejecting is the honest answer: a stream that
   * never emits looks like a slow model rather than a missing one.
   */
  async streamJsonLines(): Promise<never> {
    throw new PlatformError('this build cannot reach a local model', 'unsupported');
  }
```

In `src/platform/tauri.ts`, add `localModels: true` to its capabilities, and the adapter — following `openTerminal`'s shape exactly, since it is the same problem:

```ts
  async streamJsonLines(
    spec: JsonLinesSpec,
    onLine: (line: string) => void,
    onEnd: (error: string | null) => void,
  ): Promise<JsonLinesStream> {
    // Same reasoning as `openTerminal`: the instance token keeps ids unique
    // across a reload, which the Rust side survives.
    const id = `http-${TauriPlatform.#instance}-${++TauriPlatform.#nextStream}`;
    let alive = true;

    const unlisten = await Promise.all([
      listen<{ id: string; line: string }>('nox://http-line', (event) => {
        if (event.payload.id !== id || !alive) return;
        onLine(event.payload.line);
      }),
      listen<{ id: string; error: string | null }>('nox://http-end', (event) => {
        if (event.payload.id !== id || !alive) return;
        alive = false;
        release();
        onEnd(event.payload.error);
      }),
    ]);

    const release = () => unlisten.forEach((off) => off());

    try {
      await call<void>('nox_http_stream', { id, url: spec.url, body: spec.body });
    } catch (error) {
      alive = false;
      release();
      throw error;
    }

    return {
      async close() {
        if (!alive) return;
        alive = false;
        release();
        await call<void>('nox_http_cancel', { id });
      },
    };
  }
```

Add `static #nextStream = 0;` beside the existing `#nextTerminal` counter.

Add `localModels: false` to `src/platform/web.ts`'s capabilities object as well. It overrides `capabilities` wholesale rather than inheriting `MemoryPlatform`'s, so omitting the key is a typecheck failure rather than a silent default.

Awaiting `nox_http_stream` is correct here: Task 1's command validates the URL and returns immediately, spawning the stream, so the `await` resolves as soon as the request has been accepted rather than when the model finishes. That is what makes the returned handle useful for cancellation.

- [ ] **Step 5: Run the tests and the gate**

```bash
npx vitest run tests/ollama.test.ts && npm run check && npm test
```

Expected: PASS, 2 new tests; check clean; 597 passing.

- [ ] **Step 6: Commit**

```bash
git add src/platform/ tests/ollama.test.ts
git commit -m "Add a loopback JSON-lines stream to the platform

Named for what it does rather than who it talks to: nothing at this
boundary knows what a model is. The browser target rejects rather than
returning a stream that never emits, because a missing capability should
not look like a slow one."
```

---

### Task 3: `agents.json` learns a second kind

**Files:**
- Modify: `src/services/agent/config.ts`
- Modify: `tests/agent-config.test.ts`

**Interfaces:**
- Produces:
  - `export interface OllamaAgentConfig { id: string; label: string; kind: 'ollama'; host: string; model: string; maxTurns?: number }`
  - `export interface ProcessAgentConfig { id: string; label: string; kind?: 'process'; command: string; args?: string[]; cwd?: string }`
  - `export type AgentConfig = ProcessAgentConfig | OllamaAgentConfig`

- [ ] **Step 1: Write the failing tests**

Append to `tests/agent-config.test.ts`, following the file's existing setup:

```ts
describe('ollama agents', () => {
  /**
   * The failure this prevents: requiring `kind` on every record, which would
   * make every existing agents.json in the wild stop loading on upgrade.
   */
  it('treats a record with no kind as a process agent', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile(
      'agents.json',
      JSON.stringify({ agents: [{ id: 'a', label: 'A', command: 'node' }] }),
    );

    const config = new AgentConfigService(platform);
    await config.load();

    expect(config.agents.get()).toHaveLength(1);
    expect(config.agents.get()[0]!.kind ?? 'process').toBe('process');
  });

  it('parses an ollama record', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile(
      'agents.json',
      JSON.stringify({
        agents: [
          { id: 'local', label: 'Qwen', kind: 'ollama',
            host: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b' },
        ],
      }),
    );

    const config = new AgentConfigService(platform);
    await config.load();

    const agent = config.agents.get()[0]!;
    expect(agent.kind).toBe('ollama');
    expect(agent).toMatchObject({ host: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b' });
  });

  /**
   * The failure this prevents: an ollama record missing its model loading as
   * a valid agent, so the failure surfaces as a confusing HTTP error at
   * session start rather than as a bad config file.
   */
  it('rejects an ollama record with no model', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile(
      'agents.json',
      JSON.stringify({ agents: [{ id: 'x', label: 'X', kind: 'ollama', host: 'http://127.0.0.1:11434' }] }),
    );

    const config = new AgentConfigService(platform);
    await config.load();

    expect(config.agents.get()).toEqual([]);
  });
});
```

Read the top of `tests/agent-config.test.ts` first and reuse whatever setup helper it already has rather than duplicating one.

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/agent-config.test.ts
```

Expected: FAIL — an ollama record is dropped, because the current validator requires `command`.

- [ ] **Step 3: Widen the type and the validator**

In `src/services/agent/config.ts`, replace the single `AgentConfig` interface with the union, keeping the file's existing doc-comment voice:

```ts
interface AgentBase {
  /** Stable key, used for the session label and for policy lookup. */
  id: string;
  /** Shown in the palette and the panel. */
  label: string;
}

/** An agent Nox starts as a child process, speaking the protocol over stdio. */
export interface ProcessAgentConfig extends AgentBase {
  /**
   * Absent means `process`. Records written before local models existed have
   * no `kind`, and an upgrade that stopped loading them would be a poor
   * trade for a tidier type.
   */
  kind?: 'process';
  command: string;
  args?: string[];
  /** Defaults to the workspace root. */
  cwd?: string;
}

/** A local model served over loopback HTTP. */
export interface OllamaAgentConfig extends AgentBase {
  kind: 'ollama';
  host: string;
  model: string;
  /**
   * How many times the model may act before the session ends itself. A small
   * model will re-read the same buffer indefinitely given the chance.
   */
  maxTurns?: number;
}

export type AgentConfig = ProcessAgentConfig | OllamaAgentConfig;
```

Then extend the record validator so a record with `kind === 'ollama'` requires `host` and `model` strings, and any other record requires `command` as it does today. Find the existing per-record validation and branch there rather than adding a second pass.

Add an Ollama entry to `AGENTS_TEMPLATE` so the format stays self-explaining:

```ts
export const AGENTS_TEMPLATE = `{
  "agents": [
    {
      "id": "local",
      "label": "Local model",
      "kind": "ollama",
      "host": "http://127.0.0.1:11434",
      "model": "qwen2.5-coder:7b"
    },
    {
      "id": "example",
      "label": "Example agent",
      "command": "node",
      "args": ["./my-agent.js"]
    }
  ]
}
`;
```

- [ ] **Step 4: Run the tests and the gate**

```bash
npx vitest run tests/agent-config.test.ts && npm run check && npm test
```

Expected: PASS; check clean; 600 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/agent/config.ts tests/agent-config.test.ts
git commit -m "Let agents.json describe a local model

A discriminated union rather than a second file. An absent kind still
means a process agent, so no existing agents.json changes."
```

---

### Task 4: The parser

The heart of the integration, and pure — so it takes the weight of the testing. Everything here is built to what the model actually emits, not what it should.

**Files:**
- Create: `src/services/agent/ollama.ts`
- Modify: `tests/ollama.test.ts`

**Interfaces:**
- Produces:
  - `export interface ParsedTurn { text: string; action: RequestBody | null; error: string | null }`
  - `export function parseTurn(content: string): ParsedTurn`

- [ ] **Step 1: Write the failing tests**

Append to `tests/ollama.test.ts`:

```ts
import { parseTurn } from '../src/services/agent/ollama';

describe('parsing a turn', () => {
  it('reads a bare object', () => {
    const parsed = parseTurn('{"method":"context.openBuffers"}');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
    expect(parsed.error).toBeNull();
  });

  /**
   * The failure this prevents: requiring the model to obey "no code fences".
   * Recorded from a real session, qwen2.5-coder fenced one turn and not the
   * next, having been told not to fence at all. Tolerance is available;
   * consistency is not.
   */
  it('reads an object wrapped in a code fence', () => {
    const parsed = parseTurn('```json\n{"method":"context.openBuffers"}\n```');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
  });

  it('reads an object in an unlabelled fence', () => {
    const parsed = parseTurn('```\n{"method":"context.openBuffers"}\n```');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
  });

  it('keeps params', () => {
    const parsed = parseTurn('{"method":"context.bufferText","params":{"bufferId":"b1"}}');
    expect(parsed.action).toEqual({
      method: 'context.bufferText',
      params: { bufferId: 'b1' },
    });
  });

  /**
   * The failure this prevents: narration being swallowed. A model that says
   * what it is about to do and then does it is using the interface as
   * designed — text and action share one stream on purpose.
   */
  it('returns prose before an object as text', () => {
    const parsed = parseTurn('Let me look at the file.\n{"method":"context.openBuffers"}');
    expect(parsed.text).toBe('Let me look at the file.');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
  });

  /**
   * The failure this prevents: guessing at what a model meant by a second
   * object. One action per turn is the contract; the rest is noise.
   */
  it('ignores anything after the first object', () => {
    const parsed = parseTurn('{"method":"context.openBuffers"}\n{"method":"session.summary","params":{"text":"done"}}');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
  });

  /**
   * The failure this prevents: a malformed turn ending the session. The model
   * gets the error back and another attempt.
   */
  it('reports unparseable output rather than throwing', () => {
    const parsed = parseTurn('I think the answer is 42.');
    expect(parsed.action).toBeNull();
    expect(parsed.error).toMatch(/no JSON/i);
  });

  it('reports an object with no method', () => {
    const parsed = parseTurn('{"foo":"bar"}');
    expect(parsed.action).toBeNull();
    expect(parsed.error).toMatch(/method/i);
  });

  /**
   * The failure this prevents: accepting a method outside the vocabulary —
   * including `command.execute`, which is deliberately not offered this
   * cycle. An agent must have no route to a side effect.
   */
  it('rejects a method outside the vocabulary', () => {
    const parsed = parseTurn('{"method":"command.execute","params":{"commandId":"file.save"}}');
    expect(parsed.action).toBeNull();
    expect(parsed.error).toMatch(/command\.execute/);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/ollama.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/services/agent/ollama"`.

- [ ] **Step 3: Write the parser**

Create `src/services/agent/ollama.ts`:

```ts
import type { RequestBody } from './protocol';

/**
 * A local model, over Ollama's HTTP API.
 *
 * The shape of this file is dictated by what a 7B model actually does rather
 * than what the API documents. Three findings, all measured against Ollama
 * 0.32.13 with qwen2.5-coder:7b before any of it was written:
 *
 * - There is no `tool_calls` field. The model advertises `tools` in
 *   `ollama show` and never produces one, so actions arrive as JSON inside
 *   `message.content` and this file parses them.
 * - Code fencing is inconsistent between turns of a single conversation,
 *   having been told not to fence at all.
 * - The model cannot compute character offsets. Given an offset interface it
 *   produced a zero-width insertion of a whole function body; given quoted
 *   search/replace it produced a correct edit first time. See `resolveEdit`.
 */

/** The methods a model may call. `command.execute` is deliberately absent. */
const VOCABULARY = new Set([
  'context.openBuffers',
  'context.bufferText',
  'context.selection',
  'context.viewport',
  'context.workspaceTree',
  'context.recentTransactions',
  'session.note',
  'session.summary',
  'proposal.stage',
]);

export interface ParsedTurn {
  /** Narration the model emitted before its action. */
  text: string;
  action: RequestBody | null;
  /** Why nothing could be parsed. Fed back to the model as its next input. */
  error: string | null;
}

/** Strip one surrounding code fence, if there is one. */
function unfence(content: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(content);
  return fenced ? fenced[1]! : content;
}

/**
 * The first complete JSON object in `content`, and whatever preceded it.
 *
 * Scans for balanced braces rather than using a regex: a `find` string in a
 * staged edit can contain braces, and a lazy regex stops at the first `}`
 * inside one.
 */
function firstObject(content: string): { before: string; json: string } | null {
  const start = content.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index++) {
    const char = content[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        return { before: content.slice(0, start), json: content.slice(start, index + 1) };
      }
    }
  }
  return null;
}

export function parseTurn(content: string): ParsedTurn {
  const body = unfence(content);
  const found = firstObject(body);
  if (!found) {
    return { text: body.trim(), action: null, error: 'no JSON object in the reply' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(found.json);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { text: found.before.trim(), action: null, error: `malformed JSON: ${message}` };
  }

  const record = parsed as { method?: unknown; params?: unknown };
  if (typeof record.method !== 'string') {
    return { text: found.before.trim(), action: null, error: 'object has no "method" string' };
  }
  if (!VOCABULARY.has(record.method)) {
    return {
      text: found.before.trim(),
      action: null,
      error: `${record.method} is not a method you may call`,
    };
  }

  const action = (
    record.params === undefined
      ? { method: record.method }
      : { method: record.method, params: record.params }
  ) as RequestBody;

  return { text: found.before.trim(), action, error: null };
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/ollama.test.ts
```

Expected: PASS, 11 tests in this file.

- [ ] **Step 5: Gate and commit**

```bash
npm run check && npm test
```

Expected: clean; 609 passing.

```bash
git add src/services/agent/ollama.ts tests/ollama.test.ts
git commit -m "Parse what a local model actually emits

Brace-balanced scanning rather than a regex, because a staged edit's
find string contains braces. Fences are stripped because the model uses
them inconsistently between turns of one conversation, having been told
not to use them at all."
```

---

### Task 5: Quoted search/replace becomes real offsets

**Files:**
- Modify: `src/services/agent/ollama.ts`
- Modify: `tests/ollama.test.ts`

**Interfaces:**
- Produces: `export function resolveEdit(text: string, find: string, replace: string): { from: number; to: number; insert: string } | { error: string }`

- [ ] **Step 1: Write the failing tests**

Append to `tests/ollama.test.ts`:

```ts
import { resolveEdit } from '../src/services/agent/ollama';

describe('resolving an edit', () => {
  const doc = 'export function add(a: number, b: number) {\n  return a + b;\n}\n';

  it('turns quoted text into offsets', () => {
    const resolved = resolveEdit(doc, 'function add(', 'function sum(');
    expect(resolved).toEqual({ from: 7, to: 20, insert: 'function sum(' });
  });

  /**
   * The failure this prevents: a silent no-op. A model that quotes text which
   * is not in the buffer has misread it, and staging nothing while reporting
   * success is the worst available answer.
   */
  it('refuses text that is not present', () => {
    const resolved = resolveEdit(doc, 'function subtract(', 'function sum(');
    expect(resolved).toEqual({ error: expect.stringMatching(/not found/i) });
  });

  /**
   * The failure this prevents: editing the wrong one of several identical
   * lines. Taking the first match silently corrupts a file in a way the diff
   * looks plausible enough to accept.
   */
  it('refuses ambiguous text and says how many matches', () => {
    const repeated = 'const x = 1;\nconst x = 1;\n';
    const resolved = resolveEdit(repeated, 'const x = 1;', 'const y = 2;');
    expect(resolved).toEqual({ error: expect.stringMatching(/2 matches/) });
  });

  /**
   * The failure this prevents: an empty find matching at position 0, which
   * would insert at the top of the file — never what was meant.
   */
  it('refuses an empty find', () => {
    const resolved = resolveEdit(doc, '', 'anything');
    expect(resolved).toEqual({ error: expect.stringMatching(/empty/i) });
  });

  it('allows a replacement that deletes', () => {
    const resolved = resolveEdit(doc, '  return a + b;\n', '');
    expect(resolved).toEqual({ from: 44, to: 60, insert: '' });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/ollama.test.ts
```

Expected: FAIL — `resolveEdit is not a function`.

- [ ] **Step 3: Implement**

Append to `src/services/agent/ollama.ts`:

```ts
/**
 * Locate `find` in `text` and express the replacement as real offsets.
 *
 * The model quotes text rather than computing positions because it cannot
 * compute positions — measured, not assumed. This is the conversion, and it
 * is also the only place a bad quote can be caught: `proposal.stage` takes
 * offsets and will faithfully stage nonsense if given nonsense.
 *
 * Ambiguity is refused rather than resolved by taking the first match.
 * Editing the wrong one of three identical lines produces a diff plausible
 * enough to accept, which is the failure worth preventing.
 */
export function resolveEdit(
  text: string,
  find: string,
  replace: string,
): { from: number; to: number; insert: string } | { error: string } {
  if (find.length === 0) {
    return { error: 'the text to find is empty' };
  }

  const first = text.indexOf(find);
  if (first < 0) {
    return { error: `text not found in the buffer: ${JSON.stringify(find.slice(0, 60))}` };
  }

  let count = 0;
  for (let at = first; at >= 0; at = text.indexOf(find, at + 1)) count++;
  if (count > 1) {
    return {
      error: `text is ambiguous, ${count} matches — quote more of the surrounding lines`,
    };
  }

  return { from: first, to: first + find.length, insert: replace };
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/ollama.test.ts && npm run check && npm test
```

Expected: PASS; check clean; 614 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/agent/ollama.ts tests/ollama.test.ts
git commit -m "Turn quoted text into offsets

The model quotes because it cannot count: given an offset interface it
produced a zero-width insertion of a whole function body. Ambiguity is
refused rather than resolved, because editing the wrong one of three
identical lines produces a diff plausible enough to accept."
```

---

### Task 6: The provider and its conversation loop

**Files:**
- Modify: `src/services/agent/ollama.ts`
- Modify: `tests/ollama.test.ts`

**Interfaces:**
- Consumes: `parseTurn`, `resolveEdit`, `Platform.streamJsonLines`, `ModelProvider` / `ModelStream` from `./provider`
- Produces: `export class OllamaProvider implements ModelProvider` with `constructor(platform: Platform, config: OllamaAgentConfig)`

- [ ] **Step 1: Write the failing tests**

Append to `tests/ollama.test.ts`. The fake replays frames in the exact shape a real Ollama sent — note the fence arriving as its own chunks, which is recorded behaviour:

```ts
import type { Platform } from '../src/platform/types';
import { OllamaProvider } from '../src/services/agent/ollama';
import type { OllamaAgentConfig } from '../src/services/agent/config';

const CONFIG: OllamaAgentConfig = {
  id: 'local', label: 'Qwen', kind: 'ollama',
  host: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b',
};

/** Split a reply the way Ollama does: a few characters per frame. */
function framesFor(content: string): string[] {
  const frames = [...content].map((char) =>
    JSON.stringify({ model: 'qwen2.5-coder:7b', message: { role: 'assistant', content: char }, done: false }),
  );
  frames.push(JSON.stringify({ model: 'qwen2.5-coder:7b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }));
  return frames;
}

/** A platform whose stream replays one scripted reply per request. */
function fakePlatform(replies: string[]) {
  const bodies: unknown[] = [];
  let turn = 0;
  const platform = {
    capabilities: { localModels: true },
    async streamJsonLines(spec: { body: unknown }, onLine: (line: string) => void, onEnd: (e: string | null) => void) {
      bodies.push(spec.body);
      const reply = replies[turn++] ?? '{"method":"session.summary","params":{"text":"done"}}';
      for (const frame of framesFor(reply)) onLine(frame);
      onEnd(null);
      return { async close() {} };
    },
  } as unknown as Platform;
  return { platform, bodies };
}

/** Drive a stream to completion, feeding a fixed response back each time. */
async function drain(provider: OllamaProvider, instruction = 'do a thing') {
  const chunks = [];
  const stream = provider.complete({ instruction, context: '' });
  let response: never | undefined = undefined;
  for (;;) {
    const step = await stream.next(response as never);
    if (step.done) break;
    chunks.push(step.value);
  }
  return chunks;
}

describe('the provider', () => {
  it('yields the action a model emitted', async () => {
    const { platform } = fakePlatform(['{"method":"context.openBuffers"}']);
    const chunks = await drain(new OllamaProvider(platform, CONFIG));

    expect(chunks[0]).toEqual({ type: 'action', request: { method: 'context.openBuffers' } });
  });

  /**
   * The failure this prevents: a parser that assumes one frame is one
   * message. Ollama streams content a few characters at a time, so no single
   * frame holds a parseable object.
   */
  it('accumulates an object split across frames', async () => {
    const { platform } = fakePlatform(['{"method":"session.note","params":{"text":"hello"}}']);
    const chunks = await drain(new OllamaProvider(platform, CONFIG));

    expect(chunks[0]).toMatchObject({ type: 'action', request: { method: 'session.note' } });
  });

  /**
   * The failure this prevents: a malformed turn ending the session, where the
   * model would have recovered given the error back.
   */
  it('feeds a parse error back and continues', async () => {
    const { platform, bodies } = fakePlatform([
      'I think the answer is 42.',
      '{"method":"session.summary","params":{"text":"done"}}',
    ]);
    await drain(new OllamaProvider(platform, CONFIG));

    const second = bodies[1] as { messages: { role: string; content: string }[] };
    expect(JSON.stringify(second.messages)).toMatch(/no JSON object/);
  });

  /**
   * The failure this prevents: an infinite retry loop against a model that
   * cannot produce the format at all.
   */
  it('gives up after two unparseable turns in a row', async () => {
    const { platform, bodies } = fakePlatform(['nonsense one', 'nonsense two', 'nonsense three']);
    await drain(new OllamaProvider(platform, CONFIG));

    expect(bodies.length).toBeLessThanOrEqual(2);
  });

  /**
   * The failure this prevents: a small model re-reading the same buffer
   * forever, which it will do given the chance.
   */
  it('stops at the turn cap', async () => {
    const { platform, bodies } = fakePlatform(new Array(50).fill('{"method":"context.openBuffers"}'));
    await drain(new OllamaProvider(platform, { ...CONFIG, maxTurns: 3 }));

    expect(bodies).toHaveLength(3);
  });

  /**
   * The failure this prevents: an unreachable server hanging the session.
   * `#ask` gets an end event carrying an error and no content, and a loop that
   * treated that as an empty turn would retry against a server that is not
   * there until it hit the turn cap.
   */
  it('ends the session when the stream reports a failure', async () => {
    const platform = {
      capabilities: { localModels: true },
      async streamJsonLines(_spec: unknown, _onLine: unknown, onEnd: (e: string | null) => void) {
        onEnd('error sending request for url (http://127.0.0.1:11434/api/chat)');
        return { async close() {} };
      },
    } as unknown as Platform;

    const chunks = await drain(new OllamaProvider(platform, CONFIG));

    expect(chunks).toEqual([]);
  });

  it('stops when the model emits a summary', async () => {
    const { platform, bodies } = fakePlatform(['{"method":"session.summary","params":{"text":"all done"}}']);
    const chunks = await drain(new OllamaProvider(platform, CONFIG));

    expect(bodies).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ request: { method: 'session.summary' } });
  });

  /**
   * The failure this prevents: a cancelled session leaving the request open
   * and the model still generating.
   */
  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const { platform } = fakePlatform(new Array(20).fill('{"method":"context.openBuffers"}'));
    const provider = new OllamaProvider(platform, CONFIG);

    const stream = provider.complete({ instruction: 'x', context: '', signal: controller.signal });
    await stream.next();
    controller.abort();
    const after = await stream.next(undefined as never);

    expect(after.done).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/ollama.test.ts
```

Expected: FAIL — `OllamaProvider is not a constructor`.

- [ ] **Step 3: Implement the provider**

Append to `src/services/agent/ollama.ts`. Import what you need at the top of the file (`Platform`, `ModelProvider`, `ModelStream`, `ModelRequest`, `CoreResponse`, `OllamaAgentConfig`).

```ts
/** How many times the model may act before the session ends itself. */
const DEFAULT_MAX_TURNS = 12;

/**
 * What the model is told it may do.
 *
 * Written as the protocol's own vocabulary rather than as tool schemas: the
 * model has no tool-calling path, so this prompt *is* the interface. `find`
 * is quoted rather than positional for the reason `resolveEdit` documents.
 */
function systemPrompt(): string {
  return [
    'You are a coding agent inside the Nox editor.',
    'Reply with ONE JSON object and nothing else. Do not use code fences.',
    '',
    'Methods:',
    '{"method":"context.openBuffers"}',
    '{"method":"context.bufferText","params":{"bufferId":"<id>"}}',
    '{"method":"context.selection","params":{"bufferId":"<id>"}}',
    '{"method":"context.viewport","params":{"bufferId":"<id>"}}',
    '{"method":"context.workspaceTree"}',
    '{"method":"context.recentTransactions"}',
    '{"method":"session.note","params":{"text":"<what you are doing>"}}',
    '{"method":"proposal.stage","params":{"description":"<what>","edits":[{"bufferId":"<id>","find":"<exact existing text>","replace":"<new text>"}]}}',
    '{"method":"session.summary","params":{"text":"<what you did>"}}',
    '',
    'For proposal.stage, "find" MUST be copied exactly from the buffer and must',
    'appear exactly once in it. Quote whole lines including indentation. Never',
    'use character offsets.',
    '',
    'You receive each result as the next user message. Finish with session.summary.',
  ].join('\n');
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class OllamaProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;

  #platform: Platform;
  #config: OllamaAgentConfig;

  constructor(platform: Platform, config: OllamaAgentConfig) {
    this.#platform = platform;
    this.#config = config;
    this.id = config.id;
    this.label = config.label;
  }

  async *complete(request: ModelRequest): ModelStream {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt() },
      {
        role: 'user',
        content: `Instruction: ${request.instruction}\n\n${request.context}\n\nBegin.`,
      },
    ];

    const maxTurns = this.#config.maxTurns ?? DEFAULT_MAX_TURNS;
    let consecutiveFailures = 0;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (request.signal?.aborted) return;

      const content = await this.#ask(messages, request.signal);
      if (content === null) return;

      messages.push({ role: 'assistant', content });
      const parsed = parseTurn(content);

      if (parsed.text.length > 0) yield { type: 'text', text: parsed.text };

      if (!parsed.action) {
        consecutiveFailures++;
        // Twice is enough to know it is not a slip. A model that cannot emit
        // the format will not manage it on the third attempt, and the session
        // is more useful ended than looping.
        if (consecutiveFailures >= 2) return;
        messages.push({ role: 'user', content: `Error: ${parsed.error}. Reply with one JSON object.` });
        continue;
      }

      consecutiveFailures = 0;
      const response = yield { type: 'action', request: parsed.action };
      if (parsed.action.method === 'session.summary') return;
      messages.push({ role: 'user', content: `Result: ${describeResponse(response)}` });
    }
  }

  /**
   * One round trip. Returns the assembled `message.content`, or null when the
   * stream failed or was aborted — either way there is nothing to parse.
   */
  async #ask(messages: ChatMessage[], signal: AbortSignal | undefined): Promise<string | null> {
    const url = `${this.#config.host.replace(/\/+$/, '')}/api/chat`;
    let content = '';
    let failure: string | null = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      void this.#platform
        .streamJsonLines(
          {
            url,
            body: {
              model: this.#config.model,
              stream: true,
              // A structured-output task, not a creative one. Determinism also
              // makes a bad turn reproducible instead of a ghost.
              options: { temperature: 0 },
              messages,
            },
          },
          (line) => {
            try {
              const frame = JSON.parse(line) as { message?: { content?: string } };
              content += frame.message?.content ?? '';
            } catch {
              // A frame that is not JSON is not fatal: the reply so far still
              // stands, and the parse of the whole turn is what decides.
            }
          },
          (error) => {
            failure = error;
            finish();
          },
        )
        .then((stream) => {
          if (signal) {
            signal.addEventListener('abort', () => void stream.close().then(finish), { once: true });
          }
        })
        .catch((error: unknown) => {
          failure = error instanceof Error ? error.message : String(error);
          finish();
        });
    });

    if (failure !== null || signal?.aborted) return null;
    return content;
  }
}

/** What the model is told came back. */
function describeResponse(response: CoreResponse | undefined): string {
  if (!response) return 'ok';
  if (response.ok) return JSON.stringify(response.result);
  return `error ${response.error.code}: ${response.error.message}`;
}
```

**One thing to get right yourself:** `proposal.stage` arrives with `find`/`replace` edits, and `resolveEdit` converts them — but the provider does not hold buffer text. The conversion needs the buffer's current text, which the model has already read via `context.bufferText`. Cache the text of each buffer the model reads inside `complete`, and rewrite a `proposal.stage` action's edits before yielding it. If the model stages an edit against a buffer it never read, refuse the action the same way an unparseable turn is refused — feed back an error saying it must read the buffer first. Write a test for both paths, each with a regression comment.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/ollama.test.ts
```

Expected: PASS. Report the count you see, including your two extra tests.

- [ ] **Step 5: Gate and commit**

```bash
npm run check && npm test
```

```bash
git add src/services/agent/ollama.ts tests/ollama.test.ts
git commit -m "Drive a local model through the agent protocol

The loop lives in the provider because ModelStream hands the response
back at each yield. Two unparseable turns in a row ends the session: a
model that cannot emit the format twice will not manage it on the third
attempt."
```

---

### Task 7: Register configured models

**Files:**
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `OllamaProvider`, `AgentConfigService.agents`, `AgentRuntime.registerProvider`

- [ ] **Step 1: Register a provider per configured Ollama agent**

There is no unit test for this step: it is wiring between two tested units, and the in-app walk in Task 8 is what proves it. Do not invent one.

In `src/app.ts`, in `#wireServices`, subscribe to the agent config and keep the runtime's providers in step:

```ts
    // Each configured local model becomes a provider the agent panel can start
    // a session with. Re-registered wholesale when agents.json changes, which
    // is rare and much simpler than diffing the list.
    let disposeProviders: (() => void)[] = [];
    this.agentConfig.agents.subscribe((agents) => {
      for (const dispose of disposeProviders) dispose();
      disposeProviders = agents
        .filter((agent): agent is OllamaAgentConfig => agent.kind === 'ollama')
        .filter(() => this.platform.capabilities.localModels)
        .map((agent) => this.agents.registerProvider(new OllamaProvider(this.platform, agent)));
    });
```

Import `OllamaProvider` from `@services/agent/ollama` and the `OllamaAgentConfig` type from `@services/agent/config`.

- [ ] **Step 2: Gate**

```bash
npm run check && npm test
```

Expected: clean, and the same count as after Task 6 — you added no tests.

- [ ] **Step 3: Commit**

```bash
git add src/app.ts
git commit -m "Register a provider for each configured local model

Nothing is registered where the platform cannot reach one, so the browser
target offers no session it could not start."
```

---

### Task 8: Verify against the real Ollama, and document it

**Files:**
- Modify: `ARCHITECTURE.md`, `CHANGELOG.md`, `ROADMAP.md`

- [ ] **Step 1: Walk it against a live model**

This is the gate that matters. A green suite here proves the parser, not the integration — every test above drives a fake.

Ollama 0.32.13 is installed with `qwen2.5-coder:7b` pulled. Confirm the server is up:

```bash
curl -s http://localhost:11434/api/version
```

The desktop target is required: `capabilities.localModels` is false in the browser, so `npm run dev` cannot do this. Build and run the app:

```bash
npm run app
```

Then, with a workspace open:

1. Create `agents.json` in the config directory with an Ollama entry — the palette has a command that writes the template; use it and edit, or write it directly. Confirm the agent appears in the agents panel.
2. Start a session with an instruction against a real file, something small and concrete: *"rename the function `add` to `sum`"* against a file that has one.
3. Watch the session's audit trail: the model should read buffers, narrate, and stage a proposal.
4. **Confirm the staged proposal is correct** — the review panel should show a real rename, not a corrupt diff. This is the thing quoted search/replace exists to guarantee.
5. Accept it, and confirm the resulting edit carries an agent-authored provenance mark in the gutter, with the tooltip naming the agent.
6. Cancel a session mid-generation and confirm it stops rather than continuing to stream.
7. Point `host` at a port with nothing on it and confirm the failure names the host rather than hanging.
8. Set `model` to something not pulled and confirm Ollama's own message surfaces.

Record what you actually observed for each. If a step fails, fix it and re-walk that step. If you cannot build or run the desktop app, say so plainly rather than reporting the walk as done.

- [ ] **Step 2: Document the decision**

Add an `ARCHITECTURE.md` §4 subsection after the provenance one, matching its neighbours' voice — decision, rejected alternative, what it cost:

```markdown
### The first provider is local, and parses prose

`ModelProvider` shipped in v0.2 with no implementation, deliberately. This is
the first one, and what it had to become says something about local models.

Network access lives in Rust behind `Platform.streamJsonLines`, loopback-only.
The webview could not do it anyway — the CSP is `default-src 'self'` with no
`connect-src` — and widening that to reach one port would open the app's
network surface permanently.

Two findings shaped the provider, both measured before it was written rather
than assumed. **There is no `tool_calls` field.** `qwen2.5-coder` advertises
`tools` in `ollama show` and never produces one, so actions arrive as JSON
inside the message content and the provider parses them — including stripping
code fences the model applies inconsistently between turns of one
conversation. Building on native tool calls would have worked with an
unknowable subset of models and failed opaquely for the rest.

**And the model cannot compute character offsets.** Given `proposal.stage`'s
real interface it produced a zero-width insertion of a whole function body:
the intent right, the arithmetic nonsense. That is the dangerous shape —
`proposal.stage` would accept it and the review panel would render a
convincing corrupt diff. So the model quotes text instead, and the provider
converts the quote to offsets, refusing anything it cannot find or that
matches twice. The protocol is untouched; everything below the provider still
receives real offsets and never learns a model was involved.

The cost is a parser where a schema would have done, and a vocabulary the
model is told about in prose rather than declared. That is the price of local
models as they are, not as their APIs describe them.
```

- [ ] **Step 3: Add the §3 tree entries**

§3 is an indented tree. Add two rows in the `services/agent/` block, keeping the box-drawing characters and matching the neighbouring column alignment — measure it, do not assume:

```
│  ├─ agent/ollama.ts    A local model: prompt, parser, edit resolution
```

And in `src-tauri/src/`:

```
├─ http.rs               Streaming HTTP to loopback. No logic.
```

- [ ] **Step 4: Changelog and roadmap**

Add to `CHANGELOG.md` under `## [Unreleased]`'s `### Added`, matching the bolded-lead-phrase shape of its neighbours:

```markdown
- **Local models.** Point Nox at an Ollama server in `agents.json` and an
  agent can read your workspace and propose a change set, reviewed hunk by
  hunk before anything is written.
  - It runs entirely on your machine. No account, no telemetry, and the HTTP
    client refuses anything that is not loopback.
  - The agent can read and propose. It cannot run commands.
  - Edits are quoted, not positional: the model names the text to replace and
    Nox finds it, refusing anything ambiguous rather than guessing.
```

In `ROADMAP.md`, move local model support out of the "Later — AI" section into shipped, keeping that section's remaining entries intact.

- [ ] **Step 5: Final verification**

```bash
npm run check && npm test && cargo test --manifest-path src-tauri/Cargo.toml
```

Report the actual numbers.

- [ ] **Step 6: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md ROADMAP.md
git commit -m "Document the first model provider

Why it parses prose rather than tool calls, and why the model quotes text
rather than counting characters. Both were measured before the provider
was written."
```

---

## Notes for the executor

- **Tasks 1 and 2 are the network seam; 4, 5 and 6 are the provider.** They are separable, and a reviewer could reasonably approve one half and reject the other.
- **Task 7 has no unit test, deliberately** — it is wiring between two tested units. Task 8's walk is its gate. Do not invent one.
- **Task 6 leaves one piece of design to you**: caching buffer text so `proposal.stage`'s quoted edits can be resolved, and refusing a stage against a buffer the model never read. It is called out in that task because it needs a judgement the plan should not pretend to make for you — but it does need tests.
- **Every fixture in `tests/ollama.test.ts` should reflect real Ollama output.** The frame shape in Task 6's `framesFor` is recorded, not invented. If you extend the fixtures, capture real frames with `curl` against the running server rather than writing what you expect.
- **Do not add `command.execute` to the vocabulary.** It is the one method with a side effect and it is deliberately out of this cycle.
