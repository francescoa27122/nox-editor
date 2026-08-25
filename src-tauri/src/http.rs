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
use std::sync::{Mutex, OnceLock};

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
/// with `localhost` and is not loopback. Only `[::1]` is listed for IPv6 —
/// `url`'s `host_str()` always brackets an IPv6 host, so a bare `::1` never
/// occurs and a branch for it would be dead code.
pub fn is_loopback(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "http" {
        return false;
    }
    matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

/// The client used for every request, built once rather than per call.
///
/// The configuration is the reason this exists as a shared function at all —
/// not connection reuse, though that comes along for free. `is_loopback`
/// only proves the *first* hop stays on the machine:
///
/// - A server at the checked URL can still reply `3xx` and point anywhere.
///   The default policy follows up to 10 redirects with no host check, and
///   on `307`/`308` it replays the request body — the prompt, i.e. whatever
///   of the user's files went into it — to wherever that is. A loopback
///   client has no legitimate reason to follow a redirect at all, so the
///   policy is "never", not "check each hop and hope nothing is missed".
/// - `reqwest` also inherits `http_proxy`/`https_proxy` from the environment
///   by default, and the proxy matcher has no loopback exclusion. With a
///   proxy set, a "loopback-only" request would ship off machine anyway.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            // No TLS, no proxy, no redirects: nothing here can fail to build.
            .expect("the loopback http client is always constructible")
    })
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

/// Drives the request to completion and reports the outcome.
///
/// The one `nox://http-end` emit and the one cancel-map cleanup both live
/// here, after `run_stream` returns, rather than at each of its exit points.
/// `run_stream` used to inline both of those and clean up only at the bottom
/// of its loop — which left every return *before* the loop (a connection
/// refused, a non-2xx response) skipping cleanup entirely. Connection refused
/// is not a rare edge case here; it is what every attempt looks like before
/// the model server is running, so that leak was on the common path.
async fn stream_into_events(
    app: AppHandle,
    id: String,
    url: String,
    body: serde_json::Value,
    cancel_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let error = run_stream(&app, &id, &url, &body, cancel_rx).await;

    // `try_state` rather than indexing: the app can be tearing down by the
    // time a spawned task gets here, and a missing registry is nothing to
    // panic over — there is nothing left to cancel either way.
    if let Some(state) = app.try_state::<HttpState>() {
        if let Ok(mut cancels) = state.cancels.lock() {
            cancels.remove(&id);
        }
    }

    let _ = app.emit("nox://http-end", EndPayload { id, error });
}

/// Runs one request/stream to its end and returns the error to report, if
/// any. `None` covers both a clean finish and a cancellation — the renderer
/// does not need to tell them apart, since either way nothing more is coming.
async fn run_stream(
    app: &AppHandle,
    id: &str,
    url: &str,
    body: &serde_json::Value,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> Option<String> {
    let response = match http_client().post(url).json(body).send().await {
        Ok(response) => response,
        Err(error) => return Some(error.to_string()),
    };

    if !response.status().is_success() {
        let status = response.status();
        // The body carries the useful part of a failure — surface it rather
        // than a bare status.
        let detail = response.text().await.unwrap_or_default();
        return Some(format!("{status}: {detail}"));
    }

    let mut stream = response.bytes_stream();
    // Frames do not align to line boundaries, so the tail is held as raw
    // bytes rather than decoded per chunk. A multi-byte UTF-8 character split
    // across two chunks would otherwise be decoded as two invalid halves —
    // `from_utf8_lossy` per chunk turns it into two replacement characters,
    // silently and unrecoverably. Holding bytes and decoding only once a full
    // line has arrived means every decode sees a complete character.
    let mut pending: Vec<u8> = Vec::new();

    loop {
        tokio::select! {
            _ = &mut cancel_rx => return None,
            chunk = stream.next() => {
                let Some(chunk) = chunk else {
                    // A trailing line with no newline is still a line.
                    if !pending.is_empty() {
                        let line = String::from_utf8_lossy(&pending).into_owned();
                        if !line.trim().is_empty() {
                            let _ = app.emit("nox://http-line", LinePayload { id: id.to_string(), line });
                        }
                    }
                    return None;
                };
                match chunk {
                    Ok(bytes) => {
                        pending.extend_from_slice(&bytes);
                        while let Some(index) = pending.iter().position(|&b| b == b'\n') {
                            let raw: Vec<u8> = pending.drain(..=index).collect();
                            let line = String::from_utf8_lossy(&raw).trim_end().to_string();
                            if line.is_empty() { continue; }
                            let _ = app.emit("nox://http-line", LinePayload { id: id.to_string(), line });
                        }
                    }
                    Err(error) => return Some(error.to_string()),
                }
            }
        }
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

    /// The failure this prevents: `is_loopback` only checks the URL the
    /// caller supplied — the *first* hop. Reqwest's default redirect policy
    /// follows up to 10 more with no host check at all, so a server sitting
    /// at that first, legitimately-loopback URL could 302 anywhere and this
    /// module would happily fetch it. A second, "attacker" server proves the
    /// point empirically: if it is ever contacted, the redirect was followed
    /// and the whole loopback guarantee is void.
    #[tokio::test]
    async fn redirects_are_never_followed() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let attacker = TcpListener::bind("127.0.0.1:0").expect("bind attacker");
        let attacker_addr = attacker.local_addr().expect("attacker addr");
        let attacker_hit = Arc::new(AtomicBool::new(false));
        {
            let hit = Arc::clone(&attacker_hit);
            std::thread::spawn(move || {
                if let Ok((mut stream, _)) = attacker.accept() {
                    hit.store(true, Ordering::SeqCst);
                    let mut buf = [0u8; 1024];
                    let _ = stream.read(&mut buf);
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
                }
            });
        }

        let redirecting = TcpListener::bind("127.0.0.1:0").expect("bind redirecting");
        let redirecting_addr = redirecting.local_addr().expect("redirecting addr");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = redirecting.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let response = format!(
                    "HTTP/1.1 302 Found\r\nLocation: http://{attacker_addr}/\r\nContent-Length: 0\r\n\r\n"
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });

        let response = http_client()
            .post(format!("http://{redirecting_addr}/"))
            .json(&serde_json::json!({}))
            .send()
            .await
            .expect("request to the redirecting server should succeed");

        assert_eq!(
            response.status(),
            302,
            "the 302 must come back to the caller, not be followed"
        );
        assert!(
            !attacker_hit.load(Ordering::SeqCst),
            "the attacker server must never be contacted"
        );
    }
}
