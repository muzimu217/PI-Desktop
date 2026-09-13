//! Host-owned workspace content index storage for the P2-A foundation.
//!
//! This module deliberately exposes only lifecycle operations. It does not
//! participate in Grep execution yet; that integration belongs to P2-B after
//! the result-equivalence contract has executable coverage.

use anyhow::{Context, Result};
use ignore::WalkBuilder;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_FILES: usize = 50_000;
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
pub const MAX_INDEXED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const INDEX_SCHEMA_VERSION: i64 = 1;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexStatus {
    Fresh,
    Building,
    Stale,
    Failed,
    Partial,
    Disabled,
    SkippedOverLimit,
}

impl IndexStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Building => "building",
            Self::Stale => "stale",
            Self::Failed => "failed",
            Self::Partial => "partial",
            Self::Disabled => "disabled",
            Self::SkippedOverLimit => "skipped_over_limit",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct IndexLimits {
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub max_indexed_bytes: u64,
}

impl Default for IndexLimits {
    fn default() -> Self {
        Self {
            max_files: MAX_FILES,
            max_file_bytes: MAX_FILE_BYTES,
            max_indexed_bytes: MAX_INDEXED_BYTES,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootStatus {
    pub root_id: String,
    pub root_path: String,
    pub status: String,
    pub file_count: i64,
    pub indexed_bytes: i64,
    pub error_count: i64,
    pub last_error: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
struct IndexedFile {
    rel_path: String,
    size: u64,
    mtime_ms: i64,
    body: String,
}

#[derive(Debug, Clone, Default)]
struct ScanResult {
    files: Vec<IndexedFile>,
    indexed_bytes: u64,
    error_count: i64,
    over_limit: bool,
}

#[derive(Debug)]
struct RootUpdate<'a> {
    status: IndexStatus,
    file_count: i64,
    indexed_bytes: i64,
    error_count: i64,
    last_error: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct IndexStore {
    path: PathBuf,
}

impl IndexStore {
    pub fn open(data_dir: &Path) -> Result<Self> {
        let directory = data_dir.join("index");
        std::fs::create_dir_all(&directory).context("create index directory")?;
        let path = directory.join("index.db");
        let store = Self { path };
        if let Err(error) = store.initialize() {
            store.quarantine_corrupt_db();
            store
                .initialize()
                .with_context(|| format!("rebuild index database after failure: {error}"))?;
        }
        Ok(store)
    }

    pub fn status(&self, root: Option<&Path>) -> Result<Vec<RootStatus>> {
        let connection = self.connection()?;
        let normalized = root.map(normalize_root);
        let root_filter = normalized
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned());
        let mut statement = connection.prepare(
            "SELECT root_id, root_path, status, file_count, indexed_bytes, error_count, last_error, updated_at
             FROM indexed_roots
             WHERE (?1 IS NULL OR root_path = ?1)
             ORDER BY root_path",
        )?;
        let rows = statement.query_map([root_filter], |row| {
            Ok(RootStatus {
                root_id: row.get(0)?,
                root_path: row.get(1)?,
                status: row.get(2)?,
                file_count: row.get(3)?,
                indexed_bytes: row.get(4)?,
                error_count: row.get(5)?,
                last_error: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn rebuild(&self, root: &Path, limits: IndexLimits) -> Result<RootStatus> {
        let root = normalize_root(root);
        if !root.is_dir() {
            anyhow::bail!("INDEX_ROOT_NOT_FOUND: {}", root.display());
        }
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
        )?;

        let scan = scan_root(&root, limits);
        let connection = self.connection()?;
        match scan {
            Ok(result) => {
                replace_root_files(&connection, &root_id, &result.files)?;
                let status = if result.over_limit {
                    IndexStatus::SkippedOverLimit
                } else if result.error_count > 0 {
                    IndexStatus::Partial
                } else {
                    IndexStatus::Fresh
                };
                let message = if result.over_limit {
                    Some("index budget exceeded; fast-path use is disabled".to_string())
                } else if result.error_count > 0 {
                    Some(format!(
                        "{} file(s) could not be indexed",
                        result.error_count
                    ))
                } else {
                    None
                };
                upsert_root(
                    &connection,
                    &root_id,
                    &root,
                    RootUpdate {
                        status,
                        file_count: result.files.len() as i64,
                        indexed_bytes: result.indexed_bytes as i64,
                        error_count: result.error_count,
                        last_error: message.as_deref(),
                    },
                )?;
            }
            Err(error) => {
                upsert_root(
                    &connection,
                    &root_id,
                    &root,
                    RootUpdate {
                        status: IndexStatus::Failed,
                        file_count: 0,
                        indexed_bytes: 0,
                        error_count: 1,
                        last_error: Some(&error.to_string()),
                    },
                )?;
            }
        }
        self.status(Some(&root))?
            .into_iter()
            .next()
            .context("index status missing after rebuild")
    }

    pub fn clear(&self, root: Option<&Path>) -> Result<usize> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let count = if let Some(root) = root {
            let normalized = normalize_root(root);
            let root_id = transaction
                .query_row(
                    "SELECT root_id FROM indexed_roots WHERE root_path = ?1",
                    [normalized.to_string_lossy().into_owned()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let Some(root_id) = root_id else {
                return Ok(0);
            };
            transaction.execute(
                "DELETE FROM file_content_fts WHERE root_id = ?1",
                [&root_id],
            )?;
            transaction.execute("DELETE FROM indexed_roots WHERE root_id = ?1", [&root_id])?
        } else {
            transaction.execute("DELETE FROM file_content_fts", [])?;
            transaction.execute("DELETE FROM indexed_roots", [])?
        };
        transaction.commit()?;
        Ok(count)
    }

    fn connection(&self) -> Result<Connection> {
        fts::open(&self.path)
    }

    fn initialize(&self) -> Result<()> {
        let connection = self.connection()?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version != 0 && version != INDEX_SCHEMA_VERSION {
            anyhow::bail!("unsupported index schema version {version}");
        }
        if version == 0 {
            connection.execute_batch(fts::SCHEMA)?;
            connection.pragma_update(None, "user_version", INDEX_SCHEMA_VERSION)?;
        }
        let integrity: String =
            connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            anyhow::bail!("index database integrity check failed: {integrity}");
        }
        Ok(())
    }

    fn quarantine_corrupt_db(&self) {
        if !self.path.exists() {
            return;
        }
        let stamp = now_ms();
        let quarantined = self.path.with_extension(format!("db.corrupt-{stamp}"));
        let _ = std::fs::rename(&self.path, quarantined);
        let _ = std::fs::remove_file(self.path.with_extension("db-wal"));
        let _ = std::fs::remove_file(self.path.with_extension("db-shm"));
    }

    fn set_root_status(&self, root_id: &str, root: &Path, update: RootUpdate<'_>) -> Result<()> {
        let connection = self.connection()?;
        upsert_root(&connection, root_id, root, update)
    }
}

mod fts {
    use super::*;

    pub const SCHEMA: &str = r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS indexed_roots (
            root_id TEXT PRIMARY KEY,
            root_path TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK (status IN ('fresh','building','stale','failed','partial','disabled','skipped_over_limit')),
            file_count INTEGER NOT NULL DEFAULT 0,
            indexed_bytes INTEGER NOT NULL DEFAULT 0,
            error_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS files (
            root_id TEXT NOT NULL REFERENCES indexed_roots(root_id) ON DELETE CASCADE,
            rel_path TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime_ms INTEGER NOT NULL,
            PRIMARY KEY (root_id, rel_path)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS file_content_fts USING fts5(
            root_id UNINDEXED,
            rel_path UNINDEXED,
            body,
            tokenize = 'trigram'
        );
    "#;

    pub fn open(path: &Path) -> Result<Connection> {
        let connection = Connection::open(path).context("open index database")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        Ok(connection)
    }
}

fn scan_root(root: &Path, limits: IndexLimits) -> Result<ScanResult> {
    let mut result = ScanResult::default();
    let mut walker = WalkBuilder::new(root);
    walker
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .add_custom_ignore_filename(".pi-desktopignore");
    // `add_custom_ignore_filename` applies to ignore files found in walked
    // subdirectories only; the workspace root's own `.pi-desktopignore` is
    // loaded as an override so its rules constrain the whole scan, matching
    // the Grep tool's ignore semantics.
    let mut overrides = ignore::overrides::OverrideBuilder::new(root);
    if let Ok(rules) = std::fs::read_to_string(root.join(".pi-desktopignore")) {
        for line in rules.lines().map(str::trim) {
            if !line.is_empty() && !line.starts_with('#') {
                let _ = overrides.add(&format!("!{line}"));
            }
        }
    }
    if let Ok(overrides) = overrides.build() {
        walker.overrides(overrides);
    }
    for entry in walker.build() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                result.error_count += 1;
                continue;
            }
        };
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
            || is_ignored_path(root, entry.path())
        {
            continue;
        }
        if result.files.len() >= limits.max_files {
            result.over_limit = true;
            break;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                result.error_count += 1;
                continue;
            }
        };
        let size = metadata.len();
        if size > limits.max_file_bytes {
            continue;
        }
        if result.indexed_bytes.saturating_add(size) > limits.max_indexed_bytes {
            result.over_limit = true;
            break;
        }
        let body = match std::fs::read_to_string(entry.path()) {
            Ok(body) => body,
            Err(_) => {
                result.error_count += 1;
                continue;
            }
        };
        let rel_path = entry
            .path()
            .strip_prefix(root)
            .map(normalize_rel_path)
            .unwrap_or_else(|_| normalize_rel_path(entry.path()));
        result.indexed_bytes = result.indexed_bytes.saturating_add(size);
        result.files.push(IndexedFile {
            rel_path,
            size,
            mtime_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0),
            body,
        });
    }
    Ok(result)
}

fn is_ignored_path(root: &Path, path: &Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        // `.pi-desktopignore` is scan configuration, not workspace content.
        matches!(
            name.as_ref(),
            ".git" | ".pi-desktopignore" | "node_modules" | "target"
        )
    }) || path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "7z" | "a"
                    | "bmp"
                    | "class"
                    | "dll"
                    | "dmg"
                    | "exe"
                    | "gif"
                    | "ico"
                    | "jar"
                    | "jpeg"
                    | "jpg"
                    | "mov"
                    | "mp3"
                    | "mp4"
                    | "o"
                    | "obj"
                    | "pdf"
                    | "png"
                    | "so"
                    | "tar"
                    | "wasm"
                    | "webp"
                    | "woff"
                    | "woff2"
                    | "zip"
            )
        })
}

fn replace_root_files(connection: &Connection, root_id: &str, files: &[IndexedFile]) -> Result<()> {
    let transaction = connection.unchecked_transaction()?;
    transaction.execute("DELETE FROM files WHERE root_id = ?1", [root_id])?;
    transaction.execute("DELETE FROM file_content_fts WHERE root_id = ?1", [root_id])?;
    for file in files {
        transaction.execute(
            "INSERT INTO files (root_id, rel_path, size, mtime_ms) VALUES (?1, ?2, ?3, ?4)",
            params![root_id, file.rel_path, file.size as i64, file.mtime_ms],
        )?;
        transaction.execute(
            "INSERT INTO file_content_fts (root_id, rel_path, body) VALUES (?1, ?2, ?3)",
            params![root_id, file.rel_path, file.body],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn upsert_root(
    connection: &Connection,
    root_id: &str,
    root: &Path,
    update: RootUpdate<'_>,
) -> Result<()> {
    connection.execute(
        "INSERT INTO indexed_roots (root_id, root_path, status, file_count, indexed_bytes, error_count, last_error, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(root_id) DO UPDATE SET root_path=excluded.root_path, status=excluded.status,
         file_count=excluded.file_count, indexed_bytes=excluded.indexed_bytes, error_count=excluded.error_count,
         last_error=excluded.last_error, updated_at=excluded.updated_at",
        params![
            root_id,
            normalize_root(root).to_string_lossy().into_owned(),
            update.status.as_str(),
            update.file_count,
            update.indexed_bytes,
            update.error_count,
            update.last_error,
            now_ms()
        ],
    )?;
    Ok(())
}

pub fn normalize_root(path: &Path) -> PathBuf {
    let mut text = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = text.strip_prefix("//?/") {
        text = rest.to_string();
    }
    let candidate = PathBuf::from(text);
    candidate.canonicalize().unwrap_or(candidate)
}

pub fn normalize_rel_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub fn root_id(root: &Path) -> String {
    let mut hash = Sha256::new();
    hash.update(normalize_root(root).to_string_lossy().as_bytes());
    hex::encode(hash.finalize())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn normalizes_root_and_relative_paths() {
        let directory = tempfile::tempdir().unwrap();
        let root = normalize_root(&PathBuf::from(format!("{}/", directory.path().display())));
        assert_eq!(root, directory.path().canonicalize().unwrap());
        assert_eq!(normalize_rel_path(Path::new("src\\lib.rs")), "src/lib.rs");
        assert_eq!(root_id(&root), root_id(&root));
    }

    #[test]
    fn empty_store_is_safe() {
        let data = tempfile::tempdir().unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        assert!(store.status(None).unwrap().is_empty());
        assert_eq!(store.clear(None).unwrap(), 0);
    }

    #[test]
    fn rebuild_indexes_text_and_ignores_binary_and_vendor_dirs() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.path().join(".git")).unwrap();
        fs::write(root.path().join(".pi-desktopignore"), "private.txt\n").unwrap();
        fs::write(root.path().join("README.md"), "hello index\n").unwrap();
        fs::write(root.path().join("notes.md"), "indexed too\n").unwrap();
        fs::write(root.path().join("private.txt"), "private\n").unwrap();
        fs::write(root.path().join("node_modules/pkg/ignored.js"), "ignored\n").unwrap();
        fs::write(root.path().join("image.png"), [0_u8, 1, 2, 3]).unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        let status = store.rebuild(root.path(), IndexLimits::default()).unwrap();
        assert_eq!(status.status, "fresh");
        assert_eq!(status.file_count, 2);
        assert!(status.indexed_bytes > 0);
    }

    #[test]
    fn budget_marks_root_skipped_without_serving_partial_index() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "one\n").unwrap();
        fs::write(root.path().join("two.txt"), "two\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        let status = store
            .rebuild(
                root.path(),
                IndexLimits {
                    max_files: 1,
                    ..IndexLimits::default()
                },
            )
            .unwrap();
        assert_eq!(status.status, "skipped_over_limit");
    }

    #[test]
    fn corrupt_store_is_quarantined_and_recreated() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("index/index.db");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not sqlite").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        assert!(store.status(None).unwrap().is_empty());
        assert!(fs::read_dir(path.parent().unwrap()).unwrap().count() >= 2);
    }

    #[test]
    fn multiple_roots_are_namespaced_and_clear_is_scoped() {
        let data = tempfile::tempdir().unwrap();
        let root_a = tempfile::tempdir().unwrap();
        let root_b = tempfile::tempdir().unwrap();
        fs::write(root_a.path().join("a.txt"), "alpha\n").unwrap();
        fs::write(root_b.path().join("b.txt"), "bravo\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        store
            .rebuild(root_a.path(), IndexLimits::default())
            .unwrap();
        store
            .rebuild(root_b.path(), IndexLimits::default())
            .unwrap();
        assert_eq!(store.status(None).unwrap().len(), 2);
        assert_eq!(store.clear(Some(root_a.path())).unwrap(), 1);
        let remaining = store.status(None).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0].root_path,
            normalize_root(root_b.path()).to_string_lossy()
        );

        // The FTS side of the cleared root must go too: the virtual table has
        // no foreign keys, so clear deletes its rows explicitly. A leftover
        // row would silently keep workspace content readable after "clear".
        let connection = fts::open(&store.path).unwrap();
        let orphaned: i64 = connection
            .query_row("SELECT COUNT(*) FROM file_content_fts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(orphaned, 1);
        let files_left: i64 = connection
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        assert_eq!(files_left, 1);
    }
}
