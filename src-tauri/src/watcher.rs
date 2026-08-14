//! Filesystem watching.
//!
//! One recursive watcher on the open workspace root. Raw `notify` events are
//! filtered and forwarded to the renderer as `nox://fs-change`; **coalescing
//! and debouncing happen on the TypeScript side** so there is exactly one
//! place that decides how long to wait before reacting, and it is the place
//! that can be unit-tested.
//!
//! Noisy directories are filtered here rather than in the renderer: a `cargo
//! build` or `npm install` inside the workspace would otherwise push tens of
//! thousands of events across the IPC boundary before anyone could ignore them.

use std::path::{Component, Path};
use std::sync::Mutex;

use notify::event::{CreateKind, ModifyKind, RemoveKind};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Directory names never worth watching. Matched against whole path segments,
/// so a file called `target.ts` is unaffected.
const DENY: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".svelte-kit",
    ".next",
    "__pycache__",
    ".venv",
    ".DS_Store",
];

pub struct WatcherState(pub Mutex<Option<RecommendedWatcher>>);

impl Default for WatcherState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChangePayload {
    kind: &'static str,
    paths: Vec<String>,
}

fn is_ignored(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name
            .to_str()
            .map(|segment| DENY.contains(&segment))
            .unwrap_or(false),
        _ => false,
    })
}

/// Collapse notify's fine-grained kinds into the four the renderer acts on.
/// Access events are dropped: reading a file is not a change.
fn classify(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(CreateKind::Any | CreateKind::File | CreateKind::Folder | CreateKind::Other) => {
            Some("create")
        }
        EventKind::Remove(RemoveKind::Any | RemoveKind::File | RemoveKind::Folder | RemoveKind::Other) => {
            Some("remove")
        }
        // A rename can arrive as one event with two paths or as a pair of
        // events; the renderer treats it as "re-read the tree" either way.
        EventKind::Modify(ModifyKind::Name(_)) => Some("rename"),
        EventKind::Modify(_) => Some("modify"),
        _ => None,
    }
}

/// Begin watching `path` recursively, replacing any previous watcher.
#[tauri::command]
pub fn nox_watch(app: AppHandle, state: State<'_, WatcherState>, path: String) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "io: watcher lock poisoned".to_string())?;

    // Dropping the old watcher stops its thread before the new one starts.
    *guard = None;

    let emitter = app.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        let Some(kind) = classify(&event.kind) else { return };

        let paths: Vec<String> = event
            .paths
            .iter()
            .filter(|p| !is_ignored(p))
            .map(|p| p.to_string_lossy().into_owned())
            .collect();

        if paths.is_empty() {
            return;
        }

        // A failed emit means the window is gone; there is nothing to recover.
        let _ = emitter.emit("nox://fs-change", ChangePayload { kind, paths });
    })
    .map_err(|e| format!("io: could not create watcher ({e})"))?;

    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| format!("io: could not watch {path} ({e})"))?;

    *guard = Some(watcher);
    Ok(())
}

/// Stop watching. Safe to call when nothing is being watched.
#[tauri::command]
pub fn nox_unwatch(state: State<'_, WatcherState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "io: watcher lock poisoned".to_string())?;
    *guard = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_denied_segments_anywhere_in_the_path() {
        assert!(is_ignored(Path::new("/w/node_modules/pkg/index.js")));
        assert!(is_ignored(Path::new("/w/.git/HEAD")));
        assert!(is_ignored(Path::new("/w/crates/core/target/debug/x")));
    }

    #[test]
    fn does_not_ignore_similarly_named_files() {
        assert!(!is_ignored(Path::new("/w/src/target.ts")));
        assert!(!is_ignored(Path::new("/w/src/node_modules.md")));
    }

    #[test]
    fn drops_access_events() {
        assert_eq!(classify(&EventKind::Access(notify::event::AccessKind::Read)), None);
        assert_eq!(classify(&EventKind::Create(CreateKind::File)), Some("create"));
        assert_eq!(classify(&EventKind::Remove(RemoveKind::File)), Some("remove"));
    }

    /// Exercises the real `notify` backend on this machine, not just our
    /// classification of its output. Without this, "it compiles" would be the
    /// only evidence that watching works at all.
    #[test]
    fn detects_a_write_through_a_real_recursive_watcher() {
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("nox-watch-test-{}", std::process::id()));
        let nested = dir.join("nested");
        std::fs::create_dir_all(&nested).expect("create temp dir");

        let (tx, rx) = mpsc::channel::<(&'static str, Vec<String>)>();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            let Some(kind) = classify(&event.kind) else { return };
            let paths: Vec<String> = event
                .paths
                .iter()
                .filter(|p| !is_ignored(p))
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if !paths.is_empty() {
                let _ = tx.send((kind, paths));
            }
        })
        .expect("create watcher");

        watcher
            .watch(&dir, RecursiveMode::Recursive)
            .expect("watch temp dir");

        // Recursive: the file lands in a subdirectory, not the watched root.
        let target = nested.join("hello.txt");
        std::fs::write(&target, "hello").expect("write file");

        let mut saw_change = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok((_, paths)) => {
                    if paths.iter().any(|p| p.ends_with("hello.txt")) {
                        saw_change = true;
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        drop(watcher);
        let _ = std::fs::remove_dir_all(&dir);

        assert!(saw_change, "expected a watch event for the nested file write");
    }
}
