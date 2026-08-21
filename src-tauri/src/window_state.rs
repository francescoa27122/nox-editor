//! Remembering the window between launches.
//!
//! A desktop editor that opens at the same centred 1320x860 however you left
//! it is one you have to re-arrange every morning. This module records the
//! window's size and position and hands them back to `lib.rs`'s
//! `apply_geometry`, which clamps them to the current work area exactly the
//! way it clamps `--geometry` — one clamp, in `geometry.rs`, tested there.
//!
//! **Why Rust and not a service.** The renderer could observe the window
//! through `Platform` and write the file through `writeConfigFile`, but the
//! *restore* cannot: it has to land before the webview exists, or the window
//! visibly jumps after the first paint. Rust already owns the window (see the
//! crate doc), already resolves the config directory, and is where the flag it
//! must lose to is parsed.
//!
//! **Why its own file and not `session.json`.** Three reasons, each on its
//! own sufficient: `session.json` is only read when
//! `workbench.restoreSession` is on, and forgetting your window because you
//! turned off tab restore is not what anyone asks for; `SessionService.clear()`
//! blanks that file, and clearing your tabs should not move your window; and
//! Rust would have to understand a versioned, migrated renderer schema to read
//! one number out of it. `window.json` sits beside it in the same directory.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use tauri::{Manager, WindowEvent};

use crate::geometry::{self, Geometry};

const FILE: &str = "window.json";

/// How long the window must be still before its geometry is written.
///
/// 400 ms, the same figure `services/session.ts` debounces on. A drag-resize
/// emits an event per frame and this is what keeps that off the disk: one
/// write per gesture, not sixty per second.
const DEBOUNCE: Duration = Duration::from_millis(400);

/// How long after launch the window's own report of itself is untrustworthy.
///
/// `set_position` is asynchronous on macOS — `lib.rs`'s echo comment records
/// measuring the *previous* position immediately after setting it. A restore
/// read back too soon would therefore record where the window used to be, and
/// since that is usually the centred default, the remembered position would
/// creep back to centre a launch at a time. Nothing in the first second is
/// worth recording anyway.
const SETTLE: Duration = Duration::from_secs(1);

/// The geometry the last session left behind, or `None` when there is none to
/// read. Absence and corruption are the same answer here, deliberately: see
/// `geometry::parse_saved`.
pub fn remembered(app: &tauri::AppHandle) -> Option<Geometry> {
    let path = crate::fs::config_path(app, FILE).ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    geometry::parse_saved(&raw)
}

/// Record the window's size and position from now on.
///
/// Call this only on an ordinary launch — `geometry::Launch` explains why a
/// `--geometry` run must not write.
pub fn watch(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let installed = Instant::now();
    let label = window.label().to_string();
    let (tx, rx) = mpsc::channel::<()>();

    let writer_app = app.clone();
    let writer_label = label.clone();
    std::thread::spawn(move || loop {
        // Block for the first event of a burst; a still window costs nothing.
        if rx.recv().is_err() {
            return;
        }
        // Then swallow the rest of the gesture. Trailing edge, not leading:
        // the interesting value is where the drag ended.
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(()) => continue,
                Err(RecvTimeoutError::Timeout) => break,
                // The window is gone and took the sender with it. There is
                // nothing left to read the geometry off.
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let Some(window) = writer_app.get_webview_window(&writer_label) else {
            return;
        };
        write(&writer_app, &window, installed);
    });

    let event_app = app.clone();
    window.on_window_event(move |event| match event {
        // Only a ping: the geometry is read in the writer thread, at least
        // DEBOUNCE later, because reading it here can catch the window
        // mid-move — see SETTLE.
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            let _ = tx.send(());
        }
        // A resize in the last 400 ms would otherwise die with the window, and
        // "I made it bigger and quit" is exactly when someone expects it to be
        // remembered. Synchronous: after this returns there is no window left
        // to measure.
        WindowEvent::CloseRequested { .. } => {
            if let Some(window) = event_app.get_webview_window(&label) {
                write(&event_app, &window, installed);
            }
        }
        _ => {}
    });
}

/// The window as it is now, in the work-area-relative logical points
/// `window.json` holds — or `None` when there is nothing worth remembering.
fn snapshot(window: &tauri::WebviewWindow) -> Option<Geometry> {
    let fullscreen = window.is_fullscreen().ok()?;
    let maximized = window.is_maximized().ok()?;
    if !geometry::is_persistable(fullscreen, maximized) {
        return None;
    }

    let scale = window.scale_factor().ok()?;
    let size = window.inner_size().ok()?;
    let position = window.outer_position().ok()?;

    // Inner size against outer position is not a mismatch: `set_size` sets the
    // inner size and `set_position` the outer one, so this is the same pair
    // `apply_geometry` writes, read back the same way round.
    //
    // The work area's own origin comes off, because that is the space
    // `geometry::clamp` works in and the space `--geometry` means. See
    // `SavedWindow` for why absolute screen coordinates would be worse.
    let origin = match window.current_monitor() {
        Ok(Some(monitor)) => {
            let monitor_scale = monitor.scale_factor();
            let area = monitor.work_area();
            (
                f64::from(area.position.x) / monitor_scale,
                f64::from(area.position.y) / monitor_scale,
            )
        }
        _ => (0.0, 0.0),
    };

    Some(Geometry {
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
        position: Some((
            f64::from(position.x) / scale - origin.0,
            f64::from(position.y) / scale - origin.1,
        )),
    })
}

fn write(app: &tauri::AppHandle, window: &tauri::WebviewWindow, installed: Instant) {
    if installed.elapsed() < SETTLE {
        return;
    }
    let Some(geometry) = snapshot(window) else {
        return;
    };
    let Some(raw) = geometry::serialise_saved(geometry) else {
        return;
    };
    let Ok(path) = crate::fs::config_path(app, FILE) else {
        return;
    };
    // Swallowed rather than surfaced. Nothing the user did failed: the window
    // is still exactly where they put it, and a full disk that cost them their
    // remembered geometry has already told them about it through the session
    // write, which does have a signal (`SessionService.error`).
    let _ = crate::fs::write_config_atomically(&path, &raw);
}
