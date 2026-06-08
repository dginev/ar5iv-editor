//! Archive import (ZIP + gzip: `.tar.gz`/`.tgz` and single-file `.gz`)
//! and ZIP export.
//!
//! Every input is unpacked through a single set of validation and quota
//! chokepoints; the only difference is how entries are enumerated. See
//! `docs/FileUI.md` "Archive upload — ZIP and tar.gz".

use std::collections::HashSet;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::TryRngCore;
use sha2::{Digest, Sha256};

use crate::config::SessionConfig;
use crate::error::AppError;

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub enum ArchiveFormat {
    Zip,
    /// A gzip stream — either a gzipped tar (`.tar.gz` / `.tgz`) or a
    /// single gzipped file (`.gz`). Both carry the same `1f 8b` magic;
    /// which one it is is decided after decompression by [`collect_gzip`].
    Gzip,
}

#[derive(Debug, Clone, Copy, Default)]
pub enum ConflictPolicy {
    /// Existing files in the destination are kept; archive entries
    /// that collide are silently skipped. (Default for overlay
    /// uploads.)
    #[default]
    Skip,
    /// Existing files are overwritten by archive contents.
    Overwrite,
}

#[derive(Debug)]
pub struct UnpackOutcome {
    pub bytes_written: u64,
    pub files_written: u32,
    pub paths:         Vec<String>,
    /// Entries dropped because their extension isn't allowed (e.g. `.mp4`).
    /// The good files were still extracted; this lets the caller tell the
    /// user what was left out.
    pub skipped:       Vec<String>,
}

/// Sniff the archive format from the leading bytes. The client's
/// Content-Type is *advisory*; what we actually believe is the wire.
pub fn sniff_format(bytes: &[u8]) -> Result<ArchiveFormat, AppError> {
    if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        Ok(ArchiveFormat::Zip)
    } else if bytes.starts_with(&[0x1f, 0x8b]) {
        Ok(ArchiveFormat::Gzip)
    } else {
        Err(AppError::bad_request(
            "archive: unrecognised format (expected ZIP, tar.gz, or .gz)",
        ))
    }
}

/// SHA-256 hex prefix of an archive's bytes, suitable for use as the
/// hash component of a `Slot::Upload(<32 bytes>)`.
pub fn content_hash(bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().into()
}

/// Unpack into `dest_dir`. The directory must exist and be empty (or
/// at least free of the entries we are about to write — collisions
/// abort the unpack with `AppError::bad_request`). Used by
/// `lookup_or_create` seeds.
pub fn unpack_into(
    bytes: &[u8],
    dest_dir: &Path,
    cfg: &SessionConfig,
) -> Result<UnpackOutcome, AppError> {
    let format = sniff_format(bytes)?;
    let Plan { entries, skipped } = build_plan(bytes, format, cfg)?;

    let mut written: u64 = 0;
    let mut count: u32 = 0;
    let mut paths: Vec<String> = Vec::with_capacity(entries.len());

    for entry in entries {
        let target = dest_dir.join(&entry.rel_path);
        if target.exists() {
            return Err(AppError::bad_request(format!(
                "archive collision in fresh tmpdir: {}",
                entry.rel_path.display()
            )));
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::internal(format!("mkdir {}: {e}", parent.display())))?;
        }
        write_no_follow(&target, &entry.bytes)
            .map_err(|e| AppError::internal(format!("write {}: {e}", target.display())))?;
        written = written.saturating_add(entry.bytes.len() as u64);
        count = count.saturating_add(1);
        paths.push(entry.rel_path.to_string_lossy().replace('\\', "/"));
    }

    Ok(UnpackOutcome { bytes_written: written, files_written: count, paths, skipped })
}

/// Unpack overlaying onto an existing session directory. Extracts
/// into `<session_dir>/.staging-<random>/` first, validates the whole
/// set, then moves each file into place per `policy`. On any error
/// the staging directory is removed and the session is left
/// untouched.
pub fn unpack_overlay(
    bytes: &[u8],
    session_dir: &Path,
    cfg: &SessionConfig,
    policy: ConflictPolicy,
) -> Result<UnpackOutcome, AppError> {
    let format = sniff_format(bytes)?;
    let Plan { entries, skipped } = build_plan(bytes, format, cfg)?;

    let staging = session_dir.join(format!(".staging-{}", random_suffix()));
    std::fs::create_dir_all(&staging)
        .map_err(|e| AppError::internal(format!("mkdir staging: {e}")))?;

    let result = (|| -> Result<UnpackOutcome, AppError> {
        let mut written: u64 = 0;
        let mut count: u32 = 0;
        let mut paths: Vec<String> = Vec::with_capacity(entries.len());

        for entry in &entries {
            let final_target = session_dir.join(&entry.rel_path);
            if final_target.exists() {
                match policy {
                    ConflictPolicy::Skip => continue,
                    ConflictPolicy::Overwrite => {}
                }
            }
            let staging_target = staging.join(&entry.rel_path);
            if let Some(parent) = staging_target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| AppError::internal(format!("mkdir staging parent: {e}")))?;
            }
            write_no_follow(&staging_target, &entry.bytes).map_err(|e| {
                AppError::internal(format!("staging write {}: {e}", staging_target.display()))
            })?;
            written = written.saturating_add(entry.bytes.len() as u64);
            count = count.saturating_add(1);
            paths.push(entry.rel_path.to_string_lossy().replace('\\', "/"));
        }

        // All entries staged successfully — promote to final paths.
        for rel in &paths {
            let from = staging.join(rel);
            let to = session_dir.join(rel);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| AppError::internal(format!("mkdir final parent: {e}")))?;
            }
            std::fs::rename(&from, &to)
                .map_err(|e| AppError::internal(format!("rename into place: {e}")))?;
        }

        Ok(UnpackOutcome { bytes_written: written, files_written: count, paths, skipped })
    })();

    // Always clean up the staging dir.
    let _ = std::fs::remove_dir_all(&staging);

    result
}

/// Stream a deterministic ZIP of the session's contents to `out`,
/// optionally augmented with synthetic in-memory entries (e.g. an
/// `index.html` rendered preview + the ar5iv stylesheet bundle).
/// Sorted entries, no symlinks emitted. Used by the export route.
///
/// Synthetic entries that collide with on-disk paths win (the user's
/// own `index.html` would be overwritten by ours). Callers pass a path
/// they don't expect to clash, or stage their own naming.
pub fn export_zip<W: Write + std::io::Seek>(
    session_dir: &Path,
    out: &mut W,
    extras: &[(String, Vec<u8>)],
) -> Result<u64, AppError> {
    use zip::write::SimpleFileOptions;

    // Walk the session dir collecting (relative_path, absolute_path).
    // Drop on-disk entries that an extra is going to overwrite so the
    // ZIP doesn't carry duplicate names.
    let extra_names: HashSet<String> =
        extras.iter().map(|(n, _)| n.clone()).collect();
    let mut paths: Vec<(PathBuf, PathBuf)> = Vec::new();
    walk_for_export(session_dir, session_dir, &mut paths)?;
    paths.retain(|(rel, _)| {
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        !extra_names.contains(&rel_str)
    });
    paths.sort_by(|a, b| a.0.cmp(&b.0));

    let mut writer = zip::ZipWriter::new(out);
    let opts = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        // Maximal deflate level (flate2 range 0–9) to minimise download
        // size: the bundle is mostly text (HTML, the ar5iv CSS, SVG) that
        // compresses well, and the LaTeXML conversion dominates CPU, so
        // the extra deflate effort is negligible. (Already-compressed
        // PNG/JPG assets simply don't shrink further — no CPU concern.)
        .compression_level(Some(9))
        .unix_permissions(0o644);

    let mut total: u64 = 0;
    for (rel, abs) in &paths {
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        writer
            .start_file(rel_str.as_str(), opts)
            .map_err(|e| AppError::internal(format!("zip start_file: {e}")))?;
        let bytes = std::fs::read(abs)
            .map_err(|e| AppError::internal(format!("zip read {}: {e}", abs.display())))?;
        writer
            .write_all(&bytes)
            .map_err(|e| AppError::internal(format!("zip write: {e}")))?;
        total = total.saturating_add(bytes.len() as u64);
    }

    let mut extras_sorted: Vec<&(String, Vec<u8>)> = extras.iter().collect();
    extras_sorted.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, bytes) in extras_sorted {
        writer
            .start_file(name.as_str(), opts)
            .map_err(|e| AppError::internal(format!("zip start_file: {e}")))?;
        writer
            .write_all(bytes)
            .map_err(|e| AppError::internal(format!("zip write: {e}")))?;
        total = total.saturating_add(bytes.len() as u64);
    }

    writer
        .finish()
        .map_err(|e| AppError::internal(format!("zip finish: {e}")))?;
    Ok(total)
}

// ---------------------------------------------------------------------------
// Internal: build a validated extraction plan from archive bytes.
// ---------------------------------------------------------------------------

const MAX_ENTRIES: usize = 500;
const MAX_DEPTH: usize = 16;
const RATIO_CAP: u64 = 100;

#[derive(Debug)]
struct PlannedEntry {
    rel_path: PathBuf,
    bytes:    Vec<u8>,
}

#[derive(Debug)]
struct Plan {
    entries: Vec<PlannedEntry>,
    /// Relative paths of entries dropped because their extension isn't in the
    /// allowlist (e.g. a stray `.mp4`). The archive still extracts its good
    /// files; these are reported back so the client can surface what was
    /// skipped. Security/quota violations (traversal, symlinks, oversize,
    /// duplicates) are NOT skipped — they still abort the whole unpack.
    skipped: Vec<String>,
}

fn build_plan(
    bytes: &[u8],
    format: ArchiveFormat,
    cfg: &SessionConfig,
) -> Result<Plan, AppError> {
    if bytes.len() as u64 > cfg.quota_archive_bytes {
        return Err(AppError::quota(format!(
            "archive cap of {} bytes exceeded",
            cfg.quota_archive_bytes
        )));
    }

    let raw_entries: Vec<RawEntry> = match format {
        ArchiveFormat::Zip => collect_zip(bytes)?,
        ArchiveFormat::Gzip => collect_gzip(bytes, cfg)?,
    };

    if raw_entries.len() > MAX_ENTRIES {
        return Err(AppError::quota(format!(
            "archive entry count cap of {} exceeded",
            MAX_ENTRIES
        )));
    }

    let mut total: u64 = 0;
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut planned: Vec<PlannedEntry> = Vec::with_capacity(raw_entries.len());
    let mut skipped: Vec<String> = Vec::new();

    for re in raw_entries {
        let RawEntry { name, bytes: entry_bytes, kind } = re;
        match kind {
            EntryKind::Directory => continue, // we materialise dirs implicitly
            EntryKind::Symlink | EntryKind::Hardlink | EntryKind::Special => {
                return Err(AppError::bad_request(format!(
                    "archive: refused symlink / special entry {name}"
                )));
            }
            EntryKind::File => {}
        }

        let rel = normalize_archive_path(&name)?;
        let depth = rel.components().count();
        if depth > MAX_DEPTH {
            return Err(AppError::quota(format!(
                "archive: nesting depth {depth} exceeds cap {MAX_DEPTH}"
            )));
        }

        if !is_allowed_extension(&rel) {
            // Drop the individual file rather than failing the whole archive —
            // a stray `.mp4` shouldn't sink a project full of `.tex`. Record
            // it (and don't count it toward the size quota — this check is
            // before the byte accounting below) so the client can report it.
            skipped.push(rel.to_string_lossy().replace('\\', "/"));
            continue;
        }

        let entry_size = entry_bytes.len() as u64;
        if entry_size > cfg.quota_upload_bytes {
            return Err(AppError::quota(format!(
                "archive: entry {} exceeds per-file cap of {} bytes",
                rel.display(),
                cfg.quota_upload_bytes
            )));
        }
        total = total.saturating_add(entry_size);
        if total > cfg.quota_session_bytes {
            return Err(AppError::quota(format!(
                "archive: total uncompressed size exceeds session cap of {} bytes",
                cfg.quota_session_bytes
            )));
        }

        if !seen.insert(rel.clone()) {
            // Two entries pointing at the same path — refuse rather
            // than silently last-writer-wins.
            return Err(AppError::bad_request(format!(
                "archive: duplicate entry {}",
                rel.display()
            )));
        }

        planned.push(PlannedEntry { rel_path: rel, bytes: entry_bytes });
    }

    Ok(Plan { entries: planned, skipped })
}

#[derive(Debug)]
enum EntryKind {
    File,
    Directory,
    Symlink,
    Hardlink,
    /// Char device, block device, fifo — never accepted.
    Special,
}

#[derive(Debug)]
struct RawEntry {
    name:  String,
    bytes: Vec<u8>,
    kind:  EntryKind,
}

fn collect_zip(bytes: &[u8]) -> Result<Vec<RawEntry>, AppError> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| AppError::bad_request(format!("zip: open: {e}")))?;

    if archive.len() > MAX_ENTRIES {
        return Err(AppError::quota(format!(
            "archive entry count cap of {} exceeded",
            MAX_ENTRIES
        )));
    }

    let mut out = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::bad_request(format!("zip: entry {i}: {e}")))?;
        let name = entry.name().to_string();

        if entry.is_dir() {
            out.push(RawEntry { name, bytes: Vec::new(), kind: EntryKind::Directory });
            continue;
        }

        // Symlink detection from Unix mode bits.
        if let Some(mode) = entry.unix_mode()
            && (mode & 0o170_000) == 0o120_000
        {
            out.push(RawEntry { name, bytes: Vec::new(), kind: EntryKind::Symlink });
            continue;
        }

        // Compression-ratio cap.
        let compressed = entry.compressed_size();
        let uncompressed = entry.size();
        if compressed > 0 && uncompressed.saturating_div(compressed) > RATIO_CAP {
            return Err(AppError::quota(format!(
                "archive: zip-bomb-shaped entry {name} (ratio > {RATIO_CAP})"
            )));
        }

        let mut buf: Vec<u8> = Vec::with_capacity(uncompressed.min(1024 * 1024) as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| AppError::bad_request(format!("zip: read {name}: {e}")))?;
        out.push(RawEntry { name, bytes: buf, kind: EntryKind::File });
    }
    Ok(out)
}

/// Decompress a gzip stream and dispatch: a gzipped tar (`.tar.gz` /
/// `.tgz`) is parsed entry-by-entry; a single gzipped file (`.gz`, e.g.
/// an arXiv bare-TeX submission) becomes one entry. The two are
/// indistinguishable by magic (both `1f 8b`), so we decide after
/// decompression via the tar `ustar` marker.
fn collect_gzip(bytes: &[u8], cfg: &SessionConfig) -> Result<Vec<RawEntry>, AppError> {
    // Decompress fully into memory, bounded by a post-decompress cap so a
    // gzip-bomb (innocent compressed size, huge expansion) can't OOM us —
    // the same defence the streaming reader gave us before.
    let max_uncompressed = cfg.quota_session_bytes.saturating_mul(2);
    let mut decompressed: Vec<u8> = Vec::new();
    {
        let gz = flate2::read::GzDecoder::new(Cursor::new(bytes));
        LimitReader::new(gz, max_uncompressed)
            .read_to_end(&mut decompressed)
            .map_err(|e| AppError::bad_request(format!("gzip: decompress: {e}")))?;
    }

    if looks_like_tar(&decompressed) {
        return collect_tar(&decompressed, cfg);
    }

    // Single gzipped file. Prefer the original name from the gzip FNAME
    // header (basename only, to neutralise an embedded path); otherwise
    // assume a bare TeX submission — arXiv's convention for a single
    // gzipped source — and call it `main.tex`. The extension allowlist
    // and path normalisation downstream still apply.
    let name = gzip_original_filename(bytes)
        .and_then(|n| Path::new(&n).file_name().map(|s| s.to_string_lossy().into_owned()))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "main.tex".to_string());
    Ok(vec![RawEntry { name, bytes: decompressed, kind: EntryKind::File }])
}

/// True if the decompressed bytes look like a POSIX/GNU tar: the `ustar`
/// magic sits at offset 257 of the first 512-byte header block. A single
/// gzipped file (a lone `.tex`, say) won't carry it — that's how we tell
/// `.tar.gz` from a bare `.gz`. Pre-POSIX v7 tar lacks the marker and
/// would be treated as a single file, but that format is effectively
/// extinct for the arXiv-style sources we ingest.
fn looks_like_tar(decompressed: &[u8]) -> bool {
    decompressed.len() >= 262 && &decompressed[257..262] == b"ustar"
}

/// The original filename stored in a gzip header (RFC 1952 FNAME field),
/// if present. We parse the raw header rather than the decoder so we
/// don't have to thread the decoder past the bounded read above. Returns
/// the stored string verbatim; the caller takes the basename.
fn gzip_original_filename(bytes: &[u8]) -> Option<String> {
    // Fixed 10-byte header: magic(2) CM(1) FLG(1) MTIME(4) XFL(1) OS(1).
    if bytes.len() < 10 || bytes[0] != 0x1f || bytes[1] != 0x8b {
        return None;
    }
    const FEXTRA: u8 = 0x04;
    const FNAME: u8 = 0x08;
    let flg = bytes[3];
    if flg & FNAME == 0 {
        return None;
    }
    let mut pos = 10usize;
    if flg & FEXTRA != 0 {
        // XLEN (2 bytes, little-endian) then that many extra-field bytes.
        let xlen = u16::from_le_bytes([*bytes.get(pos)?, *bytes.get(pos + 1)?]) as usize;
        pos = pos.checked_add(2)?.checked_add(xlen)?;
    }
    // FNAME is a NUL-terminated string. Be lenient: accept valid UTF-8,
    // ignore an unterminated / non-UTF-8 field rather than erroring.
    let start = pos;
    while pos < bytes.len() && bytes[pos] != 0 {
        pos += 1;
    }
    if pos >= bytes.len() {
        return None;
    }
    std::str::from_utf8(&bytes[start..pos]).ok().map(|s| s.to_string())
}

/// Parse an already-decompressed tar byte stream into raw entries.
/// Per-file size caps are enforced here; the post-decompress total cap
/// lives upstream in [`collect_gzip`].
fn collect_tar(decompressed: &[u8], cfg: &SessionConfig) -> Result<Vec<RawEntry>, AppError> {
    use tar::EntryType;

    let mut archive = tar::Archive::new(Cursor::new(decompressed));

    let mut out: Vec<RawEntry> = Vec::new();
    let entries = archive
        .entries()
        .map_err(|e| AppError::bad_request(format!("tar: open: {e}")))?;
    for (i, entry_res) in entries.enumerate() {
        if i >= MAX_ENTRIES {
            return Err(AppError::quota(format!(
                "archive entry count cap of {MAX_ENTRIES} exceeded"
            )));
        }
        let mut entry = entry_res
            .map_err(|e| AppError::bad_request(format!("tar: entry: {e}")))?;
        let name = entry
            .path()
            .map_err(|e| AppError::bad_request(format!("tar: path: {e}")))?
            .to_string_lossy()
            .into_owned();
        let kind = match entry.header().entry_type() {
            EntryType::Regular | EntryType::Continuous => EntryKind::File,
            EntryType::Directory => EntryKind::Directory,
            EntryType::Symlink => EntryKind::Symlink,
            EntryType::Link => EntryKind::Hardlink,
            EntryType::Char | EntryType::Block | EntryType::Fifo => EntryKind::Special,
            // Long names / pax extended headers / GNU sparse — defer
            // to the file-or-directory pass; tar 0.4 normalises these
            // into the next entry's path field, so we can treat them
            // as files we'll skip via the size cap.
            _ => EntryKind::File,
        };

        if matches!(kind, EntryKind::File) {
            let reported = entry.header().size().unwrap_or(0);
            if reported > cfg.quota_upload_bytes {
                return Err(AppError::quota(format!(
                    "archive: entry {name} exceeds per-file cap of {} bytes",
                    cfg.quota_upload_bytes
                )));
            }
            let mut buf: Vec<u8> = Vec::with_capacity(reported.min(1024 * 1024) as usize);
            entry
                .read_to_end(&mut buf)
                .map_err(|e| AppError::bad_request(format!("tar: read {name}: {e}")))?;
            out.push(RawEntry { name, bytes: buf, kind });
        } else {
            out.push(RawEntry { name, bytes: Vec::new(), kind });
        }
    }
    Ok(out)
}

/// io::Read wrapper that fails once `limit` decompressed bytes have
/// been pulled. Defeats gzip-bombs at the gzip-stream layer.
struct LimitReader<R: Read> {
    inner: R,
    seen:  u64,
    limit: u64,
}
impl<R: Read> LimitReader<R> {
    fn new(inner: R, limit: u64) -> Self { Self { inner, seen: 0, limit } }
}
impl<R: Read> Read for LimitReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.seen > self.limit {
            return Err(std::io::Error::other("decompress limit exceeded"));
        }
        let n = self.inner.read(buf)?;
        self.seen = self.seen.saturating_add(n as u64);
        Ok(n)
    }
}

// ---------------------------------------------------------------------------
// Path / extension helpers — same chokepoint as `Session::resolve` but
// taking a raw entry name (which doesn't have a session yet).
// ---------------------------------------------------------------------------

fn normalize_archive_path(raw: &str) -> Result<PathBuf, AppError> {
    if raw.is_empty() {
        return Err(AppError::bad_request("archive: empty entry path"));
    }
    if raw.bytes().any(|b| b == 0) {
        return Err(AppError::bad_request("archive: NUL in entry path"));
    }
    if raw.contains('\\') {
        return Err(AppError::bad_request("archive: backslash in entry path"));
    }
    // A trailing slash means the entry is a directory; tar / zip both
    // hint that with an empty/no body. We strip it for normalisation.
    let trimmed = raw.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::bad_request("archive: empty entry path"));
    }
    let p = Path::new(trimmed);
    if p.is_absolute() {
        return Err(AppError::bad_request("archive: absolute entry path"));
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => {
                if s.as_encoded_bytes().is_empty() {
                    return Err(AppError::bad_request("archive: empty path segment"));
                }
                out.push(s);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::bad_request("archive: traversal in entry path"));
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err(AppError::bad_request("archive: empty entry path"));
    }
    Ok(out)
}

fn is_allowed_extension(rel: &Path) -> bool {
    matches!(
        rel.extension().and_then(|e| e.to_str()),
        Some(
            "tex" | "sty" | "cls" | "clo" | "bib" | "bst" | "bbl"
            | "png" | "jpg" | "jpeg" | "gif" | "svg" | "pdf" | "eps"
            | "csv" | "dat" | "txt" | "md" | "toml" | "json" | "yaml" | "yml"
        )
    )
}

fn random_suffix() -> String {
    let mut bytes = [0u8; 8];
    let _ = rand::rngs::OsRng.try_fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(unix)]
fn write_no_follow(path: &Path, body: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true) // refuse if a symlink (or anything else) is already there
        .custom_flags(o_nofollow())
        .open(path)?;
    f.write_all(body)?;
    f.flush()?;
    Ok(())
}

#[cfg(not(unix))]
fn write_no_follow(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    f.write_all(body)?;
    f.flush()?;
    Ok(())
}

#[cfg(unix)]
fn o_nofollow() -> i32 {
    #[cfg(target_os = "linux")]
    {
        0o400_000
    }
    #[cfg(target_os = "macos")]
    {
        0x100
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        0
    }
}

fn walk_for_export(
    root: &Path,
    cur: &Path,
    out: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<(), AppError> {
    let entries = std::fs::read_dir(cur)
        .map_err(|e| AppError::internal(format!("walk: {e}")))?;
    for entry in entries {
        let entry = entry.map_err(|e| AppError::internal(format!("walk entry: {e}")))?;
        let ft = entry
            .file_type()
            .map_err(|e| AppError::internal(format!("walk file_type: {e}")))?;
        let p = entry.path();
        // Skip internal scratch: leftover overlay staging dirs, and the
        // converter's post-processing destination file (`convert.rs`
        // points the HTML5 post-processor at `<session>/__preview.html`).
        // Neither belongs in a user-facing export — the self-contained
        // `index.html` we synthesise is the rendered artifact.
        let leaf_str = entry.file_name().to_string_lossy().into_owned();
        if leaf_str.starts_with(".staging-") || leaf_str == "__preview.html" {
            continue;
        }
        if ft.is_dir() {
            walk_for_export(root, &p, out)?;
        } else if ft.is_file() {
            let rel = p.strip_prefix(root).unwrap().to_path_buf();
            out.push((rel, p));
        }
        // Symlinks are intentionally ignored — we never create them
        // and accidentally including them in an export would let a
        // future import-then-extract pull bytes from outside.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn test_cfg() -> SessionConfig {
        SessionConfig {
            sessions_dir:            std::path::PathBuf::from("/tmp/ar5iv-archive-test"),
            idle_timeout:            Duration::from_secs(600),
            gc_interval:             Duration::from_secs(60),
            quota_session_bytes:     1024 * 1024,
            quota_session_files:     50,
            quota_upload_bytes:      256 * 1024,
            quota_archive_bytes:     1024 * 1024,
            quota_root_bytes:        100 * 1024 * 1024,
            quota_sessions_per_user: 8,
            quota_users_per_ip:      16,
        }
    }

    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf: Vec<u8> = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut w = zip::ZipWriter::new(cursor);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(0o644);
            for (name, body) in entries {
                w.start_file(*name, opts).unwrap();
                w.write_all(body).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    fn make_tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar_buf: Vec<u8> = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            for (name, body) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, name, *body).unwrap();
            }
            builder.finish().unwrap();
        }
        let mut gz_buf: Vec<u8> = Vec::new();
        {
            let mut encoder =
                flate2::write::GzEncoder::new(&mut gz_buf, flate2::Compression::default());
            encoder.write_all(&tar_buf).unwrap();
            encoder.finish().unwrap();
        }
        gz_buf
    }

    fn make_bare_gz(filename: Option<&str>, body: &[u8]) -> Vec<u8> {
        let mut builder = flate2::GzBuilder::new();
        if let Some(name) = filename {
            builder = builder.filename(name.as_bytes());
        }
        let mut enc = builder.write(Vec::new(), flate2::Compression::default());
        enc.write_all(body).unwrap();
        enc.finish().unwrap()
    }

    #[test]
    fn sniff_distinguishes_formats() {
        let zip = make_zip(&[("a.tex", b"hi")]);
        let tar = make_tar_gz(&[("a.tex", b"hi")]);
        let gz = make_bare_gz(Some("a.tex"), b"hi");
        assert!(matches!(sniff_format(&zip).unwrap(), ArchiveFormat::Zip));
        // Both gzipped tar and bare gzip sniff as Gzip — they share the magic.
        assert!(matches!(sniff_format(&tar).unwrap(), ArchiveFormat::Gzip));
        assert!(matches!(sniff_format(&gz).unwrap(), ArchiveFormat::Gzip));
        assert!(sniff_format(b"plain text").is_err());
    }

    #[test]
    fn unpack_bare_gz_uses_gzip_header_filename() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = test_cfg();
        let gz = make_bare_gz(Some("paper.tex"), b"\\documentclass{article}");
        let outcome = unpack_into(&gz, tmp.path(), &cfg).unwrap();
        assert_eq!(outcome.files_written, 1);
        assert_eq!(outcome.paths, vec!["paper.tex".to_string()]);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("paper.tex")).unwrap(),
            "\\documentclass{article}"
        );
    }

    #[test]
    fn unpack_bare_gz_without_name_defaults_to_main_tex() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = test_cfg();
        // No FNAME header → arXiv bare-TeX convention → main.tex.
        let gz = make_bare_gz(None, b"\\section{x}");
        let outcome = unpack_into(&gz, tmp.path(), &cfg).unwrap();
        assert_eq!(outcome.paths, vec!["main.tex".to_string()]);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("main.tex")).unwrap(),
            "\\section{x}"
        );
    }

    #[test]
    fn bare_gz_header_path_is_reduced_to_basename() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = test_cfg();
        // A hostile FNAME with a directory/traversal component must not
        // escape — we take only the basename.
        let gz = make_bare_gz(Some("../../etc/main.tex"), b"safe");
        let outcome = unpack_into(&gz, tmp.path(), &cfg).unwrap();
        assert_eq!(outcome.paths, vec!["main.tex".to_string()]);
        assert!(tmp.path().join("main.tex").exists());
    }

    #[test]
    fn tar_gz_still_unpacks_as_tar_not_single_file() {
        // Guard the tar-vs-single-file discriminator: a real multi-entry
        // tar.gz must still enumerate its entries, not collapse to one.
        let tmp = tempfile::tempdir().unwrap();
        let cfg = test_cfg();
        let tg = make_tar_gz(&[("main.tex", b"a"), ("sub/fig.svg", b"<svg/>")]);
        let outcome = unpack_into(&tg, tmp.path(), &cfg).unwrap();
        assert_eq!(outcome.files_written, 2);
        assert!(tmp.path().join("main.tex").exists());
        assert!(tmp.path().join("sub/fig.svg").exists());
    }

    #[test]
    fn unpack_zip_into_fresh_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = test_cfg();
        let zip = make_zip(&[("main.tex", b"hello"), ("sub/fig.svg", b"<svg/>")]);
        let outcome = unpack_into(&zip, tmp.path(), &cfg).unwrap();
        assert_eq!(outcome.files_written, 2);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("main.tex")).unwrap(),
            "hello"
        );
        assert_eq!(
            std::fs::read(tmp.path().join("sub/fig.svg")).unwrap(),
            b"<svg/>"
        );
    }

    #[test]
    fn unpack_tar_gz_into_fresh_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = test_cfg();
        let tg = make_tar_gz(&[("paper.tex", b"\\documentclass{article}")]);
        let outcome = unpack_into(&tg, tmp.path(), &cfg).unwrap();
        assert_eq!(outcome.files_written, 1);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("paper.tex")).unwrap(),
            "\\documentclass{article}"
        );
    }

    #[test]
    fn rejects_path_traversal_in_zip() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = test_cfg();
        let zip = make_zip(&[("../escape.tex", b"x")]);
        let err = unpack_into(&zip, tmp.path(), &cfg).unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[test]
    fn rejects_path_traversal_in_tar() {
        // `tar::Builder::append_data` validates path safety on its
        // side, so we drop into the lower-level `append` to inject a
        // hostile name field directly. This is exactly the shape of
        // attack a malicious actor (not using `tar::Builder`) could
        // craft, which is why our reader pipeline has to validate
        // independently.
        let mut tar_buf: Vec<u8> = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            let body: &[u8] = b"x";
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            // Bypass set_path's validation by writing into the
            // 100-byte name field directly.
            let evil = b"../escape.tex";
            let name_slice = &mut header.as_old_mut().name[..];
            for b in name_slice.iter_mut() {
                *b = 0;
            }
            name_slice[..evil.len()].copy_from_slice(evil);
            header.set_cksum();
            builder.append(&header, body).unwrap();
            builder.finish().unwrap();
        }
        let mut gz_buf: Vec<u8> = Vec::new();
        {
            let mut encoder =
                flate2::write::GzEncoder::new(&mut gz_buf, flate2::Compression::default());
            encoder.write_all(&tar_buf).unwrap();
            encoder.finish().unwrap();
        }

        let tmp = tempfile::tempdir().unwrap();
        let cfg = test_cfg();
        let err = unpack_into(&gz_buf, tmp.path(), &cfg).unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "got: {err:?}");
    }

    #[test]
    fn skips_disallowed_extensions_keeps_good_files() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = test_cfg();
        // A stray `.mp4` next to real source: the archive must extract the
        // good files and report the bad one as skipped — not fail outright.
        // `.clo` (LaTeX class-option file) is now in the allowlist.
        let zip = make_zip(&[
            ("paper.tex", b"\\documentclass{article}"),
            ("opts.clo", b"% class options"),
            ("clip.mp4", b"\x00\x00\x00\x18ftyp"),
        ]);
        let out = unpack_into(&zip, tmp.path(), &cfg).unwrap();
        assert_eq!(out.files_written, 2, "the two good files are written");
        assert!(tmp.path().join("paper.tex").exists());
        assert!(tmp.path().join("opts.clo").exists(), ".clo must be accepted");
        assert!(!tmp.path().join("clip.mp4").exists(), ".mp4 must be dropped");
        assert_eq!(out.skipped, vec!["clip.mp4".to_string()]);
    }

    #[test]
    fn all_disallowed_archive_extracts_nothing_but_succeeds() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = test_cfg();
        let zip = make_zip(&[("evil.exe", b"MZ"), ("clip.mp4", b"\x00")]);
        let out = unpack_into(&zip, tmp.path(), &cfg).unwrap();
        assert_eq!(out.files_written, 0);
        assert_eq!(out.skipped.len(), 2, "both bad files reported as skipped");
    }

    #[test]
    fn accepts_dat_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = test_cfg();
        let zip = make_zip(&[("fig1_data.dat", b"1 2 3\n")]);
        let out = unpack_into(&zip, tmp.path(), &cfg).unwrap();
        assert_eq!(out.paths, vec!["fig1_data.dat".to_string()]);
        assert_eq!(std::fs::read_to_string(tmp.path().join("fig1_data.dat")).unwrap(), "1 2 3\n");
    }

    #[test]
    fn rejects_oversized_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = test_cfg();
        cfg.quota_upload_bytes = 64;
        let zip = make_zip(&[("a.tex", &vec![b'x'; 1024])]);
        let err = unpack_into(&zip, tmp.path(), &cfg).unwrap_err();
        assert!(matches!(err, AppError::Quota(_)));
    }

    #[test]
    fn export_zip_round_trips_through_unpack() {
        let src = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("a.tex"), b"alpha").unwrap();
        std::fs::create_dir_all(src.path().join("sub")).unwrap();
        std::fs::write(src.path().join("sub/b.tex"), b"beta").unwrap();

        let mut buf: Vec<u8> = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        export_zip(src.path(), &mut cursor, &[]).unwrap();

        let dst = tempfile::tempdir().unwrap();
        let cfg = test_cfg();
        let outcome = unpack_into(&buf, dst.path(), &cfg).unwrap();
        assert_eq!(outcome.files_written, 2);
        assert_eq!(std::fs::read_to_string(dst.path().join("a.tex")).unwrap(), "alpha");
        assert_eq!(std::fs::read_to_string(dst.path().join("sub/b.tex")).unwrap(), "beta");
    }

    #[test]
    fn export_excludes_converter_scratch_preview_html() {
        let src = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("main.tex"), b"hi").unwrap();
        // The HTML5 post-processor's destination file the converter leaves
        // behind in the session dir — must not leak into a user export.
        std::fs::write(src.path().join("__preview.html"), b"<html>scratch</html>").unwrap();

        let mut buf: Vec<u8> = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        export_zip(src.path(), &mut cursor, &[]).unwrap();

        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&buf)).unwrap();
        let names: Vec<String> =
            (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        assert!(names.contains(&"main.tex".to_string()), "source kept: {names:?}");
        assert!(
            !names.iter().any(|n| n == "__preview.html"),
            "converter scratch must be excluded: {names:?}"
        );
    }

    #[test]
    fn overlay_skip_keeps_existing_files() {
        let session = tempfile::tempdir().unwrap();
        std::fs::write(session.path().join("main.tex"), b"original").unwrap();
        let cfg = test_cfg();
        let zip = make_zip(&[("main.tex", b"updated"), ("new.tex", b"fresh")]);
        let outcome =
            unpack_overlay(&zip, session.path(), &cfg, ConflictPolicy::Skip).unwrap();
        assert!(outcome.paths.contains(&"new.tex".to_string()));
        // Skip policy preserves the original.
        assert_eq!(
            std::fs::read_to_string(session.path().join("main.tex")).unwrap(),
            "original"
        );
        assert_eq!(
            std::fs::read_to_string(session.path().join("new.tex")).unwrap(),
            "fresh"
        );
    }

    #[test]
    fn overlay_overwrite_replaces_existing_files() {
        let session = tempfile::tempdir().unwrap();
        std::fs::write(session.path().join("main.tex"), b"original").unwrap();
        let cfg = test_cfg();
        let zip = make_zip(&[("main.tex", b"updated")]);
        unpack_overlay(&zip, session.path(), &cfg, ConflictPolicy::Overwrite).unwrap();
        assert_eq!(
            std::fs::read_to_string(session.path().join("main.tex")).unwrap(),
            "updated"
        );
    }
}
