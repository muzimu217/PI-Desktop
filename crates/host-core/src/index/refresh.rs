//! Same-path auto refresh for the workspace index.
//!
//! The index has no filesystem watcher, so an in-place edit is invisible to
//! the fast path until the root is re-crawled. [`IndexStore::refresh_due`]
//! spaces those re-crawls at least [`AUTO_REFRESH_MIN_INTERVAL`] apart per
//! root, and [`IndexStore::request_refresh`] marks a fresh root building so
//! `index.status` tells the truth while the re-walk runs.

use anyhow::Result;
use std::path::Path;
use std::time::{Duration, Instant};

use super::{normalize_root, root_id, IndexStatus, IndexStore, RootUpdate};

/// Minimum spacing between same-path auto refreshes of a workspace index.
/// Bounds how long Grep's fast path can keep serving candidates that predate
/// an in-place edit, without paying for a re-walk on every `workspace.set`.
pub const AUTO_REFRESH_MIN_INTERVAL: Duration = Duration::from_secs(600);

impl IndexStore {
    /// Whether a same-path auto refresh of `root` is due now. This only
    /// *peeks* — the interval clock starts when the caller reports the
    /// refresh actually triggered via [`Self::refresh_mark`], so a failed
    /// trigger retries on the next `workspace.set` instead of waiting out
    /// the interval.
    pub fn refresh_due(&self, root: &Path) -> bool {
        let root_id = root_id(&normalize_root(root));
        let last = self.last_refresh.lock().unwrap();
        match last.get(&root_id) {
            Some(at) => at.elapsed() >= AUTO_REFRESH_MIN_INTERVAL,
            None => true,
        }
    }

    /// Start the same-path refresh interval for `root`. Call this only after
    /// the re-walk has actually been triggered (an equivalent fresh rebuild
    /// from a changed-path set marks too — a workspace that was just crawled
    /// has no need for an immediate refresh).
    pub fn refresh_mark(&self, root: &Path) {
        let root_id = root_id(&normalize_root(root));
        self.last_refresh
            .lock()
            .unwrap()
            .insert(root_id, Instant::now());
    }

    /// Mark a `fresh` root `building` ahead of a same-path auto refresh, so
    /// `index.status` tells the truth while the re-walk runs.
    pub fn request_refresh(&self, root: &Path) -> Result<()> {
        let root = normalize_root(root);
        let root_id = root_id(&root);
        // Register the root as building in-process *before* the row flips:
        // a concurrent ensure_index in the window before the spawned rebuild
        // starts must see a live build, not crash residue, or it would
        // trigger a second crawl. If the rebuild never ends up running, the
        // registration lives until process exit — the cheaper side of the
        // ambiguity, since the alternative is a permanently spinning health
        // card.
        self.building_roots.lock().unwrap().insert(root_id.clone());
        self.set_root_status(
            &root_id,
            &root,
            RootUpdate {
                status: IndexStatus::Building,
                file_count: 0,
                indexed_bytes: 0,
                error_count: 0,
                last_error: None,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::IndexLimits;
    use std::fs;

    #[test]
    fn same_path_refresh_is_due_until_marked() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "one\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();

        assert!(store.refresh_due(root.path()), "first peek is due");
        assert!(
            store.refresh_due(root.path()),
            "peeking does not consume the interval"
        );
        store.refresh_mark(root.path());
        assert!(
            !store.refresh_due(root.path()),
            "marking starts the interval"
        );
        // An unrelated root has its own clock.
        let other = tempfile::tempdir().unwrap();
        assert!(store.refresh_due(other.path()));
    }

    #[test]
    fn request_refresh_registers_the_build_in_process() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "one\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        store.rebuild(root.path(), IndexLimits::default()).unwrap();
        assert_eq!(store.status(Some(root.path())).unwrap()[0].status, "fresh");

        store.request_refresh(root.path()).unwrap();
        // The registration must exist before the spawned rebuild starts, or
        // a concurrent ensure_index would read the `building` row as crash
        // residue and re-trigger the crawl.
        assert!(store
            .building_roots
            .lock()
            .unwrap()
            .contains(&root_id(&normalize_root(root.path()))));
        assert_eq!(
            store.status(Some(root.path())).unwrap()[0].status,
            "building"
        );
    }
}
