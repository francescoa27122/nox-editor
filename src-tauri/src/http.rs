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
