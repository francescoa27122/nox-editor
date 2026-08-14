//! Nox desktop shell.
//!
//! The Rust side owns the window, the filesystem and (later) anything that
//! needs a real thread — recursive project search, file watching, language
//! server supervision. It deliberately holds no editor state: the document
//! model lives in the renderer where the editing happens.

mod agent;
mod fs;
mod search;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(agent::AgentState::default())
        .manage(watcher::WatcherState::default())
        .manage(search::SearchState::default())
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
            watcher::nox_watch,
            watcher::nox_unwatch,
            search::nox_search_start,
            search::nox_search_cancel,
            agent::nox_agent_spawn,
            agent::nox_agent_send,
            agent::nox_agent_kill,
            agent::nox_agent_kill_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nox");
}
