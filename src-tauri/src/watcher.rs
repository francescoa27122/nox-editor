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

use std::path::{Component, Path, PathBuf};
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

/// The spellings an event path may arrive under for a watch on `root`.
///
/// Two, because the backends disagree: inotify builds paths from the path it
/// was handed, while FSEvents reports the canonical one — on macOS a watch on
/// `/var/folders/…` delivers events as `/private/var/folders/…`. Resolved once
/// at watch time so the hot callback never touches the disk.
fn watch_roots(root: &Path) -> Vec<PathBuf> {
    let mut roots = vec![root.to_path_buf()];
    if let Ok(canonical) = root.canonicalize() {
        if canonical != root {
            roots.push(canonical);
        }
    }
    roots
}

/// Whether `path` sits in a directory not worth watching, judged **relative to
/// the watched root** — the same way `search.rs` judges its patterns, since
/// `OverrideBuilder::new(&root)` makes those root-relative too.
///
/// Scanning the whole absolute path instead is what this replaces, and it was
/// not a nuance: a perfectly ordinary workspace at `~/Projects/dist/myapp` had
/// every one of its events discarded, so external changes produced no tree
/// refresh, no re-index and no reload prompt — silently, and only on that
/// machine's layout. Search kept working, so the two subsystems disagreed
/// about the same folder and the failure looked arbitrary rather than
/// explicable.
fn is_ignored_under(roots: &[PathBuf], path: &Path) -> bool {
    let Some(relative) = roots.iter().find_map(|root| path.strip_prefix(root).ok()) else {
        // Not under any spelling of the root, so there is no "inside the
        // project" to judge against. Forward it: a stray event costs one
        // wasted refresh, whereas dropping one we should have kept is exactly
        // the silent, unreportable failure this function just stopped having.
        return false;
    };
    relative.components().any(|component| match component {
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
    let roots = watch_roots(Path::new(&path));
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        let Some(kind) = classify(&event.kind) else { return };

        let paths: Vec<String> = event
            .paths
            .iter()
            .filter(|p| !is_ignored_under(&roots, p))
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

/// The second, targeted watch: `<root>/.git`, non-recursive, delivering
/// events only for `HEAD` and `index` (their `.lock` shadows included —
/// git writes via lock-and-rename, and which side of the rename an OS
/// reports varies). The recursive workspace watch keeps its DENY on `.git`;
/// this one exists precisely because of it. Debouncing lives in the
/// renderer's GitService, the one place that can be unit-tested.
pub struct GitMetaWatcherState(pub Mutex<Option<RecommendedWatcher>>);

impl Default for GitMetaWatcherState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

fn is_git_meta(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|n| n.to_str()),
        Some("HEAD" | "index" | "HEAD.lock" | "index.lock")
    )
}

/// Watch `<root>/.git`, replacing any previous meta watch. A `.git` that is
/// a *file* (a linked worktree) is watched as itself — a pointer change
/// still signals; the richer HEAD/index detail is out of reach there, and
/// the activation refetch remains the fallback, as §5 requires.
#[tauri::command]
pub fn nox_git_meta_watch(
    app: AppHandle,
    state: State<'_, GitMetaWatcherState>,
    root: String,
) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "io: git meta watcher lock poisoned".to_string())?;
    *guard = None;

    let target = Path::new(&root).join(".git");
    let watch_dir = target.is_dir();

    let emitter = app.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        if classify(&event.kind).is_none() {
            return;
        }
        // For a directory watch, only HEAD/index matter; a file watch (the
        // worktree case) has exactly one path and it is always relevant.
        if watch_dir && !event.paths.iter().any(|p| is_git_meta(p)) {
            return;
        }
        let _ = emitter.emit("nox://git-meta-change", ());
    })
    .map_err(|e| format!("io: could not create git meta watcher ({e})"))?;

    watcher
        .watch(&target, RecursiveMode::NonRecursive)
        .map_err(|e| format!("io: could not watch {} ({e})", target.display()))?;

    *guard = Some(watcher);
    Ok(())
}

/// Stop the meta watch. Safe when nothing is being watched.
#[tauri::command]
pub fn nox_git_meta_unwatch(state: State<'_, GitMetaWatcherState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "io: git meta watcher lock poisoned".to_string())?;
    *guard = None;
    Ok(())
}

/// A second concurrent watch, on Nox's own configuration directory.
///
/// Its own state rather than an entry in `WatcherState`, following
/// `GitMetaWatcherState`: `nox_watch` holds exactly one watcher and replaces
/// it on every call, so reusing it for the config folder would silently stop
/// watching the workspace — no external-change detection, no tree refresh, and
/// no save-overwrite dialog, which is the one that costs unsaved work.
///
/// Recursive, unlike the git meta watch, because `themes/` and `plugins/` are
/// subdirectories and a theme file is the point. That is affordable here in a
/// way it would not be for a project root: this folder is small, it is Nox's
/// own, and nothing in it churns.
pub struct ConfigWatcherState(pub Mutex<Option<RecommendedWatcher>>);

impl Default for ConfigWatcherState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Watch the config directory, replacing any previous config watch.
///
/// The payload carries paths, unlike `nox://git-meta-change` which carries
/// nothing: the git watcher has one subject and any event means "refetch",
/// while this folder holds several files whose changes mean different things.
/// A subscriber that had to re-read all of them on any event would reload the
/// snippets every time a theme was edited.
#[tauri::command]
pub fn nox_config_watch(
    app: AppHandle,
    state: State<'_, ConfigWatcherState>,
    path: String,
) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "io: config watcher lock poisoned".to_string())?;
    // Dropping the old watcher stops its thread before the new one starts.
    *guard = None;

    let emitter = app.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        let Some(kind) = classify(&event.kind) else { return };

        let paths: Vec<String> = event
            .paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();

        if paths.is_empty() {
            return;
        }

        // A failed emit means the window is gone; there is nothing to recover.
        let _ = emitter.emit("nox://config-change", ChangePayload { kind, paths });
    })
    .map_err(|e| format!("io: could not create config watcher ({e})"))?;

    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| format!("io: could not watch {path} ({e})"))?;

    *guard = Some(watcher);
    Ok(())
}

/// Stop the config watch. Safe when nothing is being watched.
#[tauri::command]
pub fn nox_config_unwatch(state: State<'_, ConfigWatcherState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "io: config watcher lock poisoned".to_string())?;
    *guard = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(root: &str) -> Vec<PathBuf> {
        vec![PathBuf::from(root)]
    }

    #[test]
    fn ignores_denied_segments_anywhere_below_the_root() {
        let r = roots("/w");
        assert!(is_ignored_under(&r, Path::new("/w/node_modules/pkg/index.js")));
        assert!(is_ignored_under(&r, Path::new("/w/.git/HEAD")));
        assert!(is_ignored_under(&r, Path::new("/w/crates/core/target/debug/x")));
    }

    #[test]
    fn does_not_ignore_similarly_named_files() {
        let r = roots("/w");
        assert!(!is_ignored_under(&r, Path::new("/w/src/target.ts")));
        assert!(!is_ignored_under(&r, Path::new("/w/src/node_modules.md")));
    }

    /// Guards the defect that made the watcher completely dead for anyone
    /// whose project happened to live under a directory named `dist`,
    /// `node_modules` or `target`: the segments above the watched root are
    /// not part of the project and must not be judged.
    #[test]
    fn does_not_judge_the_segments_above_the_root() {
        let r = roots("/home/me/Projects/dist/myapp");
        assert!(!is_ignored_under(&r, Path::new("/home/me/Projects/dist/myapp/src/a.ts")));
        assert!(!is_ignored_under(&r, Path::new("/home/me/Projects/dist/myapp/dist.ts")));
        // The intent that survives: a denied directory *inside* the project.
        assert!(is_ignored_under(
            &r,
            Path::new("/home/me/Projects/dist/myapp/node_modules/x/index.js"),
        ));
        assert!(is_ignored_under(
            &r,
            Path::new("/home/me/Projects/dist/myapp/dist/bundle.js"),
        ));
    }

    /// A path outside every spelling of the root is forwarded rather than
    /// dropped — see `is_ignored_under`. Without this the fallback could be
    /// "re-scan the absolute path" without any test noticing.
    #[test]
    fn forwards_paths_that_are_not_under_the_root() {
        assert!(!is_ignored_under(&roots("/w"), Path::new("/elsewhere/dist/a.ts")));
    }

    /// Guards the other half of the fallback: FSEvents hands us the canonical
    /// path, so if `watch_roots` did not carry that spelling, nothing under
    /// the root would strip, every path would take the permissive fallback,
    /// and the DENY list would leak a whole `npm install` across the IPC
    /// boundary — trading one silent failure for the storm the module header
    /// says this filter exists to prevent.
    #[test]
    fn filters_denied_directories_under_the_canonical_root_spelling() {
        let dir = std::env::temp_dir().join(format!("nox-canon-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let resolved = watch_roots(&dir);
        let canonical = dir.canonicalize().expect("temp dir canonicalises");

        assert!(is_ignored_under(&resolved, &canonical.join("node_modules/x/index.js")));
        assert!(!is_ignored_under(&resolved, &canonical.join("src/a.ts")));

        let _ = std::fs::remove_dir_all(&dir);
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
        let watch_roots = watch_roots(&dir);
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            let Some(kind) = classify(&event.kind) else { return };
            let paths: Vec<String> = event
                .paths
                .iter()
                .filter(|p| !is_ignored_under(&watch_roots, p))
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

    /// The config watch is recursive and does **not** inherit the workspace
    /// DENY list, which matters for a folder holding `themes/` and
    /// `plugins/`: a theme file two levels down has to arrive, and a plugin
    /// folder called `dist` or `target` — both denied under a project root —
    /// is an ordinary plugin here.
    ///
    /// Exercises the real `notify` backend rather than only our classification
    /// of its output, the way the workspace test above does.
    #[test]
    fn detects_a_nested_config_write_without_the_workspace_deny_list() {
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("nox-configwatch-test-{}", std::process::id()));
        // `target` is on the workspace watcher's DENY list. Under the config
        // folder it is just a folder someone named, and events from it count.
        let nested = dir.join("themes").join("target");
        std::fs::create_dir_all(&nested).expect("create temp dir");

        let (tx, rx) = mpsc::channel::<(&'static str, Vec<String>)>();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            let Some(kind) = classify(&event.kind) else { return };
            let paths: Vec<String> = event
                .paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if !paths.is_empty() {
                let _ = tx.send((kind, paths));
            }
        })
        .expect("create watcher");

        watcher
            .watch(&dir, RecursiveMode::Recursive)
            .expect("watch temp config dir");

        let target = nested.join("solar.json");
        std::fs::write(&target, "{}").expect("write theme file");

        let mut saw_change = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok((_, paths)) => {
                    if paths.iter().any(|p| p.ends_with("solar.json")) {
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

        assert!(saw_change, "expected a watch event for the nested theme file");
    }

    /// The two watches are independent states, which is the whole reason this
    /// exists rather than a second call to `nox_watch`. That command holds one
    /// watcher and replaces it, so sharing it would stop watching the
    /// workspace — and losing that costs the save-overwrite dialog.
    #[test]
    fn config_and_workspace_watchers_are_separate_states() {
        let workspace = WatcherState::default();
        let config = ConfigWatcherState::default();

        assert!(workspace.0.lock().expect("workspace lock").is_none());
        assert!(config.0.lock().expect("config lock").is_none());

        // Distinct `Mutex`es: taking one does not take the other. Written as a
        // held guard rather than two sequential locks, because sequential
        // locks would pass even if both fields named one state.
        let held = workspace.0.lock().expect("hold workspace lock");
        assert!(config.0.try_lock().is_ok(), "config lock must not be the workspace lock");
        drop(held);
    }

    #[test]
    fn git_meta_filter_accepts_head_and_index_only() {
        assert!(is_git_meta(Path::new("/w/.git/HEAD")));
        assert!(is_git_meta(Path::new("/w/.git/index")));
        assert!(is_git_meta(Path::new("/w/.git/index.lock")));
        assert!(!is_git_meta(Path::new("/w/.git/objects/ab/cdef")));
        assert!(!is_git_meta(Path::new("/w/.git/COMMIT_EDITMSG")));
    }

    /// A real `git add` through a real non-recursive watch on `.git`:
    /// the index write must arrive, the object churn must not need to.
    #[test]
    fn detects_a_stage_through_a_real_git_meta_watcher() {
        use std::process::Command;
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("nox-gitmeta-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let run = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .expect("git runs");
            assert!(output.status.success(), "git {args:?} failed");
        };
        run(&["init"]);
        std::fs::write(dir.join("a.txt"), "one\n").expect("write");

        let (tx, rx) = mpsc::channel::<()>();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            if classify(&event.kind).is_none() {
                return;
            }
            if event.paths.iter().any(|p| is_git_meta(p)) {
                let _ = tx.send(());
            }
        })
        .expect("create watcher");
        watcher
            .watch(&dir.join(".git"), RecursiveMode::NonRecursive)
            .expect("watch .git");

        run(&["add", "a.txt"]);

        let saw = rx.recv_timeout(Duration::from_secs(10)).is_ok();
        drop(watcher);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(saw, "expected a meta event for the index write");
    }

    /// The end-to-end guard for the same defect, through a real `notify`
    /// watcher rather than string arithmetic: before the fix this saw zero
    /// surviving events in ten seconds. It also covers the macOS-only half —
    /// FSEvents delivers `/private/var/...` for a watch registered on
    /// `/var/...`, so a root match on the caller's spelling alone strips
    /// nothing and every event falls through the same crack.
    #[test]
    fn watches_a_root_that_lives_under_a_denied_directory() {
        use std::sync::mpsc;
        use std::time::Duration;

        let base = std::env::temp_dir().join(format!("nox-under-dist-test-{}", std::process::id()));
        let root = base.join("dist").join("myapp");
        let nested = root.join("src");
        std::fs::create_dir_all(&nested).expect("create temp dir");

        let (tx, rx) = mpsc::channel::<Vec<String>>();
        let watch_roots = watch_roots(&root);
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            if classify(&event.kind).is_none() {
                return;
            }
            let paths: Vec<String> = event
                .paths
                .iter()
                .filter(|p| !is_ignored_under(&watch_roots, p))
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if !paths.is_empty() {
                let _ = tx.send(paths);
            }
        })
        .expect("create watcher");
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .expect("watch root");

        std::fs::write(nested.join("a.ts"), "x").expect("write file");

        let mut saw = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(paths) => {
                    if paths.iter().any(|p| p.ends_with("a.ts")) {
                        saw = true;
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        drop(watcher);
        let _ = std::fs::remove_dir_all(&base);
        assert!(saw, "expected an event for a write inside a root under dist/");
    }
}
