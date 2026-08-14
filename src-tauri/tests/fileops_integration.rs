//! Exercises the real OS trash against actual files.
//!
//! Kept out of the unit tests because it touches the user's Trash. It exists
//! because the default macOS trash strategy in the `trash` crate drives Finder
//! over AppleScript and can block for two minutes before failing — a failure
//! mode that only shows up when you actually run it.

use std::fs;
use std::time::{Duration, Instant};

fn trash_path(target: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut context = trash::TrashContext::default();
        context.set_delete_method(DeleteMethod::NsFileManager);
        context.delete(target).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(target).map_err(|e| e.to_string())
    }
}

#[test]
fn trashing_is_prompt_and_leaves_siblings_alone() {
    let dir = std::env::temp_dir().join(format!("nox-fileops-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();

    let doomed = dir.join("doomed.txt");
    let sibling = dir.join("sibling.txt");
    fs::write(&doomed, "delete me").unwrap();
    fs::write(&sibling, "keep me").unwrap();

    let started = Instant::now();
    let result = trash_path(&doomed);
    let elapsed = started.elapsed();

    assert!(result.is_ok(), "trash failed: {result:?}");
    assert!(!doomed.exists(), "file should be gone from its original path");
    assert_eq!(fs::read_to_string(&sibling).unwrap(), "keep me");

    // The whole point of the NsFileManager switch: no AppleScript round-trip.
    assert!(
        elapsed < Duration::from_secs(5),
        "trashing took {elapsed:?}; the AppleScript path has regressed"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn trashing_a_directory_removes_the_whole_tree() {
    let dir = std::env::temp_dir().join(format!("nox-fileops-dir-{}", std::process::id()));
    let nested = dir.join("victim").join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("file.txt"), "x").unwrap();

    let victim = dir.join("victim");
    assert!(trash_path(&victim).is_ok());
    assert!(!victim.exists());

    let _ = fs::remove_dir_all(&dir);
}
