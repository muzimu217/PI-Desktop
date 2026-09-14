//! Single source of truth for the workspace *visible set*.
//!
//! Grep's candidate walk and the workspace index crawler must agree on which
//! files are visible, otherwise the P2-B literal fast path could return files
//! the fallback search would not (or miss files it would). This module owns the
//! one walker configuration both callers build, so that agreement is structural
//! rather than coincidental.
//!
//! Scope: this covers *rule-based* visibility (hidden files, `.gitignore`,
//! global git excludes, `.pi-desktopignore`, parent scoping, vendor pruning).
//! Content-based ingest filters the index applies (binary-extension blacklist,
//! per-file size cap) are intentionally NOT here — they decide what content is
//! worth indexing, not what is visible, and the fast path must not treat the
//! index as complete while they are in play.

use ignore::overrides::Override;
use ignore::WalkBuilder;
use std::path::Path;

/// Directory/file names that are never part of the visible set for a
/// whole-workspace search, regardless of git state. They are tooling or scan
/// metadata, not workspace content.
pub const VENDOR_COMPONENTS: &[&str] = &[".git", ".pi-desktopignore", "node_modules", "target"];

/// Build the shared visible-set walker for `root`.
///
/// `scoped` mirrors Grep's scoped search: when the caller names a path
/// explicitly, parent ignore files and the vendor-directory prune are dropped
/// so an explicitly named directory stays reachable. The index crawler always
/// searches the whole root (`scoped == false`).
pub fn visible_walker(root: &Path, scoped: bool) -> WalkBuilder {
    let mut walker = WalkBuilder::new(root);
    walker
        .hidden(false)
        .git_ignore(true)
        // Global git excludes differ per machine; the visible set must be a
        // property of the workspace alone, so they are off for everyone.
        .git_global(false)
        .git_exclude(true)
        .parents(!scoped)
        .add_custom_ignore_filename(".pi-desktopignore");
    if !scoped {
        if let Ok(overrides) = root_ignore_overrides(root) {
            walker.overrides(overrides);
        }
    }
    walker
}

/// The workspace root's own `.pi-desktopignore` constrains the whole scan;
/// `add_custom_ignore_filename` only covers ignore files found while walking
/// subdirectories, so the root file is loaded as an override instead.
fn root_ignore_overrides(root: &Path) -> anyhow::Result<Override> {
    let mut builder = ignore::overrides::OverrideBuilder::new(root);
    if let Ok(rules) = std::fs::read_to_string(root.join(".pi-desktopignore")) {
        for line in rules.lines().map(str::trim) {
            if !line.is_empty() && !line.starts_with('#') {
                let _ = builder.add(&format!("!{line}"));
            }
        }
    }
    Ok(builder.build()?)
}

/// Whether a walked path sits under a [`VENDOR_COMPONENTS`] entry. Only applied
/// to a whole-workspace (unscoped) search, matching [`visible_walker`]'s scoped
/// behaviour.
pub fn is_vendor_path(root: &Path, path: &Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative.components().any(|component| {
        VENDOR_COMPONENTS
            .iter()
            .any(|vendor| component.as_os_str() == *vendor)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn visible_from_walker(root: &Path, scoped: bool) -> Vec<String> {
        let mut paths: Vec<String> = visible_walker(root, scoped)
            .build()
            .flatten()
            .filter(|entry| entry.file_type().is_some_and(|kind| kind.is_file()))
            .map(|entry| entry.path().to_path_buf())
            .filter(|path| scoped || !is_vendor_path(root, path))
            .map(|path| {
                path.strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        paths.sort();
        paths
    }

    #[test]
    fn vendor_and_custom_ignore_drop_from_whole_workspace_visibility() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.path().join(".git")).unwrap();
        fs::write(root.path().join(".pi-desktopignore"), "private.txt\n").unwrap();
        fs::write(root.path().join("keep.txt"), "keep\n").unwrap();
        fs::write(root.path().join("private.txt"), "secret\n").unwrap();
        fs::write(root.path().join("node_modules/pkg/a.js"), "x\n").unwrap();
        fs::write(root.path().join(".git/config"), "[core]\n").unwrap();

        assert_eq!(visible_from_walker(root.path(), false), vec!["keep.txt"]);
    }

    #[test]
    fn explicitly_named_vendor_directory_stays_reachable() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
        fs::write(root.path().join("node_modules/pkg/index.js"), "x\n").unwrap();

        // Scoped: no vendor prune, so the named directory is visible.
        assert_eq!(
            visible_from_walker(&root.path().join("node_modules/pkg"), true),
            vec!["index.js"]
        );
    }

    #[test]
    fn root_pi_desktopignore_constrains_the_whole_scan() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("sub")).unwrap();
        fs::write(root.path().join(".pi-desktopignore"), "*.log\n").unwrap();
        fs::write(root.path().join("app.log"), "x\n").unwrap();
        fs::write(root.path().join("sub/deep.log"), "x\n").unwrap();
        fs::write(root.path().join("main.rs"), "x\n").unwrap();

        assert_eq!(visible_from_walker(root.path(), false), vec!["main.rs"]);
    }
}
