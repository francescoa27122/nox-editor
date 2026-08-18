//! Nox desktop shell.
//!
//! The Rust side owns the window, the filesystem and (later) anything that
//! needs a real thread — recursive project search, file watching, language
//! server supervision. It deliberately holds no editor state: the document
//! model lives in the renderer where the editing happens.

mod agent;
mod fs;
mod http;
mod lsp;
mod pty;
mod search;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
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
        .plugin(tauri_plugin_dialog::init())
        .manage(agent::AgentState::default())
        .manage(watcher::WatcherState::default())
        .manage(search::SearchState::default())
        .manage(pty::PtyState::default())
        .manage(lsp::LspState::default())
        .manage(http::HttpState::default())
        .invoke_handler(tauri::generate_handler![
            fs::nox_home_dir,
            fs::nox_read_text_file,
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
            http::nox_http_stream,
            http::nox_http_cancel,
            watcher::nox_watch,
            watcher::nox_unwatch,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nox");
}
