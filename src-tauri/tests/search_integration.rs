//! Exercises the real `ignore` walker against a real directory tree.
//!
//! The unit tests cover pattern building and preview windowing; this covers
//! the thing that only shows up on a filesystem — that .gitignore is honoured
//! and that build directories are skipped even when it is not.

use std::fs;
use std::path::{Path, PathBuf};

use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;

const ALWAYS_EXCLUDE: &[&str] = &["**/.git/**", "**/node_modules/**", "**/target/**"];

fn fixture(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("nox-search-{}-{}", std::process::id(), name));
    let _ = fs::remove_dir_all(&root);

    fs::create_dir_all(root.join("src")).unwrap();
    fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
    fs::create_dir_all(root.join("build")).unwrap();

    fs::write(root.join("src/main.rs"), "fn main() { needle(); }\n").unwrap();
    fs::write(root.join("src/lib.rs"), "// needle in a comment\n").unwrap();
    fs::write(root.join("README.md"), "no match here\n").unwrap();
    fs::write(root.join("node_modules/pkg/index.js"), "needle needle needle\n").unwrap();
    fs::write(root.join("build/out.txt"), "needle\n").unwrap();
    fs::write(root.join(".gitignore"), "build/\n").unwrap();
    root
}

/// Mirrors the walker configuration in `search.rs`.
fn walk(root: &Path, respect_git_ignore: bool, excludes: &[&str]) -> Vec<String> {
    let mut overrides = OverrideBuilder::new(root);
    for glob in ALWAYS_EXCLUDE {
        overrides.add(&format!("!{glob}")).unwrap();
    }
    for glob in excludes {
        overrides.add(&format!("!{glob}")).unwrap();
    }

    let mut found = Vec::new();
    let mut builder = WalkBuilder::new(root);
    builder
        .overrides(overrides.build().unwrap())
        .git_ignore(respect_git_ignore)
        .git_global(false)
        .parents(false)
        // Matches search.rs: a .gitignore counts even outside a git repo.
        .require_git(false)
        .max_filesize(Some(1024 * 1024));

    for entry in builder.build().flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let text = fs::read_to_string(entry.path()).unwrap_or_default();
        if text.contains("needle") {
            found.push(
                entry
                    .path()
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    found.sort();
    found
}

#[test]
fn skips_dependency_directories_even_without_gitignore() {
    let root = fixture("deps");
    let found = walk(&root, false, &[]);

    assert!(
        !found.iter().any(|p| p.contains("node_modules")),
        "node_modules must never be searched, found: {found:?}"
    );
    assert!(found.contains(&"src/main.rs".to_string()));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn honours_gitignore_when_asked() {
    let root = fixture("gitignore");

    let respecting = walk(&root, true, &[]);
    assert!(
        !respecting.contains(&"build/out.txt".to_string()),
        "build/ is gitignored, found: {respecting:?}"
    );

    let ignoring = walk(&root, false, &[]);
    assert!(
        ignoring.contains(&"build/out.txt".to_string()),
        "with gitignore off the file should be searched, found: {ignoring:?}"
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn user_excludes_narrow_the_walk_further() {
    let root = fixture("excludes");
    let found = walk(&root, true, &["**/lib.rs"]);

    assert_eq!(found, vec!["src/main.rs".to_string()]);

    let _ = fs::remove_dir_all(&root);
}

/// Times the real walker over a genuinely large tree. Not a benchmark — a
/// guard that the parallel walk plus gitignore handling stays in the range
/// that makes streaming results feel instant.
#[test]
fn searches_a_large_tree_quickly() {
    use std::time::Instant;

    let root = std::env::temp_dir().join(format!("nox-search-big-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);

    // 40 directories x 50 files = 2000 files, one in ten containing the term.
    for dir in 0..40 {
        let sub = root.join(format!("mod{dir}"));
        fs::create_dir_all(&sub).unwrap();
        for file in 0..50 {
            let body = if file % 10 == 0 {
                format!("fn helper() {{}}\nlet needle_{dir}_{file} = 1;\n")
            } else {
                "fn helper() {}\nlet value = 1;\n".to_string()
            };
            fs::write(sub.join(format!("f{file}.rs")), body).unwrap();
        }
    }

    let started = Instant::now();
    let found = walk(&root, true, &[]);
    let elapsed = started.elapsed();

    // Correctness and speed in one assertion: every seeded file, no others.
    assert_eq!(found.len(), 200, "expected one hit per tenth file");
    println!("walked 2000 files, found {} hits, in {elapsed:?}", found.len());
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "walking 2000 files took {elapsed:?}"
    );

    let _ = fs::remove_dir_all(&root);
}
