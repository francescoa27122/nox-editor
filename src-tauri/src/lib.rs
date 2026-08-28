//! Nox desktop shell.
//!
//! The Rust side owns the window, the filesystem and (later) anything that
//! needs a real thread — recursive project search, file watching, language
//! server supervision. It deliberately holds no editor state: the document
//! model lives in the renderer where the editing happens.

mod agent;
mod encoding;
mod fs;
mod geometry;
mod git;
mod http;
mod lsp;
#[cfg(desktop)]
mod menu;
mod pty;
mod search;
mod watcher;
#[cfg(desktop)]
mod window_state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // The end-to-end harness drives the packaged app through a WebDriver
    // server living inside it. **Two gates, deliberately.** The `wdio` feature
    // decides whether the crate is compiled at all — see `Cargo.toml` for why
    // the plugin's own documented `cfg(debug_assertions)` dependency table
    // would not have done that — and `debug_assertions` decides whether it is
    // registered, so that even a release build with the feature turned on
    // starts no server. A thing that lets a local port drive the editor should
    // take more than one mistake to ship.
    //
    // A shadowing `let` rather than a branch in the chain below: `#[cfg]` does
    // not apply to a method call mid-expression, and this keeps the change to
    // the entry point three lines long.
    #[cfg(all(feature = "wdio", debug_assertions))]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .setup(|_app| {
            // `--geometry WxH+X+Y` — a launch-time window size for repeatable
            // desktop walks. See `geometry.rs` for why it is a test affordance
            // rather than a user feature (a Finder-launched .app gets no argv).
            //
            // Applied here rather than in tauri.conf.json because the value is
            // only known at launch, and clamped against the monitor's work
            // area because a window taller than the screen hides its own
            // bottom rows — which reads as a missing status bar rather than as
            // bad input, and has already cost this project a false finding.
            #[cfg(desktop)]
            {
                use tauri::Manager;
                let handle = _app.handle().clone();
                let (launch, warning) = geometry::decide_launch(
                    geometry::geometry_from_args(std::env::args()),
                    window_state::remembered(&handle),
                );
                // Loud and ignored, never silently ignored: a walk that
                // believes it asked for a size it did not get measures
                // everything against the wrong window.
                if let Some(message) = warning {
                    eprintln!("nox: --geometry ignored — {message}");
                }
                if let Some(window) = _app.get_webview_window("main") {
                    match launch {
                        geometry::Launch::Flag(requested) => {
                            apply_geometry(&handle, &window, requested, true);
                        }
                        geometry::Launch::Remembered(remembered) => {
                            if let Some(remembered) = remembered {
                                apply_geometry(&handle, &window, remembered, false);
                            }
                            window_state::watch(&handle, &window);
                        }
                    }
                }
            }

            // Windows keeps its native title bar unless told otherwise, and
            // Nox draws its own — so without this you get two stacked bars.
            // `titleBarStyle` and `hiddenTitle` in tauri.conf.json do not
            // cover it: both are macOS-only and Windows ignores them.
            //
            // Done here rather than in a `tauri.windows.conf.json` because
            // the platform config files are merged as an RFC 7386 merge
            // patch, where an array *replaces* rather than merges. Overriding
            // one field of `app.windows[0]` would mean restating the whole
            // window — size, minimums, theme, background, drag-drop — in a
            // second file, with nothing to catch the two copies drifting.
            #[cfg(windows)]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    // Ignored rather than propagated: a window that keeps its
                    // decorations is cosmetically wrong, and refusing to boot
                    // over it would be worse.
                    let _ = window.set_decorations(false);
                }
            }
            Ok(())
        })
        // One handler for every menu item there will ever be. Predefined
        // system items act on their own and are filtered out here; a Nox
        // command is forwarded by id and dispatched through the registry in
        // the renderer, exactly like a palette entry or a keypress.
        .on_menu_event(|app, event| {
            #[cfg(desktop)]
            if let Some(command_id) = menu::command_id_from(event.id().as_ref()) {
                use tauri::Emitter;
                // Fire and forget: an emit that fails means the window has
                // gone, and there is nothing left to dispatch into.
                let _ = app.emit(menu::EVENT, command_id);
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(agent::AgentState::default())
        .manage(watcher::WatcherState::default())
        .manage(watcher::GitMetaWatcherState::default())
        .manage(watcher::ConfigWatcherState::default())
        .manage(search::SearchState::default())
        .manage(pty::PtyState::default())
        .manage(lsp::LspState::default())
        .manage(http::HttpState::default())
        .invoke_handler(tauri::generate_handler![
            fs::nox_home_dir,
            fs::nox_read_text_file,
            fs::nox_read_encoded_file,
            fs::nox_write_encoded_file,
            fs::nox_write_text_file,
            fs::nox_read_dir,
            fs::nox_exists,
            fs::nox_stat,
            fs::nox_create_dir,
            fs::nox_create_file,
            fs::nox_rename,
            fs::nox_trash,
            fs::nox_copy_file,
            fs::nox_reveal,
            fs::nox_config_dir,
            fs::nox_read_config,
            fs::nox_write_config,
            git::nox_git_file_base,
            git::nox_git_status,
            git::nox_git_branches,
            git::nox_git_stage,
            git::nox_git_unstage,
            git::nox_git_commit,
            git::nox_git_switch,
            http::nox_http_stream,
            http::nox_http_cancel,
            watcher::nox_watch,
            watcher::nox_unwatch,
            watcher::nox_git_meta_watch,
            watcher::nox_git_meta_unwatch,
            watcher::nox_config_watch,
            watcher::nox_config_unwatch,
            search::nox_search_start,
            search::nox_search_cancel,
            agent::nox_agent_spawn,
            agent::nox_agent_send,
            agent::nox_agent_kill,
            agent::nox_agent_kill_all,
            pty::nox_pty_open,
            pty::nox_pty_write,
            pty::nox_pty_resize,
            pty::nox_pty_close,
            pty::nox_pty_close_all,
            lsp::nox_lsp_start,
            lsp::nox_lsp_send,
            lsp::nox_lsp_stop,
            lsp::nox_lsp_stop_all,
            #[cfg(desktop)]
            menu::nox_set_menu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nox");
}

/// Size and place the main window — for `--geometry`, and for the geometry the
/// last session left behind (`window_state`), which is clamped by the same
/// call rather than by a second copy of the rule.
///
/// `announce` echoes what it resolved to on stdout, so a walk harness can
/// anchor on the number rather than measuring a screenshot (screenshots come
/// back scaled by the display's factor, so measuring them is how points and
/// pixels get confused). Only the flag announces: a restored window printing
/// that line on every ordinary launch would be a second, unasked-for source of
/// the string the harness greps for.
#[cfg(desktop)]
fn apply_geometry<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    requested: geometry::Geometry,
    announce: bool,
) {
    // The minimums come from tauri.conf.json rather than being restated here:
    // two copies of 640x420 would drift, and a window below its own minimum
    // renders a layout no user could ever produce.
    let config = app.config();
    let window_config = config.app.windows.first();
    let minimum = (
        window_config.and_then(|w| w.min_width).unwrap_or(0.0),
        window_config.and_then(|w| w.min_height).unwrap_or(0.0),
    );

    // Work area, not full monitor size: the menu bar and dock are not usable
    // space, and treating them as usable is exactly the off-by-a-menu-bar that
    // pushes the status bar off screen.
    let (visible, origin) = match window.current_monitor() {
        Ok(Some(monitor)) => {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            (
                (
                    f64::from(area.size.width) / scale,
                    f64::from(area.size.height) / scale,
                ),
                // The work area does not start at the screen origin — the menu
                // bar sits above it. Offsets are therefore relative to the
                // usable area, so `+0+0` means its top-left corner rather than
                // a y that macOS will silently push down.
                (
                    f64::from(area.position.x) / scale,
                    f64::from(area.position.y) / scale,
                ),
            )
        }
        // No monitor to measure against means no clamp is possible. Honour the
        // request rather than inventing a bound.
        _ => ((f64::INFINITY, f64::INFINITY), (0.0, 0.0)),
    };

    let fitted = geometry::clamp(requested, visible, minimum);

    if let Err(error) = window.set_size(tauri::LogicalSize::new(fitted.width, fitted.height)) {
        eprintln!("nox: --geometry could not set the size — {error}");
        return;
    }

    match fitted.position {
        Some((x, y)) => {
            if let Err(error) =
                window.set_position(tauri::LogicalPosition::new(x + origin.0, y + origin.1))
            {
                eprintln!("nox: --geometry could not set the position — {error}");
                return;
            }
        }
        // tauri.conf.json asks for a centred window, but centring happened at
        // the old size, so a size-only --geometry would leave it off-centre.
        None => {
            let _ = window.center();
        }
    }

    // Echo the resolved request, in absolute screen points so it matches what
    // any external tool measures.
    //
    // Reading the values back off the window instead was tried and reverted:
    // `set_position` is asynchronous on macOS, so `outer_position()` called
    // immediately after it returns the *previous* position — measured, it
    // reported the centred +96+77 for a window that had already been placed at
    // +0+33. A read-back that races is worse than arithmetic, because it looks
    // authoritative. If you need the window's true bounds later, read them
    // with CoreGraphics (`scripts/window-id.swift`).
    if !announce {
        return;
    }

    match fitted.position {
        Some((x, y)) => println!(
            "nox: geometry {}x{}+{}+{}",
            fitted.width,
            fitted.height,
            x + origin.0,
            y + origin.1
        ),
        None => println!("nox: geometry {}x{}", fitted.width, fitted.height),
    }
}
