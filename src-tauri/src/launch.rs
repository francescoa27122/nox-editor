//! Paths the OS hands to Nox: `nox notes.txt` on the command line, a file
//! opened through Finder on macOS once the app is running, and the argv of a
//! second launch that `tauri-plugin-single-instance` handed over instead of
//! letting it start a window of its own.
//!
//! The paths are **buffered and pulled, never pushed**. Argv exists before the
//! webview has booted, and a macOS `Opened` event can arrive before it too, so
//! an event emitted at that moment lands in a window that is not listening and
//! is lost. Instead the paths wait in [`LaunchState`] until the renderer asks
//! for them with `nox_launch_paths`, and a later arrival only *pokes* the
//! renderer (an empty `nox://open-request` event) to ask again. One buffer,
//! one drain, so a path is never delivered twice and never dropped.
//!
//! All three arrivals converge on [`enqueue`], and the two that carry argv
//! converge on [`paths_from_args`]. That is deliberate: a second launch that
//! filtered its arguments differently from the first would open a file called
//! `800x600` in a running window.
//!
//! Where the plugin is registered, and the two launches exempt from it, is in
//! `lib.rs`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, State};

pub type Result<T> = std::result::Result<T, String>;

/// Fired after paths are queued while the renderer may already be listening.
/// Carries no payload: the renderer drains the buffer in reply.
pub const EVENT: &str = "nox://open-request";

/// Flags that consume the argument after them, so that `--geometry 800x600`
/// does not leave `800x600` behind as a file to open. `geometry.rs` owns the
/// parsing of that flag; this list only has to agree about its name.
const FLAGS_WITH_VALUE: &[&str] = &["--geometry"];

/// Paths waiting for the renderer.
#[derive(Default)]
pub struct LaunchState(Mutex<Vec<String>>);

/// The positional arguments that name something on disk, made absolute
/// against `cwd`.
///
/// `exists` is injected rather than read from the filesystem so the rule is
/// testable without touching disk. A path that does not exist is dropped
/// rather than opened as a new file: `nox --help` and `nox typo.txt` both look
/// like a request for a file, and creating an untitled buffer named for a
/// mistyped flag is worse than opening nothing.
///
/// Made absolute by joining, not by canonicalising: `canonicalize` on Windows
/// returns a `\\?\` path that nothing else in Nox produces, and the renderer
/// compares paths as strings.
pub fn paths_from_args<I>(args: I, cwd: &Path, exists: impl Fn(&Path) -> bool) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut args = args.into_iter().skip(1);
    let mut paths = Vec::new();
    while let Some(arg) = args.next() {
        if FLAGS_WITH_VALUE.contains(&arg.as_str()) {
            args.next();
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        let path = PathBuf::from(&arg);
        let path = if path.is_absolute() { path } else { cwd.join(path) };
        if exists(&path) {
            paths.push(path.to_string_lossy().into_owned());
        }
    }
    paths
}

/// Queue paths for the renderer and poke it in case it is already listening.
pub fn enqueue<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Ok(mut pending) = app.state::<LaunchState>().0.lock() {
        pending.extend(paths);
    }
    // Fire and forget: before the webview exists there is nobody to hear it,
    // and the buffer above is what carries the paths across that gap.
    use tauri::Emitter;
    let _ = app.emit(EVENT, ());
}

/// Read the process arguments and queue whatever names a real path.
pub fn enqueue_argv<R: Runtime>(app: &AppHandle<R>) {
    let cwd = std::env::current_dir().unwrap_or_default();
    enqueue(app, paths_from_args(std::env::args(), &cwd, |path| path.exists()));
}

/// The paths a second launch is asking for, given the argv and working
/// directory `tauri-plugin-single-instance` forwarded.
///
/// A free function beside [`enqueue_second_instance`], which needs an
/// `AppHandle` and so cannot be driven from a unit test. This is the whole of
/// the rule, and the whole of the rule is that there is no second rule.
pub fn second_instance_paths(
    argv: Vec<String>,
    cwd: &str,
    exists: impl Fn(&Path) -> bool,
) -> Vec<String> {
    paths_from_args(argv, Path::new(cwd), exists)
}

/// A second launch, handed over rather than allowed to open a window of its
/// own. Queues whatever it named and brings the running window forward.
///
/// The window is raised whether or not anything was queued: from the outside
/// this launch *is* the click, and a click that appears to do nothing is
/// answered by clicking again.
pub fn enqueue_second_instance<R: Runtime>(app: &AppHandle<R>, argv: Vec<String>, cwd: String) {
    enqueue(app, second_instance_paths(argv, &cwd, |path| path.exists()));
    raise_main_window(app);
}

/// Bring the one window to the front, best effort at every step.
///
/// `unminimize` first: a minimised window can be shown and focused and still
/// not be on screen. Nothing here is propagated, because the paths are already
/// queued by the time it runs and a window that refuses to raise is a worse
/// outcome to turn into a failure than to live with.
fn raise_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The one run event this module cares about. On macOS a Finder "Open With",
/// a dock drop or `open -a Nox file` arrives as `Opened` rather than as argv,
/// and can do so at any point in the app's life.
pub fn handle_run_event<R: Runtime>(app: &AppHandle<R>, event: &tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Opened { urls } = event {
        let paths: Vec<String> = urls
            .iter()
            .filter_map(|url| url.to_file_path().ok())
            .filter(|path| path.exists())
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        enqueue(app, paths);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

/// Hand the renderer every path queued so far, and forget them.
#[tauri::command]
pub fn nox_launch_paths(state: State<'_, LaunchState>) -> Result<Vec<String>> {
    let mut pending = state.0.lock().map_err(|_| "io: launch state poisoned".to_string())?;
    Ok(std::mem::take(&mut *pending))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    fn all_exist(_: &Path) -> bool {
        true
    }

    /// An absolute working directory on the platform the test runs on: `/w`
    /// is relative on Windows, where CI also runs this.
    fn cwd() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\w")
        } else {
            PathBuf::from("/w")
        }
    }

    fn under(cwd: &Path, name: &str) -> String {
        cwd.join(name).to_string_lossy().into_owned()
    }

    /// Guards the split this module exists for: the geometry flag's value must
    /// not come back as a file to open, and neither may any other flag. Does
    /// not check that `geometry_from_args` still sees the flag; its own tests
    /// do that.
    #[test]
    fn skips_flags_and_the_geometry_value() {
        let cwd = cwd();
        let found = paths_from_args(
            args(&["nox", "--geometry", "800x600", "--verbose", "-x", "notes.txt"]),
            &cwd,
            all_exist,
        );
        assert_eq!(found, vec![under(&cwd, "notes.txt")]);
        let joined = paths_from_args(args(&["nox", "--geometry=800x600", "a.md"]), &cwd, all_exist);
        assert_eq!(joined, vec![under(&cwd, "a.md")]);
    }

    /// `nox typo.txt` must open nothing rather than a buffer named for the
    /// typo, and the check must apply to the absolute form.
    #[test]
    fn drops_paths_that_do_not_exist() {
        let cwd = cwd();
        let found = paths_from_args(args(&["nox", "missing.txt", "present.txt"]), &cwd, |path| {
            path.ends_with("present.txt")
        });
        assert_eq!(found, vec![under(&cwd, "present.txt")]);
    }

    /// The single-instance seam. A second launch's argv reaches the running
    /// window through the same filter the first launch used, so `--geometry`
    /// and its value, every other flag and every path that is not there are
    /// dropped exactly once.
    ///
    /// The equality assertion is the point, not the literal one: a copy of
    /// the filter that drifted would still pass a hand-written expectation
    /// written at the same moment as the copy.
    ///
    /// What it does not catch: the plugin handing over argv in a shape this
    /// never sees. The Windows transport joins the arguments with `|` and
    /// splits on it again, which is safe only because `|` cannot appear in a
    /// Windows path.
    #[test]
    fn a_second_launch_is_filtered_like_the_first() {
        let cwd = cwd();
        let cwd_text = cwd.to_string_lossy().into_owned();
        let argv = args(&["nox", "--geometry", "800x600", "--verbose", "missing.txt", "notes.txt"]);
        let real = |path: &Path| !path.ends_with("missing.txt");

        let second = second_instance_paths(argv.clone(), &cwd_text, real);
        assert_eq!(second, vec![under(&cwd, "notes.txt")]);
        assert_eq!(second, paths_from_args(argv, &cwd, real));

        // A bare relaunch names nothing, which must queue nothing: the window
        // is raised by `enqueue_second_instance` rather than by a path.
        assert!(second_instance_paths(args(&["nox"]), &cwd_text, all_exist).is_empty());
    }

    #[test]
    fn keeps_absolute_paths_and_ignores_the_program_name() {
        let cwd = cwd();
        let raw = under(&cwd, "file.rs");
        let elsewhere = cwd.join("elsewhere");
        let found = paths_from_args(args(&["nox", &raw]), &elsewhere, all_exist);
        assert_eq!(found, vec![raw]);
        assert!(paths_from_args(args(&["nox"]), &cwd, all_exist).is_empty());
    }
}
