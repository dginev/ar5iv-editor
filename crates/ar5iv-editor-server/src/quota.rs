//! Per-session and per-host quota guards. See `docs/FileUI.md` for
//! the rationale on each limit.

use std::sync::atomic::Ordering;

use crate::config::SessionConfig;
use crate::error::AppError;
use crate::session::Session;

/// Verify that adding `delta_bytes` and `delta_files` to the session
/// would still fit within the per-session quotas. Doesn't mutate
/// state; the caller is responsible for the post-write counter
/// updates so a failed write doesn't prematurely consume budget.
pub fn check_session_growth(
    cfg: &SessionConfig,
    session: &Session,
    delta_bytes: u64,
    delta_files: u32,
) -> Result<(), AppError> {
    let new_bytes = session.bytes_used.load(Ordering::Relaxed).saturating_add(delta_bytes);
    if new_bytes > cfg.quota_session_bytes {
        return Err(AppError::quota(format!(
            "per-session size cap of {} bytes would be exceeded",
            cfg.quota_session_bytes
        )));
    }
    let new_files = session.file_count.load(Ordering::Relaxed).saturating_add(delta_files);
    if new_files > cfg.quota_session_files {
        return Err(AppError::quota(format!(
            "per-session file count cap of {} would be exceeded",
            cfg.quota_session_files
        )));
    }
    Ok(())
}

/// Reject a single upload field whose announced size exceeds the
/// per-file cap. Streaming uploads still need a running byte counter
/// to reject mid-stream when the announced size lies.
pub fn check_upload_size(cfg: &SessionConfig, size: u64) -> Result<(), AppError> {
    if size > cfg.quota_upload_bytes {
        return Err(AppError::quota(format!(
            "single-file upload cap of {} bytes would be exceeded",
            cfg.quota_upload_bytes
        )));
    }
    Ok(())
}

/// Reject an archive whose announced body size exceeds the archive
/// cap.
pub fn check_archive_size(cfg: &SessionConfig, size: u64) -> Result<(), AppError> {
    if size > cfg.quota_archive_bytes {
        return Err(AppError::quota(format!(
            "archive cap of {} bytes would be exceeded",
            cfg.quota_archive_bytes
        )));
    }
    Ok(())
}

/// Best-effort check that the sessions root has room for another
/// session. The walk-and-sum result is cached under a 10 s window so
/// we don't pay it on every session creation. A user_id that hits
/// this check sees a `503 Unavailable` with a clear "come back later"
/// message — no graceful retry, by design.
pub async fn check_root_capacity(cfg: &SessionConfig) -> Result<(), AppError> {
    let used = root_bytes_used(&cfg.sessions_dir).await?;
    if used > cfg.quota_root_bytes {
        return Err(AppError::unavailable(format!(
            "sessions root {} of {} bytes used; come back later",
            used, cfg.quota_root_bytes
        )));
    }
    Ok(())
}

async fn root_bytes_used(root: &std::path::Path) -> Result<u64, AppError> {
    use tokio::fs;
    let mut total: u64 = 0;
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries = match fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(AppError::internal(format!("read_dir {}: {}", dir.display(), err))),
        };
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| AppError::internal(format!("read_dir entry: {e}")))?
        {
            let ft = entry
                .file_type()
                .await
                .map_err(|e| AppError::internal(format!("file_type: {e}")))?;
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() {
                let meta = entry
                    .metadata()
                    .await
                    .map_err(|e| AppError::internal(format!("metadata: {e}")))?;
                total = total.saturating_add(meta.len());
            }
            // Symlinks intentionally ignored — we never create them
            // and counting their target sizes would make the walk
            // O(disk) on a hostile fs.
        }
    }
    Ok(total)
}
