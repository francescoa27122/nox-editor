//! The application menu.
//!
//! The *shape* of the menu is decided in the renderer and arrives here as
//! data — see `src/services/menu.ts` for why (the command table lives there,
//! and restating ~140 titles in Rust would be two lists with nothing keeping
//! them in step). This module turns that description into real menu items and
//! nothing else.

use serde::Deserialize;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

pub type Result<T> = std::result::Result<T, String>;

/// `platform/tauri.ts` splits a Rust error on the first `": "` and matches the
/// prefix against six codes, and an unrecognised one is *stripped* along with
/// the message in front of it. Tauri's own errors carry no prefix, so they get
/// this one — otherwise a menu failure would reach the renderer as whatever
/// happened to follow the first colon in Tauri's wording.
fn io(error: impl std::fmt::Display) -> String {
    format!("io: {error}")
}

/// Menu item ids for Nox commands carry this prefix.
///
/// It is what lets the one global menu-event handler in `lib.rs` tell a Nox
/// command from a predefined system item: the system items have ids of their
/// own, and emitting those to the renderer would produce a stream of unknown
/// command warnings for every Copy and Hide.
pub const COMMAND_PREFIX: &str = "nox:cmd:";

/// Where a chosen command id is delivered. Payload is the bare command id.
pub const EVENT: &str = "nox://menu";

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MenuNode {
    #[serde(rename_all = "camelCase")]
    Command {
        command_id: String,
        label: String,
        accelerator: Option<String>,
    },
    Separator,
    #[serde(rename_all = "camelCase")]
    Predefined {
        item: String,
        label: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Submenu {
        label: String,
        role: Option<String>,
        items: Vec<MenuNode>,
    },
}

/// Replace the application menu.
///
/// Built inline rather than handed to a thread, unlike the long-running
/// commands in `pty` and `search`. Every constructor in `tauri::menu` goes
/// through `run_main_thread!`, which looks like a blocking main-thread hop and
/// so looks like a deadlock waiting to happen from a synchronous command — it
/// is not: `tauri-runtime-wry`'s `send_user_message` runs the task inline when
/// it is already on the main thread, and posts to the event loop when it is
/// not (`tauri-runtime-wry/src/lib.rs:235-255`). Both are safe, and building
/// here is what lets the failure reach the renderer instead of an `eprintln`
/// nobody reads.
#[tauri::command]
pub fn nox_set_menu(app: AppHandle, menu: Vec<MenuNode>) -> Result<()> {
    install(&app, &menu)
}

fn install<R: Runtime>(app: &AppHandle<R>, nodes: &[MenuNode]) -> Result<()> {
    // `cfg!` rather than `#[cfg]` so the whole module still compiles in CI's
    // Windows and Linux matrix legs. Windows draws its menu bar *inside* the
    // window frame and Nox turns decorations off there to draw its own title
    // bar, so a menu would land underneath it; and the accelerator argument
    // the menu rests on is WKWebView's, which is neither WebView2's nor
    // WebKitGTK's. Both are recorded as debt in ARCHITECTURE.md §7.
    if !cfg!(target_os = "macos") {
        return Ok(());
    }

    let items = build(app, nodes)?;
    let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(AsRef::as_ref).collect();
    let menu = Menu::with_items(app, &refs).map_err(io)?;
    app.set_menu(menu).map_err(io)?;
    Ok(())
}

fn build<R: Runtime>(
    app: &AppHandle<R>,
    nodes: &[MenuNode],
) -> Result<Vec<Box<dyn IsMenuItem<R>>>> {
    let mut items: Vec<Box<dyn IsMenuItem<R>>> = Vec::with_capacity(nodes.len());

    for node in nodes {
        let item: Box<dyn IsMenuItem<R>> = match node {
            MenuNode::Command {
                command_id,
                label,
                accelerator,
            } => Box::new(
                MenuItem::with_id(
                    app,
                    format!("{COMMAND_PREFIX}{command_id}"),
                    label,
                    // Always enabled. Enablement is re-checked by
                    // `CommandRegistry.execute` when the item is chosen, and
                    // mirroring it here would mean pushing every state change
                    // in the app across the IPC boundary to keep ~130 items
                    // greyed correctly. Recorded as debt.
                    true,
                    accelerator.as_deref(),
                )
                .map_err(io)?,
            ),
            MenuNode::Separator => Box::new(
                PredefinedMenuItem::separator(app).map_err(io)?,
            ),
            MenuNode::Predefined { item, label } => predefined(app, item, label.as_deref())?,
            MenuNode::Submenu { label, role, items } => {
                let children = build(app, items)?;
                let refs: Vec<&dyn IsMenuItem<R>> = children.iter().map(AsRef::as_ref).collect();
                // The id is the whole mechanism: `AppHandle::set_menu` looks
                // the Window and Help submenus up *by id* to hand them to
                // AppKit, so a submenu merely labelled "Window" gets none of
                // the behaviour — no window list, no Bring All to Front.
                match role.as_deref() {
                    None => Box::new(
                        Submenu::with_items(app, label, true, &refs)
                            .map_err(io)?,
                    ),
                    Some(role) => {
                        let id = match role {
                            "window" => tauri::menu::WINDOW_SUBMENU_ID,
                            "help" => tauri::menu::HELP_SUBMENU_ID,
                            other => return Err(format!("io: unknown submenu role {other:?}")),
                        };
                        Box::new(
                            Submenu::with_id_and_items(app, id, label, true, &refs)
                                .map_err(io)?,
                        )
                    }
                }
            }
        };
        items.push(item);
    }

    Ok(items)
}

fn predefined<R: Runtime>(
    app: &AppHandle<R>,
    item: &str,
    label: Option<&str>,
) -> Result<Box<dyn IsMenuItem<R>>> {
    let built = match item {
        "about" => PredefinedMenuItem::about(app, label, None),
        "services" => PredefinedMenuItem::services(app, label),
        "hide" => PredefinedMenuItem::hide(app, label),
        "hideOthers" => PredefinedMenuItem::hide_others(app, label),
        "showAll" => PredefinedMenuItem::show_all(app, label),
        "quit" => PredefinedMenuItem::quit(app, label),
        "undo" => PredefinedMenuItem::undo(app, label),
        "redo" => PredefinedMenuItem::redo(app, label),
        "cut" => PredefinedMenuItem::cut(app, label),
        "copy" => PredefinedMenuItem::copy(app, label),
        "paste" => PredefinedMenuItem::paste(app, label),
        "selectAll" => PredefinedMenuItem::select_all(app, label),
        "minimize" => PredefinedMenuItem::minimize(app, label),
        "maximize" => PredefinedMenuItem::maximize(app, label),
        "fullscreen" => PredefinedMenuItem::fullscreen(app, label),
        // An unknown name is the renderer and this file having drifted, which
        // is worth failing the whole install over: half a menu is harder to
        // notice than none.
        other => return Err(format!("io: unknown predefined menu item {other:?}")),
    };
    Ok(Box::new(built.map_err(io)?))
}

/// The command id a menu event names, or `None` when a system item was chosen.
///
/// Split out of the event handler so the one piece of it with a rule in it is
/// testable without an application around it.
pub fn command_id_from(menu_item_id: &str) -> Option<&str> {
    menu_item_id.strip_prefix(COMMAND_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The failure this prevents: forwarding every predefined item's id to the
    /// renderer, which has no command by that name — so choosing Copy or Hide
    /// would log an unknown-command warning apiece.
    #[test]
    fn only_nox_command_items_reach_the_renderer() {
        assert_eq!(command_id_from("nox:cmd:file.save"), Some("file.save"));
        assert_eq!(command_id_from("Copy"), None);
        assert_eq!(command_id_from("1234"), None);
        // Not a prefix match on the id's interior, either.
        assert_eq!(command_id_from("x-nox:cmd:file.save"), None);
    }

    /// The description is the renderer's shape, and serde is the only thing
    /// checking it. Guards the field names as much as the structure: a
    /// `command_id`/`commandId` mismatch would fail every item at once.
    #[test]
    fn reads_the_description_the_renderer_sends() {
        let raw = r#"[
            {"kind":"submenu","label":"File","items":[
                {"kind":"command","commandId":"file.save","label":"Save","accelerator":"Cmd+S"},
                {"kind":"command","commandId":"file.saveAll","label":"Save All"},
                {"kind":"separator"},
                {"kind":"predefined","item":"quit","label":"Quit Nox"},
                {"kind":"predefined","item":"services"}
            ]}
        ]"#;
        let nodes: Vec<MenuNode> = serde_json::from_str(raw).expect("the renderer's shape parses");

        let [MenuNode::Submenu { label, items, .. }] = nodes.as_slice() else {
            panic!("expected one submenu, got {nodes:?}");
        };
        assert_eq!(label, "File");
        assert!(matches!(
            &items[0],
            MenuNode::Command { command_id, accelerator: Some(chord), .. }
                if command_id == "file.save" && chord == "Cmd+S"
        ));
        assert!(matches!(
            &items[1],
            MenuNode::Command { accelerator: None, .. }
        ));
        assert!(matches!(&items[2], MenuNode::Separator));
        assert!(matches!(
            &items[3],
            MenuNode::Predefined { item, label: Some(text) } if item == "quit" && text == "Quit Nox"
        ));
        assert!(matches!(
            &items[4],
            MenuNode::Predefined { label: None, .. }
        ));
    }
}
