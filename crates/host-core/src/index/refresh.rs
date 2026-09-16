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
    /// Whether a same-path auto refresh of `root` is due now. Calling this
    /// consumes the answer: the interval restarts from the call, whether or
    /// not the caller goes through with the refresh (a workspace the user
    /// keeps switching to should not queue up refreshes).
    pub fn refresh_due(&self, root: &Path) -> bool {
        let root_id = root_id(&normalize_root(root));
        let mut last = self.last_refresh.lock().unwrap();
        let due = match last.get(&root_id) {
            Some(at) => at.elapsed() >= AUTO_REFRESH_MIN_INTERVAL,
            None => true,
        };
        if due {
            last.insert(root_id, Instant::now());
        }
        due
    }

    /// Mark a `fresh` root `building` ahead of a same-path auto refresh, so
    /// `index.status` tells the truth while the re-walk runs.
    pub fn request_refresh(&self, root: &Path) -> Result<()> {
        let root = normalize_root(root);
        let root_id = root_id(&root);
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
    fn same_path_refresh_is_due_once_then_spacing_kicks_in() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "one\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();

        assert!(store.refresh_due(root.path()), "first set is due");
        assert!(
            !store.refresh_due(root.path()),
            "the interval restarts on the first call"
        );
        // An unrelated root has its own clock.
        let other = tempfile::tempdir().unwrap();
        assert!(store.refresh_due(other.path()));
    }

    #[test]
    fn request_refresh_marks_a_fresh_root_building() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "one\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        store.rebuild(root.path(), IndexLimits::default()).unwrap();
        assert_eq!(store.status(Some(root.path())).unwrap()[0].status, "fresh");

        store.request_refresh(root.path()).unwrap();
        assert_eq!(
            store.status(Some(root.path())).unwrap()[0].status,
            "building"
        );
    }
}
