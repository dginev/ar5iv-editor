//! Embedded mirror of the top-level `examples/` tree. Same source of
//! truth as the frontend's Vite-glob — see `docs/FileUI.md`.

use std::path::Path;

use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

static EXAMPLES_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../examples");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExampleManifestEntry {
    pub name: String,
    pub slug: String,
    pub entry: String,
    /// Optional `.zip` / `.tar.gz` filename under `examples/<slug>/`
    /// that the server unpacks into the session at slot-create time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive: Option<String>,
    /// Soft-hide for examples we want to keep in the tree (so we
    /// can re-enable later without rewriting history) but not
    /// surface in the dropdown or accept as a slot. The frontend
    /// filters the same flag from `EXAMPLES_LIST`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExampleManifest {
    pub examples: Vec<ExampleManifestEntry>,
}

/// Parsed-once at boot so route handlers can do an O(1) lookup.
pub struct ExampleCatalog {
    manifest: ExampleManifest,
}

impl ExampleCatalog {
    pub fn load() -> anyhow::Result<Self> {
        let raw = EXAMPLES_DIR
            .get_file("_index.json")
            .ok_or_else(|| anyhow::anyhow!("examples/_index.json not embedded"))?
            .contents_utf8()
            .ok_or_else(|| anyhow::anyhow!("examples/_index.json not utf-8"))?;
        let manifest: ExampleManifest = serde_json::from_str(raw)?;
        Ok(Self { manifest })
    }

    /// Iterator over examples that should be visible to clients —
    /// i.e. excludes anything flagged `"disabled": true` in the
    /// manifest. Disabled entries are still embedded so we can
    /// flip them back on without touching the include_dir tree.
    pub fn list(&self) -> impl Iterator<Item = &ExampleManifestEntry> {
        self.manifest.examples.iter().filter(|e| !e.disabled)
    }

    pub fn get(&self, slug: &str) -> Option<&ExampleManifestEntry> {
        self.manifest.examples.iter().find(|e| e.slug == slug && !e.disabled)
    }

    /// Materialise the example named `slug` into `dest` (which must
    /// already exist and be empty). Returns `(bytes_written,
    /// files_written)`. For archive-bearing examples this only writes
    /// the archive and signals to the caller that unpack is required;
    /// in v1.2 the archive unpack happens in Phase 4 (archive.rs).
    /// Until that lands, archive-bearing slot-creates return the
    /// archive raw and the caller's seeder is responsible for
    /// unpacking.
    pub async fn seed(
        &self,
        slug: &str,
        dest: &Path,
    ) -> Result<SeedOutcome, AppError> {
        let entry = self
            .get(slug)
            .ok_or_else(|| AppError::bad_request(format!("unknown example: {slug}")))?;
        let dir = EXAMPLES_DIR
            .get_dir(slug)
            .ok_or_else(|| AppError::internal(format!("example dir missing: {slug}")))?;

        let mut bytes: u64 = 0;
        let mut files: u32 = 0;
        let mut archive_bytes: Option<Vec<u8>> = None;

        // Walk the example dir recursively. include_dir gives us the
        // file tree at compile time, so this is just iteration, no IO.
        for f in dir.files() {
            let rel = f
                .path()
                .strip_prefix(slug)
                .map_err(|_| AppError::internal("example path strip"))?;
            let rel_str = rel.to_string_lossy().to_string();

            // Hold archive bodies aside — we don't write them into the
            // session as plain files; the archive unpacker takes them.
            if let Some(arc_name) = entry.archive.as_deref()
                && rel_str == arc_name
            {
                archive_bytes = Some(f.contents().to_vec());
                continue;
            }

            let target = dest.join(rel);
            if let Some(parent) = target.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| AppError::internal(format!("seed mkdir: {e}")))?;
            }
            tokio::fs::write(&target, f.contents())
                .await
                .map_err(|e| AppError::internal(format!("seed write: {e}")))?;
            bytes = bytes.saturating_add(f.contents().len() as u64);
            files = files.saturating_add(1);
        }

        // Recurse into subdirectories.
        let mut dir_stack: Vec<&Dir<'_>> = dir.dirs().collect();
        while let Some(d) = dir_stack.pop() {
            for f in d.files() {
                let rel = f
                    .path()
                    .strip_prefix(slug)
                    .map_err(|_| AppError::internal("example path strip"))?;
                let target = dest.join(rel);
                if let Some(parent) = target.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| AppError::internal(format!("seed mkdir: {e}")))?;
                }
                tokio::fs::write(&target, f.contents())
                    .await
                    .map_err(|e| AppError::internal(format!("seed write: {e}")))?;
                bytes = bytes.saturating_add(f.contents().len() as u64);
                files = files.saturating_add(1);
            }
            for sub in d.dirs() {
                dir_stack.push(sub);
            }
        }

        Ok(SeedOutcome { bytes, files, archive: archive_bytes, entry_file: entry.entry.clone() })
    }
}

#[derive(Debug)]
pub struct SeedOutcome {
    pub bytes:      u64,
    pub files:      u32,
    /// `Some(bytes)` if the example declares an `archive` field. The
    /// caller (slot-create) is responsible for piping this through
    /// `archive::unpack_into` once that module lands; until then,
    /// archive-bearing examples error out at slot-create time.
    pub archive:    Option<Vec<u8>>,
    pub entry_file: String,
}
